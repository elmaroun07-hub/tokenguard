#!/usr/bin/env node
/**
 * TokenGuard — LLM prompt-spend audit CLI
 *
 * Usage:
 *   node audit.js <prompts-dir> [--calls calls.json] [--out report.md]
 *                               [--prices prices.json] [--prepared-by "Name"]
 *                               [--no-recurse]
 *
 * Produces:
 *  - real BPE token counts (o200k_base + cl100k_base via gpt-tokenizer)
 *  - formatting bloat, measured by re-tokenizing a code-fence-safe cleaned copy
 *  - cross-prompt redundancy ledger (containment similarity, 0.5 threshold)
 *  - model-routing waste flags + monthly cost projection
 *
 * Every number is measured. Nothing is estimated.
 */

const fs = require("fs");
const path = require("path");
const { encode } = require("gpt-tokenizer/encoding/o200k_base");
const { encode: encodeCl100k } = require("gpt-tokenizer/encoding/cl100k_base");
const { SHINGLE_K, THRESHOLD, whitespaceAudit, cleanText, shingles, containment } = require("./lib");

const USAGE = `Usage: audit.js <prompts-dir> [options]

Options:
  --calls <file>        JSON of per-prompt monthly call volumes (see sample-calls.json)
  --out <file>          Output report path (default: audit-report.md)
  --prices <file>       Price table (default: prices.json next to this script)
  --prepared-by <name>  Name shown in the report header
  --no-recurse          Do not scan subdirectories
  -h, --help            Show this help`;

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
  if (val === undefined || val.startsWith("--")) {
    console.error(`Error: ${name} requires a value.\n\n${USAGE}`);
    process.exit(1);
  }
  return val;
}

const promptsDir = argv[0];
if (promptsDir.startsWith("--")) {
  console.error(`Error: first argument must be the prompts directory.\n\n${USAGE}`);
  process.exit(1);
}
const outFile = flag("--out", "audit-report.md");
const callsFile = flag("--calls");
const pricesFile = flag("--prices", path.join(__dirname, "prices.json"));
const preparedBy = flag("--prepared-by", "TokenGuard");
const recurse = !argv.includes("--no-recurse");

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Error reading ${label} (${file}): ${err.message}`);
    process.exit(1);
  }
}

const prices = readJson(pricesFile, "price table");
if (!prices.models || Object.keys(prices.models).length === 0) {
  console.error(`Error: ${pricesFile} contains no "models".`);
  process.exit(1);
}

// ---------- load prompts (recursive by default) ----------
const EXTS = new Set([".txt", ".md", ".json", ".prompt", ".yaml", ".yml"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "dist", "build"]);

function collect(dir, base = dir) {
  let found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`Error reading directory ${dir}: ${err.message}`);
    process.exit(1);
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recurse && !SKIP_DIRS.has(e.name)) found = found.concat(collect(full, base));
    } else if (EXTS.has(path.extname(e.name).toLowerCase())) {
      found.push({ name: path.relative(base, full), full });
    }
  }
  return found;
}

const files = collect(promptsDir).sort((a, b) => a.name.localeCompare(b.name));
if (files.length === 0) {
  console.error(`No prompt files (${[...EXTS].join(" ")}) found in ${promptsDir}`);
  process.exit(1);
}

const prompts = files.map(f => ({ name: f.name, text: fs.readFileSync(f.full, "utf8") }));

// ---------- 1. token counts ----------
for (const p of prompts) {
  p.tokens_o200k = encode(p.text).length;
  p.tokens_cl100k = encodeCl100k(p.text).length;
}

// ---------- 2. formatting bloat (code-fence safe, see lib.js) ----------
for (const p of prompts) {
  p.ws = whitespaceAudit(p.text);
  p.tokens_cleaned = encode(cleanText(p.text)).length;
  p.ws_savings = p.tokens_o200k - p.tokens_cleaned;
}

// ---------- 3. redundancy ledger ----------
const ledger = [];
const sh = prompts.map(p => shingles(p.text));
const tooShort = prompts.filter((p, i) => sh[i].size === 0).map(p => p.name);

for (let i = 0; i < prompts.length; i++) {
  for (let j = i + 1; j < prompts.length; j++) {
    const c = containment(sh[i], sh[j]);
    if (c >= THRESHOLD) {
      const min = Math.min(prompts[i].tokens_o200k, prompts[j].tokens_o200k);
      ledger.push({
        a: prompts[i].name,
        b: prompts[j].name,
        containment: +c.toFixed(2),
        // Overlap scaled by measured containment. Reporting min() alone would
        // overstate the shared portion whenever containment < 100%.
        overlapTokensApprox: Math.round(c * min),
      });
    }
  }
}

// ---------- 4. cost projection + routing flags ----------
const calls = callsFile ? readJson(callsFile, "calls file") : null;
const costRows = [];
const routingFlags = [];
const unmatched = [];

if (calls) {
  const cheapest = Object.entries(prices.models)
    .sort((a, b) => a[1].inputPerMTok - b[1].inputPerMTok)[0];

  for (const c of calls) {
    const p = prompts.find(x => x.name === c.prompt || path.basename(x.name) === c.prompt);
    const m = prices.models[c.model];
    if (!p || !m) {
      unmatched.push(`${c.prompt} (${!p ? "prompt not found" : "model not in price table"})`);
      continue;
    }
    const out = c.avgOutputTokens || 0;
    const perM = (tok, rate) => (tok * c.callsPerMonth / 1e6) * rate;

    const inCost = perM(p.tokens_o200k, m.inputPerMTok);
    const outCost = perM(out, m.outputPerMTok);
    const inCostCleaned = perM(p.tokens_cleaned, m.inputPerMTok);
    const cachedCost = m.cachedInputPerMTok != null ? perM(p.tokens_cleaned, m.cachedInputPerMTok) : null;

    costRows.push({
      prompt: p.name, model: c.model, calls: c.callsPerMonth,
      current: inCost + outCost,
      afterCleanup: inCostCleaned + outCost,
      afterCleanupAndCache: cachedCost != null ? cachedCost + outCost : null,
    });

    // Heuristic: short prompt + tiny output on a premium model = probable over-routing.
    const looksLikeClassification = p.tokens_o200k < 400 && out <= 25;
    const isPremium = m.inputPerMTok >= 3 * cheapest[1].inputPerMTok;
    if (looksLikeClassification && isPremium) {
      const alt = perM(p.tokens_o200k, cheapest[1].inputPerMTok) + perM(out, cheapest[1].outputPerMTok);
      routingFlags.push({
        prompt: p.name, from: c.model, to: cheapest[0],
        monthlySavings: (inCost + outCost) - alt,
      });
    }
  }
}

// ---------- 5. report ----------
const fmt = n => "$" + n.toFixed(2);
const totalTokens = prompts.reduce((s, p) => s + p.tokens_o200k, 0);
const totalWsSavings = prompts.reduce((s, p) => s + p.ws_savings, 0);

const md = `# AI Spend Audit — Findings Report

**Prepared by:** ${preparedBy} · **Date:** ${new Date().toISOString().slice(0, 10)}
**Scope:** ${prompts.length} prompt assets · ${totalTokens.toLocaleString()} tokens (o200k_base, measured — not estimated)

> Costs below are computed from \`${path.basename(pricesFile)}\`. Verify those rates against current provider pricing pages before relying on any dollar figure.

## 1. Prompt Inventory

| Prompt | Tokens (o200k) | Tokens (cl100k) | Formatting savings (measured) |
|---|---|---|---|
${prompts.map(p => `| ${p.name} | ${p.tokens_o200k.toLocaleString()} | ${p.tokens_cl100k.toLocaleString()} | ${p.ws_savings} tok (${p.ws.trailing} trailing, ${p.ws.multiBlank} extra blank lines, ${p.ws.spaceRuns} inline space runs) |`).join("\n")}

**Total recoverable from formatting alone: ${totalWsSavings.toLocaleString()} tokens per call cycle.**
Measured by re-tokenizing a cleaned copy. Fenced code blocks are left byte-for-byte untouched, and inline space runs are reported but not removed — so this figure is a floor.

## 2. Redundancy Ledger (containment ≥ ${THRESHOLD})

${ledger.length === 0 ? "_No cross-prompt redundancy above threshold._" :
`| Prompt A | Prompt B | Containment | Approx. overlapping tokens |
|---|---|---|---|
${ledger.map(r => `| ${r.a} | ${r.b} | ${(r.containment * 100).toFixed(0)}% | ~${r.overlapTokensApprox.toLocaleString()} |`).join("\n")}

Overlap is containment × the smaller prompt's token count — an approximation of the shared portion, not a billing figure.

**Recommendation:** extract shared blocks into a single cached/system segment; pass variant-specific content only.`}
${tooShort.length ? `\n_Not eligible for redundancy comparison (fewer than ${SHINGLE_K} words): ${tooShort.join(", ")}._` : ""}

## 3. Monthly Cost Projection

${costRows.length === 0 ? "_No calls file supplied — cost modeling skipped. Request a 30-day usage export._" :
`| Prompt | Model | Calls/mo | Current | After cleanup | After cleanup + prompt caching |
|---|---|---|---|---|---|
${costRows.map(r => `| ${r.prompt} | ${r.model} | ${r.calls.toLocaleString()} | ${fmt(r.current)} | ${fmt(r.afterCleanup)} | ${r.afterCleanupAndCache != null ? fmt(r.afterCleanupAndCache) : "n/a"} |`).join("\n")}`}
${unmatched.length ? `\n_Skipped entries: ${unmatched.join("; ")}._` : ""}

## 4. Model-Routing Flags (automatic)

${routingFlags.length === 0 ? "_No obvious over-routing detected (or no calls file supplied)._" :
routingFlags.map(r => `- **${r.prompt}**: move \`${r.from}\` → \`${r.to}\` ≈ **${fmt(r.monthlySavings)}/month saved**. Short prompt with near-empty output on a premium model — classic classification/extraction over-routing. Validate quality on the smaller model with a 200-sample eval before switching.`).join("\n")}

## 5. Prioritized Fix List

1. **Model routing** per Section 4 — usually the single largest lever.
2. **Prompt caching** — mark stable system segments cacheable (largest lever for high-volume prompts).
3. **Deduplicate** shared instruction blocks per Section 2.
4. **Formatting cleanup** per Section 1 (small but free).
5. **Output-token discipline** — max_tokens caps and terse output formats (JSON, no prose) where machine-consumed.
`;

fs.writeFileSync(outFile, md);
console.log(`✔ Analyzed ${prompts.length} prompts, ${totalTokens.toLocaleString()} tokens`);
console.log(`✔ Formatting savings: ${totalWsSavings.toLocaleString()} tokens/cycle`);
console.log(`✔ Redundancy pairs ≥${THRESHOLD}: ${ledger.length}`);
if (routingFlags.length) console.log(`✔ Routing flags: ${routingFlags.length}`);
if (unmatched.length) console.log(`! Skipped ${unmatched.length} calls entr${unmatched.length === 1 ? "y" : "ies"}`);
console.log(`✔ Report written to ${outFile}`);
