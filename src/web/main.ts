import { fetchEurChfRates, todayIso, type RateTable } from "../core/fx";
import { formatAmount } from "../core/money";
import { eurDateRange, parseExport, prepare, type Prepared } from "../core/pipeline";
import { MAX_BATCH, type AccountKey, type ImportRequest, type ImportResponse } from "../core/types";

const SECRET_KEY = "app-secret";
const ACCOUNT_LABEL: Record<AccountKey, string> = { yuh: "Yuh", bcv: "BCV" };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  settings: $<HTMLElement>("settings"),
  settingsToggle: $<HTMLButtonElement>("settings-toggle"),
  settingsForm: $<HTMLFormElement>("settings-form"),
  secret: $<HTMLInputElement>("secret"),
  secretClear: $<HTMLButtonElement>("secret-clear"),
  file: $<HTMLInputElement>("file"),
  status: $<HTMLParagraphElement>("status"),
  review: $<HTMLElement>("review"),
  reviewTitle: $<HTMLHeadingElement>("review-title"),
  reviewTotal: $<HTMLParagraphElement>("review-total"),
  rows: $<HTMLTableSectionElement>("rows"),
  skippedBox: $<HTMLDetailsElement>("skipped-box"),
  skippedTitle: $<HTMLElement>("skipped-title"),
  skipped: $<HTMLUListElement>("skipped"),
  send: $<HTMLButtonElement>("send"),
  cancel: $<HTMLButtonElement>("cancel"),
};

let current: { account: AccountKey; prepared: Prepared } | undefined;
/** Incremented for each file picked, so a slower earlier file cannot overwrite a newer one. */
let fileGeneration = 0;

// --- App secret (localStorage may be unavailable: private browsing, etc.)

function loadSecret(): string {
  try {
    return localStorage.getItem(SECRET_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveSecret(value: string | null): void {
  try {
    if (value) localStorage.setItem(SECRET_KEY, value);
    else localStorage.removeItem(SECRET_KEY);
  } catch {
    /* without storage, the secret is asked again */
  }
}

function showSettings(open: boolean): void {
  el.settings.hidden = !open;
  el.settingsToggle.setAttribute("aria-expanded", String(open));
  if (open) el.secret.focus();
}

el.settingsToggle.addEventListener("click", () => showSettings(el.settings.hidden !== false));
el.settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveSecret(el.secret.value.trim());
  el.secret.value = "";
  showSettings(false);
  setStatus("Secret saved on this device.", "ok");
});
el.secretClear.addEventListener("click", () => {
  saveSecret(null);
  el.secret.value = "";
  setStatus("Secret removed from this device.");
});

// --- File reading

el.file.addEventListener("change", () => {
  const file = el.file.files?.[0];
  if (file) void handleFile(file);
  el.file.value = "";
});

async function handleFile(file: File): Promise<void> {
  const generation = ++fileGeneration;
  const stale = () => generation !== fileGeneration;
  resetReview();
  setStatus(`Reading "${file.name}"…`);
  try {
    const result = parseExport(new Uint8Array(await file.arrayBuffer()));
    if (stale()) return;
    const range = eurDateRange(result.rows);
    let rates: RateTable = {};
    let ratesError: string | undefined;
    if (range) {
      setStatus("Fetching ECB EUR→CHF rates…");
      try {
        // Rates up to today: a later fixing proves that a missing weekday was a holiday.
        rates = await fetchEurChfRates(range.from, todayIso());
      } catch (e) {
        // Only the EUR rows depend on the rates: they are listed as skipped, the rest stays importable.
        ratesError = e instanceof TypeError ? "ECB rates unavailable (network error)" : (e as Error).message;
      }
    }
    if (stale()) return;
    current = { account: result.account, prepared: prepare(result, rates, ratesError) };
    renderReview();
    setStatus("");
  } catch (e) {
    if (!stale()) setStatus((e as Error).message, "error");
  }
}

/** File received through Android sharing: stored in the cache by the service worker. */
async function handleSharedFile(): Promise<void> {
  history.replaceState(null, "", "/");
  const lost = "No file was received from the share. Pick it below.";
  if (!("caches" in window)) {
    setStatus(lost, "error");
    return;
  }
  let file: File;
  try {
    const cache = await caches.open("share");
    const response = await cache.match("/shared-file");
    await cache.delete("/shared-file");
    if (!response) {
      setStatus(lost, "error");
      return;
    }
    const name = decodeURIComponent(response.headers.get("X-Filename") ?? "shared file");
    file = new File([await response.blob()], name);
  } catch {
    setStatus(lost, "error");
    return;
  }
  await handleFile(file);
}

// --- Review screen

function renderReview(): void {
  if (!current) return;
  const { account, prepared } = current;
  const { transactions, skipped } = prepared;
  el.reviewTitle.textContent = `${ACCOUNT_LABEL[account]} · ${transactions.length} transaction${transactions.length > 1 ? "s" : ""}`;
  const out = transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0);
  const inflow = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  el.reviewTotal.textContent = `Outflow ${formatAmount(-out)} · Inflow ${formatAmount(inflow)} CHF`;

  el.rows.replaceChildren(
    ...transactions.map((t) => {
      const tr = document.createElement("tr");
      const date = cell(t.date, "date");
      const payee = cell(t.payee_name);
      if (t.memo) {
        const memo = document.createElement("span");
        memo.className = "memo";
        memo.textContent = t.memo;
        payee.append(memo);
      }
      const amount = cell(formatAmount(t.amount), `num ${t.amount < 0 ? "neg" : "pos"}`);
      tr.append(date, payee, amount);
      return tr;
    }),
  );

  el.skippedBox.hidden = skipped.length === 0;
  el.skippedTitle.textContent = `${skipped.length} row${skipped.length > 1 ? "s" : ""} not imported`;
  el.skipped.replaceChildren(
    ...skipped.map((s) => {
      const li = document.createElement("li");
      li.textContent = `${s.line ? `Line ${s.line} · ` : ""}${s.reason} — ${s.raw}`;
      return li;
    }),
  );

  el.send.textContent = `Send to YNAB (${ACCOUNT_LABEL[account]})`;
  el.send.disabled = transactions.length === 0;
  el.review.hidden = false;
  el.review.scrollIntoView({ behavior: "smooth", block: "start" });
}

function cell(text: string, className?: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function resetReview(): void {
  current = undefined;
  el.review.hidden = true;
  el.rows.replaceChildren();
}

el.cancel.addEventListener("click", () => {
  resetReview();
  setStatus("");
});

// --- Sending

el.send.addEventListener("click", () => void send());

async function send(): Promise<void> {
  if (!current) return;
  const secret = loadSecret();
  if (!secret) {
    setStatus("Enter the app secret first.", "error");
    showSettings(true);
    return;
  }
  const { account, prepared } = current;
  const all = prepared.transactions;
  const totals: ImportResponse = { created: 0, duplicates: 0 };
  el.send.disabled = true;
  el.file.disabled = true;
  try {
    // Batches are sent one after the other. If one fails, sending everything again is
    // safe: the import_ids make YNAB skip the transactions already created.
    for (let start = 0; start < all.length; start += MAX_BATCH) {
      setStatus(all.length > MAX_BATCH ? `Sending to YNAB (${start} / ${all.length})…` : "Sending to YNAB…");
      const body: ImportRequest = { account, transactions: all.slice(start, start + MAX_BATCH) };
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ImportResponse> & { error?: string };
      if (res.status === 401) {
        setStatus("App secret rejected. Check it in the settings.", "error");
        showSettings(true);
        return;
      }
      if (!res.ok) {
        const done = start ? ` ${totals.created} created before the error; sending again is safe.` : "";
        throw new Error(`${data.error ?? `HTTP error ${res.status}`}.${done}`);
      }
      totals.created += data.created ?? 0;
      totals.duplicates += data.duplicates ?? 0;
    }
    resetReview();
    setStatus(
      `${totals.created} transaction(s) created, ${totals.duplicates} already present. ` +
        "Review and approve them in YNAB.",
      "ok",
    );
  } catch (e) {
    setStatus(`Sending failed: ${(e as Error).message}`, "error");
  } finally {
    el.send.disabled = false;
    el.file.disabled = false;
  }
}

function setStatus(text: string, kind?: "error" | "ok"): void {
  el.status.textContent = text;
  el.status.className = kind ?? "";
}

// --- Startup

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    /* without a service worker, only Android sharing is unavailable */
  });
}
// Ask the browser not to evict this site's storage, service worker included: without an
// active service worker, a shared file is sent to the Worker (see src/worker/index.ts).
navigator.storage?.persist?.().catch(() => {
  /* best effort */
});
if (new URLSearchParams(location.search).has("shared")) void handleSharedFile();
