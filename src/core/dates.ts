/**
 * Date parsing with the strftime subset used by bank2ynab.conf ("Date Format" key),
 * following Python's `strptime`: numbers may omit leading zeros, whitespace in the format
 * matches any whitespace, English month names, `%y` 00–68 → 20xx and 69–99 → 19xx.
 */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const TIME_CODES = new Set(["H", "I", "M", "S", "p", "f"]);

interface CompiledFormat {
  regex: RegExp;
  fields: string[];
}

const cache = new Map<string, CompiledFormat>();

/** Builds the matcher for a format, or throws for a directive this parser does not support. */
export function compileDateFormat(format: string): CompiledFormat {
  const cached = cache.get(format);
  if (cached) return cached;
  const fields: string[] = [];
  let source = "";
  for (let i = 0; i < format.length; i++) {
    const ch = format[i]!;
    if (ch === "%") {
      const code = format[++i];
      const pattern = code === undefined ? undefined : DIRECTIVES[code];
      if (pattern === undefined) throw new Error(`Unsupported date directive "%${code ?? ""}"`);
      if (code === "%") {
        source += "%";
      } else {
        source += `(${pattern})`;
        fields.push(code!);
      }
    } else if (/\s/.test(ch)) {
      source += "\\s+";
      while (/\s/.test(format[i + 1] ?? "")) i++;
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
    }
  }
  if (!fields.includes("Y") && !fields.includes("y")) throw new Error("Date format without a year");
  if (!fields.includes("d") || !(fields.includes("m") || fields.includes("b") || fields.includes("B"))) {
    throw new Error("Date format without a day and a month");
  }
  const compiled = { regex: new RegExp(`^${source}$`, "i"), fields };
  cache.set(format, compiled);
  return compiled;
}

const DIRECTIVES: Record<string, string> = {
  d: "\\d{1,2}",
  m: "\\d{1,2}",
  Y: "\\d{4}",
  y: "\\d{2}",
  b: "[A-Za-z]{3}",
  B: "[A-Za-z]{3,9}",
  H: "\\d{1,2}",
  I: "\\d{1,2}",
  M: "\\d{1,2}",
  S: "\\d{1,2}",
  f: "\\d{1,6}",
  p: "AM|PM",
  a: "[A-Za-z]{3}",
  A: "[A-Za-z]{6,9}",
  "%": "%",
};

/**
 * Parses `text` with `format` and returns an ISO date (YYYY-MM-DD), or throws.
 * Like bank2ynab, a date-only format also accepts a value followed by " HH:MM:SS".
 */
export function parseDateWithFormat(text: string, format: string): string {
  const value = text.trim();
  const iso = matchDate(value, format);
  if (iso) return iso;
  const hasTime = compileDateFormat(format).fields.some((f) => TIME_CODES.has(f));
  const withTime = hasTime ? undefined : matchDate(value, `${format} %H:%M:%S`);
  if (withTime) return withTime;
  throw new Error(`Unreadable date: "${text}"`);
}

/** Formats tried, in this order, when a profile has no "Date Format". */
const AUTO_FORMATS = [
  "%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y%m%d",
  "%d.%m.%Y", "%d.%m.%y", "%d/%m/%Y", "%d/%m/%y", "%d-%m-%Y",
  "%m/%d/%Y", "%m/%d/%y", "%m-%d-%Y",
  "%d %b %Y", "%d %b %y", "%d-%b-%Y", "%d-%b-%y", "%b %d %Y",
];

/**
 * Picks the date format of a file whose profile declares none (bank2ynab lets pandas guess):
 * the format that reads the most dates (unreadable values, e.g. a "Total" row, are left to
 * be skipped row by row). When formats tie with different results (day and month could
 * be swapped, e.g. every day ≤ 12), `monthFirst` decides; it is true for US banks.
 */
export function inferDateFormat(values: string[], monthFirst = false): string {
  const dates = values.map((v) => v.trim()).filter(Boolean);
  const tryFormat = (format: string) =>
    dates.map((d) => {
      try {
        return parseDateWithFormat(d, format);
      } catch {
        return undefined;
      }
    });
  const scored = AUTO_FORMATS.map((format) => {
    const results = tryFormat(format);
    return { format, results, count: results.filter(Boolean).length };
  });
  const best = Math.max(...scored.map((s) => s.count));
  if (best === 0) throw new Error("Unreadable dates: no known date format matches");
  const top = scored.filter((s) => s.count === best);
  const same = (a: (string | undefined)[], b: (string | undefined)[]) => a.every((x, i) => x === b[i]);
  if (top.every((s) => same(s.results, top[0]!.results))) return top[0]!.format;
  const isMonthFirst = (format: string) => /^%[mb]/.test(format);
  const preferred = top.filter((s) => isMonthFirst(s.format) === monthFirst);
  if (preferred.length && preferred.every((s) => same(s.results, preferred[0]!.results))) return preferred[0]!.format;
  throw new Error(`Ambiguous dates: they read both as ${top[0]!.format} and as ${top[1]!.format}`);
}

function matchDate(value: string, format: string): string | undefined {
  const { regex, fields } = compileDateFormat(format);
  const m = regex.exec(value);
  if (!m) return undefined;
  let year = NaN;
  let month = NaN;
  let day = NaN;
  fields.forEach((code, i) => {
    const part = m[i + 1]!;
    if (code === "d") day = Number(part);
    else if (code === "m") month = Number(part);
    else if (code === "Y") year = Number(part);
    else if (code === "y") year = Number(part) + (Number(part) <= 68 ? 2000 : 1900);
    else if (code === "b" || code === "B") month = MONTHS.indexOf(part.slice(0, 3).toLowerCase()) + 1;
  });
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= daysInMonth(year, month))) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
