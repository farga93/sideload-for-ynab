import { formatAmount } from "./money";

/** EUR→CHF rates by ISO date, only for the business days published by the ECB. */
export type RateTable = Record<string, number>;

const FRANKFURTER = "https://api.frankfurter.dev/v1";

/**
 * Fetches the ECB EUR→CHF rates covering [from, to]. The request starts 7 days before
 * `from` so that spending on a weekend or holiday finds the last published rate.
 * Pass today as `to`: later rates prove that a missing weekday was a holiday.
 */
export async function fetchEurChfRates(
  from: string,
  to: string,
  fetchFn: typeof fetch = fetch,
): Promise<RateTable> {
  const start = shiftDate(from, -7);
  const res = await fetchFn(`${FRANKFURTER}/${start}..${to}?base=EUR&symbols=CHF`);
  if (!res.ok) throw new Error(`ECB rates unavailable (HTTP ${res.status})`);
  const body = (await res.json()) as { rates: Record<string, { CHF: number }> };
  const table: RateTable = {};
  for (const [date, rates] of Object.entries(body.rates)) table[date] = rates.CHF;
  return table;
}

/**
 * Rate of the day, or of the previous business day (up to 7 days back).
 *
 * The CHF amount, and therefore the import_id, depends on the rate, so the rate must
 * never change between two imports of the same row. A fallback is only used when it is
 * final: on a weekend (the Friday fixing), or when a later fixing proves the day was a
 * holiday. Otherwise the day's fixing is probably not published yet (the ECB publishes
 * around 16:00 CET) and the row must be imported later.
 */
export function rateFor(table: RateTable, date: string): { date: string; rate: number } {
  const exact = table[date];
  if (exact !== undefined) return { date, rate: exact };
  for (let back = 1; back <= 7; back++) {
    const day = shiftDate(date, -back);
    const rate = table[day];
    if (rate === undefined) continue;
    if (!isFinalFallback(table, date, day)) {
      throw new Error(`ECB rate for ${date} not published yet: import this row again later`);
    }
    return { date: day, rate };
  }
  throw new Error(`No EUR→CHF rate available for ${date}`);
}

function isFinalFallback(table: RateTable, date: string, fallback: string): boolean {
  if (Object.keys(table).some((d) => d > date)) return true;
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (weekday === 6) return fallback === shiftDate(date, -1);
  if (weekday === 0) return fallback === shiftDate(date, -2);
  return false;
}

/**
 * Converts EUR milliunits to CHF milliunits, rounded to the centime (half away from zero,
 * so a purchase and its refund convert to opposite amounts).
 * The returned note records the original amount, e.g. "12.50 EUR @ 0.9312".
 */
export function convertEurToChf(
  eurMilli: number,
  table: RateTable,
  date: string,
): { amount: number; note: string } {
  const { rate } = rateFor(table, date);
  const amount = Math.sign(eurMilli) * Math.round(Math.abs(eurMilli * rate) / 10) * 10;
  return { amount: amount === 0 ? 0 : amount, note: `${formatAmount(Math.abs(eurMilli))} EUR @ ${rate.toFixed(4)}` };
}

/** Today's date in the browser's time zone, as ISO YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
