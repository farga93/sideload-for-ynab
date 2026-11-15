import { describe, expect, it, vi } from "vitest";
import { handleImport, validateRequest, type Env } from "../src/worker/handler";

const env: Env = {
  YNAB_TOKEN: "ynab-token",
  APP_SECRET: "app-secret",
  YNAB_PLAN_ID: "plan-1",
  YNAB_ACCOUNT_YUH: "acc-yuh",
  YNAB_ACCOUNT_BCV: "",
  YNAB_API_BASE: "https://api.ynab.com/v1/plans",
};

const tx = {
  date: "2026-11-02",
  amount: -4500,
  payee_name: "Migros",
  import_id: "YNAB:-4500:2026-11-02:1",
};

function req(body: unknown, secret = "app-secret", method = "POST"): Request {
  return new Request("https://x/api/import", {
    method,
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

function ynabOk(created: number, duplicates: number) {
  return vi.fn(async () =>
    Response.json({
      data: {
        transaction_ids: Array.from({ length: created }, (_, i) => `t${i}`),
        duplicate_import_ids: Array.from({ length: duplicates }, (_, i) => `d${i}`),
      },
    }),
  );
}

describe("handleImport", () => {
  it("forwards the batch to YNAB with the configured account, unapproved", async () => {
    const fetchFn = ynabOk(1, 2);
    const res = await handleImport(req({ account: "yuh", transactions: [tx] }), env, fetchFn as typeof fetch);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 1, duplicates: 2 });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.ynab.com/v1/plans/plan-1/transactions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ynab-token");
    expect(JSON.parse(init.body as string).transactions[0]).toEqual({
      ...tx,
      account_id: "acc-yuh",
      cleared: "cleared",
      approved: false,
    });
  });

  it("rejects a wrong secret without calling YNAB", async () => {
    const fetchFn = ynabOk(0, 0);
    const res = await handleImport(req({ account: "yuh", transactions: [tx] }, "wrong"), env, fetchFn as typeof fetch);
    expect(res.status).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an unconfigured account", async () => {
    const fetchFn = ynabOk(0, 0);
    const res = await handleImport(req({ account: "bcv", transactions: [tx] }), env, fetchFn as typeof fetch);
    expect(res.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects methods other than POST", async () => {
    const res = await handleImport(req(null, "app-secret", "GET"), env);
    expect(res.status).toBe(405);
  });

  it("reports a missing plan ID clearly, after the secret check", async () => {
    const fetchFn = ynabOk(0, 0);
    const misconfigured = { ...env, YNAB_PLAN_ID: "" };
    const res = await handleImport(req({ account: "yuh", transactions: [tx] }), misconfigured, fetchFn as typeof fetch);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/YNAB_PLAN_ID/) });
    expect(fetchFn).not.toHaveBeenCalled();
    const unauthenticated = await handleImport(req({}, "wrong"), misconfigured);
    expect(unauthenticated.status).toBe(401);
  });

  it("reports a YNAB rejection", async () => {
    const fetchFn = vi.fn(async () => new Response("{\"error\":{}}", { status: 400 }));
    const res = await handleImport(req({ account: "yuh", transactions: [tx] }), env, fetchFn as typeof fetch);
    expect(res.status).toBe(502);
  });
});

describe("handleImport, unreadable YNAB reply", () => {
  it("returns an explicit error instead of crashing when YNAB's success body is not JSON", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>", { status: 201 }));
    const res = await handleImport(req({ account: "yuh", transactions: [tx] }), env, fetchFn as typeof fetch);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/could not be read/);
  });
});

describe("validateRequest", () => {
  it.each([
    [{ account: "ubs", transactions: [tx] }, /account/],
    [{ account: "yuh", transactions: [] }, /No transactions/],
    [{ account: "yuh", transactions: [{ ...tx, amount: -45.5 }] }, /amount/],
    [{ account: "yuh", transactions: [{ ...tx, date: "02.11.2026" }] }, /date/],
    [{ account: "yuh", transactions: [{ ...tx, payee_name: "" }] }, /payee/],
    [{ account: "yuh", transactions: [{ ...tx, import_id: "x" }] }, /import_id/],
  ])("rejects %j", (body, message) => {
    expect(validateRequest(body)).toMatch(message);
  });

  it("accepts the import_id of a converted row", () => {
    const body = { account: "yuh", transactions: [{ ...tx, import_id: "EUR:-12500:2026-11-07:1" }] };
    expect(validateRequest(body)).not.toBeTypeOf("string");
  });

  it("keeps only the expected fields", () => {
    const result = validateRequest({ account: "yuh", transactions: [{ ...tx, account_id: "other", approved: true }] });
    expect(result).toEqual({ account: "yuh", transactions: [{ ...tx, memo: undefined }] });
  });
});
