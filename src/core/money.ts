/**
 * Converts a bank-export amount string to integer milliunits without going through
 * a float. Accepts "-12.50", "12,5", "1'234.50", "1 234,50", "+3".
 *
 * Only 1 or 2 decimals are accepted: "1,234" or "2.500" could be a thousands separator,
 * so they are rejected (the row is then listed as skipped) rather than misread.
 */
export function parseAmount(text: string): number {
  let s = text.trim().replace(/['\u2019\s\u00a0\u202f]/g, "");
  let sign = 1;
  if (s.startsWith("-") || s.startsWith("\u2212")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!match) throw new Error(`Unreadable amount: "${text}"`);
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(3, "0"));
  const milli = whole * 1000 + fraction;
  return milli === 0 ? 0 : sign * milli;
}

/** Formats milliunits as a 2-decimal string: -12500 → "-12.50". */
export function formatAmount(milli: number): string {
  const sign = milli < 0 ? "-" : "";
  const abs = Math.abs(milli);
  const cents = Math.round(abs / 10);
  return `${sign}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
