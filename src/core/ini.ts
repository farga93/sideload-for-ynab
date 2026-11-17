/** One `[section]` of an INI file: keys are lower-cased, values trimmed. */
export type IniSection = Map<string, string>;

export interface IniFile {
  /** `[DEFAULT]` values, inherited by every section. */
  defaults: IniSection;
  /** Other sections in file order, with their own values only. */
  sections: Map<string, IniSection>;
}

/**
 * Minimal reader for the INI dialect of Python's `configparser.RawConfigParser`, as used
 * by bank2ynab.conf: `key = value` or `key: value`, keys case-insensitive, full-line
 * comments starting with `#` or `;`, no inline comments, no interpolation, and values
 * continued on indented lines (joined with "\n").
 */
export function parseIni(text: string): IniFile {
  const defaults: IniSection = new Map();
  const sections = new Map<string, IniSection>();
  let current: IniSection | undefined;
  let lastKey: string | undefined;

  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const indented = /^[ \t]/.test(rawLine);
    if (trimmed === "" || (!indented && /^[#;]/.test(trimmed))) {
      if (trimmed === "") lastKey = undefined;
      continue;
    }
    if (indented && current && lastKey !== undefined) {
      const previous = current.get(lastKey) ?? "";
      current.set(lastKey, previous === "" ? trimmed : `${previous}\n${trimmed}`);
      continue;
    }
    const header = /^\[(.+)\]$/.exec(trimmed);
    if (header) {
      const name = header[1]!.trim();
      if (name === "DEFAULT") {
        current = defaults;
      } else {
        current = sections.get(name) ?? new Map();
        sections.set(name, current);
      }
      lastKey = undefined;
      continue;
    }
    const option = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(trimmed);
    if (!option || !current) continue;
    lastKey = option[1]!.toLowerCase();
    current.set(lastKey, option[2]!.trim());
  }
  return { defaults, sections };
}

/** Value of `key` in `section`, falling back to `[DEFAULT]`. */
export function iniGet(file: IniFile, section: IniSection, key: string): string | undefined {
  const k = key.toLowerCase();
  return section.get(k) ?? file.defaults.get(k);
}
