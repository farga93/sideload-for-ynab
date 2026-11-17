import type { BankProfile, SkipRule } from "./catalog";
import { parseCsv, type CsvRecord } from "./csv";
import { inferDateFormat, parseDateWithFormat } from "./dates";
import { inferDecimalSeparator, parseBankAmount } from "./money";
import type { ParsedRow, ParseResult, SkippedRow } from "./types";

export interface ProfileOptions {
  /**
   * Currency of rows when the format has no Currency column: the account's currency.
   * Empty when unknown (format not linked to an account): rows then keep currency "".
   */
  currency: string;
}

/**
 * Reads a delimited-text export described by a bank2ynab-style profile.
 *
 * Follows bank2ynab's semantics so its catalog can be used as is (header and footer rows,
 * "Input Columns" roles, repeated roles merged, "Inflow or Outflow Indicator", conversion
 * factor, payee falling back to the memo), with these differences:
 * - payee and memo keep the bank's text (no title case or punctuation removal), only
 *   literal quotes around a cell are removed;
 * - amounts are parsed without floats, the decimal separator being inferred per file;
 * - no row is dropped silently: rows without a date or an amount, unreadable rows and
 *   rows matched by a `Skip Rows Where` rule are returned as skipped, with the reason;
 * - rows are returned oldest first when the file lists the newest first, so import_id
 *   occurrences stay stable when a later export adds newer operations.
 */
export function parseWithProfile(bytes: Uint8Array, profile: BankProfile, options: ProfileOptions): ParseResult {
  if (profile.unsupported) throw new Error(`The "${profile.name}" format is not supported: ${profile.unsupported}`);
  const records = parseCsv(decodeText(bytes, profile.encoding), profile.delimiter);
  const header = records.find((r) => r.line === profile.headerRows)?.fields.map(unquote) ?? [];
  const data = records.filter((r) => r.line > profile.headerRows);
  while (data.length && isBlank(data[data.length - 1]!)) data.pop();
  if (profile.footerRows) data.splice(-profile.footerRows);

  const rules = resolveSkipRules(profile.skipRules, header);
  const indexes = (role: string) => profile.columns.flatMap((c, i) => (c === role ? [i] : []));
  const dateFormat =
    profile.dateFormat ||
    inferDateFormat(
      data.flatMap((r) => indexes("Date").map((i) => unquote(r.fields[i] ?? ""))),
      /^US /.test(profile.name),
    );
  // Amount columns in file order; when there are as many Currency columns, they pair up
  // (Yuh: DEBIT with DEBIT CURRENCY, CREDIT with CREDIT CURRENCY).
  const inflowAt = indexes("Inflow");
  const outflowAt = indexes("Outflow");
  const amountAt = [...inflowAt, ...outflowAt].sort((a, b) => a - b);
  const currencyAt = indexes("Currency");
  const decimal = inferDecimalSeparator(
    data.flatMap((r) => [...inflowAt, ...outflowAt].map((i) => unquote(r.fields[i] ?? ""))),
  );

  const rows: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  let previousDate: string | undefined;
  for (const record of data) {
    if (isBlank(record)) continue;
    const cells = record.fields.map(unquote);
    const skip = (reason: string) => skipped.push({ line: record.line, reason, raw: cells.join(" | ") });
    // Repeated text roles are joined with a space; repeated amounts take the first non-empty.
    const first = (at: number[]) => at.map((i) => cells[i] ?? "").find(Boolean) ?? "";
    const text = (role: string) =>
      profile.firstNonEmpty.includes(role)
        ? first(indexes(role))
        : indexes(role)
            .map((i) => cells[i] ?? "")
            .filter(Boolean)
            .join(" ")
            .replace(/\s{2,}/g, " ")
            .trim();
    const currencyCell = () => {
      if (currencyAt.length !== amountAt.length) return first(currencyAt);
      const used = amountAt.findIndex((i) => (cells[i] ?? "") !== "");
      return used === -1 ? "" : (cells[currencyAt[used]!] ?? "");
    };

    if (cells.slice(profile.columns.length).some(Boolean)) {
      skip("Unexpected number of columns");
      continue;
    }
    const rule = rules.find((r) => r.conditions.every((c) => c.pattern.test(cells[c.index] ?? "")));
    if (rule) {
      skip(rule.reason);
      continue;
    }
    try {
      const dateText = text("Date");
      const date = dateText
        ? parseDateWithFormat(dateText, dateFormat)
        : profile.fillEmptyDates
          ? previousDate
          : undefined;
      if (!date) {
        skip("Missing date");
        continue;
      }
      previousDate = date;

      let inflow = parseBankAmount(first(inflowAt), decimal);
      const outflow = parseBankAmount(first(outflowAt), decimal);
      if (profile.outflowFlag !== undefined && text("CDFlag") === profile.outflowFlag) inflow = -inflow;
      let amount = inflow - outflow;
      if (profile.conversionFactor !== 1) {
        amount = Math.sign(amount) * Math.round(Math.abs(amount) / profile.conversionFactor / 10) * 10;
      }
      if (amount === 0) {
        skip("Row without amount");
        continue;
      }
      const memo = text("Memo");
      const payee = text("Payee") || memo;
      if (!payee) {
        skip("Missing payee");
        continue;
      }
      rows.push({
        date,
        amount,
        currency: (currencyCell() || options.currency).toUpperCase(),
        payee,
        memo: memo || undefined,
        line: record.line,
      });
    } catch (e) {
      skip((e as Error).message);
    }
  }
  if (rows.length > 1 && rows[0]!.date > rows[rows.length - 1]!.date) rows.reverse();
  return { profile: profile.name, account: profile.account, rows, skipped };
}

function resolveSkipRules(rules: SkipRule[], header: string[]) {
  return rules.map((rule) => ({
    reason: rule.reason,
    conditions: rule.conditions.map((c) => {
      const index = header.findIndex((h) => h.trim() === c.column);
      if (index === -1) throw new Error(`Skip rule: column "${c.column}" not found in the file's header`);
      return { index, pattern: c.pattern };
    }),
  }));
}

function isBlank(record: CsvRecord): boolean {
  return record.fields.every((f) => f.trim() === "");
}

/** Trims a cell and removes literal quotes around it (Yuh writes `"""Shop"""`, read as `"Shop"`). */
export function unquote(value: string): string {
  const v = value.trim();
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).trim() : v;
}

/**
 * Decodes a text export: a byte-order mark wins, then the profile's "Encoding" if the
 * browser knows it, then UTF-8 if the bytes are valid UTF-8, else Windows-1252.
 */
export function decodeText(bytes: Uint8Array, encoding = ""): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const label = encoding
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/^utf-8-sig$/, "utf-8")
    .replace(/^latin-?1$/, "iso-8859-1")
    .replace(/^cp(125\d)$/, "windows-$1");
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* unknown to the browser: detect below */
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
