export interface CsvRecord {
  /** Physical line (1-based) where the record starts in the file. */
  line: number;
  fields: string[];
}

/**
 * Splits CSV text into records of fields (doubled quotes, configurable delimiter,
 * line breaks inside quoted fields). A leading UTF-8 BOM is removed. Each record keeps
 * the line it starts on, so a multi-line record does not shift later line numbers.
 */
export function parseCsv(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  const s = text.startsWith("\ufeff") ? text.slice(1) : text;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && s[i + 1] !== "\n")) line++;
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      fields.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      fields.push(field);
      records.push({ line: start, fields });
      fields = [];
      field = "";
      line++;
      start = line;
    } else {
      field += ch;
    }
  }
  if (field !== "" || fields.length > 0) {
    fields.push(field);
    records.push({ line: start, fields });
  }
  return records;
}
