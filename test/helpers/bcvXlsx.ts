import { strToU8, zipSync } from "fflate";

/**
 * Builds in memory an xlsx that mirrors the structure of the BCV "Liste des opérations"
 * export: account info block at the top, column header on row 9, shared strings, dates as
 * text, amounts as numeric cells, empty cells as the shared string "".
 * Callers pass fictitious data: no real export is committed.
 */
export function buildBcvXlsx(
  ops: { date: string; label: string; debit?: string; credit?: string }[],
): Uint8Array {
  const strings: string[] = [];
  const s = (text: string) => {
    let i = strings.indexOf(text);
    if (i === -1) i = strings.push(text) - 1;
    return i;
  };
  const str = (ref: string, text: string) => `<c r="${ref}" t="s"><v>${s(text)}</v></c>`;
  const num = (ref: string, value: string) => `<c r="${ref}" t="n"><v>${value}</v></c>`;

  const rows = [
    `<row r="1">${str("A1", "Liste des opérations")}${num("F1", "46340.89")}</row>`,
    `<row r="3">${str("A3", "N° compte : CH00 0000 0000 0000 0000 0")}</row>`,
    `<row r="4">${str("A4", "Titulaire : FICTITIOUS HOLDER")}</row>`,
    `<row r="9">${["Date d'exécution", "Opérations", "Débit", "Crédit", "Date valeur", "Solde"]
      .map((h, i) => str(`${"ABCDEF"[i]}9`, h))
      .join("")}</row>`,
    ...ops.map((op, i) => {
      const r = 10 + i;
      return `<row r="${r}">${str(`A${r}`, op.date)}${str(`B${r}`, op.label)}${
        op.debit ? num(`C${r}`, op.debit) : str(`C${r}`, "")
      }${op.credit ? num(`D${r}`, op.credit) : str(`D${r}`, "")}${str(`E${r}`, op.date)}${num(`F${r}`, "1000.0")}</row>`;
    }),
  ];

  const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return buildXlsx(rows.join(""), strings.map((t) => `<si><t>${escape(t)}</t></si>`).join(""));
}

/** Minimal one-sheet xlsx from raw <sheetData> rows and raw <si> shared-string entries. */
export function buildXlsx(sheetRows: string, sharedEntries: string): Uint8Array {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" r:id="rId3" sheetId="1"/></sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="sharedStrings.xml" Type="x"/><Relationship Id="rId3" Target="worksheets/sheet1.xml" Type="y"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData>${sheetRows}</sheetData></worksheet>`,
    ),
    "xl/sharedStrings.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><sst ${ns}>${sharedEntries}</sst>`),
  });
}
