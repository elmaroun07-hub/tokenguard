#!/usr/bin/env node
/**
 * TokenGuard log readiness check.
 *
 *   node verify.js tokenguard-usage.ndjson
 *
 * Run this on day 1, not day 7. Every finding a cost audit can produce depends
 * on a specific field being populated; this reports which findings the capture
 * can currently support and which are still blind. Exit 1 if the log cannot
 * support a cost projection at all.
 */

"use strict";

const fs = require("fs");

const file = process.argv[2] || "tokenguard-usage.ndjson";
if (!fs.existsSync(file)) {
  console.error(`Error: ${file} not found. Set TOKENGUARD_LOG or pass the path.`);
  process.exit(1);
}

let raw;
try {
  if (fs.statSync(file).isDirectory()) { console.error(`Error: ${file} is a directory. Pass the .ndjson file itself.`); process.exit(1); }
  raw = fs.readFileSync(file, "utf8");
} catch (err) {
  console.error(`Error reading ${file}: ${err.code || err.message}`);
  process.exit(1);
}
const lines = raw.split("\n").filter(Boolean);
const rows = [];
let malformed = 0;
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    // JSON.parse("null") succeeds and returns null; so do bare numbers and
    // arrays. Only a plain object is a usable record - reading .status off
    // null threw an uncaught TypeError at the client's terminal.
    if (o && typeof o === "object" && !Array.isArray(o)) rows.push(o); else malformed++;
  } catch { malformed++; }
}

if (rows.length === 0) {
  console.error(`Error: no readable records in ${file}.`);
  process.exit(1);
}

const has = f => rows.filter(r => r[f] !== null && r[f] !== undefined).length;
const pct = n => {
  const v = (n / rows.length) * 100;
  return v > 0 && v < 1 ? "<1%" : `${v.toFixed(0)}%`;
};
const ok = rows.filter(r => r.status === "ok");
const errors = rows.filter(r => r.status === "error");

const times = rows.map(r => Date.parse(r.ts)).filter(t => !isNaN(t)).sort((a, b) => a - b);
const spanDays = times.length > 1 ? (times[times.length - 1] - times[0]) / 86400000 : 0;
const paths = new Set(rows.map(r => r.path).filter(Boolean));
const models = new Set(rows.map(r => r.model).filter(Boolean));

console.log(`\nTokenGuard log readiness — ${file}\n`);
console.log(`  Records          ${rows.length.toLocaleString("en-US")}${malformed ? ` (${malformed} malformed, skipped)` : ""}`);
console.log(`  Window           ${spanDays.toFixed(1)} days`);
console.log(`  Successful       ${ok.length.toLocaleString("en-US")}`);
console.log(`  Errors           ${errors.length.toLocaleString("en-US")}${errors.length ? ` (${pct(errors.length)})` : ""}`);
console.log(`  Call paths       ${paths.size || "— none labelled"}`);
console.log(`  Models           ${[...models].join(", ") || "—"}`);

// Coverage below this cannot support a per-path figure: the audit would be
// extrapolating from a fraction of traffic while the client reads it as a
// measurement of all of it.
const REQUIRED_COVERAGE = 0.9;

const checks = [
  { field: "outputTokens", finding: "Cost projection + avgOutputTokens", required: true },
  { field: "path",         finding: "Per-path cost breakdown",           required: true },
  { field: "inputHash",    finding: "Retry storms / duplicate calls",     required: false },
  { field: "conversationId", finding: "Unbounded conversation history",   required: false },
  { field: "retrievedTokens", finding: "RAG over-retrieval",              required: false },
  { field: "cachedReadTokens", finding: "Cache hit rate",                 required: false },
  { field: "reasoningTokens", finding: "Reasoning-token billing gap",     required: false },
];

console.log(`\n  Coverage by finding:`);
let blocked = false;
for (const c of checks) {
  const n = has(c.field);
  const state = n === 0 ? "BLIND" : n < rows.length * REQUIRED_COVERAGE ? "partial" : "ready";
  // "present on one record in 100,000" is not coverage. A required field below
  // the threshold blocks exactly as an absent one does.
  if (c.required && n < rows.length * REQUIRED_COVERAGE) blocked = true;
  console.log(`    ${state.padEnd(8)} ${c.finding.padEnd(38)} ${pct(n)} of records have ${c.field}`);
}

// Days are what make a projection defensible. A single busy afternoon is not a month.
console.log("");
// The capture window gates the verdict, not just the prose. A client scripting
// on the exit code would otherwise ship a two-hour sample as a month's traffic.
if (spanDays < 5) { blocked = true; console.log(`  ! ${spanDays.toFixed(1)} days captured. Seven days covers a full weekly cycle - weekend traffic differs. Keep logging.`); }
if (times.length === 0) { blocked = true; console.log(`  ! No parseable timestamps. The capture window cannot be established.`); }
if (paths.size === 0) console.log(`  ! No tgPath set. Every call is in one bucket; the expensive path stays hidden inside the average.`);
if (paths.size === 1 && rows.length > 200) console.log(`  ! Only one call path labelled. Confirm that is genuinely the whole surface.`);
if (has("conversationId") === 0) console.log(`  ! No conversationId. Unbounded-history growth cannot be measured — often the largest single leak in a chat product.`);
if (errors.length / rows.length > 0.02) console.log(`  ! Error rate above 2%. Check whether failures are being retried at full input cost.`);

const tooShortWindow = spanDays < 5;
console.log(blocked
  ? `\n  NOT READY — a required field is missing or below ${(REQUIRED_COVERAGE * 100).toFixed(0)}% coverage. A cost projection built on this would be a guess.\n`
  : tooShortWindow
    ? `\n  NOT READY YET — the fields are there, but ${spanDays.toFixed(1)} days is too short a window. Keep logging to seven days.\n`
    : `\n  READY for a cost projection.\n`);

// Exit code is what a client scripts on. A short window has to fail it too, or
// a two-hour capture ships as if it were a week of traffic.
process.exit(blocked || tooShortWindow ? 1 : 0);
