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

const COMMENT_MARK = { js: "//", go: "//", rs: "//", py: "#" };
const ECHO_MAX_WORDS = 8;
/** A comment that gives a reason, a condition, a number or a directive is not a restatement. */
const COMMENT_KEEPERS =
  /\b(?:because|since|otherwise|unless|workaround|hack|todo|fixme|note|why|except|avoid|due|instead|must|never|always|only|before|after|until|when|if|while|eslint|prettier|istanbul|nolint|noqa)\b|[:;@\d]|work around|so that/i;
const FILLER_WORDS = new Set(
  "a an the this that these those to of in on for and or with over into from by at it is are be as each every all".split(
    " ",
  ),
);
/** Verbs a comment uses to name what the next line already does. */
const ACTION_WORDS = new Set(
  "set get return returns create creates call calls increment decrement loop iterate check checks add adds define defines initialize initialise assign import declare open read write load save update remove delete find fetch build make run print log start stop use".split(
    " ",
  ),
);

const stem = (word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word);
/** Lowercase words of an identifier-laden string: camelCase and snake_case are split. */
const wordsOf = (text) =>
  (text.replace(/([a-z\d])([A-Z])/g, "$1 $2").match(/[A-Za-z]+/g) ?? []).map((word) =>
    stem(word.toLowerCase()),
  );

/** Comments that only restate the line under them, such as "// increment the counter". */
function echoComments(files) {
  const hits = [];
  for (const file of files) {
    const mark = COMMENT_MARK[file.language];
    for (const { lines } of file.hunks)
      for (const [at, line] of lines.entries()) {
        const code = lines[at + 1];
        if (line.kind !== "add" || code?.kind !== "add") continue;
        const trimmed = line.text.trim();
        if (!trimmed.startsWith(mark) || /^(?:\/\/|#)[/!#]/.test(trimmed)) continue;
        const comment = trimmed.slice(mark.length).trim();
        if (!comment || COMMENT_KEEPERS.test(comment) || code.text.trim().startsWith(mark))
          continue;
        const words = comment.split(/\s+/);
        const content = wordsOf(comment).filter(
          (word) => !FILLER_WORDS.has(word) && !ACTION_WORDS.has(word),
        );
        if (words.length > ECHO_MAX_WORDS || content.length === 0) continue;
        const known = new Set(wordsOf(code.text));
        if (content.every((word) => known.has(word)))
          hits.push({ path: file.path, n: line.n, text: `${trimmed} / ${code.text.trim()}` });
      }
  }
  return hits;
}

const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;
const TYPE_SILENCERS = [
  /\bas\s+any\b/,
  /(?<![\w>])<any>/,
  /\bas\s+unknown\s+as\b/,
  /@ts-(?:ignore|expect-error)\s*$/,
];

/** `as any`, `as unknown as T` and a bare ts-ignore: the cast is there to make the error go away. */
function silencedTypes(files) {
  const hits = [];
  for (const file of files) {
    if (!/\.[cm]?tsx?$/.test(file.path)) continue;
    for (const { lines } of file.hunks)
      for (const line of lines) {
        if (line.kind !== "add") continue;
        const bare = line.text.replace(STRING_LITERAL, '""').trimEnd();
        if (TYPE_SILENCERS.some((pattern) => pattern.test(bare)))
          hits.push({ path: file.path, n: line.n, text: line.text });
      }
  }
  return hits;
}

const FALLBACK_COMMENT =
  /\b(?:fall\s?back|just in case|should(?:n['’]t| never)|can(?:not|['’]t) happen|backwards?[- ]compat\w*|legacy|defensive|for safety)\b/i;
const NULLISH_CHAIN = /\?\?[^?]*\?\?/;

/** Defaults, guards and compatibility shims that a comment admits nobody asked for. */
function unrequestedFallbacks(files) {
  const hits = [];
  for (const file of files) {
    const mark = COMMENT_MARK[file.language];
    for (const { lines } of file.hunks)
      for (const line of lines) {
        if (line.kind !== "add") continue;
        const code = line.text.replace(STRING_LITERAL, '""');
        const at = code.indexOf(mark);
        const chained =
          file.language === "js" && NULLISH_CHAIN.test(at < 0 ? code : code.slice(0, at));
        if (chained || (at >= 0 && FALLBACK_COMMENT.test(code.slice(at))))
          hits.push({ path: file.path, n: line.n, text: line.text });
      }
  }
  return hits;
}

const TAB_WIDTH = 4;
const NESTING_DEPTH = 3;
const BRACE_CONTROL =
  /^\s*(?:\}\s*)?(?:if|else\s+if|else|for|while|switch|try|catch|do|match|loop|select)\b/;
const PY_CONTROL = /^\s*(?:if|elif|else|for|while|try|except|finally|with)\b/;
const BRANCHING = /^\s*(?:\}\s*)?(?:if|for|while|switch|try|match|loop|select|elif)\b/;
const BRANCH_ELSE = /^\s*(?:\}\s*)?else\b/;
const LEAVES_BLOCK = /^\s*(?:return|throw|raise|continue|break)\b/;

const indentOf = (text) => text.match(/^\s*/)[0].replace(/\t/g, " ".repeat(TAB_WIDTH)).length;

/** An `if` inside three other blocks, and an `else` after a block that already left. */
function deepNesting(files) {
  const hits = [];
  for (const file of files) {
    const python = file.language === "py";
    const opens = python ? /:\s*$/ : /\{\s*$/;
    const isControl = python ? PY_CONTROL : BRACE_CONTROL;
    for (const { lines } of file.hunks) {
      const stack = [];
      let previous = "";
      for (const line of lines) {
        if (!line.text.trim()) continue;
        const indent = indentOf(line.text);
        while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();
        const control = isControl.test(line.text);
        if (line.kind === "add") {
          if (BRANCH_ELSE.test(line.text) && LEAVES_BLOCK.test(previous))
            hits.push({ path: file.path, n: line.n, text: line.text });
          else if (BRANCHING.test(line.text) && opens.test(line.text)) {
            let depth = 0;
            let reported = false;
            for (let at = stack.length - 1; at >= 0 && stack[at].control; at--) {
              depth++;
              reported ||= stack[at].reported;
            }
            if (depth >= NESTING_DEPTH && !reported) {
              hits.push({ path: file.path, n: line.n, text: line.text });
              stack.push({ indent, control, reported: true });
              previous = line.text;
              continue;
            }
          }
        }
        if (opens.test(line.text)) stack.push({ indent, control, reported: false });
        previous = line.text;
      }
    }
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
  {
    id: "echo-comment",
    label: "comment that only repeats the code under it",
    fix: "delete it, or say why the code does this",
    scan: echoComments,
  },
  {
    id: "silenced-type",
    label: "cast or suppression that only silences the type checker",
    fix: "fix the type, or narrow it with a guard and name the reason",
    scan: silencedTypes,
  },
  {
    id: "fallback",
    label: "fallback or guard nobody asked for",
    fix: "remove it, or keep it and name the case it covers",
    scan: unrequestedFallbacks,
  },
  {
    id: "nesting",
    label: "nesting that early returns would flatten",
    fix: "return or continue early and keep the main path at one level",
    scan: deepNesting,
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
