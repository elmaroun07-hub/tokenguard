# AI Spend Audit — Findings Report

**Prepared by:** TokenGuard · **Date:** 2026-07-28
**Scope:** 4 prompt assets · 157 tokens (o200k_base, measured — not estimated)

> Costs below are computed from `prices.json`. Verify those rates against current provider pricing pages before relying on any dollar figure.

## 1. Prompt Inventory

| Prompt | Tokens (o200k) | Tokens (cl100k) | Formatting savings (measured) |
|---|---|---|---|
| classifier.txt | 18 | 18 | 0 tok (0 trailing, 0 extra blank lines, 0 inline space runs) |
| nested/deep.md | 15 | 15 | 0 tok (0 trailing, 0 extra blank lines, 0 inline space runs) |
| system-sales.md | 56 | 56 | 0 tok (0 trailing, 0 extra blank lines, 0 inline space runs) |
| system-support.md | 68 | 68 | 2 tok (1 trailing, 3 extra blank lines, 0 inline space runs) |

**Total recoverable from formatting alone: 2 tokens per call cycle.**
Measured by re-tokenizing a cleaned copy. Fenced code blocks are left byte-for-byte untouched, and inline space runs are reported but not removed — so this figure is a floor.

## 2. Redundancy Ledger (containment ≥ 0.5)

| Prompt A | Prompt B | Containment | Approx. overlapping tokens |
|---|---|---|---|
| nested/deep.md | system-sales.md | 80% | ~12 |
| nested/deep.md | system-support.md | 80% | ~12 |
| system-sales.md | system-support.md | 51% | ~29 |

Overlap is containment × the smaller prompt's token count — an approximation of the shared portion, not a billing figure.

**Recommendation:** extract shared blocks into a single cached/system segment; pass variant-specific content only.


## 3. Monthly Cost Projection

| Prompt | Model | Calls/mo | Current | After cleanup | After cleanup + prompt caching |
|---|---|---|---|---|---|
| system-support.md | claude-sonnet | 50,000 | $145.20 | $144.90 | $135.99 |
| system-sales.md | claude-sonnet | 12,000 | $41.62 | $41.62 | $39.80 |
| classifier.txt | claude-opus | 90,000 | $51.30 | $51.30 | $29.43 |


## 4. Model-Routing Flags (automatic)

- **classifier.txt**: move `claude-opus` → `gpt-small` ≈ **$49.46/month saved**. Short prompt with near-empty output on a premium model — classic classification/extraction over-routing. Validate quality on the smaller model with a 200-sample eval before switching.

## 5. Prioritized Fix List

1. **Model routing** per Section 4 — usually the single largest lever.
2. **Prompt caching** — mark stable system segments cacheable (largest lever for high-volume prompts).
3. **Deduplicate** shared instruction blocks per Section 2.
4. **Formatting cleanup** per Section 1 (small but free).
5. **Output-token discipline** — max_tokens caps and terse output formats (JSON, no prose) where machine-consumed.
