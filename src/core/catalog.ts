import { compileDateFormat } from "./dates";
import { iniGet, parseIni, type IniFile, type IniSection } from "./ini";
import type { AccountKey } from "./types";

/** Formats with a coded parser instead of a column description (`Sideload Parser` key). */
const PARSERS = new Set(["bcv"]);
const ACCOUNTS = new Set<AccountKey>(["yuh", "bcv"]);

/** Row filter from the `Skip Rows Where` extension key: all conditions must match. */
export interface SkipRule {
  conditions: { column: string; pattern: RegExp }[];
  reason: string;
}

/** A bank export format, read from bank2ynab.conf or from Sideload's local catalog. */
export interface BankProfile {
  /** Section name, e.g. "CH UBS Checking account". */
  name: string;
  origin: "bank2ynab" | "local";
  /** Why this engine cannot read the format (e.g. it needs a bank2ynab Python plugin). */
  unsupported?: string;
  filenamePattern: string;
  useRegex: boolean;
  extension: string;
  delimiter: string;
  headerRows: number;
  footerRows: number;
  columns: string[];
  dateFormat: string;
  /** "Date De-Duplication": an empty date takes the previous row's date. */
  fillEmptyDates: boolean;
  /** From "Inflow or Outflow Indicator": rows whose CDFlag equals it are outflows. */
  outflowFlag?: string;
  /** "Currency Conversion Factor": amounts are divided by it. */
  conversionFactor: number;
  encoding: string;
  // Sideload extensions, only in catalog/local.conf.
  parser?: "bcv";
  account?: AccountKey;
  /** Recognizes the file from its first line, whatever its name. */
  detectHeader?: RegExp;
  /** Roles whose repeated columns take the first non-empty cell instead of being joined. */
  firstNonEmpty: string[];
  skipRules: SkipRule[];
}

/**
 * Builds the profile list from bank2ynab.conf and Sideload's local.conf (same format plus
 * extension keys). A local section replaces a bank2ynab section of the same name.
 */
export function buildProfiles(bank2ynabConf: string, localConf: string): BankProfile[] {
  const byName = new Map<string, BankProfile>();
  const add = (file: IniFile, origin: BankProfile["origin"]) => {
    for (const [name, section] of file.sections) {
      // "[<bank> payee_mappings]" sections rename payees; Sideload keeps the bank's text.
      if (/ payee_mappings$/.test(name)) continue;
      byName.set(name, toProfile(file, name, section, origin));
    }
  };
  const upstream = parseIni(bank2ynabConf);
  add(upstream, "bank2ynab");
  // Local sections inherit bank2ynab's [DEFAULT] values.
  const local = parseIni(localConf);
  add({ defaults: upstream.defaults, sections: local.sections }, "local");
  return [...byName.values()];
}

function toProfile(file: IniFile, name: string, section: IniSection, origin: BankProfile["origin"]): BankProfile {
  const get = (key: string) => iniGet(file, section, key) ?? "";
  const problems: string[] = [];
  const int = (key: string) => {
    const n = Number(get(key) || "0");
    if (!Number.isInteger(n) || n < 0) problems.push(`invalid "${key}"`);
    return n;
  };

  const columns = get("Input Columns").split(",").map((c) => c.trim());
  const flags = get("Inflow or Outflow Indicator").split(",").map((f) => f.trim());
  const factor = Number(get("Currency Conversion Factor") || "1");
  const parser = get("Sideload Parser") || undefined;
  const account = (get("Sideload Account") || undefined) as AccountKey | undefined;
  const profile: BankProfile = {
    name,
    origin,
    filenamePattern: get("Source Filename Pattern"),
    useRegex: get("Use Regex For Filename").toLowerCase() === "true",
    extension: get("Source Filename Extension"),
    delimiter: get("Source CSV Delimiter") === "\\t" ? "\t" : get("Source CSV Delimiter") || ",",
    headerRows: int("Header Rows"),
    footerRows: int("Footer Rows"),
    columns,
    dateFormat: get("Date Format"),
    fillEmptyDates: get("Date De-Duplication").toLowerCase() === "true",
    outflowFlag: flags.length === 3 ? flags[2] : undefined,
    conversionFactor: factor,
    encoding: get("Encoding"),
    parser: parser as BankProfile["parser"],
    account,
    firstNonEmpty: get("Sideload First Non-Empty")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
    skipRules: [],
  };

  const plugin = get("Plugin");
  if (plugin) problems.push(`needs the bank2ynab plugin "${plugin}"`);
  if (parser && !PARSERS.has(parser)) problems.push(`unknown parser "${parser}"`);
  if (account && !ACCOUNTS.has(account)) problems.push(`unknown account "${account}"`);
  if (!Number.isFinite(factor) || factor <= 0) problems.push('invalid "Currency Conversion Factor"');
  if (!parser) {
    if (!columns.includes("Date")) problems.push("no Date column");
    if (!columns.includes("Inflow") && !columns.includes("Outflow")) problems.push("no Inflow or Outflow column");
    if (profile.outflowFlag !== undefined && !columns.includes("CDFlag")) problems.push("indicator without a CDFlag column");
    try {
      // Without a format, the engine infers it from the file (see inferDateFormat).
      if (profile.dateFormat) compileDateFormat(profile.dateFormat);
    } catch (e) {
      problems.push(`date format "${profile.dateFormat}": ${(e as Error).message.toLowerCase()}`);
    }
  }
  try {
    filenameMatcher(profile);
  } catch {
    problems.push("filename pattern is not a valid regular expression here");
  }
  try {
    const detect = get("Sideload Detect Header");
    if (detect) profile.detectHeader = new RegExp(detect);
    profile.skipRules = parseSkipRules(get("Skip Rows Where"));
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (problems.length) profile.unsupported = problems.join("; ");
  return profile;
}

/**
 * `Skip Rows Where` (one rule per line): `<header> ~ <regex> [& <header> ~ <regex>] => <reason>`.
 * Headers are names from the file's last header row. Example:
 * `DEBIT ~ \S & CREDIT ~ \S => Currency exchange`.
 */
export function parseSkipRules(value: string): SkipRule[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [conditionText, reason] = line.split(/\s+=>\s+/);
      if (!conditionText || !reason) throw new Error(`invalid skip rule "${line}"`);
      const conditions = conditionText.split(/\s+&\s+/).map((part) => {
        const m = /^(.+?)\s+~\s+(.+)$/.exec(part.trim());
        if (!m) throw new Error(`invalid skip rule "${line}"`);
        return { column: m[1]!, pattern: new RegExp(m[2]!) };
      });
      return { conditions, reason: reason.trim() };
    });
}

/**
 * Same test as bank2ynab's `get_files`: the name ends with the extension (case-sensitive)
 * and starts with the pattern, or, with "Use Regex For Filename", matches
 * `pattern + ".*\."` from its first character. Files written by bank2ynab ("fixed_" prefix)
 * are excluded.
 */
export function filenameMatcher(profile: BankProfile): (filename: string) => boolean {
  const regex = profile.useRegex
    ? new RegExp(`${profile.filenamePattern.replace(/\(\?P</g, "(?<")}.*\\.`, "y")
    : undefined;
  return (filename) => {
    if (!filename.endsWith(profile.extension) || filename.includes("fixed_")) return false;
    if (!regex) return filename.startsWith(profile.filenamePattern);
    regex.lastIndex = 0;
    return regex.test(filename);
  };
}

/** Profiles matching a file name, supported ones first. */
export function profilesForFilename(profiles: BankProfile[], filename: string): BankProfile[] {
  return profiles
    .filter((p) => {
      try {
        return filenameMatcher(p)(filename);
      } catch {
        return false; // pattern not valid in JavaScript: the profile is already marked unsupported
      }
    })
    .sort((a, b) => Number(Boolean(a.unsupported)) - Number(Boolean(b.unsupported)));
}
