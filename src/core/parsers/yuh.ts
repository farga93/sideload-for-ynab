import { parseCsv } from "../csv";
import { parseAmount } from "../money";
import type { ParsedRow, ParseResult, SkippedRow } from "../types";

const REQUIRED = ["DATE", "ACTIVITY TYPE", "ACTIVITY NAME", "DEBIT", "DEBIT CURRENCY", "CREDIT", "CREDIT CURRENCY", "RECIPIENT", "SENDER"];
const SUPPORTED_CURRENCIES = new Set(["CHF", "EUR"]);

/** Recognizes the Yuh app "ACTIVITIES_REPORT" export by its header line. */
export function isYuhExport(text: string): boolean {
  return /^\ufeff?DATE;ACTIVITY TYPE;ACTIVITY NAME;/.test(text);
}

/**
 * Parses the Yuh CSV export (";" delimiter, DD/MM/YYYY dates, debits already negative).
 * Yuh wraps text fields in literal quotes ("""Example Shop"""); they are removed here.
 *
 * Skips, with a reason: currency exchanges (debit and credit on the same row),
 * securities trades, currencies other than CHF/EUR, unreadable rows.
 */
export function parseYuh(text: string): ParseResult {
  const [header, ...records] = parseCsv(text, ";");
  if (!header) throw new Error("Empty Yuh export");
  const col = Object.fromEntries(header.fields.map((name, i) => [name.trim(), i]));
  const missing = REQUIRED.filter((name) => col[name] === undefined);
  if (missing.length) throw new Error(`Yuh export: missing columns (${missing.join(", ")})`);
  const get = (cells: string[], name: string) => unquote(cells[col[name]!] ?? "");

  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  records.forEach(({ line, fields: cells }) => {
    const raw = cells.map(unquote).join(" | ");
    if (cells.every((c) => c.trim() === "")) return;
    const skip = (reason: string) => skipped.push({ line, reason, raw });

    const debit = get(cells, "DEBIT");
    const credit = get(cells, "CREDIT");
    if (get(cells, "ASSET") || get(cells, "QUANTITY") || get(cells, "BUY/SELL")) return skip("Securities trade");
    if (debit && credit) return skip("Currency exchange");
    if (!debit && !credit) return skip("Row without amount");

    const currency = get(cells, debit ? "DEBIT CURRENCY" : "CREDIT CURRENCY");
    if (!SUPPORTED_CURRENCIES.has(currency)) return skip(`Unsupported currency: ${currency || "(empty)"}`);

    try {
      const amount = parseAmount(debit || credit);
      const date = parseDate(get(cells, "DATE"));
      const name = get(cells, "ACTIVITY NAME");
      const payee = get(cells, "RECIPIENT") || get(cells, "SENDER") || name;
      if (!payee) return skip("Missing payee");
      rows.push({
        date,
        // A credit stays positive; a debit is already negative in the export.
        amount: debit ? -Math.abs(amount) : Math.abs(amount),
        currency,
        payee,
        memo: memoFor(get(cells, "ACTIVITY TYPE"), name, get(cells, "LOCALITY")),
      });
    } catch (e) {
      skip((e as Error).message);
    }
  });
  return { account: "yuh", rows, skipped };
}

/** Payment method, plus locality for cards: "Twint", "Transfer", "Card · PARIS, FR". */
function memoFor(type: string, name: string, locality: string): string | undefined {
  if (type.startsWith("CARD_")) return locality ? `Card · ${locality}` : "Card";
  if (/^Twint\b/i.test(name)) return "Twint";
  if (/^Transfert\b/i.test(name)) return "Transfer";
  return undefined;
}

function unquote(value: string): string {
  const v = value.trim();
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).trim() : v;
}

function parseDate(text: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!m) throw new Error(`Unreadable date: "${text}"`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}
