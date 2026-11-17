// Updates catalog/bank2ynab.conf to a given bank2ynab commit (default: the tip of develop)
// and records it in catalog/source.json. Review the diff and run the tests afterwards.
//
//   npm run catalog:update [-- <commit-sha>]
import { writeFile } from "node:fs/promises";

const repo = "bank2ynab/bank2ynab";
const path = "bank2ynab/data/bank2ynab.conf";
const ref = process.argv[2] ?? "develop";

const commitRes = await fetch(`https://api.github.com/repos/${repo}/commits/${ref}`, {
  headers: { Accept: "application/vnd.github+json", "User-Agent": "sideload-for-ynab-catalog-update" },
});
if (!commitRes.ok) throw new Error(`GitHub API: HTTP ${commitRes.status} for ${ref}`);
const commit = await commitRes.json();
const sha = commit.sha;

const confRes = await fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`);
if (!confRes.ok) throw new Error(`Download failed: HTTP ${confRes.status}`);
const conf = await confRes.text();

const catalog = new URL("../catalog/", import.meta.url);
await writeFile(new URL("bank2ynab.conf", catalog), conf);
const source = {
  repository: `https://github.com/${repo}`,
  path,
  commit: sha,
  commitDate: commit.commit.committer.date.slice(0, 10),
  license: "MIT",
};
await writeFile(new URL("source.json", catalog), `${JSON.stringify(source, null, 2)}\n`);
console.log(`catalog/bank2ynab.conf updated to ${sha} (${source.commitDate})`);
