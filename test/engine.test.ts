import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProfiles, filenameMatcher, parseSkipRules, profilesForFilename, type BankProfile } from "../src/core/catalog";
import { PROFILES } from "../src/core/catalogData";
import { inferDateFormat, parseDateWithFormat } from "../src/core/dates";
import { parseIni } from "../src/core/ini";
import { inferDecimalSeparator, parseBankAmount } from "../src/core/money";
import { decodeText, parseWithProfile } from "../src/core/profile";

const upstreamConf = readFileSync(new URL("../catalog/bank2ynab.conf", import.meta.url), "utf-8");
const encode = (text: string) => new TextEncoder().encode(text);

/** One profile from a test section, on top of bank2ynab's [DEFAULT] values. */
function profile(section: string): BankProfile {
  const profiles = buildProfiles(upstreamConf, `[Test]\n${section}`);
  return profiles.find((p) => p.name === "Test")!;
}
const read = (p: BankProfile, text: string) => parseWithProfile(encode(text), p, { currency: "CHF" });

describe("parseIni", () => {
  it("reads sections, case-insensitive keys, continued values and [DEFAULT]", () => {
    const ini = parseIni(
      "# comment\n[DEFAULT]\nHeader Rows = 1\n\n[Bank]\ninput columns: Date,Payee\nSkip Rows Where =\n    A ~ x => one\n    B ~ y => two\n; other comment\n",
    );
    expect(ini.defaults.get("header rows")).toBe("1");
    expect(ini.sections.get("Bank")?.get("input columns")).toBe("Date,Payee");
    expect(ini.sections.get("Bank")?.get("skip rows where")).toBe("A ~ x => one\nB ~ y => two");
  });
});

describe("dates", () => {
  it.each([
    ["13.11.2026", "%d.%m.%Y", "2026-11-13"],
    ["3/7/26", "%m/%d/%y", "2026-03-07"],
    ["20261113", "%Y%m%d", "2026-11-13"],
    ["13 Nov 2026", "%d %b %Y", "2026-11-13"],
    ["2026-11-13 08:15:00 +0000", "%Y-%m-%d %H:%M:%S +0000", "2026-11-13"],
    ["13.11.2026 08:15:00", "%d.%m.%Y", "2026-11-13"],
    ["01.01.69", "%d.%m.%y", "1969-01-01"],
  ])("reads %s with %s", (text, format, iso) => {
    expect(parseDateWithFormat(text, format)).toBe(iso);
  });

  it("rejects impossible dates and unsupported formats", () => {
    expect(() => parseDateWithFormat("31.02.2026", "%d.%m.%Y")).toThrow(/Unreadable date/);
    expect(() => parseDateWithFormat("13.11", "%d.%m")).toThrow(/without a year/);
  });

  it("infers a missing format, ignoring unreadable values", () => {
    expect(inferDateFormat(["2026-11-13", "2026-11-01"])).toBe("%Y-%m-%d");
    expect(inferDateFormat(["13/11/2026", "01/11/2026", "Total"])).toBe("%d/%m/%Y");
    expect(() => inferDateFormat(["Total", ""])).toThrow(/Unreadable dates/);
  });

  it("settles day/month ambiguity by the bank's country: month first only for US banks", () => {
    expect(inferDateFormat(["01/11/2026", "02/11/2026"])).toBe("%d/%m/%Y");
    expect(inferDateFormat(["01/11/2026", "02/11/2026"], true)).toBe("%m/%d/%Y");
    expect(inferDateFormat(["11/13/2026", "01/11/2026"])).toBe("%m/%d/%Y");
  });
});

describe("parseBankAmount", () => {
  it.each([
    ["-12.50", undefined, -12500],
    ["1'234.50", ".", 1234500],
    ["1.234,50", ",", 1234500],
    ["1 234,5 €", ",", 1234500],
    ["CHF -7.05", ".", -7050],
    ["12.50-", ".", -12500],
    ["(12.50)", ".", -12500],
    ["1,234", ".", 1234000],
    ["1.234.567,89", ",", 1234567890],
    ["", ".", 0],
  ] as const)("reads %j", (text, decimal, milli) => {
    expect(parseBankAmount(text, decimal)).toBe(milli);
  });

  it.each([
    ["1,234", undefined],
    ["12,5", "."],
    ["1.2.3", "."],
    ["12.345", undefined],
    ["abc", "."],
  ] as const)("rejects %j", (text, decimal) => {
    expect(() => parseBankAmount(text, decimal)).toThrow(/Ambiguous|Unreadable/);
  });

  it("infers the decimal separator from the file's amounts", () => {
    expect(inferDecimalSeparator(["1.234,50", "12,00", ""])).toBe(",");
    expect(inferDecimalSeparator(["1,234.50", "7.5"])).toBe(".");
    expect(inferDecimalSeparator(["100", "1,234"])).toBeUndefined();
  });
});

describe("catalog", () => {
  it("loads bank2ynab's formats and the local ones, with a reason for each unsupported one", () => {
    expect(PROFILES.length).toBeGreaterThan(120);
    const unsupported = PROFILES.filter((p) => p.unsupported);
    expect(unsupported.length).toBeLessThan(15);
    for (const p of unsupported) expect(p.unsupported).toMatch(/\w/);
    expect(PROFILES.find((p) => p.name === "CH Yuh")).toMatchObject({ origin: "local", account: "yuh" });
    expect(PROFILES.find((p) => p.name === "CH UBS Checking account")).toMatchObject({ origin: "bank2ynab" });
    expect(PROFILES.find((p) => p.name === "SG UOB Credit Card")?.unsupported).toMatch(/plugin "xls_converter"/);
  });

  it("ignores a format whose file name pattern is not valid in JavaScript", () => {
    const bad = profile("Use Regex For Filename = True\nSource Filename Pattern = (?<=x)(?P=y)");
    expect(bad.unsupported).toMatch(/not a valid regular expression/);
    expect(profilesForFilename([bad, ...PROFILES], "SC-Transactions_1.csv").map((p) => p.name)).toEqual(["CH SwissCard"]);
  });

  it("matches file names like bank2ynab: prefix or regex, case-sensitive extension", () => {
    const plain = profile("Source Filename Pattern = export\nSource Filename Extension = .csv");
    expect(filenameMatcher(plain)("export_2026.csv")).toBe(true);
    expect(filenameMatcher(plain)("export_2026.CSV")).toBe(false);
    expect(filenameMatcher(plain)("fixed_export_2026.csv")).toBe(false);
    const regex = profile("Use Regex For Filename = True\nSource Filename Pattern = (a|b)\\d+");
    expect(filenameMatcher(regex)("b12.csv")).toBe(true);
    expect(filenameMatcher(regex)("xb12.csv")).toBe(false);
  });

  it("parses skip rules", () => {
    expect(parseSkipRules("DEBIT ~ \\S & CREDIT ~ \\S => Currency exchange")).toEqual([
      { conditions: [{ column: "DEBIT", pattern: /\S/ }, { column: "CREDIT", pattern: /\S/ }], reason: "Currency exchange" },
    ]);
    expect(() => parseSkipRules("DEBIT => x")).toThrow(/invalid skip rule/);
  });
});

describe("parseWithProfile", () => {
  it("reads a bank2ynab format as is: UBS checking account with a footer", () => {
    const ubs = PROFILES.find((p) => p.name === "CH UBS Checking account")!;
    const row = (date: string, payee: string, memo: string, debit: string, credit: string) =>
      `;;;;;;;;;${date};;;;${payee};${memo};;;;${debit};${credit};`;
    const text = [
      "header;of;the;export",
      row("12.11.2026", "Café Exemple", "Card payment", "4.50", ""),
      row("13.11.2026", "Employer Exemple SA", "Salary", "", "1'500.00"),
      "Footer 1",
      "Footer 2;x",
      "Footer 3",
    ].join("\n");
    const result = read(ubs, text);
    expect(result.rows).toEqual([
      { date: "2026-11-12", amount: -4500, currency: "CHF", payee: "Café Exemple", memo: "Card payment", line: 2 },
      { date: "2026-11-13", amount: 1500000, currency: "CHF", payee: "Employer Exemple SA", memo: "Salary", line: 3 },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("applies the inflow/outflow indicator and keeps the bank's text", () => {
    const p = profile("Header Rows = 0\nInput Columns = Date,Payee,CDFlag,Inflow\nDate Format = %Y%m%d\nInflow or Outflow Indicator = 2,C,D");
    expect(read(p, "20261113,SHOP & CO.,D,12.50\n20261113,REFUND,C,3.00").rows.map((r) => [r.payee, r.amount])).toEqual([
      ["SHOP & CO.", -12500],
      ["REFUND", 3000],
    ]);
  });

  it("merges repeated columns, divides by the conversion factor and fills empty dates", () => {
    const p = profile(
      "Header Rows = 0\nInput Columns = Date,Payee,Payee,Outflow,Inflow\nDate Format = %d.%m.%Y\nCurrency Conversion Factor = 100\nDate De-Duplication = True",
    );
    const result = read(p, "13.11.2026,Shop,Zurich,1250,\n,Bank,,,500");
    expect(result.rows.map((r) => [r.date, r.payee, r.amount])).toEqual([
      ["2026-11-13", "Shop Zurich", -12500],
      ["2026-11-13", "Bank", 5000],
    ]);
  });

  it("returns newest-first files oldest first, and infers the date format and decimal comma", () => {
    const p = profile("Header Rows = 0\nSource CSV Delimiter = ;\nInput Columns = Date,Payee,Inflow\nDate Format =");
    const result = read(p, "14/11/2026;B;-1.234,50\n13/11/2026;A;-2,00");
    expect(result.rows.map((r) => [r.date, r.payee, r.amount])).toEqual([
      ["2026-11-13", "A", -2000],
      ["2026-11-14", "B", -1234500],
    ]);
  });

  it("lists every row it cannot import, with the reason", () => {
    const p = profile("Header Rows = 1\nInput Columns = Date,Payee,Inflow\nDate Format = %Y-%m-%d");
    const result = read(p, "Date,Payee,Amount\n2026-11-13,A,0\n,B,1.00\n2026-13-01,C,1.00\n2026-11-13,D,1,234\n2026-11-13,E,1.00,extra\n2026-11-13,,1.00");
    expect(result.skipped.map((s) => [s.line, s.reason])).toEqual([
      [2, "Row without amount"],
      [3, "Missing date"],
      [4, 'Unreadable date: "2026-13-01"'],
      [5, "Unexpected number of columns"],
      [6, "Unexpected number of columns"],
      [7, "Missing payee"],
    ]);
  });

  it("takes the first non-empty cell for roles listed in Sideload First Non-Empty", () => {
    const p = profile(
      "Header Rows = 0\nInput Columns = Date,Payee,Payee,Inflow\nDate Format = %Y-%m-%d\nSideload First Non-Empty = Payee",
    );
    expect(read(p, "2026-11-13,,Sender SA,5.00\n2026-11-13,Recipient,Sender SA,-5.00").rows.map((r) => r.payee)).toEqual([
      "Sender SA",
      "Recipient",
    ]);
  });

  it("pairs Currency columns with the amount column actually used", () => {
    const p = profile(
      "Header Rows = 0\nSource CSV Delimiter = ;\nInput Columns = Date,Payee,Inflow,Currency,Inflow,Currency\nDate Format = %Y-%m-%d",
    );
    const result = read(p, "2026-11-13;A;;EUR;18.00;CHF\n2026-11-13;B;-5.00;EUR;;CHF");
    expect(result.rows.map((r) => [r.payee, r.currency, r.amount])).toEqual([
      ["A", "CHF", 18000],
      ["B", "EUR", -5000],
    ]);
  });

  it("keeps an unknown currency when the format has no Currency column and no account", () => {
    const p = profile("Header Rows = 0\nInput Columns = Date,Payee,Inflow\nDate Format = %Y-%m-%d");
    const rows = parseWithProfile(encode("2026-11-13,A,-5.00"), p, { currency: "" }).rows;
    expect(rows[0]?.currency).toBe("");
  });

  it("refuses an unsupported format", () => {
    const p = PROFILES.find((x) => x.name === "SG UOB Credit Card")!;
    expect(() => read(p, "x")).toThrow(/not supported/);
  });
});

describe("decodeText", () => {
  it("falls back to Windows-1252 when the bytes are not UTF-8", () => {
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
    expect(decodeText(encode("Café"))).toBe("Café");
  });
});
