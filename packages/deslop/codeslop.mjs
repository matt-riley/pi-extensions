// codeslop.mjs — the code half of deslop: patterns that a model leaves in the
// code it writes, found in the lines a branch added.
//
// This is a separate pass from the prose checklist in patterns.mjs and shares
// none of its patterns. It reads a unified diff, looks only at added lines
// (plus the context lines git prints around them), and returns proposals in the
// shape formatFindings already prints. Every check is a heuristic: a hit is a
// place to look, never a rewrite, and nothing here edits a file.

/** Diffs past this are cut: a generated change is not worth judging line by line. */
const MAX_DIFF_CHARS = 400_000;
/** A line longer than this is minified or generated, not code someone reads. */
const MAX_LINE_CHARS = 500;
const MAX_EXCERPTS = 5;
const MAX_EXCERPT_CHARS = 100;

const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs)$/;
const SKIPPED_PATH =
  /(?:^|\/)(?:node_modules|dist|build|vendor|tests?|__tests__)\/|\.(?:test|spec)\.|\.d\.ts$|\.min\./;

/** The language family of a path, as far as the checks care. */
function languageOf(path) {
  if (path.endsWith(".py")) return "py";
  if (path.endsWith(".go")) return "go";
  if (path.endsWith(".rs")) return "rs";
  return "js";
}

/**
 * The files of a unified diff: each with its hunks of added and context lines
 * (numbered in the new file) and the text of the lines it removed. Deleted
 * files, tests, generated output and anything that is not code are dropped.
 */
export function parseDiff(diff) {
  const files = [];
  let file = null;
  let hunk = null;
  let line = 0;
  for (const raw of String(diff ?? "")
    .slice(0, MAX_DIFF_CHARS)
    .split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = null;
      hunk = null;
      continue;
    }
    if (!hunk && raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim().replace(/^b\//, "");
      file =
        path !== "/dev/null" && CODE_FILE.test(path) && !SKIPPED_PATH.test(path)
          ? { path, language: languageOf(path), hunks: [], removed: [] }
          : null;
      if (file) files.push(file);
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (header) {
      hunk = { lines: [] };
      line = Number(header[1]);
      file?.hunks.push(hunk);
      continue;
    }
    if (!file || !hunk || raw.length > MAX_LINE_CHARS) {
      if (file && hunk && raw.length > MAX_LINE_CHARS && raw[0] !== "-") line++;
      continue;
    }
    if (raw[0] === "+") hunk.lines.push({ n: line++, kind: "add", text: raw.slice(1) });
    else if (raw[0] === " ") hunk.lines.push({ n: line++, kind: "ctx", text: raw.slice(1) });
    else if (raw[0] === "-") file.removed.push(raw.slice(1));
  }
  return files.filter((item) => item.hunks.length > 0);
}

const EMPTY_VALUE = String.raw`(?:null|undefined|false|\[\]|\{\}|""|'')`;
const SWALLOW_ONE_LINE = [
  new RegExp(String.raw`\bcatch\b[^{]*\{\s*\}`),
  new RegExp(String.raw`\bcatch\b[^{]*\{\s*return(?:\s+${EMPTY_VALUE})?\s*;?\s*\}`),
  new RegExp(String.raw`\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*${EMPTY_VALUE}\s*\)`),
  new RegExp(String.raw`^\s*except\b[^:]*:\s*pass\s*$`),
];
const JS_CATCH_OPEN = /\bcatch\b[^{]*\{\s*$/;
const JS_QUIET_RETURN = new RegExp(String.raw`^\s*return(?:\s+${EMPTY_VALUE})?\s*;?\s*$`);
const PY_EXCEPT_OPEN = /^\s*except\b[^:]*:\s*$/;
const PY_QUIET_BODY = /^\s*(?:pass|return(?:\s+(?:None|False|\[\]|\{\}|""|''))?)\s*$/;
const GO_ERR_OPEN = /^\s*if\s+err\s*!=\s*nil\s*\{\s*$/;
const GO_QUIET_RETURN = /^\s*return\s+(?:nil|false|""|0)(?:,\s*nil)?\s*$/;
const CLOSING_BRACE = /^\s*\}/;

/** The lines after `at` in a hunk, up to the line that closes the block. */
function blockBody(lines, at, closes) {
  const body = [];
  for (let next = at + 1; next < lines.length; next++) {
    if (closes(lines[next].text)) return body;
    body.push(lines[next].text);
  }
  return null;
}

/** Errors swallowed into false, null or an empty result, with no log and no reason. */
function swallowedErrors(files) {
  const hits = [];
  for (const file of files)
    for (const { lines } of file.hunks)
      for (const [at, line] of lines.entries()) {
        if (line.kind !== "add") continue;
        const text = line.text;
        let swallowed = SWALLOW_ONE_LINE.some((pattern) => pattern.test(text));
        if (!swallowed && file.language === "js" && JS_CATCH_OPEN.test(text)) {
          const body = blockBody(lines, at, (next) => CLOSING_BRACE.test(next));
          swallowed =
            body !== null &&
            (body.length === 0 || (body.length === 1 && JS_QUIET_RETURN.test(body[0])));
        } else if (!swallowed && file.language === "py" && PY_EXCEPT_OPEN.test(text)) {
          const next = lines[at + 1]?.text;
          const after = lines[at + 2]?.text;
          swallowed =
            next !== undefined &&
            PY_QUIET_BODY.test(next) &&
            (after === undefined ||
              !/^\s{2,}\S/.test(after) ||
              after.search(/\S/) <= text.search(/\S/));
        } else if (!swallowed && file.language === "go" && GO_ERR_OPEN.test(text)) {
          const body = blockBody(lines, at, (next) => CLOSING_BRACE.test(next));
          swallowed = body !== null && body.length === 1 && GO_QUIET_RETURN.test(body[0]);
        }
        if (swallowed) hits.push({ path: file.path, n: line.n, text });
      }
  return hits;
}

const CHECKS = [
  {
    id: "swallowed",
    label: "error swallowed into a quiet result",
    fix: "let the error reach the caller, or handle it and say why in a comment",
    scan: swallowedErrors,
  },
];

/**
 * Proposals for a branch diff, one finding per check that hit. Each carries up
 * to a few `path:line: code` excerpts. The shape matches the prose findings, so
 * formatFindings prints both.
 */
export function findCodeSlop(diff) {
  const files = parseDiff(diff);
  const findings = [];
  for (const check of CHECKS) {
    const hits = check.scan(files);
    if (hits.length === 0) continue;
    findings.push({
      id: check.id,
      sign: "code-slop",
      severity: "medium",
      label: check.label,
      fix: check.fix,
      count: hits.length,
      excerpts: hits
        .slice(0, MAX_EXCERPTS)
        .map((hit) => `${hit.path}:${hit.n}: ${hit.text.trim().slice(0, MAX_EXCERPT_CHARS)}`),
    });
  }
  return findings;
}
