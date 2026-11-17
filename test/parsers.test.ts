import type { ParseResult } from "../src/core/types";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "../src/core/csv";
import { parseBcv, splitLabel } from "../src/core/parsers/bcv";
import { PROFILES } from "../src/core/catalogData";
import { detectProfiles, eurDateRange, MAX_MEMO, parseExport, prepare, truncate } from "../src/core/pipeline";
import { readFirstSheet } from "../src/core/xlsx";
import { buildBcvXlsx, buildXlsx } from "./helpers/bcvXlsx";

const yuhBytes = new Uint8Array(readFileSync(new URL("./fixtures/yuh.csv", import.meta.url)));
const yuhText = new TextDecoder().decode(yuhBytes);
const yuhProfile = PROFILES.find((p) => p.name === "CH Yuh")!;
const parseYuh = (text: string) => parseExport(new TextEncoder().encode(text), yuhProfile);

const bcvBytes = buildBcvXlsx([
  { date: "13.11.2026", label: "Caisse de pension Exe", debit: "154.43" },
  { date: "13.11.2026", label: "PMT TWINT PARKING EXEMPLE", debit: "16.300000000000001" },
  { date: "12.11.2026", label: "PMT CARTE LIBRAIRIE & CIE", debit: "5.0" },
  { date: "10.11.2026", label: "PMT E-COM Service Cloud", debit: "5.0" },
  { date: "10.11.2026", label: "EMPLOYEUR EXEMPLE SA", credit: "8000.0" },
  { date: "09.11.2026", label: "Assurance Exemple", credit: "57.55" },
  { date: "", label: "Solde final" },
  { date: "08/11/2026", label: "Malformed date", debit: "1.0" },
]);

describe("parseCsv", () => {
  it("handles BOM, doubled quotes, delimiter and CRLF", () => {
    expect(parseCsv('\ufeffa;"b;""c""";d\r\n1;2;3', ";")).toEqual([
      { line: 1, fields: ["a", 'b;"c"', "d"] },
      { line: 2, fields: ["1", "2", "3"] },
    ]);
  });

  it("keeps the starting line of records after a multi-line quoted field", () => {
    expect(parseCsv('h\n"a\r\nb"\nc\n', ";").map((r) => r.line)).toEqual([1, 2, 4]);
  });
});

describe("CH Yuh format", () => {
  const result = parseExport(yuhBytes, yuhProfile);

  it("reads every currency with RECIPIENT as payee and the activity name and locality as memo", () => {
    expect(result).toMatchObject({ profile: "CH Yuh", account: "yuh" });
    expect(result.rows).toEqual([
      { date: "2026-11-06", amount: -6700, currency: "CHF", payee: "BOULANGERIEDUCOIN", memo: "Twint à BOULANGERIEDUCOIN", line: 2 },
      { date: "2026-11-06", amount: -1790, currency: "CHF", payee: "EPICERIEDUCOIN", memo: "Twint à EPICERIEDUCOIN", line: 3 },
      { date: "2026-11-06", amount: -1790, currency: "CHF", payee: "EPICERIEDUCOIN", memo: "Twint à EPICERIEDUCOIN", line: 4 },
      { date: "2026-11-07", amount: -12500, currency: "EUR", payee: "Librairie Exemple", memo: "Librairie Exemple LYON, FR", line: 5 },
      { date: "2026-11-08", amount: -36800, currency: "CHF", payee: "Opérateur Mobile SA", memo: "Transfert à Opérateur Mobile SA", line: 6 },
      { date: "2026-11-09", amount: 18490, currency: "EUR", payee: "Remboursement Exemple", memo: "Remboursement Exemple NICE, FR", line: 7 },
      { date: "2026-11-12", amount: -80000, currency: "USD", payee: "Hôtel Exemple", memo: "Hôtel Exemple NEW YORK, US", line: 10 },
    ]);
  });

  it("skips exchanges and securities with the reason from the format's skip rules", () => {
    expect(result.skipped.map(({ line, reason }) => ({ line, reason }))).toEqual([
      { line: 8, reason: "Currency exchange" },
      { line: 9, reason: "Securities trade" },
    ]);
  });

  it("reports real file lines when a field spans several lines", () => {
    const header = yuhText.split("\n")[0]!;
    const multiLine = `${header}\n06/11/2026;PAYMENT_TRANSACTION_OUT;"Twint\nà X";-1.00;CHF;;;;;"X";;0;;;;\n07/11/2026;X;"Y";;;;;;;"Y";;0;;;;\n`;
    expect(parseYuh(multiLine).skipped).toMatchObject([{ line: 4, reason: "Row without amount" }]);
  });

  it("falls back to SENDER when RECIPIENT is empty", () => {
    const header = yuhText.split("\n")[0]!;
    const row = `${header}\n09/11/2026;PAYMENT_TRANSACTION_IN;"""Transfert de X""";;;100.00;CHF;;;;"""Payer Exemple""";0;;;;\n`;
    expect(parseYuh(row).rows.map((r) => r.payee)).toEqual(["Payer Exemple"]);
  });

  it("rejects a file without the columns its skip rules need", () => {
    expect(() => parseYuh("DATE;ACTIVITY TYPE\n01/01/2026;X")).toThrow(/not found in the file's header/);
  });
});

describe("readFirstSheet", () => {
  it("returns cells as text with XML entities decoded", () => {
    const rows = readFirstSheet(bcvBytes);
    expect(rows.find((r) => r.row === 12)?.cells.slice(0, 3)).toEqual(["12.11.2026", "PMT CARTE LIBRAIRIE & CIE", "5.0"]);
  });

  it("keeps shared-string indexes with empty <si/> and <t/> entries", () => {
    const xlsx = buildXlsx(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>',
      '<si/><si><r><t/></r><r><t>CO</t></r><r><t xml:space="preserve">OP</t></r></si><si><t>LAST</t></si>',
    );
    expect(readFirstSheet(xlsx)[0]?.cells).toEqual(["", "COOP", "LAST"]);
  });
});

describe("parseBcv", () => {
  const result = parseBcv(bcvBytes);

  it("reads debits (negative) and credits oldest first, moving the PMT prefix to the memo", () => {
    expect(result.account).toBe("bcv");
    expect(result.rows.map(({ line: _line, ...row }) => row)).toEqual([
      { date: "2026-11-09", amount: 57550, currency: "CHF", payee: "Assurance Exemple", memo: undefined },
      { date: "2026-11-10", amount: 8000000, currency: "CHF", payee: "EMPLOYEUR EXEMPLE SA", memo: undefined },
      { date: "2026-11-10", amount: -5000, currency: "CHF", payee: "Service Cloud", memo: "E-commerce" },
      { date: "2026-11-12", amount: -5000, currency: "CHF", payee: "LIBRAIRIE & CIE", memo: "Card" },
      { date: "2026-11-13", amount: -16300, currency: "CHF", payee: "PARKING EXEMPLE", memo: "Twint" },
      { date: "2026-11-13", amount: -154430, currency: "CHF", payee: "Caisse de pension Exe", memo: undefined },
    ]);
  });

  it("keeps import_ids stable when a later export adds a same-day, same-amount operation", () => {
    const ids = (ops: Parameters<typeof buildBcvXlsx>[0]) =>
      prepare(parseBcv(buildBcvXlsx(ops)), {}).transactions.map((t) => `${t.payee_name} ${t.import_id}`);
    const a = { date: "11.11.2026", label: "PMT TWINT CAFE A", debit: "5.0" };
    const b = { date: "11.11.2026", label: "PMT TWINT CAFE B", debit: "5.0" };
    expect(ids([a])).toEqual(["CAFE A YNAB:-5000:2026-11-11:1"]);
    // B happened later that day, so the export lists it above A.
    expect(ids([b, a])).toEqual(["CAFE A YNAB:-5000:2026-11-11:1", "CAFE B YNAB:-5000:2026-11-11:2"]);
  });

  it("rejects an xlsx file that is not a BCV export", () => {
    expect(() => parseBcv(buildXlsx('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', "<si><t>Other</t></si>"))).toThrow(
      /Unrecognized xlsx file/,
    );
  });

  it("reports rows without amount or unreadable", () => {
    expect(result.skipped.map(({ line, reason }) => ({ line, reason }))).toEqual([
      { line: 16, reason: "Row without amount" },
      { line: 17, reason: 'Unreadable date: "08/11/2026"' },
    ]);
  });

  it("keeps an unknown payment code as is", () => {
    expect(splitLabel("PMT LSV Assurance")).toEqual({ payee: "Assurance", method: "LSV" });
  });
});

describe("detectProfiles", () => {
  const names = (filename: string, bytes: Uint8Array) =>
    detectProfiles(PROFILES, filename, bytes).map((m) => `${m.profile.name} (${m.by})`);

  it("recognizes Yuh and BCV from the content, whatever the file name", () => {
    expect(names("download (3).csv", yuhBytes)).toEqual(["CH Yuh (content)"]);
    expect(names("download.xlsx", bcvBytes)).toEqual(["CH BCV (content)"]);
  });

  it("recognizes bank2ynab formats from the file name", () => {
    expect(names("SC-Transactions_2026-02-16_06-56-22.csv", new TextEncoder().encode("x"))).toEqual([
      "CH SwissCard (filename)",
    ]);
  });

  it("finds nothing for an unknown file", () => {
    expect(names("notes.csv", new TextEncoder().encode("a;b;c"))).toEqual([]);
  });
});

describe("prepare", () => {
  // 2026-11-07 is a Saturday: Friday the 6th's rate applies.
  const rates = { "2026-11-06": 0.9312, "2026-11-09": 0.93 };
  const result = parseExport(yuhBytes, yuhProfile);

  it("only requests rates for the EUR rows' period", () => {
    expect(eurDateRange(result.rows)).toEqual({ from: "2026-11-07", to: "2026-11-09" });
    expect(eurDateRange(parseBcv(bcvBytes).rows)).toBeUndefined();
  });

  it("converts EUR to CHF and assigns stable import_ids", () => {
    const { transactions } = prepare(result, rates);
    expect(transactions.map((t) => [t.import_id, t.payee_name, t.memo])).toEqual([
      ["YNAB:-6700:2026-11-06:1", "BOULANGERIEDUCOIN", "Twint à BOULANGERIEDUCOIN"],
      ["YNAB:-1790:2026-11-06:1", "EPICERIEDUCOIN", "Twint à EPICERIEDUCOIN"],
      ["YNAB:-1790:2026-11-06:2", "EPICERIEDUCOIN", "Twint à EPICERIEDUCOIN"],
      ["EUR:-12500:2026-11-07:1", "Librairie Exemple", "Librairie Exemple LYON, FR · 12.50 EUR @ 0.9312"],
      ["YNAB:-36800:2026-11-08:1", "Opérateur Mobile SA", "Transfert à Opérateur Mobile SA"],
      ["EUR:18490:2026-11-09:1", "Remboursement Exemple", "Remboursement Exemple NICE, FR · 18.49 EUR @ 0.9300"],
    ]);
  });

  it("sorts transactions by ascending date", () => {
    const dates = prepare(parseBcv(bcvBytes), {}).transactions.map((t) => t.date);
    expect(dates).toEqual([...dates].sort());
  });

  it("skips an EUR row without an available rate instead of importing it in EUR", () => {
    const { transactions, skipped } = prepare(result, {});
    expect(transactions).toHaveLength(4);
    expect(skipped.filter((s) => /No EUR→CHF rate/.test(s.reason))).toHaveLength(2);
  });

  it("flags rows in an unknown currency (format not linked to an account) without converting them", () => {
    const rows = [{ date: "2026-11-10", amount: -5000, currency: "", payee: "X" }];
    const prepared = prepare({ profile: "test", rows, skipped: [] }, {});
    expect(prepared.unknownCurrency).toBe(true);
    expect(prepared.transactions.map((t) => t.amount)).toEqual([-5000]);
    expect(prepare(parseExport(yuhBytes, yuhProfile), {}).unknownCurrency).toBe(false);
  });

  it("still imports the CHF rows when the rates could not be fetched", () => {
    const { transactions, skipped } = prepare(result, {}, "ECB rates unavailable (HTTP 503)");
    expect(transactions).toHaveLength(4);
    expect(skipped.filter((s) => s.reason.startsWith("ECB rates unavailable (HTTP 503)"))).toHaveLength(2);
  });

  it("keeps CHF import_ids unchanged whether or not a same-day EUR row could be converted", () => {
    const parsed = (rows: ParseResult["rows"]): ParseResult => ({ profile: "test", account: "yuh", rows, skipped: [] });
    const eur = { date: "2026-11-10", amount: -5380, currency: "EUR", payee: "EUR SHOP" };
    const chf = { date: "2026-11-10", amount: -5000, currency: "CHF", payee: "CHF SHOP" };
    const before = prepare(parsed([eur, chf]), {}); // rate not published yet: EUR row skipped
    const after = prepare(parsed([eur, chf]), { "2026-11-10": 0.9294 }); // converts to -5.00 CHF
    expect(before.transactions.map((t) => t.import_id)).toEqual(["YNAB:-5000:2026-11-10:1"]);
    expect(after.transactions.map((t) => [t.amount, t.import_id])).toEqual([
      [-5000, "EUR:-5380:2026-11-10:1"],
      [-5000, "YNAB:-5000:2026-11-10:1"],
    ]);
  });

  it("truncates long payees and memos to YNAB's limits, keeping the FX note", () => {
    const row = { date: "2026-11-09", amount: -1000, currency: "EUR", payee: "P".repeat(300), memo: "M".repeat(600) };
    const [t] = prepare({ profile: "test", account: "yuh", rows: [row], skipped: [] }, { "2026-11-09": 0.93 }).transactions;
    expect(t!.payee_name).toHaveLength(200);
    expect(t!.memo!.length).toBeLessThanOrEqual(MAX_MEMO);
    expect(t!.memo).toMatch(/· 1\.00 EUR @ 0\.9300$/);
  });
});

describe("truncate", () => {
  it("does not split a character made of two UTF-16 units", () => {
    expect(truncate("ab\u{1F600}cd", 4)).toBe("ab\u2026");
    expect(truncate("abc", 3)).toBe("abc");
  });
});
