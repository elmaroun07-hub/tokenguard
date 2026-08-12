# AI Spend Audit - Findings Report

**Prepared by:** Houssain El Marouni · **Date:** 2026-08-12
**Scope:** 4 prompt assets · 1,500 tokens (o200k_base, measured - not estimated)

> Rates from `prices.json`, verified 2099-01-01. Provider rates are published in USD. Figures shown in EUR at 1 USD = 0.865 EUR, rate as of 2099-01-01.

**Current modelled spend: €194.92/month. Identified saving: €69.26/month (€831.15/year).**

## 1. Prompt Inventory

| Prompt | Tokens (o200k) | Tokens (cl100k) | Formatting savings (measured) |
|---|---|---|---|
| classifier.txt | 18 | 18 | 0 tok (0 trailing, 0 extra blank lines, 0 inline space runs) |
| router.md | 8 | 8 | 0 tok (0 trailing, 0 extra blank lines, 0 inline space runs) |
| system-sales.md | 731 | 731 | 1 tok (1 trailing, 0 extra blank lines, 0 inline space runs) |
| system-support.md | 743 | 743 | 1 tok (1 trailing, 1 extra blank lines, 0 inline space runs) |

**Total recoverable from formatting alone: 2 tokens per call cycle.**
Measured by re-tokenizing a cleaned copy. Fenced code blocks are left byte-for-byte untouched, and inline space runs are reported but not removed - so this figure is a floor.

## 2. Redundancy Ledger (containment >= 0.5)

| Prompt A | Prompt B | Containment | Approx. overlapping tokens | Measured against |
|---|---|---|---|---|
| system-sales.md | system-support.md | 88% | ~640 | system-sales.md |

**Recommendation:** extract shared blocks into a single cached/system segment; pass variant-specific content only.

_Too short for redundancy comparison: router.md._

## 3. Monthly Cost Projection

One ordered pipeline: current -> routing -> cleanup -> caching. Each step is priced on the output of the previous one, so the steps sum without double counting.

| Prompt | Model | Calls/mo | Current | + routing | + cleanup | + caching |
|---|---|---|---|---|---|---|
| system-support.md (approx) | claude-sonnet-5 | 50,000 | €142.12 | €142.12 | €142.03 | €84.71 |
| system-sales.md (approx) | claude-sonnet-5 | 12,000 | €38.01 | €38.01 | €37.99 | not modelled |
| classifier.txt (approx) | claude-opus-5 -> claude-haiku-4-5 | 90,000 | €14.79 | €2.96 | €2.96 | not modelled |
| **Total** | | | **€194.92** | | | **€125.66** |

**Identified saving: €69.26/month · €831.15/year.**

_Rows marked (approx) were priced with a fallback encoder (o200k_base) because the model declares no `tokenizer` in the price table. Non-OpenAI tokenizers typically differ by a few percent on English prose and more on code and non-Latin scripts; treat these rows as indicative and confirm against the provider's own usage figures before acting on them._

**Skipped entries (excluded from every figure above):**
- router.md: avgOutputTokens missing or out of range - cannot price output, entry excluded

## 4. Model-Routing Flags

- **classifier.txt**: move `claude-opus-5` -> `claude-haiku-4-5` (same provider: anthropic) = **€11.83/month**. Short prompt with near-empty output on a premium model - classic classification/extraction over-routing. Validate quality on the smaller model with a 200-sample eval before switching.

Candidates are restricted to the same provider and the same declared type. A cross-provider swap is a migration, not a config change, and is never priced as if it were free.

## 5. Caching

- **system-sales.md**: not modelled - missing cacheablePrefixTokens (declared stable prefix), cacheWritesPerMonth (writes incl. TTL expiries; must be at least 1)
- **classifier.txt**: not modelled - missing cacheablePrefixTokens (declared stable prefix), cacheWritesPerMonth (writes incl. TTL expiries; must be at least 1)

A cache read rate alone cannot price caching. The write is paid on the first call and on every TTL expiry, only the declared stable prefix is eligible, and every provider enforces a per-model minimum below which nothing caches at all.

## 6. Scheduled Rate Changes

These are **increases**, not savings, and are reported separately. No optimisation in this report prevents them.

| Model | Expires | Days left | At current rate | After reversion | Monthly increase |
|---|---|---|---|---|---|
| claude-sonnet-5 | 2099-06-30 | 26620 | €180.13 | €270.20 | **+€90.07** |

Priced on current usage at raw token counts, on the same basis as section 3's Current column.

## 7. Prioritized Fix List

1. **Prompt caching** - €57.32/month on prompts with a declared stable prefix above the per-model minimum.
2. **Model routing** - 1 prompt(s) flagged in section 4, €11.83/month. Validate on a 200-sample eval before switching.
3. **Formatting cleanup** - 2 tokens per call cycle across priced prompts, €0.11/month. No behaviour change; safe to ship first.
4. **Deduplicate shared instruction blocks** - 1 pair(s) in section 2. Value depends on call mix; not priced here.
5. **Supply the caching inputs** - 2 prompt(s) could not be modelled (section 5). Each is a saving that may exist and is currently invisible.

## 8. Method and Limits

Token counts are measured with `gpt-tokenizer` (`o200k_base`, `cl100k_base`), never estimated. Formatting savings are confirmed by re-tokenizing the cleaned text. Redundancy uses 8-word shingle containment at a 0.5 threshold.

**Not modelled, and to be handled as separate findings:** batch pricing (50% off on both major providers), reasoning-token billing (billed as output, absent from the response body), long-context rate tiers, retry and error-path waste, unbounded conversation history, and RAG over-retrieval. These require a request-level usage export rather than a prompt library.

All figures in EUR.
