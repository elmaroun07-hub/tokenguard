# TokenGuard usage log — schema

One JSON object per line (NDJSON), one line per LLM request. Append-only.

**No prompt content is ever written.** Inputs are hashed. The log holds token counts, timings and a fingerprint — nothing readable. Say this to the client before you ask them to install anything; it is the objection that kills adoption.

## Fields

| Field | Type | Set by | Unlocks |
|---|---|---|---|
| `ts` | ISO 8601 | shim | Time-of-day and weekday cost patterns |
| `path` | string | **you** | Per-path cost breakdown. Written verbatim - do not put customer identifiers or secrets in it |
| `provider` | string | shim | Rate lookup |
| `model` | string | shim | Rate lookup, routing analysis |
| `inputTokens` | int \| null | shim | Cost projection |
| `outputTokens` | int \| null | shim | Cost projection, `avgOutputTokens` |
| `reasoningTokens` | int \| null | shim | The billed-vs-visible output gap |
| `cachedReadTokens` | int \| null | shim | Cache hit rate |
| `cacheWriteTokens` | int \| null | shim | Whether caching is net positive |
| `inputHash` | string \| null | shim | Retry storms, duplicate calls |
| `conversationId` | string \| null | **you** | Unbounded history growth. Written verbatim - use an opaque id, not an email or account number |
| `turnIndex` | int \| null | **you** | Per-turn token growth curve |
| `retrievedTokens` | int \| null | **you** | RAG over-retrieval |
| `attempt` | int | **you** | Explicit retry accounting |
| `latencyMs` | int | shim | Timeout-driven retry patterns |
| `status` | `ok` \| `error` | shim | Error-path waste |
| `errorType` | string \| null | shim | Which failures cost the most |

Four fields are yours to set, and each one is the sole source for a finding. Without them the analysis silently loses that section:

- **`path`** — the one to insist on. Without it every call lands in one bucket and the expensive path hides inside the average.
- **`conversationId`** — without it, unbounded-history growth cannot be measured. In a chat product this is frequently the single largest leak.
- **`retrievedTokens`** — without it, RAG over-retrieval is invisible.
- **`attempt`** — optional; `inputHash` catches most retries on its own.

## How each finding is derived

| Finding | Derivation |
|---|---|
| Average output tokens | `mean(outputTokens + coalesce(reasoningTokens,0))` grouped by `path` |
| Retry storms | Same `inputHash` recurring within a short window; every `status="error"` followed by a repeat |
| Unbounded history | Regress `inputTokens` on `turnIndex` within each `conversationId`. Flat is fine; a rising slope means the transcript is resent every turn and cost grows quadratically |
| RAG over-retrieval | `retrievedTokens / inputTokens`. Above ~0.7, `top_k` is very likely too high |
| Cache economics | Compare `cachedReadTokens` against `cacheWriteTokens` at the model's actual rates. Break-even is **reads > 0.278 x writes** at Anthropic's 5-minute TTL (write 1.25x base input, read 0.1x). "More writes than reads" is *not* the threshold - caching stays net positive well past that point |
| Reasoning gap | `reasoningTokens / outputTokens` — the share of billed output that never appeared in a response body |

## Known blind spot

A wrapper around the SDK cannot see retries the SDK performs internally. To make those visible, set the client's own retry count to 0 and retry in application code, or instrument at the HTTP layer. Otherwise a real retry storm can appear as a single clean call.

State this limitation in the report. Do not let it go unmentioned — an audit that quietly under-counts retries is worse than one that names what it could not see.

## Capture window

Seven days. A weekly cycle covers weekend traffic, which is usually different in both volume and mix. Run `verify.js` on **day 1**, not day 7 — it reports which findings the capture can support, so a missing `conversationId` costs you a day instead of a week.
