export type DecimalSeparator = "." | ",";

/**
 * Decimal separator of a file's amount column, from the cells whose last separator is
 * followed by 1 or 2 digits ("12.50", "1.234,5"). Undefined when no cell tells.
 */
export function inferDecimalSeparator(cells: Iterable<string>): DecimalSeparator | undefined {
  let dot = 0;
  let comma = 0;
  for (const cell of cells) {
    const m = /([.,])\d{1,2}\D*$/.exec(cell.trim());
    if (m?.[1] === ".") dot++;
    else if (m?.[1] === ",") comma++;
  }
  if (dot === comma) return undefined;
  return dot > comma ? "." : ",";
}

/**
 * Converts an amount written by any bank to integer milliunits, without a float.
 * Accepts thousands separators (`'`, spaces, and "." or "," opposite to `decimal`),
 * a currency code or symbol around the number, a leading or trailing minus, and
 * accounting parentheses: "1'234.50", "1.234,50 €", "CHF -12.50", "12.50-", "(12.50)".
 * Empty text gives 0.
 *
 * A separator followed by exactly 3 digits ("1,234") is only read as a thousands
 * separator when `decimal` (inferred from the whole file) is the other one; otherwise
 * the amount is ambiguous and rejected rather than misread.
 */
export function parseBankAmount(text: string, decimal?: DecimalSeparator): number {
  let s = text.trim().replace(/[−–]/g, "-");
  if (s === "") return 0;
  let sign = 1;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    sign = -1;
    s = paren[1]!;
  }
  s = s.replace(/^[A-Za-z]{3}\s*|\s*[A-Za-z]{3}$|[€$£]/g, "").replace(/['’\s  ]/g, "");
  if (s.startsWith("-") || s.endsWith("-")) {
    sign = -sign;
    s = s.startsWith("-") ? s.slice(1) : s.slice(0, -1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  if (!/^\d[\d.,]*$/.test(s)) throw new Error(`Unreadable amount: "${text}"`);

  const last = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let whole = s;
  let fraction = "";
  if (last !== -1) {
    const sep = s[last] as DecimalSeparator;
    const digitsAfter = s.length - last - 1;
    const isDecimal =
      digitsAfter >= 1 && digitsAfter <= 2 ? (decimal === undefined || decimal === sep) : false;
    if (digitsAfter === 3 && decimal === undefined && !s.slice(0, last).includes(sep === "." ? "," : ".")) {
      throw new Error(`Ambiguous amount: "${text}"`);
    }
    if (isDecimal) {
      whole = s.slice(0, last);
      fraction = s.slice(last + 1);
    }
    const group = isDecimal ? (sep === "." ? "," : ".") : undefined;
    // Every remaining separator must be a thousands separator in front of 3 digits.
    const groups = whole.split(/[.,]/);
    const separators = whole.match(/[.,]/g) ?? [];
    const expected = group ?? separators[0];
    if (separators.some((x) => x !== expected || x === decimal)) {
      throw new Error(`Unreadable amount: "${text}"`);
    }
    if (groups.slice(1).some((g) => g.length !== 3) || groups[0] === "") {
      throw new Error(`Unreadable amount: "${text}"`);
    }
    whole = groups.join("");
  }
  const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
  if (!Number.isSafeInteger(milli)) throw new Error(`Unreadable amount: "${text}"`);
  return milli === 0 ? 0 : sign * milli;
}

/** Formats milliunits as a 2-decimal string: -12500 → "-12.50". */
export function formatAmount(milli: number): string {
  const sign = milli < 0 ? "-" : "";
  const abs = Math.abs(milli);
  const cents = Math.round(abs / 10);
  return `${sign}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
