import type { BankProfile } from "./catalog";
import { profilesForFilename } from "./catalog";
import { convertEurToChf, type RateTable } from "./fx";
import { assignImportIds } from "./importId";
import { isBcvExport, parseBcv } from "./parsers/bcv";
import { decodeText, parseWithProfile } from "./profile";
import type { ParsedRow, ParseResult, SkippedRow, Transaction } from "./types";

/** Currency of the YNAB budget, and of rows whose format has no Currency column. */
export const BUDGET_CURRENCY = "CHF";

export interface ProfileMatch {
  profile: BankProfile;
  /** "content": recognized from the file itself, reliable; "filename": name pattern only. */
  by: "content" | "filename";
}

/**
 * Formats that can read a file, most likely first: formats recognized from the content
 * (BCV xlsx sheet, `Sideload Detect Header`), then formats whose file name pattern
 * matches, supported ones before unsupported ones.
 */
export function detectProfiles(profiles: BankProfile[], filename: string, bytes: Uint8Array): ProfileMatch[] {
  const byContent: BankProfile[] = [];
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // An xlsx file is a zip archive: "PK" signature.
    if (isBcvExport(bytes)) byContent.push(...profiles.filter((p) => p.parser === "bcv"));
  } else {
    const firstLine = decodeText(bytes.subarray(0, 4096)).replace(/^\ufeff/, "").split(/\r?\n/, 1)[0] ?? "";
    byContent.push(...profiles.filter((p) => p.detectHeader?.test(firstLine)));
  }
  return [
    ...byContent.map((profile) => ({ profile, by: "content" as const })),
    ...profilesForFilename(profiles, filename)
      .filter((p) => !byContent.includes(p))
      .map((profile) => ({ profile, by: "filename" as const })),
  ];
}

/** Reads a bank export with the given format. */
export function parseExport(bytes: Uint8Array, profile: BankProfile): ParseResult {
  if (profile.unsupported) throw new Error(`The "${profile.name}" format is not supported: ${profile.unsupported}`);
  if (profile.parser === "bcv") return { ...parseBcv(bytes), profile: profile.name, account: profile.account };
  // Without a Currency column, rows are in the account's currency. Only formats linked to an
  // account have a known one for now; the others keep "" (shown as the file's currency).
  return parseWithProfile(bytes, profile, { currency: profile.account ? BUDGET_CURRENCY : "" });
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
  /** Some amounts are in the file's currency, unknown to the app: shown as is, not sendable. */
  unknownCurrency: boolean;
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
  const rows = assignImportIds(sorted, (row) => (row.currency === "CHF" || row.currency === "" ? "YNAB" : row.currency));
  const transactions: Transaction[] = [];
  for (const row of rows) {
    const skip = (reason: string) =>
      skipped.push({ line: row.line ?? 0, reason, raw: `${row.date} | ${row.payee}${row.memo ? ` | ${row.memo}` : ""}` });
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
    } else if (row.currency !== "CHF" && row.currency !== "") {
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
  skipped.sort((a, b) => a.line - b.line);
  return { transactions, skipped, unknownCurrency: result.rows.some((r) => r.currency === "") };
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
