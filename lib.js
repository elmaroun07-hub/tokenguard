/**
 * TokenGuard core analysis functions.
 * Pure, dependency-light, and unit-tested — see test.js.
 */

const SHINGLE_K = 8;
const THRESHOLD = 0.5;

/**
 * Iterate lines, telling the callback whether each is inside a fenced code block.
 *
 * Line endings are normalised before splitting. A CRLF file leaves a trailing
 * "\r" on every line, which defeats the /[ \t]+$/ and .trim() checks
 * downstream: trailing whitespace goes undetected and blank-run collapsing
 * emits mixed endings that tokenize WORSE than the original. That produced a
 * negative "saving" in a client-facing report. The original ending is recorded
 * so cleanText can restore it exactly.
 *
 * Fence tracking follows CommonMark rather than a boolean toggle: both ``` and
 * ~~~ open a fence, and a fence is closed only by a run of the SAME character
 * at least as long as the opener. A three-backtick line inside a four-backtick
 * block is content, not a delimiter.
 */
function detectEol(text) {
  // Majority, not presence. Returning "\r\n" for any document containing a
  // single CRLF rewrote every other line ending in the file and booked the
  // difference as a "formatting saving" the client never asked for.
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/** True when a document mixes line-ending styles - worth disclosing, since the
 *  minority style is normalised and that is a change to the client's files. */
function hasMixedEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  return crlf > 0 && lf > 0;
}

function walkOutsideFences(text, onLine) {
  let fenceChar = null, fenceLen = 0;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^\ufeff? {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m) {
      const char = m[1][0], len = m[1].length;
      if (fenceChar === null) {
        // An opening fence may carry an info string; a closing one may not.
        fenceChar = char; fenceLen = len;
        onLine(line, true, true);
        continue;
      }
      if (char === fenceChar && len >= fenceLen && m[2].trim() === "") {
        fenceChar = null; fenceLen = 0;
        onLine(line, true, true);
        continue;
      }
      // Same-or-different marker that does not close the current fence:
      // ordinary content inside the block.
      onLine(line, true, false);
      continue;
    }
    onLine(line, fenceChar !== null, false);
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
  // Restore the document's own line ending. Rewriting a CRLF file as LF would
  // report a "saving" the client cannot realise without changing their files.
  return out.join(detectEol(text));
}

/**
 * Shingles of size k.
 *
 * Word shingles for whitespace-delimited scripts. Chinese, Japanese and Thai
 * do not separate words with spaces, so a 700-character Chinese prompt yields
 * zero word shingles and was previously reported as "fewer than 8 words" — a
 * false statement about a substantial document. Those texts fall back to
 * character n-grams.
 *
 * The set carries its mode. Comparing a word-shingle set against a
 * character-shingle set is meaningless, so audit.js skips cross-mode pairs
 * rather than reporting a containment of zero as if it were a measurement.
 */
const CHAR_SHINGLE_K = 12;

function shingles(text, k = SHINGLE_K) {
  const normalised = text.toLowerCase().replace(/\s+/g, " ").trim();
  const words = normalised ? normalised.split(" ") : [];
  const set = new Set();

  // Detect the scripts that genuinely lack word separators - CJK, kana, hangul
  // and Thai - rather than inferring it from a low word count. "Classify the
  // following customer support message" is 7 words and 55 characters, and was
  // being classed as separator-less and dropped from every comparison.
  const NO_SEPARATOR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u0e00-\u0e7f]/;
  if (words.length < k && NO_SEPARATOR.test(normalised) && normalised.replace(/\s/g, "").length >= CHAR_SHINGLE_K * 2) {
    const chars = normalised.replace(/\s/g, "");
    for (let i = 0; i <= chars.length - CHAR_SHINGLE_K; i++) set.add(chars.slice(i, i + CHAR_SHINGLE_K));
    set.mode = "char";
    return set;
  }

  for (let i = 0; i <= words.length - k; i++) set.add(words.slice(i, i + k).join(" "));
  set.mode = "word";
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

module.exports = {
  detectEol,
  hasMixedEol,
  CHAR_SHINGLE_K, SHINGLE_K, THRESHOLD, walkOutsideFences, whitespaceAudit, cleanText, shingles, containment };
