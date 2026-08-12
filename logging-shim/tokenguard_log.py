"""
TokenGuard logging shim - Python, standard library only.

Records one NDJSON line per LLM request so a cost audit has real traffic to
work from. Field contract is identical to the Node shim; see SCHEMA.md.

Two guarantees, both deliberate:

  1. NO PROMPT CONTENT IS EVER WRITTEN. Inputs are hashed, not stored.
  2. LOGGING NEVER BREAKS YOUR REQUEST PATH. Every failure here is swallowed.

Quick start:

    from tokenguard_log import record

    with record(path="support-reply", provider="anthropic",
                model="claude-sonnet-5", conversation_id=ticket_id,
                turn_index=n, input_payload=messages) as r:
        resp = client.messages.create(model=..., messages=messages, max_tokens=512)
        r.capture(resp)

`path` is the one field worth insisting on. Without it every call collapses
into a single bucket and the expensive path hides inside the average.
"""

import hashlib
import json
import os
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone

LOG_FILE = os.environ.get("TOKENGUARD_LOG", "tokenguard-usage.ndjson")
ENABLED = os.environ.get("TOKENGUARD_DISABLE") != "1"

_lock = threading.Lock()


def _js_numbers(value):
    """JSON.stringify renders 1.0 as "1"; json.dumps renders "1.0". A payload
    carrying temperature=1.0 would otherwise hash differently in each language
    and break retry detection across a mixed Node/Python stack."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _js_numbers(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_js_numbers(v) for v in value]
    return value


def _error_type(err):
    """Node records the SDK's HTTP status where one exists, falling back to the
    error name. Match that vocabulary or failures cannot be grouped across a
    mixed Node/Python stack."""
    for attr in ("status_code", "status"):
        v = getattr(err, attr, None)
        if v is not None:
            return str(v)
    return type(err).__name__


def _first_not_none(*values):
    """Mirror JavaScript's ?? - only None falls through, never 0."""
    for v in values:
        if v is not None:
            return v
    return None


def fingerprint(value):
    """sha256 of the request input, truncated. Enough to spot a duplicate
    call, not enough to reconstruct anything."""
    try:
        # Must match the Node shim byte for byte or retry detection fails in a
        # mixed stack. JSON.stringify preserves insertion order and uses no
        # separators padding, so sort_keys stays off and separators are pinned.
        text = value if isinstance(value, str) else json.dumps(
            _js_numbers(value), default=str, sort_keys=False,
            separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    except Exception:
        return None


def _write(rec):
    if not ENABLED:
        return
    try:
        parent = os.path.dirname(os.path.abspath(LOG_FILE))
        if parent:
            os.makedirs(parent, exist_ok=True)
        with _lock, open(LOG_FILE, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")
    except Exception:
        pass  # never throw into the caller's request path


def _read_usage(resp):
    """Normalise the two providers' usage objects into one shape."""
    empty = dict(_EMPTY_USAGE)
    try:
        u = getattr(resp, "usage", None)
        if u is None and isinstance(resp, dict):
            u = resp.get("usage")
    except Exception:
        return empty
    if u is None:
        # Node always writes all five as null. Omitting them here would make
        # a consumer that indexes the field raise on Python-written lines only.
        return empty

    def g(*names):
        for n in names:
            v = getattr(u, n, None)
            if v is None and isinstance(u, dict):
                v = u.get(n)
            if v is not None:
                return v
        return None

    def nested(outer, inner):
        o = g(outer)
        if o is None:
            return None
        v = getattr(o, inner, None)
        if v is None and isinstance(o, dict):
            v = o.get(inner)
        return v

    return {
        "inputTokens": g("input_tokens", "prompt_tokens"),
        "outputTokens": g("output_tokens", "completion_tokens"),
        # Reasoning tokens bill as output but never appear in the response body.
        # Without this field, measured output understates real cost.
        "reasoningTokens": nested("completion_tokens_details", "reasoning_tokens"),
        # `or` would turn a measured 0 ("no cache reads happened") into None
        # ("not reported"). Those are different facts, and the distinction is
        # exactly what a cache hit-rate calculation depends on.
        "cachedReadTokens": _first_not_none(g("cache_read_input_tokens"),
                                            nested("prompt_tokens_details", "cached_tokens")),
        "cacheWriteTokens": g("cache_creation_input_tokens"),
    }


_EMPTY_USAGE = {"inputTokens": None, "outputTokens": None, "reasoningTokens": None,
                "cachedReadTokens": None, "cacheWriteTokens": None}


class _Recorder:
    def __init__(self, base):
        self.base = base
        # Default to all-null rather than {}. Forgetting r.capture(resp) is a
        # separate line in the documented example and easy to miss; omitting the
        # keys entirely would make a consumer raise on Python-written lines only.
        self.usage = dict(_EMPTY_USAGE)

    def capture(self, response):
        """Call with the provider response so token counts are recorded."""
        try:
            self.usage = _read_usage(response)
        except Exception:
            self.usage = dict(_EMPTY_USAGE)
        return response


@contextmanager
def record(path=None, provider=None, model=None, conversation_id=None,
           turn_index=None, retrieved_tokens=None, attempt=1, input_payload=None):
    started = time.time()
    base = {
        # Milliseconds, matching Node's toISOString(). Retry detection groups by
        # inputHash within a short window; second resolution loses ordering
        # inside a burst, which is exactly where a retry storm lives.
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "path": path,
        "provider": provider,
        "model": model,
        "conversationId": conversation_id,
        "turnIndex": turn_index,
        "retrievedTokens": retrieved_tokens,
        "attempt": attempt,
        "inputHash": fingerprint(input_payload),
    }
    rec = _Recorder(base)
    try:
        yield rec
    except Exception as err:
        # A failed call still consumed input tokens upstream and is almost
        # always followed by a retry. Both halves of a storm must be visible.
        _write({**base, "inputTokens": None, "outputTokens": None,
                "reasoningTokens": None, "cachedReadTokens": None, "cacheWriteTokens": None,
                "latencyMs": int((time.time() - started) * 1000),
                "status": "error", "errorType": _error_type(err)})
        raise
    else:
        _write({**base, **rec.usage,
                "latencyMs": int((time.time() - started) * 1000),
                "status": "ok", "errorType": None})
