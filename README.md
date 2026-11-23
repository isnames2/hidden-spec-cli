[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/isnames2/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/isnames2/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats, and `mend` reads them all: a unified diff (often
with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON. Every file is changed or nothing is.

Node 22, standard library only. Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. `PATCH` is the patch file,
relative to the working directory; when it is absent or `-`, the patch is read
from standard input. `--format=NAME` reads the patch in one format
(`unified`, `search-replace`, `v4a`, `json`); `auto`, the default, detects it.
`--check` does everything but write. `--strict` matches lines exactly.

## Matching

Each edit names old lines that are replaced by new lines. They are found in
the file at the first of three tiers at which they occur at least once:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are
  removed (new lines are re-indented to the file's indentation).

That is what makes `mend` beat a strict applier: drifted whitespace and
indentation, and line numbers that no longer point at the edit, still apply.
A unified hunk takes the occurrence nearest to its (possibly wrong) line
number; a SEARCH/REPLACE block fails as ambiguous when its old lines occur
more than once; a V4A chunk walks a cursor through the file from its anchor.

## Output

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new` for
a move), then `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line
per failed edit, then `failed: <k> of <n> edits`, and writes nothing. Exit 2
prints one line: `error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`.

`SPEC.md` is the whole contract. `runner.ts` is the kit's trial runner, kept
as it is; `check.ts` runs the public practice set:

    node check.ts ../program/generator/practice.json

## License

MIT. See `LICENSE`.
