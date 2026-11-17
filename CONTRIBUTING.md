# Contributing

Thanks for helping more banks reach YNAB. The most useful contribution is a bank export format.

## Adding a bank

Sideload reads the bank format catalog of [bank2ynab](https://github.com/bank2ynab/bank2ynab). A format added there helps every bank2ynab user too, so it goes there first.

1. **Delimited text (CSV, TSV, …) that bank2ynab's format can describe**: add a section to [`bank2ynab/data/bank2ynab.conf`](https://github.com/bank2ynab/bank2ynab/blob/develop/bank2ynab/data/bank2ynab.conf) in a pull request to bank2ynab (see their contributing guide). Once it is merged, run `npm run catalog:update` here and open a pull request with the updated catalog.
2. **Anything else**: add a section to [`catalog/local.conf`](catalog/local.conf). It uses the same format, plus extension keys documented at the top of the file:
   - a `Currency` column, for exports with several currencies (converted to the budget's currency at the ECB rate);
   - `Skip Rows Where` rules, for rows that must not become transactions (currency exchanges, securities trades);
   - `Sideload Detect Header`, to recognize the file from its first line;
   - `Sideload First Non-Empty`, to take the first non-empty of repeated columns (payee, else sender) instead of joining them;
   - `Sideload Parser`, for a file that is not delimited text, with a coded parser in `src/core/parsers/` (as for BCV's xlsx export).

   When bank2ynab's format gains an equivalent of an extension key, propose the format there as well.

Check a format with your own export before proposing it: put the file in `private/` (git-ignored) and run `npm test`; `test/private.test.ts` reads it without printing any amount or label.

## Test data and privacy

Bank exports contain personal data: names, account numbers, card digits, salary, places.

- **Never commit a real export**, not even a few lines. `private/` is git-ignored for your own files.
- Tests use **synthetic** files only: invented payees, amounts and dates, with the real file's structure (columns, delimiter, encoding, header and footer lines). See `test/fixtures/yuh.csv` and `test/helpers/bcvXlsx.ts`.
- Do not quote real content in issues, pull requests or commit messages. Describe the structure instead (column names, date and amount formats).

## Code

- Everything in the repository is in English: code, comments, docs, UI text.
- Run `npm test` and `npm run typecheck` before opening a pull request.
- By contributing, you agree that your contribution is licensed under the [AGPL-3.0-or-later](LICENSE), like the rest of the project.
