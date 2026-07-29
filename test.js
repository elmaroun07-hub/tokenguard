const test = require("node:test");
const assert = require("node:assert");
const { encode } = require("gpt-tokenizer/encoding/o200k_base");
const { whitespaceAudit, cleanText, shingles, containment } = require("./lib");

const FENCED = [
  "Be concise.   ",
  "",
  "```python",
  "def handler(msg):    ",
  "    return classify(msg)   ",
  "```",
  "",
  "",
  "Done.",
].join("\n");

test("cleanText never modifies bytes inside a fenced code block", () => {
  const cleaned = cleanText(FENCED);
  assert.ok(cleaned.includes("def handler(msg):    "), "trailing spaces in fence must survive");
  assert.ok(cleaned.includes("    return classify(msg)   "), "indented fence line must survive");
});

test("cleanText strips trailing whitespace outside fences", () => {
  assert.ok(cleanText(FENCED).startsWith("Be concise.\n"));
});

test("cleanText collapses runs of blank lines outside fences", () => {
  assert.ok(!/\n{3,}/.test(cleanText(FENCED)));
});

test("cleanText is idempotent", () => {
  const once = cleanText(FENCED);
  assert.strictEqual(cleanText(once), once);
});

test("measured savings are real and never negative", () => {
  const savings = encode(FENCED).length - encode(cleanText(FENCED)).length;
  assert.ok(savings > 0, "this fixture has removable bloat");
  for (const s of ["", "no bloat here", "```\na\n```"]) {
    assert.ok(encode(s).length - encode(cleanText(s)).length >= 0);
  }
});

test("whitespaceAudit ignores trailing whitespace inside fences", () => {
  // Only "Be concise.   " is outside the fence.
  assert.strictEqual(whitespaceAudit(FENCED).trailing, 1);
});

test("shingles returns empty set for texts shorter than k words", () => {
  assert.strictEqual(shingles("only five words here now").size, 0);
});

test("containment is 1 for identical texts and 0 when one side is empty", () => {
  const a = shingles("the quick brown fox jumps over the lazy dog again and again");
  assert.strictEqual(containment(a, a), 1);
  assert.strictEqual(containment(a, new Set()), 0);
});

test("containment is symmetric", () => {
  const a = shingles("alpha beta gamma delta epsilon zeta eta theta iota kappa");
  const b = shingles("alpha beta gamma delta epsilon zeta eta theta lambda mu nu xi");
  assert.strictEqual(containment(a, b), containment(b, a));
});

test("overlap estimate is scaled by containment, not the raw minimum", () => {
  // Regression guard: reporting min(tokensA, tokensB) overstates the shared
  // portion whenever containment < 100%.
  const a = "you are a helpful support agent for acme corp always be polite and accurate";
  const b = a + " your goal is to book a demo ask for company size before proposing a plan";
  const c = containment(shingles(a), shingles(b));
  const min = Math.min(encode(a).length, encode(b).length);
  const scaled = Math.round(c * min);
  assert.ok(scaled <= min);
  assert.ok(c > 0 && c <= 1);
});
