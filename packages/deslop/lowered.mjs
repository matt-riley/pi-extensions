// lowered.mjs — the lowered-bar pass of `/deslop code`: changes that make a
// branch pass by lowering what passing means. A suppression directive, a
// skipped test, a weaker threshold and a stub all turn a red result green
// without fixing what was red.
//
// Like codeslop.mjs this reads a unified diff and only reports. A hit is a place
// to look, never a rewrite. It judges what the diff adds or removes, so a
// suppression that was already there is not new. A reason next to a hit, or in
// a commit message, moves it from strong (severity "high") to weak ("low").

/** Diffs past this are cut: a generated change is not worth judging line by line. */
const MAX_DIFF_CHARS = 400_000;
/** A line longer than this is minified or generated, not code someone reads. */
const MAX_LINE_CHARS = 500;
const MAX_EXCERPTS = 5;
const MAX_EXCERPT_CHARS = 100;
/** A reason is a short sentence: this many plain words after the directive. */
const REASON_WORDS = 3;

const SLASH_EXTENSIONS = new Set(
  "js mjs cjs jsx ts mts cts tsx jsonc go rs java kt c h cc cpp cs swift php".split(" "),
);
const HASH_EXTENSIONS = new Set("py sh bash yml yaml toml rb ini cfg".split(" "));
const SKIPPED_PATH = /(?:^|\/)(?:node_modules|dist|build|vendor)\/|\.min\.|\.d\.ts$|\.lock$/;

const extensionOf = (path) => path.match(/\.([A-Za-z0-9]+)$/)?.[1]?.toLowerCase() ?? "";

// How comments are written in a file: "slash" (C style), "hash" (`#`), or null for none we read.
function commentStyleOf(path) {
  const extension = extensionOf(path);
  if (SLASH_EXTENSIONS.has(extension)) return "slash";
  return HASH_EXTENSIONS.has(extension) ? "hash" : null;
}

/**
 * The files of a unified diff with every kind of line: added and context lines
 * numbered in the new file, removed lines numbered by where they were taken out.
 * Unlike the code-slop reader this keeps deleted files, tests and config, because
 * those are where a bar is lowered.
 */
function parseChanges(diff) {
  const files = [];
  let file = null;
  let hunk = null;
  let line = 0;
  for (const raw of String(diff ?? "")
    .slice(0, MAX_DIFF_CHARS)
    .split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(raw);
    if (header) {
      file = { path: header[1], deleted: false, hunks: [] };
      hunk = null;
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (!hunk && raw.startsWith("deleted file mode")) {
      file.deleted = true;
      continue;
    }
    const start = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (start) {
      hunk = { lines: [] };
      line = Number(start[1]);
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || raw.length > MAX_LINE_CHARS) {
      if (hunk && raw.length > MAX_LINE_CHARS && raw[0] !== "-") line++;
      continue;
    }
    if (raw[0] === "+") hunk.lines.push({ n: line++, kind: "add", text: raw.slice(1) });
    else if (raw[0] === " ") hunk.lines.push({ n: line++, kind: "ctx", text: raw.slice(1) });
    else if (raw[0] === "-") hunk.lines.push({ n: line, kind: "del", text: raw.slice(1) });
  }
  return files.filter((item) => !SKIPPED_PATH.test(item.path));
}

/**
 * A line split into its code and its comment. String literals are blanked in the
 * code, so a directive quoted in a string is not read as one, and a comment mark
 * inside a string does not start a comment. Block-comment continuation lines
 * (` * text`) are all comment.
 */
function splitComment(text, style) {
  if (style === "slash" && /^\s*\*(?:\s|\/|$)/.test(text))
    return { code: "", comment: text.replace(/^\s*\*\/?/, "").replace(/\*\/\s*$/, "") };
  let code = "";
  let quote = "";
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote) {
      if (char === "\\") at++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      code += '""';
      continue;
    }
    const slash = style === "slash" && char === "/" && "/*".includes(text[at + 1] ?? " ");
    const hash = style === "hash" && char === "#" && (at === 0 || /\s/.test(text[at - 1]));
    if (slash || hash)
      return {
        code,
        comment: text
          .slice(at + (hash ? 1 : 2))
          .replace(/\*\/\s*$/, "")
          .trim(),
      };
    code += char;
  }
  return { code, comment: null };
}

const DIRECTIVE =
  /^\s*(?:@ts-(?:ignore|expect-error|nocheck)|(?:eslint|oxlint)-disable(?:-next-line|-line)?|biome-ignore|noqa|type:\s*ignore|nolint|(?:istanbul|c8|v8)\s+ignore|nosemgrep|gitleaks:allow|pragma:\s*no\s+cover|pylint:\s*disable)/;
const RUST_ALLOW = /#!?\[\s*allow\s*\(/;

/**
 * The plain words of a comment once a directive and any rule names are removed.
 * A name with a dash, a slash, a digit or a trailing comma is a rule or a code,
 * not part of a reason.
 */
function reasonWordCount(comment) {
  return (comment ?? "")
    .replace(DIRECTIVE, "")
    .split(/\s+/)
    .filter((word) => !/[-/\d[\]()@:=,]/.test(word.replace(/[.;!?]$/, "")))
    .filter((word) => /^[A-Za-z']{2,}[.;!?]?$/.test(word)).length;
}

/** Whether the comment on this line, or a comment-only line next to it, gives a reason. */
function reasonNear(lines, at, style) {
  const own = splitComment(lines[at].text, style).comment;
  if (reasonWordCount(own) >= REASON_WORDS) return true;
  return [lines[at - 1], lines[at + 1]].some((next) => {
    if (!next || next.kind === "del") return false;
    const { code, comment } = splitComment(next.text, style);
    return code.trim() === "" && reasonWordCount(comment) >= REASON_WORDS;
  });
}

/** Every added line of a file with its position in the hunk, for the scans below. */
function* addedLines(file) {
  for (const { lines } of file.hunks)
    for (const [at, line] of lines.entries()) if (line.kind === "add") yield { lines, at, line };
}

/** New suppression directives: the code stops being checked, rather than being fixed. */
function suppressions(files) {
  const hits = [];
  for (const file of files) {
    const style = commentStyleOf(file.path);
    if (!style || file.deleted) continue;
    const rust = extensionOf(file.path) === "rs";
    for (const { lines, at, line } of addedLines(file)) {
      const { code, comment } = splitComment(line.text, style);
      if (!(comment !== null && DIRECTIVE.test(comment)) && !(rust && RUST_ALLOW.test(code)))
        continue;
      hits.push({
        path: file.path,
        n: line.n,
        text: line.text,
        weak: reasonNear(lines, at, style),
      });
    }
  }
  return hits;
}

const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rs)$|(?:^|\/)test_[^/]*\.py$/;
const isTest = (path) => TEST_PATH.test(path);

/** Calls that switch a test off. `arg` marks the ones whose string argument is a stated reason. */
const SKIPS = [
  { pattern: /\b(?:it|test|describe|context|suite|specify)\.(?:skip|only)\b/ },
  { pattern: /\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/ },
  { pattern: /\bt\.(?:Skip|Skipf|SkipNow|skip)\s*\(/, arg: true },
  { pattern: /\bpytest\.(?:skip\s*\(|mark\.(?:skip|xfail)\b)/, arg: true },
  { pattern: /\bunittest\.skip(?:If|Unless)?\b/, arg: true },
  { pattern: /\bskip\s*:\s*(?:true|"")/, arg: true },
];
const RUST_IGNORE = /#\[\s*ignore\b/;
const STRING_ARGUMENT = /(["'`])((?:\\.|(?!\1).)*)\1/;

/** Whether a string argument after a skip call is a sentence of reason words, not a test name. */
function skipArgumentGivesReason(raw, from) {
  const text = STRING_ARGUMENT.exec(raw.slice(from))?.[2] ?? "";
  return (
    text.split(/\s+/).filter((word) => /^[A-Za-z']{2,}[.,;!?]?$/.test(word)).length >= REASON_WORDS
  );
}

/** Skipped or focused tests, `#[ignore]`, and test files deleted with nothing left to test. */
function skippedTests(files) {
  const hits = [];
  for (const file of files) {
    const style = commentStyleOf(file.path);
    const rust = extensionOf(file.path) === "rs";
    if (!style || file.deleted || (!isTest(file.path) && !rust)) continue;
    for (const { lines, at, line } of addedLines(file)) {
      const code = splitComment(line.text, style).code;
      const call = isTest(file.path) ? SKIPS.find(({ pattern }) => pattern.test(code)) : undefined;
      if (!call && !(rust && RUST_IGNORE.test(code))) continue;
      const argument =
        (call?.arg || rust) && skipArgumentGivesReason(line.text, line.text.search(/skip|ignore/i));
      hits.push({
        path: file.path,
        n: line.n,
        text: line.text,
        weak: argument || reasonNear(lines, at, style),
      });
    }
  }
  return hits;
}

const stemOf = (path) =>
  path
    .split("/")
    .pop()
    .replace(/\.[^.]+$/, "")
    .replace(/(?:[._]test|[._]spec)$|^test_/, "");

/** A test file the diff deletes, when the file it tests is not deleted with it. */
function deletedTests(files) {
  const goneWithSource = new Set(
    files.filter((file) => file.deleted && !isTest(file.path)).map((file) => stemOf(file.path)),
  );
  return files
    .filter((file) => file.deleted && isTest(file.path) && !goneWithSource.has(stemOf(file.path)))
    .map((file) => ({ path: file.path, n: 0, text: "test file deleted" }));
}

const ASSERTION =
  /\b(?:assert(?:\.\w+)?|expect|require\.\w+|t\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)|self\.assert\w+)\s*\(|\b(?:assert|assert_eq|assert_ne|debug_assert\w*)!\s*\(|^\s*assert\s/;
const TEST_CASE =
  /^\s*(?:(?:it|test|describe)\s*\(|func\s+Test|(?:async\s+)?def\s+test_|#\[test\])/;

/**
 * Test files that keep existing but hold fewer assertions than before. A pair of
 * removed and added assertions cancels, so rewording one is fine. Strong when
 * assertions left tests that stayed; weak when a whole test case left too.
 */
function strippedAssertions(files) {
  const hits = [];
  for (const file of files) {
    const style = commentStyleOf(file.path);
    if (!style || file.deleted || !isTest(file.path)) continue;
    const all = file.hunks.flatMap(({ lines }) => lines);
    const asserts = (kind) =>
      all.filter(
        (line) => line.kind === kind && ASSERTION.test(splitComment(line.text, style).code),
      );
    const gone = asserts("del");
    const fewer = gone.length - asserts("add").length;
    if (fewer <= 0) continue;
    const cases = all.filter((line) => line.kind === "del" && TEST_CASE.test(line.text)).length;
    hits.push({
      path: file.path,
      n: gone[0].n,
      text: `${fewer} fewer assertion${fewer === 1 ? "" : "s"}: ${gone[0].text.trim()}`,
      weak: cases > 0,
    });
  }
  return hits;
}

/** Every way a test is made easier to pass. */
const easierTests = (files) => [
  ...skippedTests(files),
  ...deletedTests(files),
  ...strippedAssertions(files),
];

const CHECKS = [
  {
    id: "suppression",
    label: "new suppression of a lint, type or coverage check",
    fix: "fix what the check found, or write down why the suppression is safe",
    scan: suppressions,
  },
  {
    id: "easier-test",
    label: "test skipped, deleted or stripped of assertions",
    fix: "make the test pass, or say why it can go",
    scan: easierTests,
  },
];

const excerptOf = (hit) =>
  `${hit.path}${hit.n ? `:${hit.n}` : ""}: ${hit.text.trim().slice(0, MAX_EXCERPT_CHARS)}`;

/**
 * Proposals for a branch diff, as many findings as there are checks and
 * strengths: a strong one (severity "high") for hits with no reason, and a weak
 * one ("low") for hits that state one. The shape matches the code-slop
 * findings, so formatFindings prints both.
 */
export function findLoweredBar(diff) {
  const files = parseChanges(diff);
  const findings = [];
  for (const check of CHECKS) {
    const hits = check.scan(files);
    for (const weak of [false, true]) {
      const group = hits.filter((hit) => Boolean(hit.weak) === weak);
      if (group.length === 0) continue;
      const base = weak ? `${check.label}, weak sign` : check.label;
      findings.push({
        id: check.id,
        sign: "lowered-bar",
        severity: weak ? "low" : "high",
        label: group.length > MAX_EXCERPTS ? `${base}, ${group.length} in all` : base,
        fix: check.fix,
        count: group.length,
        excerpts: group.slice(0, MAX_EXCERPTS).map(excerptOf),
      });
    }
  }
  return findings;
}
