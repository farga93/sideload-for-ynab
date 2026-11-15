import { strFromU8, unzipSync } from "fflate";

export interface SheetRow {
  /** Excel row number (1-based). */
  row: number;
  /** Cell values as text, indexed by column (A = 0); "" for an empty cell. */
  cells: string[];
}

/**
 * Reads the first sheet of an xlsx workbook as plain text. Deliberately minimal:
 * it covers bank-generated files (shared strings, numbers, inline strings),
 * not formulas or dates stored as Excel serial numbers.
 */
export function readFirstSheet(data: Uint8Array): SheetRow[] {
  const files = unzipSync(data, { filter: (f) => f.name.startsWith("xl/") });
  const read = (path: string) => {
    const file = files[path];
    if (!file) throw new Error(`Incomplete xlsx file: ${path} missing`);
    return strFromU8(file);
  };

  const sheetPath = firstSheetPath(read("xl/workbook.xml"), read("xl/_rels/workbook.xml.rels"));
  const shared = files["xl/sharedStrings.xml"] ? sharedStrings(strFromU8(files["xl/sharedStrings.xml"])) : [];

  const rows: SheetRow[] = [];
  for (const rowMatch of read(sheetPath).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rowMatch[1]!, "r"));
    const cells: string[] = [];
    for (const cellMatch of (rowMatch[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1]!;
      const ref = attr(attrs, "r");
      const col = ref ? columnIndex(ref) : cells.length;
      while (cells.length < col) cells.push("");
      cells[col] = cellValue(attr(attrs, "t"), cellMatch[2] ?? "", shared);
    }
    rows.push({ row: rowNumber || rows.length + 1, cells });
  }
  return rows;
}

function firstSheetPath(workbook: string, rels: string): string {
  const sheet = /<sheet\b([^>]*?)\/?>/.exec(workbook);
  const id = sheet && attr(sheet[1]!, "r:id");
  if (!id) throw new Error("No sheet in the workbook");
  for (const rel of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    if (attr(rel[1]!, "Id") === id) {
      const target = attr(rel[1]!, "Target")!;
      return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    }
  }
  throw new Error("Sheet not found in the workbook");
}

/** Shared-string table. A self-closing <si/> is an empty entry and keeps its index. */
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => textRuns(m[1] ?? ""));
}

/** Concatenates <t> elements (plain or rich text), skipping phonetic annotations and empty <t/>. */
function textRuns(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  return [...withoutPhonetic.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)]
    .map((m) => decodeXml(m[1] ?? ""))
    .join("");
}

function cellValue(type: string | undefined, inner: string, shared: string[]): string {
  if (type === "inlineStr") return textRuns(inner);
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (v === undefined) return "";
  if (type === "s") return shared[Number(v)] ?? "";
  return decodeXml(v);
}

function columnIndex(ref: string): number {
  let index = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? "A") index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function attr(attrs: string, name: string): string | undefined {
  const escaped = name.replace(":", "\\:");
  return new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`).exec(attrs)?.[1];
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[entity]!;
  });
}
