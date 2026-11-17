import { readFirstSheet, type SheetRow } from "../xlsx";
import type { ParsedRow, ParseResult, SkippedRow } from "../types";

const HEADER = ["Date d'exécution", "Opérations", "Débit", "Crédit"];

/** BCV "PMT <METHOD>" label prefixes → readable memo. */
const METHODS: Record<string, string> = { TWINT: "Twint", CARTE: "Card", "E-COM": "E-commerce" };

/**
 * Parses the BCV e-banking "Liste des opérations" xlsx export: CHF account,
 * DD.MM.YYYY dates as text, debit and credit as positive numbers in two columns.
 * The bank truncates labels; the "PMT TWINT" etc. prefix moves to the memo.
 *
 * The export lists the newest operation first. Rows are returned oldest first so that
 * import_id occurrences of same-day, same-amount operations stay stable when a later
 * export adds newer operations on that day.
 */
export function parseBcv(data: Uint8Array): ParseResult {
  const sheet = readFirstSheet(data);
  const headerIndex = findHeader(sheet);
  if (headerIndex === -1) {
    throw new Error("Unrecognized xlsx file: expected the BCV \"Liste des opérations\" export");
  }
  const col = Object.fromEntries(sheet[headerIndex]!.cells.map((name, i) => [name.trim(), i]));

  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  for (const { row, cells } of sheet.slice(headerIndex + 1).reverse()) {
    const get = (name: string) => (cells[col[name]!] ?? "").trim();
    if (cells.every((c) => c.trim() === "")) continue;
    const skip = (reason: string) => skipped.push({ line: row, reason, raw: cells.join(" | ") });

    const debit = get("Débit");
    const credit = get("Crédit");
    if (debit && credit) {
      skip("Debit and credit on the same row");
      continue;
    }
    if (!debit && !credit) {
      skip("Row without amount");
      continue;
    }
    try {
      const date = parseDate(get("Date d'exécution"));
      const amount = cellToMilli(debit || credit);
      const { payee, method } = splitLabel(get("Opérations"));
      if (!payee) {
        skip("Missing label");
        continue;
      }
      rows.push({ date, amount: debit ? -amount : amount, currency: "CHF", payee, memo: method, line: row });
    } catch (e) {
      skip((e as Error).message);
    }
  }
  skipped.sort((a, b) => a.line - b.line);
  return { profile: "CH BCV", account: "bcv", rows, skipped };
}

/** True when the xlsx file is a BCV "Liste des opérations" export. */
export function isBcvExport(data: Uint8Array): boolean {
  try {
    return findHeader(readFirstSheet(data)) !== -1;
  } catch {
    return false;
  }
}

function findHeader(rows: SheetRow[]): number {
  return rows.findIndex((r) => HEADER.every((h) => r.cells.some((c) => c.trim() === h)));
}

/** "PMT TWINT SBB MOBILE" → payee "SBB MOBILE", memo "Twint". */
export function splitLabel(label: string): { payee: string; method?: string } {
  const m = /^PMT\s+(\S+)\s+(.+)$/.exec(label);
  if (!m) return { payee: label };
  const code = m[1]!.toUpperCase();
  return { payee: m[2]!.trim(), method: METHODS[code] ?? code };
}

/**
 * xlsx number (decimal text, sometimes with a float artifact such as "16.300000000000001")
 * → positive milliunits, rounded to the centime.
 */
function cellToMilli(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Unreadable amount: "${text}"`);
  return Math.round(n * 100) * 10;
}

function parseDate(text: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (!m) throw new Error(`Unreadable date: "${text}"`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}
