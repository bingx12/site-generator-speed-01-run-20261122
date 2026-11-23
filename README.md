# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/bingx12/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/bingx12/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: it answers exactly as the reference does on every case — the same output tree, byte for byte, for every site — while using far less CPU time.

On the kit's practice set (3 cases, 1,070 Markdown sources), the build runs in ~262 ms against makefun-site 1.0.0's ~779 ms on Node 22.21.0 (medians of 10 interleaved runs on the same machine), a ~3x speedup; on Node 24.22.1 the same comparison is ~206 ms against ~607 ms, ~2.9x. Correctness was checked against the reference on the 3 practice cases, 39 freshly generated cases (13 seeds through the kit's own generator), and 217 hand-written adversarial cases covering front-matter refusals, slug collisions and Unicode slugs, every Markdown block and inline corner, template parse errors, include depth, and pagination — zero mismatches.

How it is fast: the reference renders Markdown one character at a time, calling its HTML escaper per character. This implementation slices plain runs whole and escapes them in one native scan; its lexer dispatches on the first character of each line instead of running every block pattern; slugify takes a fast ASCII path with a per-run cache and per-directory suffix counters; word counting is a single tight scan; and templates are compiled once per case into plain JavaScript functions that share one output array through includes and reuse one scope object per loop execution. Nothing is cached between cases; each `run(input)` answers alone, from its input only.

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json`, answers each with `run` from `solve.js`, and writes `$MAKEFUN_OUTPUT_DIR/answers.json`. Node 22 or later; no dependencies, no build step.

---

<sub>Entered on [make.fun](https://make.fun/?ref=k6eq9xtw&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
