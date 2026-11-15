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
/** A reason is a short phrase: this many plain words once a directive and rule names are set aside. */
const REASON_WORDS = 2;

const SLASH_EXTENSIONS = new Set(
  "js mjs cjs jsx ts mts cts tsx jsonc go rs java kt c h cc cpp cs swift php".split(" "),
);
const HASH_EXTENSIONS = new Set("py sh bash yml yaml toml rb ini cfg".split(" "));
const SKIPPED_PATH =
  /(?:^|\/)(?:node_modules|dist|build|vendor)\/|\.min\.|\.d\.ts$|\.lock$|(?:^|\/)package-lock\.json$/;

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
 * Test files that keep existing but hold fewer assertions than before, when the
 * diff as a whole removes more assertions than it adds: tests moved to another
 * file, or an assertion reworded, cancel out. Strong when assertions left tests
 * that stayed; weak when a whole test case left too.
 */
function strippedAssertions(files) {
  const counts = [];
  let added = 0;
  let gone = 0;
  for (const file of files) {
    const style = commentStyleOf(file.path);
    if (!style || file.deleted || !isTest(file.path)) continue;
    const all = file.hunks.flatMap(({ lines }) => lines);
    const asserts = (kind) =>
      all.filter(
        (line) => line.kind === kind && ASSERTION.test(splitComment(line.text, style).code),
      );
    const removedHere = asserts("del");
    const fewer = removedHere.length - asserts("add").length;
    added += asserts("add").length;
    gone += removedHere.length;
    if (fewer > 0) counts.push({ file, all, removedHere, fewer });
  }
  if (gone <= added) return [];
  return counts.map(({ file, all, removedHere, fewer }) => ({
    path: file.path,
    n: removedHere[0].n,
    text: `${fewer} fewer assertion${fewer === 1 ? "" : "s"}: ${removedHere[0].text.trim()}`,
    weak: all.some((line) => line.kind === "del" && TEST_CASE.test(line.text)),
  }));
}

/** Every way a test is made easier to pass. */
const easierTests = (files) => [
  ...skippedTests(files),
  ...deletedTests(files),
  ...strippedAssertions(files),
];

const CONFIG_FILE =
  /\.(?:json|jsonc|ya?ml|toml|ini|cfg)$|(?:^|\/)\.[\w-]*rc(?:\.\w+)?$|\.config\.[cm]?[jt]s$/;
const WORKFLOW_FILE =
  /(?:^|\/)(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml)$/;
const LINT_CONFIG =
  /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?|\.oxlintrc(?:\.jsonc?)?|oxlint\.jsonc?|biome\.jsonc?|\.golangci\.ya?ml|\.?ruff\.toml|\.flake8|\.pylintrc|clippy\.toml|\.rubocop\.yml|tsconfig[\w.-]*\.json|pyproject\.toml|Cargo\.toml|setup\.cfg|tox\.ini)$/;

/** Numbers set by `key: 12`, `key = 12` or `"key": 12`, and by `--key 12` or `--key=12`. */
const SETTINGS = [
  /["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/g,
  /(?:^|\s)--([A-Za-z][\w-]*)(?:=|\s+)["']?(\d+(?:\.\d+)?)/g,
];
/** A floor is a number that must be met (coverage); lowering it lowers the bar. */
const FLOOR_KEY = /coverage|threshold|failunder|^(?:lines|branches|functions|statements)$|score/;
/** A ceiling is a number that must not be passed (a size budget); raising it lowers the bar. */
const CEILING_KEY =
  /budget|^max(?:warnings|size|lines|bytes|complexity|length|errors|issues|depth)$|sizelimit|^limit$/;

function settingsOf(text) {
  return SETTINGS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((found) => ({
      key: found[1].toLowerCase().replace(/[-_.]/g, ""),
      name: found[1],
      value: Number(found[2]),
    })),
  );
}

/** Coverage floors lowered and size or warning budgets raised, within one hunk. */
function weakerThresholds(files) {
  const hits = [];
  for (const file of files) {
    if (file.deleted || !CONFIG_FILE.test(file.path)) continue;
    const style = commentStyleOf(file.path);
    for (const { lines } of file.hunks) {
      const before = new Map();
      for (const line of lines)
        if (line.kind === "del")
          for (const { key, value } of settingsOf(line.text))
            before.set(key, [...(before.get(key) ?? []), value]);
      for (const [at, line] of lines.entries()) {
        if (line.kind !== "add") continue;
        for (const { key, name, value } of settingsOf(line.text)) {
          const old = before.get(key)?.shift();
          const lowered =
            old !== undefined &&
            ((FLOOR_KEY.test(key) && value < old) || (CEILING_KEY.test(key) && value > old));
          if (lowered)
            hits.push({
              path: file.path,
              n: line.n,
              text: `${name}: ${old} -> ${value}`,
              weak: reasonNear(lines, at, style),
            });
        }
      }
    }
  }
  return hits;
}

/** Commands and actions that check the code, as opposed to setting it up or shipping it. */
const CHECK_STEP =
  /\b(?:tests?|lint\w*|checks?|typecheck|tsc|coverage|audit|scan|codeql|semgrep|gitleaks|trivy|verify|vet|clippy|pytest|jest|vitest|eslint|oxlint|mypy|ruff|golangci|staticcheck|fmt|sast|security)\b/i;

/**
 * What a workflow line runs: the value of `run:` or `uses:` (without an action's
 * version), or a line of a multi-line script. Null for any other key.
 */
function stepOf(text) {
  const line = text.trim().replace(/^-\s+/, "");
  if (line === "" || line.startsWith("#")) return null;
  const keyed = /^(run|uses):\s*(.*)$/.exec(line);
  if (keyed) return keyed[1] === "uses" ? keyed[2].replace(/@\S*$/, "").trim() : keyed[2].trim();
  return /^[\w-]+:(?:\s|$)/.test(line) ? null : line;
}

/**
 * CI checks taken out of a workflow (or a whole workflow deleted) with nothing
 * that runs them added anywhere in the diff, and checks told to pass regardless.
 */
function weakerWorkflows(files) {
  const workflows = files.filter((file) => WORKFLOW_FILE.test(file.path));
  const kept = new Set(
    workflows.flatMap((file) =>
      file.hunks.flatMap(({ lines }) =>
        lines.filter((line) => line.kind === "add").map((line) => stepOf(line.text)),
      ),
    ),
  );
  const hits = [];
  for (const file of workflows)
    for (const { lines } of file.hunks)
      for (const [at, line] of lines.entries()) {
        const step = stepOf(line.text);
        if (line.kind === "del" && step && CHECK_STEP.test(step) && !kept.has(step))
          hits.push({
            path: file.path,
            n: line.n,
            text: `removed: ${line.text.trim()}`,
            weak: reasonNear(lines, at, "hash"),
          });
        else if (
          line.kind === "add" &&
          (/^\s*continue-on-error:\s*true\b/.test(line.text) ||
            (step && CHECK_STEP.test(step) && /\|\|\s*true\s*$/.test(step)))
        )
          hits.push({
            path: file.path,
            n: line.n,
            text: line.text,
            weak: reasonNear(lines, at, "hash"),
          });
      }
  return hits;
}

const RULE_OFF =
  /["']?[\w@/.:-]+["']?\s*[:=]\s*(?:\[\s*)?["']?(?:off|allow|none|0)["']?\s*(?:[,\]}]|$)/;
const STRICT_OFF =
  /["']?(?:strict\w*|noImplicit\w+|noUnused\w+|noUnchecked\w+|exactOptional\w+|noFallthrough\w+|useUnknownInCatchVariables|alwaysStrict)["']?\s*:\s*false/;
const IGNORE_LIST = /^\s*["']?(?:ignore|extend-ignore|disable|disable-all)["']?\s*[:=]/;

/** Lint and compiler rules switched off, or ignore lists started, in the config that sets them. */
function rulesOff(files) {
  const hits = [];
  for (const file of files) {
    if (file.deleted || !LINT_CONFIG.test(file.path)) continue;
    // Lint and compiler configs named .json are read with comments allowed (JSONC).
    const style = commentStyleOf(file.path) ?? (extensionOf(file.path) === "json" ? "slash" : null);
    for (const { lines, at, line } of addedLines(file)) {
      if (style && splitComment(line.text, style).code.trim() === "") continue;
      if (![RULE_OFF, STRICT_OFF, IGNORE_LIST].some((pattern) => pattern.test(line.text))) continue;
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

/** Every way a threshold or a check is weakened. */
const weakerChecks = (files) => [
  ...weakerThresholds(files),
  ...weakerWorkflows(files),
  ...rulesOff(files),
];

const SOURCE_LANGUAGES = {
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  ts: "js",
  mts: "js",
  cts: "js",
  tsx: "js",
  py: "py",
  go: "go",
  rs: "rs",
};
const STUB_PHRASE = /not\s+(?:yet\s+)?implemented|unimplemented|\btodo\b/i;
const MACRO_STUB = /\b(?:todo|unimplemented)!\s*\(|\bNotImplementedError\b/;
const MESSAGE_STUB = /\bnew\s+\w*Error\s*\(|\bpanic!?\s*\(/;
const TRACKER = /#\d+|https?:\/\/|\b[A-Z]{2,}-\d+/;
const TODO_COMMENT = /^(?:TODO|FIXME|XXX)\b/i;

/** An empty block holds at most this many comment lines before its closing line. */
const LOOKAHEAD_LINES = 6;

const indentOf = (text) => text.match(/^\s*/)[0].length;

/**
 * The first code line after `at`, and the comments before it. Comment-only lines
 * are skipped, because a comment inside an empty block is not the block's body.
 */
function bodyAfter(lines, at, style) {
  const comments = [];
  for (let next = at + 1; next < lines.length && next <= at + LOOKAHEAD_LINES; next++) {
    if (lines[next].kind === "del") continue;
    const { code, comment } = splitComment(lines[next].text, style);
    if (code.trim() === "" && comment !== null) comments.push(comment);
    else return { code: code.trim(), text: lines[next].text, comments };
  }
  return null;
}

const commentsGiveReason = (comments) =>
  comments.some((comment) => reasonWordCount(comment) >= REASON_WORDS);

/** A catch, except or `if err != nil` block with nothing in it. */
function emptyHandlerAt(language, lines, at, style) {
  const code = splitComment(lines[at].text.replace(/\/\*.*?\*\//g, " "), style).code;
  if (language === "js") {
    if (
      /\bcatch\b(?:\s*\([^)]*\))?\s*\{\s*\}/.test(code) ||
      /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*\{\s*\}\s*\)/.test(code)
    )
      return { comments: [...lines[at].text.matchAll(/\/\*(.*?)\*\//g)].map((found) => found[1]) };
  }
  const opens = {
    js: /\bcatch\b[^{]*\{\s*$/,
    go: /^\s*if\s+err\s*!=\s*nil\s*\{\s*$/,
    py: /^\s*except\b[^:]*:\s*$/,
  }[language];
  if (!opens?.test(code)) return null;
  const body = bodyAfter(lines, at, style);
  const closes = language === "py" ? /^(?:pass|\.\.\.)$/ : /^\}/;
  return body && closes.test(body.code) ? { comments: body.comments } : null;
}

/** A comment-only TODO that sits alone where a function body should be. */
function todoBodyAt(language, lines, at, style) {
  const { code, comment } = splitComment(lines[at].text, style);
  if (code.trim() !== "" || !TODO_COMMENT.test(comment ?? "")) return null;
  const before = lines[at - 1];
  if (!before || before.kind === "del") return null;
  const opener = splitComment(before.text, style).code.trimEnd();
  if (!opener.endsWith(language === "py" ? ":" : "{")) return null;
  const body = bodyAfter(lines, at, style);
  if (!body) return null;
  const ends =
    language === "py"
      ? /^(?:pass|\.\.\.)$/.test(body.code) || indentOf(body.text) <= indentOf(before.text)
      : body.code.startsWith("}");
  return ends ? { tracked: TRACKER.test(comment) } : null;
}

/** Work left undone: stubs that throw, empty error handlers, and a TODO where the code goes. */
function unfinishedWork(files) {
  const hits = [];
  for (const file of files) {
    const style = commentStyleOf(file.path);
    const language = SOURCE_LANGUAGES[extensionOf(file.path)];
    if (!style || !language || file.deleted || isTest(file.path)) continue;
    for (const { lines, at, line } of addedLines(file)) {
      const { code } = splitComment(line.text, style);
      const stub =
        MACRO_STUB.test(code) || (MESSAGE_STUB.test(code) && STUB_PHRASE.test(line.text));
      const handler = emptyHandlerAt(language, lines, at, style);
      const todo = todoBodyAt(language, lines, at, style);
      if (!stub && !handler && !todo) continue;
      hits.push({
        path: file.path,
        n: line.n,
        text: line.text,
        weak: todo
          ? todo.tracked
          : reasonNear(lines, at, style) || commentsGiveReason(handler?.comments ?? []),
      });
    }
  }
  return hits;
}

const CHECKS = [
  {
    id: "suppression",
    label: "new suppression of a lint, type or coverage check",
    fix: "fix what the check found, or write down why the suppression is safe",
    topic: [
      /\b(?:suppress\w*|ignor\w+|disabl\w+|silenc\w+|lint\w*|noqa|nolint|ts-ignore|ts-expect-error)\b/i,
    ],
    scan: suppressions,
  },
  {
    id: "easier-test",
    label: "test skipped, deleted or stripped of assertions",
    fix: "make the test pass, or say why it can go",
    topic: [
      /\b(?:skip\w*|flak\w+|disabl\w+|remov\w+|delet\w+|drop\w*|ignor\w+|only)\b/i,
      /\b(?:tests?|specs?|assert\w*)\b/i,
    ],
    scan: easierTests,
  },
  {
    id: "weaker-check",
    label: "threshold lowered, CI check removed or lint rule switched off",
    fix: "restore it, or record why the bar can drop",
    topic: [
      /\b(?:lower\w*|reduc\w+|relax\w*|loosen\w*|drop\w*|remov\w+|delet\w+|disabl\w+|off|rais\w+)\b/i,
      /\b(?:coverage|threshold|budget|lint\w*|ci|workflows?|checks?|rules?|steps?)\b/i,
    ],
    scan: weakerChecks,
  },
  {
    id: "unfinished",
    label: "stub, empty error handler or TODO standing in for the code",
    fix: "write the missing code, or note what tracks it",
    topic: [
      /\b(?:stub\w*|todo|not implemented|unimplemented|placeholder|scaffold\w*|wip|empty|swallow\w*|ignor\w+)\b/i,
    ],
    scan: unfinishedWork,
  },
];

const REASON_IN_MESSAGE =
  /\b(?:because|since|due to|so that|until|temporar\w+|workaround|flak\w+|upstream|follow-?up|tracked|for now|false positive|intentional\w*|deliberate\w*|obsolete|superseded)\b|#\d+/i;

/** Whether one commit message is about this kind of change and says why it was made. */
const messageGivesReason = (check, message) =>
  REASON_IN_MESSAGE.test(message) && check.topic.every((pattern) => pattern.test(message));

const excerptOf = (hit) =>
  `${hit.path}${hit.n ? `:${hit.n}` : ""}: ${hit.text.trim().slice(0, MAX_EXCERPT_CHARS)}`;

/**
 * Proposals for a branch diff, as many findings as there are checks and
 * strengths: a strong one (severity "high") for hits with no reason, and a weak
 * one ("low") for hits that state one, on the line, in an adjacent comment or in
 * a commit message about that kind of change (`messages`). The shape matches the code-slop
 * findings, so formatFindings prints both.
 */
export function findLoweredBar(diff, messages = []) {
  const files = parseChanges(diff);
  const said = [messages].flat().map(String);
  const findings = [];
  for (const check of CHECKS) {
    const explained = said.some((message) => messageGivesReason(check, message));
    const hits = check.scan(files).map((hit) => ({ ...hit, weak: hit.weak || explained }));
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
