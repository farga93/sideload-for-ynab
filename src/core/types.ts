/** YNAB accounts fed by the tool. The Worker maps each key to an account_id. */
export type AccountKey = "yuh" | "bcv";

/** Row read from a bank export, before currency conversion. */
export interface ParsedRow {
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** Amount in milliunits of the original currency (spending is negative). */
  amount: number;
  currency: string;
  payee: string;
  memo?: string;
}

/** Row left out by a parser, shown on screen with the reason. */
export interface SkippedRow {
  line: number;
  reason: string;
  raw: string;
}

export interface ParseResult {
  account: AccountKey;
  rows: ParsedRow[];
  skipped: SkippedRow[];
}

/** Transaction ready for YNAB: amount in CHF milliunits. */
export interface Transaction {
  date: string;
  amount: number;
  payee_name: string;
  memo?: string;
  import_id: string;
}

/** Maximum transactions per POST /api/import; the page splits larger imports. */
export const MAX_BATCH = 500;

/** Body of POST /api/import, shared by the web page and the Worker. */
export interface ImportRequest {
  account: AccountKey;
  transactions: Transaction[];
}

export interface ImportResponse {
  created: number;
  duplicates: number;
}
