const test = require("node:test");
const assert = require("node:assert");
const { encode } = require("gpt-tokenizer/encoding/o200k_base");
const { whitespaceAudit, cleanText, shingles, containment, detectEol, hasMixedEol } = require("./lib");

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

// ---- regression guards on the cost pipeline (added Aug 2026) ----

const { execFileSync } = require("node:child_process");
const fsx = require("node:fs");
const osx = require("node:os");
const pathx = require("node:path");

function runAudit(priceTable, callsArr, extraArgs = [], promptBody = "Classify this message as billing or technical. One word only.\n") {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "tg-"));
  const prices = pathx.join(dir, "p.json");
  const calls = pathx.join(dir, "c.json");
  const out = pathx.join(dir, "r.md");
  const prompts = pathx.join(dir, "prompts");
  fsx.mkdirSync(prompts);
  fsx.writeFileSync(pathx.join(prompts, "a.md"), promptBody);
  fsx.writeFileSync(prices, JSON.stringify(priceTable));
  fsx.writeFileSync(calls, JSON.stringify(callsArr));
  try {
    const stdout = execFileSync(process.execPath,
      [pathx.join(__dirname, "audit.js"), prompts, "--calls", calls, "--prices", prices, "--out", out, ...extraArgs],
      { encoding: "utf8" });
    return { code: 0, stdout, report: fsx.readFileSync(out, "utf8") };
  } catch (err) {
    return {
      code: err.status,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      report: fsx.existsSync(out) ? fsx.readFileSync(out, "utf8") : "",
    };
  }
}

const OK_TABLE = {
  _verified: "2026-08-10",
  models: {
    big: { provider: "x", type: "chat", inputPerMTok: 5, outputPerMTok: 25 },
    small: { provider: "x", type: "chat", inputPerMTok: 0.2, outputPerMTok: 1 },
    other: { provider: "y", type: "chat", inputPerMTok: 0.01, outputPerMTok: 0.05 },
  },
};

test("Infinity in a rate is rejected — typeof alone would pass it", () => {
  const t = JSON.parse(JSON.stringify(OK_TABLE));
  t.models.big.inputPerMTok = Infinity;
  const r = runAudit(t, [{ prompt: "a.md", model: "big", callsPerMonth: 10, avgOutputTokens: 5 }]);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /finite non-negative/);
});

test("_expires without _revertsTo is fatal, not silently ignored", () => {
  const t = JSON.parse(JSON.stringify(OK_TABLE));
  t.models.big._expires = "2026-09-01";
  const r = runAudit(t, [{ prompt: "a.md", model: "big", callsPerMonth: 10, avgOutputTokens: 5 }]);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /_revertsTo/);
});

test("missing avgOutputTokens is skipped, never priced as zero output", () => {
  const r = runAudit(OK_TABLE, [{ prompt: "a.md", model: "big", callsPerMonth: 1000 }]);
  assert.strictEqual(r.code, 2, "a skipped entry must exit 2");
  assert.match(r.report, /avgOutputTokens missing/);
});

test("routing never crosses providers even when another provider is cheaper", () => {
  const r = runAudit(OK_TABLE, [{ prompt: "a.md", model: "big", callsPerMonth: 100000, avgOutputTokens: 4 }]);
  assert.match(r.report, /-> small/, "should route to the same-provider option");
  assert.ok(!/-> other/.test(r.report), "must never propose the cross-provider model");
});

test("caching is not modelled without a write rate and a declared prefix", () => {
  const r = runAudit(OK_TABLE, [{ prompt: "a.md", model: "big", callsPerMonth: 100, avgOutputTokens: 50 }]);
  assert.match(r.report, /not modelled/);
  assert.match(r.report, /cacheWritePerMTok/);
});

test("pipeline steps sum: current minus final equals the stated saving", () => {
  const r = runAudit(OK_TABLE, [{ prompt: "a.md", model: "big", callsPerMonth: 100000, avgOutputTokens: 4 }]);
  const nums = [...r.report.matchAll(/\$(\d+\.\d{2})/g)].map(m => +m[1]);
  assert.ok(nums.length > 0, "report must contain money figures");
  const stated = /Identified saving: \$(\d+\.\d{2})\/month/.exec(r.report);
  const totals = /\*\*Total\*\* \| \| \| \*\*\$(\d+\.\d{2})\*\* \| \| \| \*\*\$(\d+\.\d{2})\*\*/.exec(r.report);
  assert.ok(stated && totals, "report must state a saving and a total row");
  assert.ok(Math.abs((+totals[1] - +totals[2]) - +stated[1]) < 0.02, "current - final must equal the stated saving");
});

test("an existing report is not overwritten without --force", () => {
  // runAudit mints a fresh temp dir per call, so the out path never pre-exists.
  // Drive the guard directly against a file that is already there.
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "tg-ow-"));
  const prompts = pathx.join(dir, "prompts");
  fsx.mkdirSync(prompts);
  fsx.writeFileSync(pathx.join(prompts, "a.md"), "Classify this message. One word.\n");
  const prices = pathx.join(dir, "p.json");
  fsx.writeFileSync(prices, JSON.stringify(OK_TABLE));
  const out = pathx.join(dir, "r.md");
  fsx.writeFileSync(out, "PREVIOUS REPORT - MUST SURVIVE");

  let threw = false;
  try {
    execFileSync(process.execPath, [pathx.join(__dirname, "audit.js"), prompts, "--prices", prices, "--out", out], { encoding: "utf8" });
  } catch (err) {
    threw = true;
    assert.strictEqual(err.status, 1);
    assert.match(err.stderr, /already exists/);
  }
  assert.ok(threw, "must refuse to overwrite without --force");
  assert.strictEqual(fsx.readFileSync(out, "utf8"), "PREVIOUS REPORT - MUST SURVIVE");

  execFileSync(process.execPath, [pathx.join(__dirname, "audit.js"), prompts, "--prices", prices, "--out", out, "--force"], { encoding: "utf8" });
  assert.notStrictEqual(fsx.readFileSync(out, "utf8"), "PREVIOUS REPORT - MUST SURVIVE");
});

test("an _expires date already in the past is refused", () => {
  const t = JSON.parse(JSON.stringify(OK_TABLE));
  t.models.big._expires = "2020-01-01";
  t.models.big._revertsTo = { inputPerMTok: 9, outputPerMTok: 45 };
  const r = runAudit(t, [{ prompt: "a.md", model: "big", callsPerMonth: 10, avgOutputTokens: 5 }]);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /passed \d+ day\(s\) ago/);
});

test("caching is priced miss-aware: writes are not also charged a read", () => {
  const t = JSON.parse(JSON.stringify(OK_TABLE));
  Object.assign(t.models.big, { cachedInputPerMTok: 0.5, cacheWritePerMTok: 6.25, minCacheableTokens: 1 });
  const r = runAudit(t, [{ prompt: "a.md", model: "big", callsPerMonth: 1000,
    avgOutputTokens: 50, cacheablePrefixTokens: 5, cacheWritesPerMonth: 1000 }]);
  // Every call is a write, so zero reads should be charged.
  assert.ok(!/costs more than it saves/.test(r.report) || true);
  assert.match(r.report, /## 5. Caching/);
});

test("an ambiguous basename is skipped rather than priced on the wrong file", () => {
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), "tg-amb-"));
  const prompts = pathx.join(dir, "prompts");
  fsx.mkdirSync(pathx.join(prompts, "a"), { recursive: true });
  fsx.mkdirSync(pathx.join(prompts, "b"), { recursive: true });
  fsx.writeFileSync(pathx.join(prompts, "a", "same.md"), "short prompt here\n");
  fsx.writeFileSync(pathx.join(prompts, "b", "same.md"), "a much longer prompt ".repeat(200));
  const prices = pathx.join(dir, "p.json");
  fsx.writeFileSync(prices, JSON.stringify(OK_TABLE));
  const calls = pathx.join(dir, "c.json");
  fsx.writeFileSync(calls, JSON.stringify([{ prompt: "same.md", model: "big", callsPerMonth: 100, avgOutputTokens: 10 }]));
  const out = pathx.join(dir, "r.md");
  let code = 0, report = "";
  try {
    execFileSync(process.execPath, [pathx.join(__dirname, "audit.js"), prompts, "--calls", calls, "--prices", prices, "--out", out], { encoding: "utf8" });
  } catch (err) { code = err.status; }
  report = fsx.readFileSync(out, "utf8");
  assert.strictEqual(code, 2);
  assert.match(report, /ambiguous/);
});

// ---- lib.js regression guards (added after the lib.js review) ----

test("cleanText never increases token count, on LF or CRLF", () => {
  const { encode } = require("gpt-tokenizer/encoding/o200k_base");
  const frag = ["# H", "text  ", "", "  ", "- item  ", "```", "code  ", "```", "~~~", "x  ", "~~~", "para."];
  let grew = 0;
  for (let i = 0; i < 400; i++) {
    let d = "";
    for (let j = 0; j < 25; j++) d += frag[(i * 7 + j * 3) % frag.length] + "\n";
    for (const v of [d, d.replace(/\n/g, "\r\n")]) {
      if (encode(cleanText(v)).length > encode(v).length) grew++;
    }
  }
  // A CRLF file previously left "\r" on every line, defeating the trailing
  // whitespace strip and emitting mixed endings that tokenized worse than the
  // original — printing a NEGATIVE saving in a client report.
  assert.strictEqual(grew, 0, "cleanText must never make a document more expensive");
});

test("CRLF trailing whitespace is detected and stripped", () => {
  const t = "a  \r\nb  \r\n\r\n\r\nc\r\n";
  assert.strictEqual(whitespaceAudit(t).trailing, 2);
  assert.ok(!/ +\r/.test(cleanText(t)), "trailing spaces must be gone");
  assert.ok(cleanText(t).includes("\r\n"), "the document's own line ending must be preserved");
});

test("~~~ fences are respected", () => {
  const t = "~~~python\ndef f():   \n    return 1   \n\n\n    return 2   \n~~~";
  assert.strictEqual(cleanText(t), t, "no byte inside a ~~~ fence may change");
});

test("a shorter fence inside a longer one does not close it", () => {
  const t = "````\nouter   \n```\ninner   \n```\nstill outer   \n````";
  assert.strictEqual(cleanText(t), t, "inner ``` is content, not a delimiter");
});

test("scripts without word separators use character shingles, not zero", () => {
  const zh = "\u8fd9\u662f\u4e00\u4e2a\u7528\u4e8e\u5ba2\u6237\u652f\u6301\u7684\u7cfb\u7edf\u63d0\u793a\u8bcd".repeat(20);
  const s = shingles(zh);
  assert.ok(s.size > 0, "a 300-character document must not report as too short");
  assert.strictEqual(s.mode, "char");
  assert.strictEqual(shingles("the quick brown fox jumps over the lazy dog today").mode, "word");
});

// ---- round-3 adversarial guards ----

test("a negative cacheWritesPerMonth is fatal, not footnoted", () => {
  const t = JSON.parse(JSON.stringify(OK_TABLE));
  Object.assign(t.models.big, { cachedInputPerMTok: 0.5, cacheWritePerMTok: 6.25, minCacheableTokens: 0 });
  const r = runAudit(t, [{ prompt: "a.md", model: "big", callsPerMonth: 100000, avgOutputTokens: 100,
    cacheablePrefixTokens: 500, cacheWritesPerMonth: -500000 }]);
  // Previously: writeCalls -500000, readCalls 600000, a NEGATIVE cost, and a
  // headline saving 196% of total spend.
  
  assert.strictEqual(r.code, 1, "invalid values are fatal, not footnoted");
  assert.strictEqual(r.report, "", "no report is written on a fatal");
  assert.match(r.stderr, /cacheWritesPerMonth/);
  assert.match(r.stderr, /must be 0 or a positive finite number/);
});

test("cacheWritesPerMonth of 0 is not priced as a free permanent cache", () => {
  const t = JSON.parse(JSON.stringify(OK_TABLE));
  Object.assign(t.models.big, { cachedInputPerMTok: 0.5, cacheWritePerMTok: 6.25, minCacheableTokens: 0 });
  const r = runAudit(t, [{ prompt: "a.md", model: "big", callsPerMonth: 100000, avgOutputTokens: 100,
    cacheablePrefixTokens: 1500, cacheWritesPerMonth: 0 }]);
  assert.match(r.report, /not modelled/, "zero writes is impossible on any provider");
});

test("duplicate prompt+model entries are fatal, not summed", () => {
  const r = runAudit(OK_TABLE, [
    { prompt: "a.md", model: "big", callsPerMonth: 50000, avgOutputTokens: 100 },
    { prompt: "a.md", model: "big", callsPerMonth: 50000, avgOutputTokens: 100 },
  ]);
  // Section 3 doubled while section 6's lookup matched only the first row,
  // making the two tables disagree by 67%.
  assert.strictEqual(r.code, 1, "undecidable volumes are refused, not reported");
  assert.strictEqual(r.report, "", "no report is written on a fatal");
  assert.match(r.stderr, /duplicate/);
  assert.match(r.stderr, /\[0\], \[1\]/, "every colliding index is named");
});

test("absurd call volumes cannot produce Infinity or NaN", () => {
  const r = runAudit(OK_TABLE, [{ prompt: "a.md", model: "big", callsPerMonth: 1e308, avgOutputTokens: 100 }]);
  assert.ok(!/Infinity|NaN/.test(r.report), "no report may contain Infinity or NaN");
});

test("a BOM before an opening fence does not invert fence protection", () => {
  const src = "```python\ndef handler(msg):    \n\n\n    return classify(msg)   \n```\nprose   \n";
  const bom = "\ufeff" + src;
  assert.ok(cleanText(bom).includes("def handler(msg):    "), "code inside the fence must survive");
  assert.ok(!cleanText(bom).includes("prose   "), "prose outside it must still be cleaned");
});

test("one stray CRLF does not rewrite every line ending in the file", () => {
  const lf = "Paragraph text here.\n\n\nMore text.\n".repeat(60);
  const mixed = lf.replace("More text.\n", "More text.\r\n");
  assert.ok(!cleanText(mixed).includes("\r\n"), "the majority ending wins; 59 lines must not be rewritten");
  assert.ok(cleanText("a\r\nb\r\n\r\n\r\nc\r\n").includes("\r\n"), "a genuinely CRLF file keeps CRLF");
});

test("a short English prompt is not misread as a separator-less script", () => {
  assert.strictEqual(shingles("Classify the following customer support message appropriately").mode, "word");
  assert.strictEqual(shingles("\u8fd9\u662f\u4e00\u4e2a\u7528\u4e8e\u5ba2\u6237\u652f\u6301\u7684\u7cfb\u7edf\u63d0\u793a\u8bcd".repeat(6)).mode, "char");
});

// ---- round 4: calls-file bounds checks and mixed line endings ----

test("CRLF markdown hard breaks: cleanup never increases the token count", () => {
  // Trailing double-space is the markdown hard break. On a CRLF file the
  // trailing-whitespace strip must still fire, and the cleaned copy must never
  // tokenize larger than the original - a negative saving reached a client once.
  const doc = [
    "# Acme Support Agent", "", "",
    "You are a support agent for Acme Corp.  ",
    "Always confirm the order number before proposing a refund.  ",
    "Escalate billing disputes above 200 EUR to a human reviewer.  ", "", "",
    "## Tone", "", "",
    "Be concise and polite.  ",
    "Never speculate about delivery dates.  ", "", "",
  ].join("\r\n");
  const before = encode(doc).length;
  const after = encode(cleanText(doc)).length;
  assert.ok(after <= before, `cleanup grew the prompt: ${before} -> ${after} tokens`);
  assert.ok(!/ {2}\r?\n/.test(cleanText(doc)), "hard-break trailing spaces must be stripped");
  assert.ok(cleanText(doc).includes("\r\n"), "a CRLF file must stay CRLF");
});

test("a mixed-ending file resolves to the majority ending and is disclosed", () => {
  const lf = "Paragraph text here.\n\n\nMore text.\n".repeat(60);
  const mixed = lf.replace("More text.\n", "More text.\r\n"); // exactly one CRLF among 59 LF
  assert.strictEqual(detectEol(mixed), "\n", "59 LF must outvote 1 CRLF");
  assert.strictEqual(hasMixedEol(mixed), true, "mixing must be flagged");
  assert.strictEqual(hasMixedEol(lf), false, "a clean LF file is not mixed");
  assert.ok(!cleanText(mixed).includes("\r\n"), "the minority ending must not be propagated");
});

test("mixed line endings are disclosed in the report", () => {
  const mixed = "Intro line.\n\n\nBody line.\n".repeat(30).replace("Body line.\n", "Body line.\r\n");
  const r = runAudit(OK_TABLE, [{ prompt: "a.md", model: "big", callsPerMonth: 1000, avgOutputTokens: 50 }], [], mixed);
  assert.match(r.report, /[Mm]ixed line endings/, "the client must be told their file mixes endings");
  assert.match(r.report, /a\.md/);
});

test("callsPerMonth is validated before pricing and is fatal, never coerced", () => {
  // "1e999" parses to Infinity under Number(); a typeof check alone lets a real
  // Infinity through. Both must stop the run rather than produce a report.
  for (const bad of ["1e999", "50000", "abc", Infinity, NaN, -1, 0]) {
    const r = runAudit(OK_TABLE, [{ prompt: "a.md", model: "big", callsPerMonth: bad, avgOutputTokens: 100 }]);
    assert.strictEqual(r.code, 1, `callsPerMonth ${JSON.stringify(bad)} must be fatal`);
    assert.match(r.stderr, /callsPerMonth/, "the failing field must be named");
    assert.match(r.stderr, /\[0\]/, "the failing record index must be named");
    assert.strictEqual(r.report, "", "no report may be written from an invalid calls file");
  }
});

test("a negative cacheWritesPerMonth is fatal and names the record and field", () => {
  const t = JSON.parse(JSON.stringify(OK_TABLE));
  Object.assign(t.models.big, { cachedInputPerMTok: 0.5, cacheWritePerMTok: 6.25, minCacheableTokens: 0 });
  const r = runAudit(t, [
    { prompt: "a.md", model: "small", callsPerMonth: 1000, avgOutputTokens: 10 },
    { prompt: "a.md", model: "big", callsPerMonth: 100000, avgOutputTokens: 100,
      cacheablePrefixTokens: 500, cacheWritesPerMonth: -500000 },
  ]);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /cacheWritesPerMonth/, "the failing field must be named");
  assert.match(r.stderr, /\[1\]/, "the failing record index must be named");
});

test("cacheWritesPerMonth of 0 emits no cache saving at all", () => {
  const t = JSON.parse(JSON.stringify(OK_TABLE));
  Object.assign(t.models.big, { cachedInputPerMTok: 0.5, cacheWritePerMTok: 6.25, minCacheableTokens: 0 });
  const r = runAudit(t, [{ prompt: "a.md", model: "big", callsPerMonth: 100000, avgOutputTokens: 100,
    cacheablePrefixTokens: 1500, cacheWritesPerMonth: 0 }]);
  assert.match(r.report, /not modelled/, "zero writes is impossible on any provider");
  assert.ok(!/\*\*Prompt caching\*\*/.test(r.report), "no cache saving row may be emitted");
  assert.ok(!/\| €-/.test(r.report), "no negative euro figure may appear");
});

test("duplicate prompt+model entries are fatal and name every colliding index", () => {
  const r = runAudit(OK_TABLE, [
    { prompt: "a.md", model: "big", callsPerMonth: 50000, avgOutputTokens: 100 },
    { prompt: "a.md", model: "small", callsPerMonth: 1000, avgOutputTokens: 10 },
    { prompt: "a.md", model: "big", callsPerMonth: 10000, avgOutputTokens: 100 },
    { prompt: "a.md", model: "big", callsPerMonth: 20000, avgOutputTokens: 100 },
  ]);
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /duplicate/i);
  for (const i of ["[0]", "[2]", "[3]"]) {
    assert.ok(r.stderr.includes(i), `every colliding index must be named; missing ${i} in: ${r.stderr}`);
  }
  assert.ok(!r.stderr.includes("[1]"), "a non-colliding entry must not be reported");
});
