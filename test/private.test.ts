import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROFILES } from "../src/core/catalogData";
import { detectProfiles, parseExport } from "../src/core/pipeline";

/**
 * Regression check on real exports placed in private/ (git-ignored).
 * Skipped automatically when there are no files, e.g. on a public clone.
 * Assertions only check the shape: no real amount or label appears in test output.
 */
const dir = new URL("../private/", import.meta.url);
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(csv|xlsx)$/i.test(f)) : [];

describe.skipIf(files.length === 0)("real exports (private/)", () => {
  it.each(files.map((f, i) => [`file ${i + 1}`, f] as const))("%s parses without unreadable rows", (_, file) => {
    const bytes = new Uint8Array(readFileSync(new URL(file, dir)));
    const profile = detectProfiles(PROFILES, file, bytes)[0]?.profile;
    expect(profile?.unsupported).toBeUndefined();
    const result = parseExport(bytes, profile!);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isSafeInteger(row.amount) && row.amount !== 0 && row.amount % 10 === 0).toBe(true);
      expect(row.payee.length).toBeGreaterThan(0);
    }
    expect(result.skipped.filter((s) => /unreadable|missing/i.test(s.reason))).toHaveLength(0);
  });
});
