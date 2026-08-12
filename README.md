# TokenGuard

**Audit LLM prompt spend with real tokenizers.** Point it at a folder of prompts and it reports what your prompt library actually costs, where the waste is, and what a cleanup is worth per month — measured, not estimated.

```
OK 4 prompts, 1,500 tokens
OK Recoverable: €69.26/month (€831.15/yr)
OK Redundancy pairs >=0.5: 1
OK Routing flags: 1
!  Caching not modelled for 2 prompt(s)
!  Scheduled rate change on 1 model(s) in use
!  Skipped 1 calls entry
OK Report: sample-report.md
```

## Why "measured, not estimated"

An earlier version used a heuristic token estimator. Self-testing it against real tokenization showed errors from **−36% to +20%** — useless for cost decisions. TokenGuard was rebuilt on real BPE: every figure comes from tokenizing actual text with the same encodings the models use.

The principle is enforced throughout, and the enforcement runs in both directions — **the tool refuses to print a number it cannot derive:**

- **Formatting savings are verified, not projected.** The cleaned copy is re-tokenized and the delta reported.
- **Cleanup never touches fenced code blocks.** Counting and cleaning share one fence-aware pass, so the reported saving is achievable without mutating a byte of your code samples.
- **Inline space runs are reported but not removed** — they can be load-bearing. The savings figure is a floor, not a hope.
- **Overlap is scaled by measured containment**, against the token count of the document the containment was measured on.
- **Caching is not modelled without the inputs to model it.** A cache read rate alone cannot price caching: the write is paid on the first call and on every TTL expiry, only the declared stable prefix is eligible, and every provider enforces a per-model minimum below which nothing caches at all. Supply `cacheWritePerMTok` and `minCacheableTokens` in the price table and `cacheablePrefixTokens` / `cacheWritesPerMonth` in the calls file, or the column reads `not modelled` and tells you which input is missing.
- **Routing candidates are same-provider and same-type only.** A cross-provider swap is a migration, not a config change, and must never be priced as if it were free. Models without a declared `type` are excluded from candidacy rather than defaulted in.
- **Missing data is never read as zero.** A calls entry without `avgOutputTokens` is skipped and listed, not silently priced at zero output.

## Install

```bash
git clone https://github.com/elmaroun07-hub/tokenguard.git
cd tokenguard
npm install
```

## Usage

```bash
node audit.js <prompts-dir> [options]
```

| Option | Description |
|---|---|
| `--calls <file>` | Per-prompt monthly call volumes — enables cost projection and routing flags |
| `--out <file>` | Report path (default `audit-report.md`) |
| `--prices <file>` | Price table (default `prices.json`) |
| `--prepared-by <name>` | Name in the report header |
| `--no-recurse` | Skip subdirectories |
| `--include-json` | Treat `.json` files as prompts (off by default) |
| `--force` | Overwrite an existing report |
| `--stale-ok` | Run even if the price table is past its 45-day verification window |

Scans `.md` `.txt` `.yaml` `.yml` `.prompt`, recursively by default. **`.json` is opt-in**, and lockfiles and tooling configs are denied outright — a `package-lock.json` counted as a prompt asset will distort the headline token figure by orders of magnitude.

```bash
node audit.js ./prompts --calls calls.json --out report.md
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean. Every calls entry was priced. |
| `1` | Fatal. Nothing was written — the price table or the calls file failed validation, or the report path already exists without `--force`. |
| `2` | Completed with skipped entries. A report was written, but at least one calls entry was incomplete and is excluded from every figure in it. |

The `1`/`2` split is the difference between a value that is **wrong** and a value that is **missing**. A missing `avgOutputTokens` is incomplete: the entry is dropped, listed in the report, and the run exits `2`, so a partial audit is never mistaken for a clean one. A duplicated row or a negative write count is wrong: the run stops at `1` rather than print a figure derived from it.

### Calls-file validation

The calls file is validated once, before any pricing runs. These are **fatal** — the audit stops and writes nothing:

| Rejected | Why |
|---|---|
| `callsPerMonth` that is not a finite number in `1 … 1,000,000,000` | `Infinity` reached the report as a spend of `Infinity/month`. `"1e999"` parses to `Infinity`, and a string is never silently coerced. |
| `cacheWritesPerMonth` below zero | A negative write count inverted the hit/miss split into a negative cost and a saving larger than the entire bill. |
| Duplicate `{prompt, model}` pairs | **Refused, not summed.** Two rows for one pair doubled the cost table while the rate-change table matched only the first, so the two disagreed. Merging them is a decision about your data, not one this tool should make silently — every colliding index is named so you can fix them in one pass. |

`cacheWritesPerMonth: 0` is not fatal but is not modelled either: a prefix that is never written and never expires does not exist on any provider, so the row is excluded from cache savings rather than priced as a free permanent cache.

## What it measures

| Check | Method |
|---|---|
| **Token counts** | `o200k_base` + `cl100k_base` via [`gpt-tokenizer`](https://www.npmjs.com/package/gpt-tokenizer). Costs use the encoder declared per model; rows priced with a fallback encoder are marked `(approx)` |
| **Formatting bloat** | Fence-safe cleanup, savings confirmed by re-tokenizing |
| **Redundancy** | 8-word shingle containment across the library, 0.5 threshold |
| **Routing waste** | Short prompt + tiny output on a premium model, where a same-provider chat model at least halves the cost |
| **Scheduled rate changes** | Models carrying `_expires` / `_revertsTo` are modelled at both rates and reported separately |
| **Cost projection** | One ordered pipeline — current → routing → cleanup → caching — so the steps sum without double counting |

Prompts shorter than 8 words can't form shingles and are listed as ineligible rather than silently skipped.

### Line endings

A file's own line ending is preserved: a CRLF prompt stays CRLF in the cleaned copy, so the measured saving is one you can actually realise without rewriting your files.

Where a file **mixes** both styles, the majority wins and the report says so under section 1. That disclosure matters because normalising the minority endings is a change beyond whitespace removal, and without it a single stray CRLF among fifty-nine LF endings would rewrite the whole file and book the difference as a formatting saving.

## Scheduled rate changes

Introductory and promotional rates expire. When they do, the bill rises with **no change in usage**, and no optimisation in any report prevents it.

Record it in the price table:

```json
"some-model": {
  "provider": "anthropic", "type": "chat",
  "inputPerMTok": 2.0, "outputPerMTok": 10.0,
  "_expires": "2026-08-31",
  "_revertsTo": { "inputPerMTok": 3.0, "outputPerMTok": 15.0 }
}
```

The report then models both rates and states the exposure with days remaining. It is reported **separately from savings**, never netted against them — an increase you cannot avoid is not the same kind of number as a saving you can capture, and mixing them produces a total that means nothing.

`_expires` without `_revertsTo` is a fatal error. A dated rate change that cannot be modelled is worse than none, because it looks handled.

## Prices

`prices.json` ships with **placeholder values only** — every rate in it is invented, and its `_WARNING` key says so. No provider was consulted. Replace every figure from the providers' live pricing pages and set `_verified` before relying on any output — the tool refuses to run without a `_verified` date, and refuses again if that date is more than 45 days old. An undated rate is not auditable; a stale one is worse, because it looks handled. `--stale-ok` overrides deliberately.

The shipped table carries a far-future `_verified` so the quickstart above still runs on a clone made months from now. That is a property of the example, not a model to copy: a real table goes stale by design 45 days after the day you actually checked the rates, and at that point you either re-verify it or pass `--stale-ok` and accept that the figures are dated.

```bash
node audit.js ./prompts --calls calls.json --prices prices.json --stale-ok
```

| Field | Required | Notes |
|---|---|---|
| `provider` | yes | Routing candidates are restricted to the same provider |
| `type` | recommended | e.g. `"chat"`. Missing → excluded from routing candidacy |
| `inputPerMTok` / `outputPerMTok` | yes | USD per million tokens |
| `tokenizer` | no | `o200k_base` \| `cl100k_base` \| `null`. `null` → fallback counting, row marked `(approx)` |
| `cachedInputPerMTok` | no | Cache **read** rate |
| `cacheWritePerMTok` | no | Cache **write** rate — higher than base input. Without it, caching is not modelled |
| `minCacheableTokens` | no | Per-model floor. Below it nothing caches, however the request is marked |
| `_expires` / `_revertsTo` | no | Dated rate change; both or neither |

An `fx` block converts output to another currency and must carry `perUsd`, `symbol`, `code` and a dated `asOf`. Incomplete blocks are rejected rather than partially applied.

**Not modelled:** batch pricing, reasoning-token billing, and long-context tiers. All three are documented in `prices.json` under `_not_modelled` and must be handled manually as separate findings.

## Tests

```bash
npm test
```

Thirty-nine tests, in four groups.

**Ten** cover the analysis primitives in `lib.js` — fence safety, cleanup idempotency, non-negative savings, containment symmetry and its empty/identical edges, and a regression guard on the overlap estimate.

**Ten** are end-to-end guards on the cost pipeline: non-finite rates rejected, `_expires` without `_revertsTo` fatal, an already-passed `_expires` refused, missing `avgOutputTokens` skipped rather than zeroed, routing held within a provider even when another is cheaper, ambiguous basenames skipped rather than guessed, caching refused without a write rate, caching priced miss-aware, the overwrite guard, and the pipeline steps proven to sum.

**Nine** guard `lib.js` against defects an independent review found: negative savings on CRLF input, CRLF trailing whitespace going undetected, unrecognised `~~~` fences, a shorter fence closing a longer one, a BOM inverting fence protection, one stray CRLF rewriting a whole file, markdown hard breaks on CRLF, and scripts without word separators being dropped from the redundancy ledger.

**Ten** cover calls-file validation and disclosure: `callsPerMonth` fatal on every non-finite and out-of-range form including the string `"1e999"`, negative `cacheWritesPerMonth` fatal and naming the record index and field, `cacheWritesPerMonth: 0` emitting no cache saving at all, duplicate `{prompt, model}` pairs fatal and naming every colliding index, and mixed line endings both resolving to the majority and being disclosed in the report.

## Roadmap

- Per-provider tokenizer coverage (Anthropic, Google) so non-OpenAI rows stop falling back
- CI mode — fail the build when a prompt exceeds a token budget
- Cache hit-rate estimation from a usage export, removing the need to declare it manually

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Houssain El Marouni](https://github.com/elmaroun07-hub).
