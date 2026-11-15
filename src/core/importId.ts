/**
 * Computes import_ids in the format YNAB uses for file imports:
 * `YNAB:[milliunits]:[ISO date]:[occurrence]`, where occurrence numbers (from 1)
 * the transactions sharing the same prefix, amount and date within the batch.
 *
 * `prefixOf` defaults to "YNAB". Rows converted from another currency use that currency
 * code instead (`EUR:-12500:2026-11-07:1`, original amount): their converted amount
 * depends on the exchange rate, their original amount never changes.
 *
 * The result depends on row order: re-importing the same file yields the same IDs,
 * which lets YNAB drop the duplicates.
 */
export function assignImportIds<T extends { date: string; amount: number }>(
  items: T[],
  prefixOf: (item: T) => string = () => "YNAB",
): (T & { import_id: string })[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const key = `${prefixOf(item)}:${item.amount}:${item.date}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return { ...item, import_id: `${key}:${occurrence}` };
  });
}
