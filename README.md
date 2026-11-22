# hidden-spec-cli-01-westi

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jefriidan15/hidden-spec-cli-01-westi/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jefriidan15/hidden-spec-cli-01-westi/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edit commands to a tree of files, matching lines at three tiers (exact, trailing whitespace, leading + trailing whitespace), with `--strict` for exact-only matching. Practice score 1000 (100 of 100 practice checks pass). Node 22, standard library only.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH comes from a file or stdin (`-` or absent). `--format` is `auto`, `unified`, `search-replace`, `v4a`, or `json`. Exit 0 lists the changed files and prints `ok: <n> files`; exit 1 reports failed edits (`error: <code> <path>`, then `failed: <k> of <n> edits`); exit 2 is a usage, format, or parse error. Any failed edit changes nothing, and any failure means nothing is written.

---

<sub>Entered on [make.fun](https://make.fun/?ref=s7vdxe79&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
