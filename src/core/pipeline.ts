import { convertEurToChf, type RateTable } from "./fx";
import { assignImportIds } from "./importId";
import { parseBcv } from "./parsers/bcv";
import { isYuhExport, parseYuh } from "./parsers/yuh";
import type { ParsedRow, ParseResult, SkippedRow, Transaction } from "./types";

/** Detects the bank from the file content (not its name) and parses it. */
export function parseExport(bytes: Uint8Array): ParseResult {
  // An xlsx file is a zip archive: "PK" signature.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return parseBcv(bytes);
  const text = new TextDecoder("utf-8").decode(bytes);
  if (isYuhExport(text)) return parseYuh(text);
  throw new Error("Unrecognized format: expected a Yuh CSV export or a BCV xlsx export");
}

/** Date range [min, max] of the EUR rows, so only the needed rates are fetched. */
export function eurDateRange(rows: ParsedRow[]): { from: string; to: string } | undefined {
  const dates = rows.filter((r) => r.currency === "EUR").map((r) => r.date).sort();
  return dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : undefined;
}

export interface Prepared {
  transactions: Transaction[];
  /** Rows skipped by the parser or for lack of an exchange rate. */
  skipped: SkippedRow[];
}

/** YNAB limits, also enforced by the Worker (UTF-16 length). */
export const MAX_PAYEE = 200;
export const MAX_MEMO = 500;

/**
 * Sorts by date (stable), assigns import_ids, then converts EUR to CHF.
 *
 * import_ids are assigned to every row before any can be skipped, so a row skipped today
 * (rate not published yet) does not shift the occurrence numbers of the others when the
 * file is imported again. EUR rows are numbered in their own `EUR:` namespace from their
 * original amount, so they can never take the ID of a CHF row.
 *
 * `ratesError` is set when the rates could not be fetched: EUR rows are then skipped
 * with that reason and the CHF rows can still be imported.
 */
export function prepare(result: ParseResult, rates: RateTable, ratesError?: string): Prepared {
  const skipped = [...result.skipped];
  const sorted = [...result.rows].sort((a, b) => a.date.localeCompare(b.date));
  const rows = assignImportIds(sorted, (row) => (row.currency === "CHF" ? "YNAB" : row.currency));
  const transactions: Transaction[] = [];
  for (const row of rows) {
    const skip = (reason: string) => skipped.push({ line: 0, reason, raw: `${row.date} | ${row.payee}` });
    let amount = row.amount;
    let memo = row.memo;
    if (row.currency === "EUR") {
      if (ratesError) {
        skip(`${ratesError}: import this row again later`);
        continue;
      }
      try {
        const fx = convertEurToChf(row.amount, rates, row.date);
        amount = fx.amount;
        memo = memo ? `${truncate(memo, MAX_MEMO - fx.note.length - 3)} · ${fx.note}` : fx.note;
      } catch (e) {
        skip((e as Error).message);
        continue;
      }
    } else if (row.currency !== "CHF") {
      skip(`Unsupported currency: ${row.currency}`);
      continue;
    }
    transactions.push({
      date: row.date,
      amount,
      payee_name: truncate(row.payee, MAX_PAYEE),
      memo: memo === undefined ? undefined : truncate(memo, MAX_MEMO),
      import_id: row.import_id,
    });
  }
  return { transactions, skipped };
}

/** Shortens text to at most `max` UTF-16 units, without splitting a character, ending with "…". */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}\u2026`;
}
