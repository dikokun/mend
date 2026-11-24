# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dikokun/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/dikokun/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edit lists, matches lines at three tiers (exact, trailing-whitespace, indentation-shifted), and applies a patch all-or-nothing — if any edit fails, no file is touched. Node 22, standard library alone.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--format=auto|unified|search-replace|v4a|json`, `--check` (report without writing), `--strict` (tier-1 matching only). The patch comes from the named file, or from standard input when PATCH is omitted or `-`.

---

<sub>Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
