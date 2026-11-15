import { MAX_BATCH, type AccountKey, type ImportRequest, type ImportResponse, type Transaction } from "../core/types";

export interface Env {
  /** Secrets (wrangler secret put). */
  YNAB_TOKEN: string;
  APP_SECRET: string;
  /** Variables (wrangler.jsonc). */
  YNAB_PLAN_ID: string;
  YNAB_ACCOUNT_YUH: string;
  YNAB_ACCOUNT_BCV: string;
  /** E.g. https://api.ynab.com/v1/plans; configurable in case the API keeps /budgets. */
  YNAB_API_BASE: string;
}

/**
 * POST /api/import. Never logs request content, so transactions stay confidential
 * even in Cloudflare logs.
 */
export async function handleImport(
  request: Request,
  env: Env,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!(await secretMatches(request.headers.get("Authorization"), env.APP_SECRET))) {
    return json({ error: "Invalid app secret" }, 401);
  }
  if (!env.YNAB_TOKEN || !env.YNAB_PLAN_ID || !env.YNAB_API_BASE) {
    return json({ error: "Worker misconfigured: YNAB_TOKEN, YNAB_PLAN_ID or YNAB_API_BASE is not set" }, 500);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = validateRequest(body);
  if (typeof parsed === "string") return json({ error: parsed }, 400);

  const accountId = accountIdFor(parsed.account, env);
  if (!accountId) return json({ error: `Account "${parsed.account}" is not configured` }, 400);

  const res = await fetchFn(`${env.YNAB_API_BASE}/${env.YNAB_PLAN_ID}/transactions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.YNAB_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      transactions: parsed.transactions.map((t) => ({
        account_id: accountId,
        date: t.date,
        amount: t.amount,
        payee_name: t.payee_name,
        memo: t.memo,
        import_id: t.import_id,
        cleared: "cleared",
        approved: false,
      })),
    }),
  });

  if (!res.ok) {
    // YNAB's error message describes the request, not the data, so it is safe to return.
    const detail = await res.text();
    return json({ error: `YNAB rejected the request (HTTP ${res.status})`, detail }, 502);
  }
  let data: { transaction_ids?: unknown; duplicate_import_ids?: unknown } | undefined;
  try {
    data = ((await res.json()) as { data?: typeof data }).data;
  } catch {
    data = undefined;
  }
  if (!data) {
    // The transactions may already exist: say so instead of a bare server error.
    return json(
      { error: "YNAB accepted the request but its reply could not be read. Check YNAB; sending again is safe" },
      502,
    );
  }
  const result: ImportResponse = {
    created: Array.isArray(data.transaction_ids) ? data.transaction_ids.length : 0,
    duplicates: Array.isArray(data.duplicate_import_ids) ? data.duplicate_import_ids.length : 0,
  };
  return json(result, 200);
}

/** Validates the exact shape of the batch; returns an error message or the typed request. */
export function validateRequest(body: unknown): ImportRequest | string {
  if (!isObject(body)) return "Expected body: JSON object";
  if (body.account !== "yuh" && body.account !== "bcv") return "Invalid account field";
  if (!Array.isArray(body.transactions) || body.transactions.length === 0) {
    return "No transactions to import";
  }
  if (body.transactions.length > MAX_BATCH) {
    return `Too many transactions (maximum ${MAX_BATCH})`;
  }
  const transactions: Transaction[] = [];
  for (const [i, t] of body.transactions.entries()) {
    const where = `Transaction ${i + 1}`;
    if (!isObject(t)) return `${where}: expected an object`;
    if (typeof t.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(t.date)) return `${where}: invalid date`;
    if (typeof t.amount !== "number" || !Number.isSafeInteger(t.amount)) return `${where}: invalid amount`;
    if (typeof t.payee_name !== "string" || t.payee_name.length === 0 || t.payee_name.length > 200) {
      return `${where}: invalid payee`;
    }
    if (t.memo !== undefined && (typeof t.memo !== "string" || t.memo.length > 500)) return `${where}: invalid memo`;
    if (typeof t.import_id !== "string" || !/^(?:YNAB|[A-Z]{3}):-?\d+:\d{4}-\d{2}-\d{2}:\d+$/.test(t.import_id) || t.import_id.length > 36) {
      return `${where}: invalid import_id`;
    }
    transactions.push({ date: t.date, amount: t.amount, payee_name: t.payee_name, memo: t.memo, import_id: t.import_id });
  }
  return { account: body.account, transactions };
}

function accountIdFor(account: AccountKey, env: Env): string | undefined {
  const id = account === "yuh" ? env.YNAB_ACCOUNT_YUH : env.YNAB_ACCOUNT_BCV;
  return id ? id : undefined;
}

/** Constant-time comparison of the Bearer token (through SHA-256 digests). */
async function secretMatches(header: string | null, secret: string): Promise<boolean> {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const [a, b] = await Promise.all([sha256(header.slice(7)), sha256(secret)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
