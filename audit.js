#!/usr/bin/env node
/**
 * TokenGuard — LLM prompt-spend audit CLI
 *
 * Usage:
 *   node audit.js <prompts-dir> [--calls calls.json] [--out report.md]
 *                               [--prices prices.json] [--prepared-by "Name"]
 *                               [--no-recurse] [--include-json] [--force]
 *
 * Design rule: the tool refuses to print a number it cannot derive.
 * Every figure is measured or declared. Nothing is inferred from a default.
 */

const fs = require("fs");
const path = require("path");
const { encode } = require("gpt-tokenizer/encoding/o200k_base");
const { encode: encodeCl100k } = require("gpt-tokenizer/encoding/cl100k_base");
const { SHINGLE_K, THRESHOLD, CHAR_SHINGLE_K, hasMixedEol, whitespaceAudit, cleanText, shingles, containment } = require("./lib");

const USAGE = `Usage: audit.js <prompts-dir> [options]

Options:
  --calls <file>        JSON of per-prompt monthly call volumes (see sample-calls.json)
  --out <file>          Output report path (default: audit-report.md)
  --prices <file>       Price table (default: prices.json next to this script)
  --prepared-by <name>  Name shown in the report header
  --no-recurse          Do not scan subdirectories
  --include-json        Treat .json files as prompts (off by default)
  --force               Overwrite an existing report
  --stale-ok            Run even if the price table is past its verification window
  -h, --help            Show this help

Exit codes: 0 clean - 1 fatal - 2 completed with skipped calls entries`;

const die = msg => { console.error(`Error: ${msg}`); process.exit(1); };

// ---------- args ----------
const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}

function flag(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const val = argv[i + 1];
  if (val === undefined || val.startsWith("--")) die(`${name} requires a value.\n\n${USAGE}`);
  return val;
}

const promptsDir = argv[0];
if (promptsDir.startsWith("--")) die(`first argument must be the prompts directory.\n\n${USAGE}`);

const outFile = flag("--out", "audit-report.md");
const callsFile = flag("--calls");
const pricesFile = flag("--prices", path.join(__dirname, "prices.json"));
const preparedBy = flag("--prepared-by", "TokenGuard");
const recurse = !argv.includes("--no-recurse");
const includeJson = argv.includes("--include-json");
const force = argv.includes("--force");
const staleOk = argv.includes("--stale-ok");
// Provider rates move monthly; anything older than this is refused by default.
const STALE_AFTER_DAYS = staleOk ? Infinity : 45;

// Guard the output path before doing any work - an audit that silently
// overwrites last week's report is how a client gets sent the wrong numbers.
if (fs.existsSync(outFile) && !force) {
  die(`${outFile} already exists. Pass --force to overwrite, or choose another --out path.`);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    die(`reading ${label} (${file}): ${err.message}`);
  }
}

// ---------- 0. price table validation ----------
// typeof NaN === "number", so a plain typeof check lets NaN through and every
// downstream figure silently becomes NaN. Validate at load, once, loudly.
const isNum = v => typeof v === "number" && Number.isFinite(v);
const isDate = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const VALID_ENCODERS = new Set(["o200k_base", "cl100k_base"]);

const prices = readJson(pricesFile, "price table");
const priceErrors = [];

if (!isDate(prices._verified)) {
  priceErrors.push(`_verified must be a YYYY-MM-DD date. This table drives every figure in the report; an undated rate is not auditable.`);
} else {
  // A date alone is not freshness. Provider rates move monthly, and a table
  // verified long ago is as wrong as one with no date at all - it just looks
  // handled. Refuse rather than quietly price a client's stack on stale rates.
  const ageDays = Math.floor((Date.now() - Date.parse(prices._verified)) / 86400000);
  if (ageDays > STALE_AFTER_DAYS) {
    priceErrors.push(`rates were last verified ${ageDays} days ago (${prices._verified}), beyond the ${STALE_AFTER_DAYS}-day limit. Re-verify against the providers' live pricing pages and update _verified, or pass --stale-ok to run anyway.`);
  }
}
if (!prices.models || typeof prices.models !== "object" || Object.keys(prices.models).length === 0) {
  priceErrors.push(`no "models" defined.`);
}

for (const [key, m] of Object.entries(prices.models || {})) {
  const at = `models.${key}`;
  if (typeof m.provider !== "string" || !m.provider) priceErrors.push(`${at}.provider is required (routing is restricted to same-provider candidates).`);
  for (const f of ["inputPerMTok", "outputPerMTok"]) {
    if (!isNum(m[f]) || m[f] < 0) priceErrors.push(`${at}.${f} must be a finite non-negative number.`);
  }
  for (const f of ["cachedInputPerMTok", "cacheWritePerMTok", "minCacheableTokens"]) {
    if (m[f] != null && (!isNum(m[f]) || m[f] < 0)) priceErrors.push(`${at}.${f} must be a finite non-negative number or omitted.`);
  }
  if (m.tokenizer != null && !VALID_ENCODERS.has(m.tokenizer)) {
    priceErrors.push(`${at}.tokenizer must be ${[...VALID_ENCODERS].join(" | ")} or null.`);
  }
  if (m._expires != null) {
    if (!isDate(m._expires)) priceErrors.push(`${at}._expires must be a YYYY-MM-DD date.`);
    // A rate that already reverted is not "scheduled" - the table is stating
    // rates the provider no longer charges. Refuse rather than understate a bill.
    else if (Date.parse(m._expires) < Date.now()) {
      const ago = Math.floor((Date.now() - Date.parse(m._expires)) / 86400000);
      priceErrors.push(`${at}._expires passed ${ago} day(s) ago (${m._expires}). This model now bills at its _revertsTo rates. Move those into inputPerMTok/outputPerMTok and delete the _expires block.`);
    }
    const r = m._revertsTo;
    if (!r || !isNum(r.inputPerMTok) || !isNum(r.outputPerMTok)) {
      // A dated rate change that cannot be modelled is worse than none,
      // because it looks handled.
      priceErrors.push(`${at}._expires requires _revertsTo with numeric inputPerMTok and outputPerMTok.`);
    }
  }
}

// fx is applied whole or not at all. A partially applied conversion produces
// figures that look converted and are not.
let fx = null;
if (prices.fx != null) {
  const f = prices.fx;
  if (!isNum(f.perUsd) || f.perUsd <= 0 || typeof f.symbol !== "string" || typeof f.code !== "string" || !isDate(f.asOf)) {
    priceErrors.push(`fx must carry a positive numeric perUsd, a symbol, a code and a dated asOf - or be null.`);
  } else {
    fx = f;
  }
}

if (priceErrors.length) {
  console.error(`Error: ${pricesFile} failed validation:`);
  for (const e of priceErrors) console.error(`  - ${e}`);
  process.exit(1);
}

// ---------- load prompts ----------
const BASE_EXTS = [".txt", ".md", ".prompt", ".yaml", ".yml"];
const EXTS = new Set(includeJson ? [...BASE_EXTS, ".json"] : BASE_EXTS);
const SKIP_DIRS = new Set(["node_modules", ".git", ".github", ".venv", "dist", "build", "coverage", ".next", "vendor"]);
// A package-lock.json counted as a prompt asset distorts the headline token
// figure by orders of magnitude. Denied even under --include-json.
const DENY_FILES = new Set([
  "package-lock.json", "package.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
  "tsconfig.json", "jsconfig.json", ".eslintrc.json", "renovate.json", "manifest.json",
]);

function collect(dir, base = dir) {
  let found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    die(`reading directory ${dir}: ${err.message}`);
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recurse && !SKIP_DIRS.has(e.name)) found = found.concat(collect(full, base));
    } else if (EXTS.has(path.extname(e.name).toLowerCase()) && !DENY_FILES.has(e.name.toLowerCase())) {
      // Store POSIX-style regardless of platform. path.relative yields
      // backslashes on Windows, which would never match a calls file written
      // with forward slashes - the entry would skip silently and vanish from
      // every total, on Windows only.
      found.push({ name: path.relative(base, full).split(path.sep).join("/"), full });
    }
  }
  return found;
}

const files = collect(promptsDir).sort((a, b) => a.name.localeCompare(b.name, "en"));
if (files.length === 0) {
  die(`no prompt files (${[...EXTS].join(" ")}) found in ${promptsDir}${includeJson ? "" : " - pass --include-json if your prompts are .json"}`);
}

const unreadable = [];
const prompts = files.map(f => {
  try { return { name: f.name, text: fs.readFileSync(f.full, "utf8") }; }
  catch (err) { unreadable.push(`${f.name} (${err.code || err.message})`); return null; }
}).filter(Boolean);
if (prompts.length === 0) die(`no readable prompt files in ${promptsDir}.`);

// ---------- 1. token counts ----------
for (const p of prompts) {
  p.tokens_o200k = encode(p.text).length;
  p.tokens_cl100k = encodeCl100k(p.text).length;
}

// ---------- 2. formatting bloat (code-fence safe, see lib.js) ----------
for (const p of prompts) {
  p.ws = whitespaceAudit(p.text);
  p.cleaned = cleanText(p.text);
  p.tokens_cleaned = encode(p.cleaned).length;
  p.tokens_cleaned_cl100k = encodeCl100k(p.cleaned).length;
  p.ws_savings = p.tokens_o200k - p.tokens_cleaned;
  // detectEol resolves a mixed file to its majority ending, so the minority
  // endings are normalised in the cleaned copy. That is a change to the
  // client's bytes beyond whitespace removal, so it is disclosed rather than
  // folded silently into the measured saving.
  p.mixedEol = hasMixedEol(p.text);
}
const mixedEolFiles = prompts.filter(p => p.mixedEol).map(p => p.name);

// ---------- 3. redundancy ledger ----------
const ledger = [];
const sh = prompts.map(p => shingles(p.text));
const tooShort = prompts.filter((p, i) => sh[i].size === 0).map(p => p.name);
const crossMode = [];

for (let i = 0; i < prompts.length; i++) {
  for (let j = i + 1; j < prompts.length; j++) {
    // Word shingles and character shingles are not comparable. Reporting a
    // containment of 0 across modes would present a non-measurement as a result.
    if (sh[i].mode !== sh[j].mode && sh[i].size && sh[j].size) {
      crossMode.push(`${prompts[i].name} / ${prompts[j].name}`);
      continue;
    }
    const c = containment(sh[i], sh[j]);
    if (c >= THRESHOLD) {
      // Containment is measured against the SMALLER shingle set. Scale the
      // overlap by the token count of that same document, not an unrelated one.
      const basis = sh[i].size <= sh[j].size ? prompts[i] : prompts[j];
      ledger.push({
        a: prompts[i].name,
        b: prompts[j].name,
        containment: +c.toFixed(2),
        basis: basis.name,
        overlapTokensApprox: Math.round(c * basis.tokens_o200k),
      });
    }
  }
}

// ---------- 4. cost pipeline ----------
const calls = callsFile ? readJson(callsFile, "calls file") : null;
if (calls && !Array.isArray(calls)) die(`${callsFile} must be a JSON array of call entries.`);

// Every field in the calls file multiplies into a euro figure, so "is a number"
// is not a sufficient test. A negative write count produced a NEGATIVE cost and
// a saving larger than the entire bill; 1e308 produced Infinity at exit 0.
const MAX_CALLS_PER_MONTH = 1e9;
const MAX_OUTPUT_TOKENS = 1e6;

// Validated once, here, before any pricing runs. A malformed volume is not a
// per-entry footnote in a report the client will act on - it stops the audit.
// Skipping (exit 2) is reserved for entries that are merely incomplete, such as
// a missing avgOutputTokens; these are wrong, which is a different thing.
function validateCalls(entries) {
  const errors = [];
  const seen = new Map(); // "prompt||model" -> [index, ...]

  entries.forEach((c, i) => {
    if (c === null || typeof c !== "object" || Array.isArray(c)) {
      errors.push(`entry [${i}]: must be a JSON object.`);
      return;
    }
    // Number.isFinite, not typeof: typeof Infinity === "number", and Infinity
    // reached the report as "Current modelled spend: EUR Infinity/month". The
    // typeof guard in turn rejects "1e999", which Number() would silently turn
    // into Infinity, along with every other numeric-looking string.
    const cpm = c.callsPerMonth;
    if (typeof cpm !== "number" || !Number.isFinite(cpm) || cpm <= 0 || cpm > MAX_CALLS_PER_MONTH) {
      errors.push(`entry [${i}].callsPerMonth: must be a finite number between 1 and ${MAX_CALLS_PER_MONTH.toLocaleString("en-US")}, got ${JSON.stringify(cpm)}.`);
    }
    // Optional. Absent or zero is handled downstream as "caching not modelled";
    // negative is not a missing input, it is a wrong one, and it inverted the
    // read/write split into a negative cost and a saving 196% of total spend.
    const cw = c.cacheWritesPerMonth;
    if (typeof cw === "number" && (!Number.isFinite(cw) || cw < 0)) {
      errors.push(`entry [${i}].cacheWritesPerMonth: must be 0 or a positive finite number, got ${JSON.stringify(cw)}.`);
    }
    const key = `${c.prompt}||${c.model}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(i);
  });

  // Name every colliding index, not just the repeats. A file with three copies
  // of one pair should be fixed in one pass, not three runs.
  for (const [key, idx] of seen) {
    if (idx.length < 2) continue;
    const [prompt, model] = key.split("||");
    errors.push(`entries [${idx.join("], [")}]: duplicate {prompt: ${JSON.stringify(prompt)}, model: ${JSON.stringify(model)}} - merge the volumes into one entry. Two rows doubled section 3 while section 6 matched only the first, so the tables disagreed.`);
  }
  return errors;
}

if (calls) {
  const callsErrors = validateCalls(calls);
  if (callsErrors.length) {
    console.error(`Error: ${callsFile} failed validation:`);
    for (const e of callsErrors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

const rows = [];
const routingFlags = [];
const routingBlind = new Set();
const routingNoCandidates = new Set();
const skipped = [];
const cachingGaps = [];
const modelsInUse = new Set();

// Cost must use the encoder the model actually bills on. Where a model
// declares no tokenizer we fall back and mark the row approximate rather
// than pretending the count is exact.
function tokensFor(model, p) {
  if (model.tokenizer === "cl100k_base") return { raw: p.tokens_cl100k, clean: p.tokens_cleaned_cl100k, approx: false };
  if (model.tokenizer === "o200k_base") return { raw: p.tokens_o200k, clean: p.tokens_cleaned, approx: false };
  return { raw: p.tokens_o200k, clean: p.tokens_cleaned, approx: true };
}

if (calls) {
  for (const c of calls) {
    const label = c && c.prompt ? String(c.prompt) : "(unnamed entry)";
    const exact = prompts.filter(x => x.name === c.prompt);
    const byBase = exact.length ? exact : prompts.filter(x => path.basename(x.name) === c.prompt);
    const p = byBase[0];
    const m = prices.models[c.model];

    if (!p) { skipped.push(`${label}: prompt not found in ${promptsDir}`); continue; }
    // Two files can share a basename and differ in size by orders of magnitude.
    // Picking the first by sort order would price the wrong document silently.
    if (!exact.length && byBase.length > 1) {
      skipped.push(`${label}: ambiguous - matches ${byBase.map(x => x.name).join(", ")}. Use the full relative path in the calls file`);
      continue;
    }
    if (!m) { skipped.push(`${label}: model "${c.model}" not in price table`); continue; }
    // callsPerMonth and duplicate {prompt, model} pairs are already validated
    // fatally in validateCalls above, before any pricing ran.
    // Missing output volume is not zero output. Zero would understate current
    // cost, which understates every saving measured against it.
    if (!isNum(c.avgOutputTokens) || c.avgOutputTokens < 0 || c.avgOutputTokens > MAX_OUTPUT_TOKENS) { skipped.push(`${label}: avgOutputTokens missing or out of range - cannot price output, entry excluded`); continue; }

    modelsInUse.add(c.model);
    const t = tokensFor(m, p);
    const out = c.avgOutputTokens;
    const perM = (tok, rate) => (tok * c.callsPerMonth / 1e6) * rate;

    // --- step 0: current ---
    const current = perM(t.raw, m.inputPerMTok) + perM(out, m.outputPerMTok);

    // --- step 1: routing (same provider, same declared type, must at least halve) ---
    let target = c.model, tm = m, afterRouting = current;
    // Short prompt, near-empty output: the classification/extraction shape.
    // 400 input tokens and 25 output tokens are the cutoffs; above them a
    // premium model is plausibly earning its cost and the flag would be noise.
    const eligible = m.type != null && t.raw < 400 && out <= 25;
    if (m.type == null) routingBlind.add(c.model);
    if (eligible) {
      const best = Object.entries(prices.models)
        .filter(([k, mm]) => k !== c.model && mm.provider === m.provider && mm.type === m.type)
        .map(([k, mm]) => {
          const tt = tokensFor(mm, p);
          return { key: k, model: mm, cost: perM(tt.raw, mm.inputPerMTok) + perM(out, mm.outputPerMTok) };
        })
        .sort((a, b) => a.cost - b.cost)[0];
      if (!best) routingNoCandidates.add(c.model);
      if (best && best.cost <= current * 0.5) {
        target = best.key; tm = best.model; afterRouting = best.cost;
        routingFlags.push({
          prompt: p.name, from: c.model, to: best.key, provider: m.provider,
          monthlySavings: current - best.cost,
        });
      }
    }

    // --- step 2: cleanup, priced at the post-routing model ---
    const tt = tokensFor(tm, p);
    const afterCleanup = perM(tt.clean, tm.inputPerMTok) + perM(out, tm.outputPerMTok);

    // --- step 3: caching, priced on the post-cleanup prompt ---
    // Requires a read rate, a write rate, a declared per-model minimum, a
    // declared stable prefix, and a write count. Missing any one and caching
    // is not modelled - the column says so and names what is missing.
    let afterCaching = null, cacheNote = null;
    const missing = [];
    if (tm.cachedInputPerMTok == null) missing.push("cachedInputPerMTok (read rate)");
    if (tm.cacheWritePerMTok == null) missing.push("cacheWritePerMTok (write rate)");
    if (tm.minCacheableTokens == null) missing.push("minCacheableTokens (per-model floor)");
    if (!isNum(c.cacheablePrefixTokens)) missing.push("cacheablePrefixTokens (declared stable prefix)");
    // Zero writes would mean a prefix that is never first-written and never
    // expires. No provider offers that, and it is the most likely value a
    // client supplies by accident - it yields the largest saving the tool can
    // produce. Treated as unmodellable, not as a free permanent cache.
    if (!isNum(c.cacheWritesPerMonth) || c.cacheWritesPerMonth <= 0) missing.push("cacheWritesPerMonth (writes incl. TTL expiries; must be at least 1)");

    if (missing.length) {
      cacheNote = `not modelled - missing ${missing.join(", ")}`;
      cachingGaps.push({ prompt: p.name });
    } else if (c.cacheablePrefixTokens < tm.minCacheableTokens) {
      cacheNote = `not eligible - prefix ${c.cacheablePrefixTokens} tok is below the ${tm.minCacheableTokens} tok minimum for ${target}; nothing caches`;
      cachingGaps.push({ prompt: p.name });
    } else {
      const prefix = Math.min(c.cacheablePrefixTokens, tt.clean);
      const remainder = Math.max(0, tt.clean - prefix);
      // A call is either a hit or a miss, never both. On a miss you pay the
      // write rate for the prefix, not the read rate. Charging every call a
      // read and then adding writes on top overstates the cached cost, which
      // can flip the verdict and talk a client out of a real saving.
      const writeCalls = Math.min(c.cacheWritesPerMonth, c.callsPerMonth);
      const readCalls = Math.max(0, c.callsPerMonth - writeCalls);
      const reads = (prefix * readCalls / 1e6) * tm.cachedInputPerMTok;
      const writes = (prefix * writeCalls / 1e6) * tm.cacheWritePerMTok;
      afterCaching = reads + writes + perM(remainder, tm.inputPerMTok) + perM(out, tm.outputPerMTok);
      if (afterCaching > afterCleanup) {
        cacheNote = `caching costs more than it saves here - ${c.cacheWritesPerMonth.toLocaleString("en-US")} writes/mo against ${c.callsPerMonth.toLocaleString("en-US")} calls`;
      }
    }

    rows.push({
      // tt is the post-routing model's encoder - the one every figure after
      // step 1 is priced with. Marking the row from the pre-routing model
      // would make the footnote false.
      prompt: p.name, model: c.model, target, calls: c.callsPerMonth, approx: tt.approx,
      current, afterRouting, afterCleanup, afterCaching, cacheNote,
      final: afterCaching != null && afterCaching < afterCleanup ? afterCaching : afterCleanup,
    });
  }
}

// ---------- 5. scheduled rate changes ----------
// Reported separately from savings and never netted against them: an increase
// you cannot avoid is not the same kind of number as a saving you can capture.
const today = new Date();
const exposures = [];
const exposureReducedByRouting = new Set();
for (const key of modelsInUse) {
  const m = prices.models[key];
  if (!m._expires) continue;
  let atCurrent = 0, atReverted = 0;
  for (const r of rows.filter(r => r.model === key)) {
    const c = calls.find(x => (x.prompt === r.prompt || x.prompt === path.basename(r.prompt)) && x.model === key);
    const p = prompts.find(x => x.name === r.prompt);
    if (!c || !p) continue;
    const t = tokensFor(m, p);
    const perM = (tok, rate) => (tok * c.callsPerMonth / 1e6) * rate;
    // Raw tokens, matching section 3's "Current" column. Pricing the exposure
    // on post-cleanup tokens made the two tables disagree on the same model in
    // the same month, and understated an increase the client cannot avoid.
    atCurrent += perM(t.raw, m.inputPerMTok) + perM(c.avgOutputTokens, m.outputPerMTok);
    atReverted += perM(t.raw, m._revertsTo.inputPerMTok) + perM(c.avgOutputTokens, m._revertsTo.outputPerMTok);
    if (r.target !== r.model) exposureReducedByRouting.add(key);
  }
  exposures.push({
    model: key, expires: m._expires,
    days: Math.ceil((Date.parse(m._expires) - today) / 86400000),
    atCurrent, atReverted, delta: atReverted - atCurrent,
  });
}

// ---------- 6. report ----------
const esc = s => String(s).replace(/\|/g, "\\|");
const n0 = n => n.toLocaleString("en-US");
const money = n => fx ? `${fx.symbol}${(n * fx.perUsd).toFixed(2)}` : `$${n.toFixed(2)}`;

const totalTokens = prompts.reduce((s, p) => s + p.tokens_o200k, 0);
const totalWsSavings = prompts.reduce((s, p) => s + p.ws_savings, 0);
const totalCurrent = rows.reduce((s, r) => s + r.current, 0);
const totalFinal = rows.reduce((s, r) => s + r.final, 0);
const totalSaving = totalCurrent - totalFinal;
// A saving cannot exceed the spend it is measured against. If this ever fires,
// an input passed validation that should not have - refuse rather than print it.
if (rows.length && (totalSaving < -1e-9 || totalSaving > totalCurrent + 1e-9 || !Number.isFinite(totalSaving))) {
  die(`internal check failed: computed saving (${totalSaving}) is not within 0 and total spend (${totalCurrent}). Refusing to write a report. Check the calls file for out-of-range values.`);
}
const anyApprox = rows.some(r => r.approx);

// The fix list is derived from what was actually found, ranked by measured
// impact - not a static list of good ideas.
const fixes = [];
if (routingFlags.length) {
  const v = routingFlags.reduce((s, r) => s + r.monthlySavings, 0);
  fixes.push({ v, text: `**Model routing** - ${routingFlags.length} prompt(s) flagged in section 4, ${money(v)}/month. Validate on a 200-sample eval before switching.` });
}
const cleanupValue = rows.reduce((s, r) => s + (r.afterRouting - r.afterCleanup), 0);
// Count tokens only across prompts that were actually priced - totalWsSavings
// spans the whole library and would describe a different set from the euro figure.
const pricedNames = new Set(rows.map(r => r.prompt));
const pricedWsSavings = prompts.filter(p => pricedNames.has(p.name)).reduce((s, p) => s + p.ws_savings, 0);
if (cleanupValue > 0) fixes.push({ v: cleanupValue, text: `**Formatting cleanup** - ${n0(pricedWsSavings)} tokens per call cycle across priced prompts, ${money(cleanupValue)}/month. No behaviour change; safe to ship first.` });
const cacheValue = rows.reduce((s, r) => s + (r.afterCaching != null && r.afterCaching < r.afterCleanup ? r.afterCleanup - r.afterCaching : 0), 0);
if (cacheValue > 0) fixes.push({ v: cacheValue, text: `**Prompt caching** - ${money(cacheValue)}/month on prompts with a declared stable prefix above the per-model minimum.` });
if (ledger.length) fixes.push({ v: 0, text: `**Deduplicate shared instruction blocks** - ${ledger.length} pair(s) in section 2. Value depends on call mix; not priced here.` });
if (cachingGaps.length) fixes.push({ v: 0, text: `**Supply the caching inputs** - ${cachingGaps.length} prompt(s) could not be modelled (section 5). Each is a saving that may exist and is currently invisible.` });
fixes.sort((a, b) => b.v - a.v);

const md = `# AI Spend Audit - Findings Report

**Prepared by:** ${esc(preparedBy)} · **Date:** ${today.toISOString().slice(0, 10)}
**Scope:** ${n0(prompts.length)} prompt assets · ${n0(totalTokens)} tokens (o200k_base, measured - not estimated)

> Rates from \`${esc(path.basename(pricesFile))}\`, verified ${prices._verified}. Provider rates are published in USD.${fx ? ` Figures shown in ${fx.code} at 1 USD = ${fx.perUsd} ${fx.code}, rate as of ${fx.asOf}.` : ""}
${rows.length ? `\n**Current modelled spend: ${money(totalCurrent)}/month. Identified saving: ${money(totalSaving)}/month (${money(totalSaving * 12)}/year).**\n` : ""}
## 1. Prompt Inventory

| Prompt | Tokens (o200k) | Tokens (cl100k) | Formatting savings (measured) |
|---|---|---|---|
${prompts.map(p => `| ${esc(p.name)} | ${n0(p.tokens_o200k)} | ${n0(p.tokens_cl100k)} | ${p.ws_savings} tok (${p.ws.trailing} trailing, ${p.ws.multiBlank} extra blank lines, ${p.ws.spaceRuns} inline space runs) |`).join("\n")}

**Total recoverable from formatting alone: ${n0(totalWsSavings)} tokens per call cycle.**
Measured by re-tokenizing a cleaned copy. Fenced code blocks are left byte-for-byte untouched, and inline space runs are reported but not removed - so this figure is a floor.
${mixedEolFiles.length ? `\n_Mixed line endings in ${mixedEolFiles.map(esc).join(", ")}. Each file's majority ending was used for the cleaned copy, so the saving quoted for these files also normalises the minority endings - a change beyond whitespace removal. Confirm that is acceptable before applying the cleanup._\n` : ""}
## 2. Redundancy Ledger (containment >= ${THRESHOLD})

${ledger.length === 0 ? "_No cross-prompt redundancy above threshold._" :
`| Prompt A | Prompt B | Containment | Approx. overlapping tokens | Measured against |
|---|---|---|---|---|
${ledger.map(r => `| ${esc(r.a)} | ${esc(r.b)} | ${(r.containment * 100).toFixed(0)}% | ~${n0(r.overlapTokensApprox)} | ${esc(r.basis)} |`).join("\n")}

**Recommendation:** extract shared blocks into a single cached/system segment; pass variant-specific content only.`}
${tooShort.length ? `\n_Too short for redundancy comparison: ${tooShort.map(esc).join(", ")}._` : ""}${crossMode.length ? `\n_Not compared (one document uses word shingles, the other character shingles - the two are not comparable): ${crossMode.map(esc).join("; ")}._` : ""}

## 3. Monthly Cost Projection

${rows.length === 0 ? (calls ? `_Every calls entry was skipped - see the list below. No cost figure can be derived from this input._` : "_No calls file supplied - cost modelling skipped. Request a 30-day usage export._") :
`One ordered pipeline: current -> routing -> cleanup -> caching. Each step is priced on the output of the previous one, so the steps sum without double counting.

| Prompt | Model | Calls/mo | Current | + routing | + cleanup | + caching |
|---|---|---|---|---|---|---|
${rows.map(r => `| ${esc(r.prompt)}${r.approx ? " (approx)" : ""} | ${esc(r.model)}${r.target !== r.model ? ` -> ${esc(r.target)}` : ""} | ${n0(r.calls)} | ${money(r.current)} | ${money(r.afterRouting)} | ${money(r.afterCleanup)} | ${r.afterCaching != null ? money(r.afterCaching) : "not modelled"} |`).join("\n")}
| **Total** | | | **${money(totalCurrent)}** | | | **${money(totalFinal)}** |

**Identified saving: ${money(totalSaving)}/month · ${money(totalSaving * 12)}/year.**${anyApprox ? `\n\n_Rows marked (approx) were priced with a fallback encoder (o200k_base) because the model declares no \`tokenizer\` in the price table. Non-OpenAI tokenizers typically differ by a few percent on English prose and more on code and non-Latin scripts; treat these rows as indicative and confirm against the provider's own usage figures before acting on them._` : ""}`}
${skipped.length ? `\n**Skipped entries (excluded from every figure above):**\n${skipped.map(s => `- ${esc(s)}`).join("\n")}` : ""}

## 4. Model-Routing Flags

${routingFlags.length === 0 ? `_No over-routing detected among same-provider, same-type candidates._${routingBlind.size ? `\n\n**This check could not run** for ${[...routingBlind].map(esc).join(", ")} - no \`type\` declared, so no candidate was eligible. Declare \`type\` in the price table before reading this section as a clean result.` : ""}${routingNoCandidates.size ? `\n\n**No alternative existed** for ${[...routingNoCandidates].map(esc).join(", ")} - the price table lists no other model with the same provider and type.` : ""}` :
`${routingBlind.size ? `**This check was blind** for ${[...routingBlind].map(esc).join(", ")} - no \`type\` declared in the price table.\n\n` : ""}` +
routingFlags.map(r => `- **${esc(r.prompt)}**: move \`${esc(r.from)}\` -> \`${esc(r.to)}\` (same provider: ${esc(r.provider)}) = **${money(r.monthlySavings)}/month**. Short prompt with near-empty output on a premium model - classic classification/extraction over-routing. Validate quality on the smaller model with a 200-sample eval before switching.`).join("\n")}

Candidates are restricted to the same provider and the same declared type. A cross-provider swap is a migration, not a config change, and is never priced as if it were free.

## 5. Caching

${rows.length === 0 ? (calls ? "_No entry could be priced._" : "_No calls file supplied._") :
(rows.filter(r => r.cacheNote).length === 0 ? "_Caching modelled for every priced prompt._" :
rows.filter(r => r.cacheNote).map(r => `- **${esc(r.prompt)}**: ${esc(r.cacheNote)}`).join("\n"))}

A cache read rate alone cannot price caching. The write is paid on the first call and on every TTL expiry, only the declared stable prefix is eligible, and every provider enforces a per-model minimum below which nothing caches at all.

## 6. Scheduled Rate Changes

${exposures.length === 0 ? "_No model in use carries a dated rate change._" :
`These are **increases**, not savings, and are reported separately. No optimisation in this report prevents them.

| Model | Expires | Days left | At current rate | After reversion | Monthly increase |
|---|---|---|---|---|---|
${exposures.map(e => `| ${esc(e.model)} | ${e.expires} | ${e.days} | ${money(e.atCurrent)} | ${money(e.atReverted)} | **+${money(e.delta)}** |`).join("\n")}

Priced on current usage at raw token counts, on the same basis as section 3's Current column.${[...exposureReducedByRouting].length ? ` Note: section 4 recommends routing away from ${[...exposureReducedByRouting].map(esc).join(", ")}; acting on that reduces this exposure accordingly.` : ""}`}

## 7. Prioritized Fix List

${fixes.length === 0 ? "_No findings._" : fixes.map((f, i) => `${i + 1}. ${f.text}`).join("\n")}

## 8. Method and Limits

Token counts are measured with \`gpt-tokenizer\` (\`o200k_base\`, \`cl100k_base\`), never estimated. Formatting savings are confirmed by re-tokenizing the cleaned text. Redundancy uses ${SHINGLE_K}-word shingle containment at a ${THRESHOLD} threshold${sh.some(x => x.mode === "char") ? `, falling back to ${CHAR_SHINGLE_K}-character shingles for scripts without word separators` : ""}.

**Not modelled, and to be handled as separate findings:** batch pricing (50% off on both major providers), reasoning-token billing (billed as output, absent from the response body), long-context rate tiers, retry and error-path waste, unbounded conversation history, and RAG over-retrieval. These require a request-level usage export rather than a prompt library.

All figures in ${fx ? fx.code : "USD"}.
`;

fs.writeFileSync(outFile, md);

console.log(`OK ${n0(prompts.length)} prompts, ${n0(totalTokens)} tokens`);
if (rows.length) console.log(`OK Recoverable: ${money(totalSaving)}/month (${money(totalSaving * 12)}/yr)`);
console.log(`OK Redundancy pairs >=${THRESHOLD}: ${ledger.length}`);
if (routingFlags.length) console.log(`OK Routing flags: ${routingFlags.length}`);
if (cachingGaps.length) console.log(`!  Caching not modelled for ${cachingGaps.length} prompt(s)`);
if (exposures.length) console.log(`!  Scheduled rate change on ${exposures.length} model(s) in use`);
if (skipped.length) console.log(`!  Skipped ${skipped.length} calls entr${skipped.length === 1 ? "y" : "ies"}`);
console.log(`OK Report: ${outFile}`);

// A partial audit must never be mistaken for a clean one.
process.exit(skipped.length ? 2 : 0);
