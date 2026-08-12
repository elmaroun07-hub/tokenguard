/**
 * TokenGuard logging shim — Node, zero dependencies.
 *
 * Records one NDJSON line per LLM request so a cost audit has real traffic to
 * work from. See SCHEMA.md for the field contract.
 *
 * Two guarantees, both deliberate:
 *
 *   1. NO PROMPT CONTENT IS EVER WRITTEN. Inputs are hashed, not stored. The
 *      log holds token counts, timings and a fingerprint. Nothing readable.
 *   2. LOGGING NEVER BREAKS YOUR REQUEST PATH. Every failure inside this file
 *      is swallowed. A broken log is an inconvenience; a broken checkout is not.
 *
 * Quick start:
 *
 *   const { wrapAnthropic } = require("./tokenguard-log");
 *   const client = wrapAnthropic(new Anthropic());
 *
 *   await client.messages.create(
 *     { model: "claude-sonnet-5", messages, max_tokens: 512 },
 *     { tgPath: "support-reply", tgConversationId: ticketId, tgTurnIndex: n }
 *   );
 *
 * The tg* fields are optional but each one unlocks a specific finding —
 * see SCHEMA.md. Without tgPath everything collapses into one bucket and the
 * expensive call path stays hidden inside the average.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LOG_FILE = process.env.TOKENGUARD_LOG || "tokenguard-usage.ndjson";
const ENABLED = process.env.TOKENGUARD_DISABLE !== "1";

let ready = false;
function out() {
  if (!ENABLED) return false;
  if (ready) return true;
  try {
    fs.mkdirSync(path.dirname(path.resolve(LOG_FILE)), { recursive: true });
    ready = true;
  } catch { ready = false; }
  return ready;
}

/** sha256 of the request input, truncated. Enough to spot a duplicate call,
 *  not enough to reconstruct anything. */
function fingerprint(value) {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return crypto.createHash("sha256").update(text || "").digest("hex").slice(0, 16);
  } catch { return null; }
}

// appendFileSync rather than a WriteStream: process.on("exit") only runs
// synchronous work, so a buffered stream loses the tail of every log - and the
// tail is where a crash-related retry storm lives. One line per request is
// cheap enough that the blocking write is not worth optimising away.
function write(record) {
  if (!out()) return;
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n"); } catch { /* never throw */ }
}

/** Normalise the two providers' usage objects into one shape. */
function readUsage(res) {
  let u = {};
  try { u = (res && (res.usage || (res.response && res.response.usage))) || {}; } catch { u = {}; }
  return {
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? null,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? null,
    // Reasoning tokens bill as output but never appear in the response body.
    // Without this field, measured output understates real cost.
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
    cachedReadTokens: u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null,
    cacheWriteTokens: u.cache_creation_input_tokens ?? null,
  };
}

/**
 * Core recorder. Wrap any async call that returns a provider response.
 * meta: { path, provider, model, conversationId, turnIndex, retrievedTokens, attempt, input }
 */
async function record(meta, fn) {
  const started = Date.now();
  const base = {
    ts: new Date().toISOString(),
    path: meta.path ?? null,
    provider: meta.provider ?? null,
    model: meta.model ?? null,
    conversationId: meta.conversationId ?? null,
    turnIndex: meta.turnIndex ?? null,
    retrievedTokens: meta.retrievedTokens ?? null,
    attempt: meta.attempt ?? 1,
    inputHash: fingerprint(meta.input),
  };
  let res;
  try {
    res = await fn();
  } catch (err) {
    // A failed call still consumed input tokens upstream and is almost always
    // followed by a retry. Both halves of a retry storm must be visible.
    write({
      ...base, inputTokens: null, outputTokens: null, reasoningTokens: null,
      cachedReadTokens: null, cacheWriteTokens: null,
      latencyMs: Date.now() - started, status: "error",
      errorType: (err && (err.status || err.name)) ? String(err.status || err.name) : "unknown",
    });
    throw err;
  }
  // Success path is logged OUTSIDE the try. Anything thrown while reading the
  // usage object or writing the line must never be mistaken for a failed
  // request and rethrown at the caller - that would turn instrumentation into
  // an outage. Guarantee 2 depends on this separation.
  try {
    write({ ...base, ...readUsage(res), latencyMs: Date.now() - started, status: "ok", errorType: null });
  } catch { /* logging failure is never the caller's problem */ }
  return res;
}

function extract(opts = {}) {
  return {
    path: opts.tgPath,
    conversationId: opts.tgConversationId,
    turnIndex: opts.tgTurnIndex,
    retrievedTokens: opts.tgRetrievedTokens,
    attempt: opts.tgAttempt,
  };
}

/** Wrap an Anthropic SDK client. Returns the same object with messages.create instrumented. */
function wrapAnthropic(client) {
  try {
    const original = client.messages.create.bind(client.messages);
    client.messages.create = (body, opts = {}) =>
      record(
        { ...extract(opts), provider: "anthropic", model: body?.model, input: body?.messages ?? body },
        () => original(body, opts)
      );
  } catch { /* leave the client untouched rather than break it */ }
  return client;
}

/** Wrap an OpenAI SDK client. Instruments chat.completions.create and responses.create. */
function wrapOpenAI(client) {
  try {
    if (client.chat?.completions?.create) {
      const original = client.chat.completions.create.bind(client.chat.completions);
      client.chat.completions.create = (body, opts = {}) =>
        record(
          { ...extract(opts), provider: "openai", model: body?.model, input: body?.messages ?? body },
          () => original(body, opts)
        );
    }
    if (client.responses?.create) {
      const original = client.responses.create.bind(client.responses);
      client.responses.create = (body, opts = {}) =>
        record(
          { ...extract(opts), provider: "openai", model: body?.model, input: body?.input ?? body },
          () => original(body, opts)
        );
    }
  } catch { /* leave the client untouched */ }
  return client;
}

module.exports = { record, wrapAnthropic, wrapOpenAI, fingerprint, LOG_FILE };
