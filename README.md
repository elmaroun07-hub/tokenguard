> **Superseded.** This is TokenGuard v1.0.0, kept for history. It contains defects that overstate savings — trailing-whitespace detection fails on CRLF files, fence tracking can strip inside code blocks, and separator-less scripts are silently excluded. Use `main`.
```
✔ Analyzed 4 prompts, 157 tokens
✔ Formatting savings: 2 tokens/cycle
✔ Redundancy pairs ≥0.5: 3
✔ Routing flags: 1
✔ Report written to audit-report.md
```

## Why "measured, not estimated"

An earlier version of this tool used a heuristic token estimator. Self-testing it against real tokenization showed errors ranging from **−36% to +20%** — useless for cost decisions. TokenGuard was rebuilt on real BPE: every figure comes from tokenizing actual text with the same encodings the models use.

That principle is enforced throughout:

- **Formatting savings are verified, not projected.** The cleaned copy is re-tokenized and the delta is reported.
- **Cleanup never touches fenced code blocks.** Counting and cleaning share one fence-aware pass, so the reported saving is achievable without mutating a single byte of your code samples.
- **Inline space runs are reported but not removed** — they can be load-bearing. The savings figure is a floor, not a hope.
- **Overlap is scaled by measured containment.** Reporting the smaller prompt's full token count would overstate the shared portion roughly 2× at a 50% containment threshold.

## Install

```bash
git clone https://github.com/elmaroun07-hub/tokenguard.git
cd tokenguard
npm install
## Install

```bash
npm install -g @houssain/tokenguard
```

Or run without installing:

```bash
npx @houssain/tokenguard --help
```

**From source:**

```bash
git clone https://github.com/elmaroun07-hub/tokenguard.git
cd tokenguard
npm install
```
| Option | Description |
|---|---|
| `--calls <file>` | Per-prompt monthly call volumes — enables cost projection and routing flags (see `sample-calls.json`) |
| `--out <file>` | Report path (default `audit-report.md`) |
| `--prices <file>` | Price table (default `prices.json`) |
| `--prepared-by <name>` | Name in the report header |
| `--no-recurse` | Skip subdirectories |

Scans `.md` `.txt` `.json` `.yaml` `.yml` `.prompt`, recursively by default.

```bash
node audit.js ./prompts --calls calls.json --out report.md
```

## What it measures

| Check | Method |
|---|---|
| **Token counts** | `o200k_base` + `cl100k_base` via [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer) |
| **Formatting bloat** | Fence-safe cleanup, savings confirmed by re-tokenizing |
| **Redundancy** | 8-word shingle containment similarity across the library, 0.5 threshold |
| **Routing waste** | Short prompt + tiny output on a premium model → flagged with $/month savings |
| **Cost projection** | Current vs post-cleanup vs post-caching, per prompt |

Prompts shorter than 8 words can't form shingles and are listed as ineligible for redundancy comparison rather than silently skipped.

## Prices

`prices.json` ships with **example values only**. Model prices change often — update it from the providers' live pricing pages before relying on any dollar figure.

## Tests

```bash
npm test
```

Ten unit tests covering fence safety, cleanup idempotency, non-negative savings, containment symmetry, and a regression guard on the overlap estimate.

## Roadmap

- Prompt-caching simulation per provider
- Anthropic and Google tokenizer coverage
- CI mode — fail the build when a prompt exceeds a token budget

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Houssain El Marouni](https://github.com/elmaroun07-hub).
