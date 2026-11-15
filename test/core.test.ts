import { describe, expect, it, vi } from "vitest";
import { formatAmount, parseAmount } from "../src/core/money";
import { assignImportIds } from "../src/core/importId";
import { convertEurToChf, fetchEurChfRates, rateFor } from "../src/core/fx";

describe("parseAmount", () => {
  it.each([
    ["-12.50", -12500],
    ["12,5", 12500],
    ["1'234.50", 1234500],
    ["1 234,50", 1234500],
    ["+3", 3000],
    ["−7.05", -7050],
    ["0.00", 0],
    ["-0.00", 0],
  ])("%s → %d", (text, expected) => {
    expect(parseAmount(text)).toBe(expected);
  });

  it.each(["", "abc", "12.5.3", "1.2345", "--3", "1,234", "-2.500"])("rejects \"%s\"", (text) => {
    expect(() => parseAmount(text)).toThrow(/Unreadable/);
  });
});

describe("formatAmount", () => {
  it("formats milliunits as decimal text", () => {
    expect(formatAmount(-12500)).toBe("-12.50");
    expect(formatAmount(1234560)).toBe("1234.56");
    expect(formatAmount(50)).toBe("0.05");
  });
});

describe("assignImportIds", () => {
  it("numbers duplicates with the same amount and date", () => {
    const ids = assignImportIds([
      { date: "2026-11-02", amount: -4500 },
      { date: "2026-11-02", amount: -4500 },
      { date: "2026-11-03", amount: -4500 },
      { date: "2026-11-02", amount: -12000 },
    ]).map((t) => t.import_id);
    expect(ids).toEqual([
      "YNAB:-4500:2026-11-02:1",
      "YNAB:-4500:2026-11-02:2",
      "YNAB:-4500:2026-11-03:1",
      "YNAB:-12000:2026-11-02:1",
    ]);
  });

  it("gives a re-imported file the same IDs", () => {
    const rows = [
      { date: "2026-11-02", amount: -4500 },
      { date: "2026-11-02", amount: -4500 },
    ];
    expect(assignImportIds(rows)).toEqual(assignImportIds(rows));
  });
});

describe("EUR → CHF conversion", () => {
  // 2026-11-06 is a Friday; the 7th and 8th are the weekend.
  const table = { "2026-11-05": 0.93, "2026-11-06": 0.9312 };

  it("uses the rate of the day", () => {
    expect(rateFor(table, "2026-11-06")).toEqual({ date: "2026-11-06", rate: 0.9312 });
  });

  it("falls back to the last business day on a weekend", () => {
    expect(rateFor(table, "2026-11-08").date).toBe("2026-11-06");
  });

  it("fails without a rate within 7 days", () => {
    expect(() => rateFor(table, "2026-11-20")).toThrow(/No EUR→CHF rate/);
  });

  it("refuses a fallback while the day's rate may not be published yet", () => {
    // Friday the 13th without its own rate and no later rate: probably not published yet.
    expect(() => rateFor({ "2026-11-12": 0.93 }, "2026-11-13")).toThrow(/not published yet/);
    // A later rate proves the 13th was a holiday: Thursday's rate is final.
    expect(rateFor({ "2026-11-12": 0.93, "2026-11-16": 0.94 }, "2026-11-13").date).toBe("2026-11-12");
    // Saturday falls back to Thursday only because Friday's rate is missing: not final.
    expect(() => rateFor({ "2026-11-12": 0.93 }, "2026-11-14")).toThrow(/not published yet/);
  });

  it("rounds half-centimes away from zero, symmetrically for refunds", () => {
    // 10.00 EUR × 0.9375 = 9.375 CHF
    const table = { "2026-11-06": 0.9375 };
    expect(convertEurToChf(-10000, table, "2026-11-06").amount).toBe(-9380);
    expect(convertEurToChf(10000, table, "2026-11-06").amount).toBe(9380);
  });

  it("rounds to the centime and keeps the original amount in the memo", () => {
    // -12.50 EUR × 0.9312 = -11.64 CHF
    expect(convertEurToChf(-12500, table, "2026-11-07")).toEqual({
      amount: -11640,
      note: "12.50 EUR @ 0.9312",
    });
  });

  it("queries Frankfurter with a 7-day margin", async () => {
    const fetchFn = vi.fn(async () =>
      Response.json({ rates: { "2026-11-06": { CHF: 0.9312 } } }),
    );
    const rates = await fetchEurChfRates("2026-11-08", "2026-11-14", fetchFn as typeof fetch);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.frankfurter.dev/v1/2026-11-01..2026-11-14?base=EUR&symbols=CHF",
    );
    expect(rates).toEqual({ "2026-11-06": 0.9312 });
  });
});
