# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Everything in the repository is in English: code comments, docs, `.md` files, test names, UI text and error messages. Exception: bank-specific labels the parsers must match (BCV headers such as "Date d'exécution", Yuh's "Twint à" / "Transfert à").

## License

AGPL-3.0-or-later (`LICENSE`, `package.json`), chosen so that anyone reusing the tool, including as a hosted service, must share their code. Keep the app's "Source code" footer link (`/source` → `SOURCE_URL` var) working. New dependencies must be AGPL-compatible (MIT, BSD, Apache-2.0, LGPL, GPL-3.0 are fine).

## Personal data

Bank exports contain personal data and must never be committed.
- Put real exports in `private/` (git-ignored). Never copy them into `test/` or quote their content in code, tests, commit messages or docs.
- Fixtures are synthetic: `test/fixtures/yuh.csv`, and `test/helpers/bcvXlsx.ts`, which builds a BCV-shaped xlsx in memory.
- `test/private.test.ts` runs only when `private/` has files, and asserts on shape only so no real value is printed.
- `.dev.vars` (local Worker secrets) and `CLAUDE.local.md` (personal instructions) are git-ignored.

## Commands

Node 22 via nvm (`.nvmrc`). In non-interactive shells run `. ~/.nvm/nvm.sh && nvm use 22` first.

- `npm test`: Vitest. Single file: `npx vitest run test/parsers.test.ts`; single test: add `-t "<name>"`.
- `npm run typecheck`: three `tsc` passes: browser/core (`tsconfig.json`), Worker (`src/worker/tsconfig.json`, Cloudflare types), tests (`test/tsconfig.json`, Node types).
- `npm run dev`: Vite dev server for the page only (no `/api`).
- `npm run worker:dev`: build, then `wrangler dev` on :8787 (page + API), secrets from `.dev.vars`.
- `npm run deploy`: build, then `wrangler deploy`. Secrets: `npx wrangler secret put YNAB_TOKEN` and `APP_SECRET`; plan and account IDs and `SOURCE_URL` are `vars` in `wrangler.jsonc`.

## Purpose

Project name: **Sideload for YNAB** (repo and Worker `sideload-for-ynab`). YNAB's API terms only allow "YNAB" in an app name or web address when preceded by "for". Positioning: import exports of banks without API access into YNAB from phone and PC; bank format descriptions come from the bank2ynab catalog (generalization in progress), Sideload adds the mobile/browser UI, currency conversion and formats bank2ynab cannot describe.

Started as an importer for Yuh (CSV from the Android app) and BCV (xlsx "Liste des opérations" from web e-banking; camt.053 can also be enabled in BCV-net, evaluation pending) transactions into a single-currency CHF YNAB budget, without an always-on machine. YNAB categorizes by payee and the user reviews in YNAB, so transactions are sent with `approved: false` and no category.

## Architecture

One Cloudflare Workers deployment serves the static PWA (Vite build of `src/web/` into `dist/`) and `POST /api/import`.

- **`catalog/`**: `bank2ynab.conf` is a pinned copy of bank2ynab's format catalog (MIT, commit in `source.json`, updated with `npm run catalog:update`; never edit it by hand). `local.conf` holds Sideload's own formats in the same INI format plus extension keys (`Currency` column role, `Skip Rows Where`, `Sideload Parser`, `Sideload Account`, `Sideload Detect Header`, `Sideload First Non-Empty`); a local section replaces a bank2ynab one of the same name. Both are bundled with `?raw` imports (`src/core/catalogData.ts`).
- **`src/core/`**: pure logic, runs in the browser. `catalog.ts` turns INI sections (`ini.ts`, Python `RawConfigParser` dialect) into `BankProfile`s, marking those this engine cannot read (`unsupported`: bank2ynab Python plugins, no date or amount column…). `detectProfiles` finds the format from the content (BCV xlsx sheet, `Sideload Detect Header`) then from the file name (bank2ynab's `get_files` rules). `parseExport` runs the BCV coded parser or `profile.ts`, which follows bank2ynab's semantics (header/footer rows, repeated roles merged, inflow/outflow indicator, conversion factor, payee falling back to memo) but keeps the bank's text, parses amounts without floats (`parseBankAmount`, decimal separator inferred per file), infers a missing date format (`inferDateFormat`, refuses day/month ambiguity), lists every unusable row as skipped and returns newest-first files oldest first. Both return `ParsedRow`s in original currency plus `SkippedRow`s with a reason. `prepare` converts EUR rows to CHF at the ECB rate of the day (`fx.ts`, Frankfurter API, weekends and holidays fall back to the previous business day, original amount appended to the memo), sorts by date, then `assignImportIds` builds `YNAB:[milliunits]:[date]:[occurrence]` from the CHF amount.
- **`src/core/xlsx.ts`**: minimal first-sheet reader on top of `fflate` (shared strings, numbers, inline strings). Deliberately no full xlsx library.
- **`src/worker/`**: deliberately narrow. Checks `Authorization: Bearer <APP_SECRET>` (constant-time), strictly validates and re-builds the batch, maps `yuh`/`bcv` to configured account IDs, adds the YNAB token, forwards to `{YNAB_API_BASE}/{YNAB_PLAN_ID}/transactions`. It never reads from YNAB. Logic in `handler.ts` (injectable `fetch`); `index.ts` only routes (`/api/import`, `/share`, `/source`, then static assets).
- **`src/web/`**: `main.ts` drives a single screen (file input → review table → send). The app secret is kept in `localStorage`. Android Web Share Target: `public/manifest.webmanifest` posts the shared file to `/share`, `public/sw.js` stores it in Cache Storage and redirects to `/?shared=1`, where `main.ts` reads and deletes it. If the service worker is not active yet, the Worker answers `/share` with that redirect and drops the file. Security headers (CSP) are in `public/_headers`.

## Bank format details

- **Yuh** (`[CH Yuh]` in `catalog/local.conf`; bank2ynab PR #532 adds the same format without the extensions): UTF-8 with BOM, `;`-separated, dates `DD/MM/YYYY`, text fields wrapped in literal quotes (`"""Example Shop"""`). Debits are already negative, so DEBIT and CREDIT are both `Inflow`. Payee = `RECIPIENT`, else `SENDER` (`Sideload First Non-Empty = Payee`), else the memo. Currency columns pair with DEBIT and CREDIT. Memo = ACTIVITY NAME + LOCALITY. Skip rules: securities rows, rows with both debit and credit (currency exchange); currencies other than CHF/EUR are skipped by `prepare`.
- **BCV** (`[CH BCV]`, `Sideload Parser = bcv`, coded in `src/core/parsers/bcv.ts`): header row "Date d'exécution / Opérations / Débit / Crédit / Date valeur / Solde" after an account info block; newest first (reversed by the parser); dates as text `DD.MM.YYYY`; amounts are positive numeric cells, sometimes with float artifacts (rounded to the centime). Labels are truncated by the bank to ~22 chars. A `PMT <METHOD> ` prefix is stripped from the payee and mapped to the memo (`Twint`, `Card`, `E-commerce`; unknown codes kept as is).

## Invariants

- **Confidentiality**: the raw bank file stays on the device; only the normalized batch reaches the Worker. Known exception, documented in the README: an Android share while no service worker is active uploads the file to `/share`, where the Worker discards it unread (the page requests persistent storage to make this rare). The Worker must not log or store request bodies (`observability` disabled; no KV/D1).
- **Stable `import_id`s**: re-importing the same row must always give the same ID, or YNAB creates a duplicate. Hence:
  - `prepare` assigns import_ids to all rows *before* any can be skipped (e.g. "rate not published yet"), so a skipped row does not shift the others' occurrences on the next import;
  - EUR rows use their own namespace and original amount (`EUR:-12500:2026-11-07:1`), so they never collide with CHF rows and do not depend on the rate;
  - rows are numbered oldest first (the BCV parser and the profile engine reverse newest-first exports), so a newer same-day, same-amount operation gets the next occurrence instead of shifting existing ones;
  - the CHF amount must not change between imports: `rateFor` only falls back to an earlier fixing when it is final (weekend → Friday, or a later fixing proves a holiday). Otherwise the row is skipped as "not published yet". The page fetches rates up to today for that reason.
- **Amounts** are integer milliunits, parsed from text without floats by `parseBankAmount` (`money.ts`): at most 2 decimals; the decimal separator is inferred over the whole file (`inferDecimalSeparator`), so "1,234" is 1234 in a file whose decimals use "." and rejected as ambiguous when the file gives no evidence. Only FX conversion, the conversion factor and xlsx numeric cells go through a float, rounded to the centime half away from zero.
- **Currency**: rows without a Currency column are in the account's currency. Formats not linked to an account keep currency "" (`Prepared.unknownCurrency`): shown as the file's currency and never sent. Step 3 (configurable accounts) must take the currency from the chosen account.
- **No row disappears silently**: every unimported row is listed on the review screen with its reason. If the ECB rates cannot be fetched, only the EUR rows are skipped.
- **YNAB limits**: payee ≤ 200, memo ≤ 500 UTF-16 units; `prepare` truncates (keeping the FX note) and the Worker rejects anything longer.
- **Batch limit**: `MAX_BATCH` (500, `src/core/types.ts`) is enforced by the Worker; the page sends larger imports in several requests.
- `POST .../transactions/import` only triggers linked-account sync; it does not upload a file.

## Open points

- First real import: confirm the `/v1/plans` path (else set `YNAB_API_BASE` to `/v1/budgets`) and that YNAB auto-categorizes API-created transactions by payee.
- Android share sheet: confirm the MIME type the Yuh app uses for its CSV matches `share_target.accept`.
- Frankfurter advertises a v2 API; v1 still works.
