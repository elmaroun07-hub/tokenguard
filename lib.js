/**
 * TokenGuard core analysis functions.
 * Pure, dependency-light, and unit-tested — see test.js.
 */

const SHINGLE_K = 8;
const THRESHOLD = 0.5;

/** Iterate lines, telling the callback whether each is inside a fenced code block. */
function walkOutsideFences(text, onLine) {
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      onLine(line, true, true); // fence delimiter
      continue;
    }
    onLine(line, inFence, false);
  }
}

/** Count formatting bloat OUTSIDE fenced code blocks. */
function whitespaceAudit(text) {
  let trailing = 0, multiBlank = 0, blankRun = 0, spaceRuns = 0;
  walkOutsideFences(text, (line, inFence, isDelim) => {
    if (isDelim) { blankRun = 0; return; }
    if (inFence) return;
    if (/[ \t]+$/.test(line)) trailing++;
    if (line.trim() === "") { blankRun++; if (blankRun > 1) multiBlank++; }
    else blankRun = 0;
    const runs = line.match(/(?<=\S) {2,}(?=\S)/g);
    if (runs) spaceRuns += runs.length;
  });
  return { trailing, multiBlank, spaceRuns };
}

/**
 * Conservative cleanup: strips trailing whitespace and collapses blank-line runs
 * OUTSIDE fenced code blocks only. Inline multi-space runs are reported but NOT
 * removed (they can be load-bearing), so measured savings are a floor.
 */
function cleanText(text) {
  const out = [];
  let blankRun = 0;
  walkOutsideFences(text, (line, inFence, isDelim) => {
    if (isDelim || inFence) { out.push(line); blankRun = 0; return; }
    const stripped = line.replace(/[ \t]+$/, "");
    if (stripped.trim() === "") {
      blankRun++;
      if (blankRun > 1) return;
      out.push("");
    } else {
      blankRun = 0;
      out.push(stripped);
    }
  });
  return out.join("\n");
}

/** Word shingles of size k. Texts shorter than k words yield an empty set. */
function shingles(text, k = SHINGLE_K) {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().split(" ");
  const set = new Set();
  for (let i = 0; i <= words.length - k; i++) set.add(words.slice(i, i + k).join(" "));
  return set;
}

/** Containment similarity: |A n B| / min(|A|, |B|). */
function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  return inter / small.size;
}

module.exports = { SHINGLE_K, THRESHOLD, walkOutsideFences, whitespaceAudit, cleanText, shingles, containment };
