# Sideload for YNAB

Import bank exports into [YNAB](https://www.ynab.com) from your phone or computer, for banks that YNAB cannot connect to. On Android, you share the export from your banking app to Sideload, check the list, and send it to YNAB through its API.

YNAB's own file import only works in the web app and on iPad, and converting files by hand (cleaning them up, running a CSV converter, converting foreign-currency spending) is tedious. Sideload replaces those steps: the file is read in the browser, foreign currencies are converted at the ECB rate of the day, and the transactions arrive in YNAB ready to approve.

Supported today: **Yuh** (CSV) and **BCV** (Banque Cantonale Vaudoise, xlsx). Support for many more banks, based on the [bank2ynab](https://github.com/bank2ynab/bank2ynab) format catalog, is in progress.

Sideload for YNAB is an independent project. It is not affiliated with, sponsored or endorsed by YNAB.

## Features

- **Yuh**: reads the CSV export from the Yuh app (Account → Documents) as is.
- **BCV**: reads the "Liste des opérations" xlsx export from BCV e-banking.
- **EUR → CHF**: converts EUR transactions at the official ECB rate of the transaction day, or of the previous business day for weekends and holidays. The original amount stays in the memo, e.g. `12.50 EUR @ 0.9312`, so a single-currency CHF budget keeps a correct balance.
- **No duplicates**: each transaction gets an `import_id` in YNAB's own format. Re-importing a file, or exports with overlapping dates, does not create duplicates.
- **Review first**: the app shows every transaction before sending, and lists every row it leaves out (currency exchanges, securities trades, unsupported currencies) with the reason.
- **Review in YNAB**: transactions arrive unapproved and without a category. YNAB's own payee matching suggests the categories.
- **Android share target**: once installed as a PWA, the app appears in the Android share menu.

## How it works

```
Phone or PC (browser)                           Cloudflare Worker            YNAB API
┌──────────────────────────────────┐           ┌──────────────────┐
│ bank file → detect bank → parse  │  JSON     │ POST /api/import │  POST
│ → EUR→CHF (ECB rates) → review   │ ────────► │ check secret     │ ──────► transactions
│ → send                           │           │ validate batch   │
└──────────────────────────────────┘           │ add YNAB token   │
                                               └──────────────────┘
```

A single Cloudflare Workers deployment serves both the static web app and a small API endpoint.

- **The bank file stays on your device.** Parsing and currency conversion run in the browser. Only the normalized list of transactions is sent. One exception: if you share a file to the app while its service worker is not active (the very first share right after installing, or after the browser cleared the site's storage), Android uploads the file to the Worker, which discards it unread and asks you to pick it again. The app asks the browser for persistent storage to make this rare.
- **The YNAB token never reaches the browser.** It is a Cloudflare secret. The page authenticates to the Worker with a separate app secret.
- **The Worker is deliberately narrow.** It can only create transactions in the two configured accounts. It never reads from YNAB, and it does not log or store request content.
- **Exchange rates** come from the public [Frankfurter](https://frankfurter.dev) API (ECB reference rates). Only dates are sent.

Cloudflare is a trusted third party in this design: the normalized transactions pass through the Worker. If that is not acceptable for you, this project is not a good fit as is.

## Setup

You need a YNAB account, a free Cloudflare account and Node.js 22 (`.nvmrc` is provided for [nvm](https://github.com/nvm-sh/nvm)).

1. **Install dependencies**

   ```sh
   nvm use
   npm install
   ```

2. **Collect the YNAB IDs.** Create a personal access token in YNAB under *Account settings → Developer settings*. Open each target account in the YNAB web app: the URL looks like `https://app.ynab.com/<plan_id>/accounts/<account_id>`.

3. **Configure the Worker.** Put the plan and account IDs in the `vars` section of `wrangler.jsonc` (`YNAB_PLAN_ID`, `YNAB_ACCOUNT_YUH`, `YNAB_ACCOUNT_BCV`), and the URL of the public repository of the code you deploy in `SOURCE_URL` (see [License](#license)). Then set the two secrets; choose a long random string for `APP_SECRET`:

   ```sh
   npx wrangler login
   npx wrangler secret put YNAB_TOKEN
   npx wrangler secret put APP_SECRET
   ```

4. **Deploy**

   ```sh
   npm run deploy
   ```

5. **Open the app** at the URL Wrangler prints, open *Settings* and enter the app secret. On Android, use *Install app* (or *Add to home screen*) in Chrome to enable sharing files to it.

To try it first without touching your real budget, point the IDs at a test plan in YNAB.

## Usage

- **Yuh (Android):** export the CSV from the Yuh app and share it to *Sideload*. Don't open or re-save the CSV first: spreadsheet apps change its structure.
- **BCV (PC):** download "Liste des opérations" as xlsx from e-banking, open the app in a desktop browser, and choose the file.
- Check the list, press *Send to YNAB*, then approve the transactions in YNAB.

## Development

```sh
npm test               # unit tests (Vitest)
npx vitest run test/parsers.test.ts -t "BCV"   # one file / one test
npm run typecheck      # TypeScript: web/core, Worker and tests
npm run dev            # web page only (Vite), no API
npm run worker:dev     # build + local Worker with API on http://127.0.0.1:8787
```

`npm run worker:dev` reads local secrets from `.dev.vars` (git-ignored), for example:

```sh
YNAB_TOKEN="..."
APP_SECRET="local-test-secret"
YNAB_PLAN_ID="..."
YNAB_ACCOUNT_YUH="..."
YNAB_ACCOUNT_BCV="..."
```

### Project layout

| Path | Contents |
| --- | --- |
| `src/core/` | Pure logic, runs in the browser: bank detection, parsers, minimal xlsx reader, amounts in milliunits, ECB rates, `import_id`. |
| `src/worker/` | Cloudflare Worker: app-secret check, batch validation, call to the YNAB API. |
| `src/web/` | The PWA: page, styles, manifest with share target, service worker. |
| `test/` | Unit tests and synthetic fixtures. |

### Test data and privacy

Never commit real bank exports. Fixtures in `test/fixtures/` and `test/helpers/` are synthetic and only reproduce the file structure. You can drop your own exports in `private/` (git-ignored): `test/private.test.ts` then checks that they parse, without printing any amount or label.

## Limitations

- Only CHF and EUR rows are imported. Other currencies are listed as skipped.
- Bank export formats can change without notice; the parsers rely on the current column headers.
- BCV truncates transaction labels to about 22 characters.
- The YNAB API base path is configurable (`YNAB_API_BASE`) because the API is moving from `/budgets` to `/plans`.

## License

Copyright (C) 2026 farga

This program is free software: you can redistribute it and/or modify it under the terms of the [GNU Affero General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

In short: if you distribute this tool, or run a modified version of it as a service for other people, you must share your source code under the same license. The app's *Source code* link (`/source`, configured by `SOURCE_URL` in `wrangler.jsonc`) is there for that purpose: point it to your own repository if you deploy a modified version.
