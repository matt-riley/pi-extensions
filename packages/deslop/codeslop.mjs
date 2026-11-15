// codeslop.mjs — the code half of deslop: patterns that a model leaves in the
// code it writes, found in the lines a branch added.
//
// This is a separate pass from the prose checklist in patterns.mjs and shares
// none of its patterns. It reads a unified diff, looks only at added lines
// (plus the context lines git prints around them), and returns proposals in the
// shape formatFindings already prints. Every check is a heuristic: a hit is a
// place to look, never a rewrite, and nothing here edits a file.

import { formatFindings } from "./patterns.mjs";

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
 * files and anything that is not code are dropped. Tests and generated output
 * stay in, marked `skipped`: they are not examined, but they do use the code.
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
        path !== "/dev/null" && CODE_FILE.test(path)
          ? {
              path,
              language: languageOf(path),
              skipped: SKIPPED_PATH.test(path),
              hunks: [],
              removed: [],
            }
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

/** A quiet handler has at most this many lines; a longer block is real handling. */
const QUIET_BODY_LINES = 1;

/**
 * The lines after `at` in a hunk, up to the line that closes the block, or null
 * when the block is longer than a quiet handler can be. Stopping early keeps
 * the scan short even when no line ever closes.
 */
function blockBody(lines, at, closes) {
  const body = [];
  for (let next = at + 1; next < lines.length; next++) {
    if (closes(lines[next].text)) return body;
    if (body.length >= QUIET_BODY_LINES) return null;
    body.push(lines[next].text);
  }
  return null;
}

/** Errors dropped into false, null or an empty value, with no log and no reason. */
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
const CHAIN_OPERAND = String.raw`(?:""|\[\]|\{\}|[\w$]+(?:\??\.[\w$]+)*(?:\([^()]*\))?)`;
/** `a ?? b ?? c`: three operands in a row, not two separate defaults on one line. */
const NULLISH_CHAIN = new RegExp(
  String.raw`${CHAIN_OPERAND}\s*\?\?\s*${CHAIN_OPERAND}\s*\?\?\s*${CHAIN_OPERAND}`,
);

/** Defaults, guards and compatibility shims that a comment admits no one wanted. */
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

const FORWARDER_NAME = /^\s*(?:export\s+)?(?:(?:async\s+)?(?:function|def)\s+|const\s+)(\w+)/;
const IDENTIFIER = /[A-Za-z_]\w*/g;
const INTERFACE_DECLARATION = /^\s*(?:export\s+)?(?:interface|abstract\s+class)\s+([A-Za-z_]\w*)/;
const IMPLEMENTS_OR_EXTENDS = /\b(?:implements|extends)\b/;

/**
 * A function whose whole body forwards its parameters, in order, to one other
 * function. The patterns capture (name, parameters, target, arguments).
 */
const FORWARDERS = [
  /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::[^=>]*)?=>\s*(?:await\s+)?([\w.$]+)\(([^()]*)\)\s*;?\s*$/,
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*(?::[^{]*)?\{\s*return\s+(?:await\s+)?([\w.$]+)\(([^()]*)\)\s*;?\s*\}\s*$/,
];
const FORWARDER_OPEN =
  /^\s*(?:export\s+)?(?:(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)(?::[^{]*)?|const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::[^=>]*)?=>)\s*\{\s*$/;
const PY_FORWARDER_OPEN = /^\s*(?:async\s+)?def\s+(\w+)\(([^)]*)\)(?:\s*->[^:]*)?:\s*$/;
const RETURNED_CALL = /^\s*return\s+(?:await\s+)?([\w.$]+)\(([^()]*)\)\s*;?\s*$/;

/** A parameter's name: without its type, default or optional mark. Null when it is not a plain name. */
function parameterName(param) {
  const trimmed = param.trim();
  if (/[<>{}[\]]/.test(trimmed.split(/[:=]/)[0])) return null;
  return trimmed.split(/[:=]/)[0].replace(/\?$/, "").trim();
}

function forwards(name, params, target, args) {
  if (!name || !target || target.split(".").at(-1) === name) return false;
  const names = params
    .split(",")
    .map(parameterName)
    .filter((item) => item !== "");
  const passed = args
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const own = names.filter((item) => item !== "self" && item !== "cls");
  return (
    !names.includes(null) &&
    own.length === passed.length &&
    own.every((item, at) => item === passed[at])
  );
}

/** Whether the added line at `at` declares a function that only forwards its call. */
function forwarderAt(language, lines, at) {
  const text = lines[at].text;
  if (language === "py") {
    const open = PY_FORWARDER_OPEN.exec(text);
    const call = RETURNED_CALL.exec(lines[at + 1]?.text ?? "");
    const after = lines[at + 2]?.text;
    const ended = after === undefined || !after.trim() || indentOf(after) <= indentOf(text);
    return Boolean(open && call && ended && forwards(open[1], open[2], call[1], call[2]));
  }
  for (const pattern of FORWARDERS) {
    const found = pattern.exec(text);
    if (found && forwards(found[1], found[2], found[3], found[4])) return true;
  }
  const open = FORWARDER_OPEN.exec(text);
  const call = RETURNED_CALL.exec(lines[at + 1]?.text ?? "");
  return Boolean(
    open &&
    call &&
    CLOSING_BRACE.test(lines[at + 2]?.text ?? "") &&
    forwards(open[1] ?? open[3], open[2] ?? open[4], call[1], call[2]),
  );
}

/**
 * How many lines with `implements` or `extends` name each identifier, counted
 * in one pass so the cost does not grow with the number of interfaces. The
 * name a line declares is not counted as implementing itself.
 */
function implementerCounts(lines) {
  const counts = new Map();
  for (const text of lines) {
    if (!IMPLEMENTS_OR_EXTENDS.test(text)) continue;
    const declaring = /\b(?:interface|class)\s+([A-Za-z_]\w*)/.exec(text)?.[1];
    for (const word of new Set(text.match(IDENTIFIER) ?? []))
      if (word !== declaring) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * Abstractions that add a name and nothing else: a type or interface the diff
 * implements exactly once, and a function that only forwards to another. Tests
 * count as implementers, and a name that a removed line also declares is an
 * edit to old code, so it is skipped. Private helpers used once are ordinary
 * code and are not reported.
 */
function emptyAbstractions(files, everything) {
  const lines = everything.flatMap((file) =>
    file.hunks.flatMap(({ lines: hunk }) => hunk.map((line) => line.text)),
  );
  const implementers = implementerCounts(lines);
  const oldNames = new Set(
    everything.flatMap((file) =>
      file.removed.flatMap((text) => {
        const name = INTERFACE_DECLARATION.exec(text)?.[1] ?? FORWARDER_NAME.exec(text)?.[1];
        return name ? [name] : [];
      }),
    ),
  );
  const hits = [];
  for (const file of files)
    for (const { lines: hunk } of file.hunks)
      for (const [at, line] of hunk.entries()) {
        if (line.kind !== "add") continue;
        const interfaceName = INTERFACE_DECLARATION.exec(line.text)?.[1];
        const empty = interfaceName
          ? !oldNames.has(interfaceName) && (implementers.get(interfaceName) ?? 0) === 1
          : !oldNames.has(FORWARDER_NAME.exec(line.text)?.[1]) &&
            forwarderAt(file.language, hunk, at);
        if (empty) hits.push({ path: file.path, n: line.n, text: line.text });
      }
  return hits;
}

const CHECKS = [
  {
    id: "swallowed",
    label: "failure turned into a normal-looking value",
    fix: "propagate it, or record why dropping it is safe",
    scan: swallowedErrors,
  },
  {
    id: "echo-comment",
    label: "comment saying what the next line already says",
    fix: "delete it, or write down why the line exists",
    scan: echoComments,
  },
  {
    id: "silenced-type",
    label: "type escape hatch used to quiet the compiler",
    fix: "give the value its real type, or add a guard and say why it holds",
    scan: silencedTypes,
  },
  {
    id: "fallback",
    label: "default or guard for a case nobody described",
    fix: "drop it, or note which case it handles",
    scan: unrequestedFallbacks,
  },
  {
    id: "nesting",
    label: "logic buried under several levels of conditions",
    fix: "test the failing case first and leave, so the main path stays shallow",
    scan: deepNesting,
  },
  {
    id: "single-use",
    severity: "low",
    label: "interface with a single implementation, or wrapper that only forwards",
    fix: "use the concrete thing directly unless a second implementation is planned",
    scan: emptyAbstractions,
  },
];

/**
 * Proposals for a branch diff, one finding per check that hit. Each carries up
 * to a few `path:line: code` excerpts. The shape matches the prose findings, so
 * formatFindings prints both.
 */
export function findCodeSlop(diff) {
  const everything = parseDiff(diff);
  const files = everything.filter((file) => !file.skipped);
  const findings = [];
  for (const check of CHECKS) {
    const hits = check.scan(files, everything);
    if (hits.length === 0) continue;
    findings.push({
      id: check.id,
      sign: "code-slop",
      severity: check.severity ?? "medium",
      label: hits.length > MAX_EXCERPTS ? `${check.label}, ${hits.length} in all` : check.label,
      fix: check.fix,
      count: hits.length,
      excerpts: hits
        .slice(0, MAX_EXCERPTS)
        .map((hit) => `${hit.path}:${hit.n}: ${hit.text.trim().slice(0, MAX_EXCERPT_CHARS)}`),
    });
  }
  return findings;
}

const GIT_TIMEOUT_MS = 10_000;
const SAFE_REF = /^[A-Za-z0-9_][\w./@^~-]*$/;
const DEFAULT_BASES = ["origin/main", "origin/master", "main", "master"];

/** Run one read-only git command; its trimmed stdout, or null when it fails. */
async function git(exec, cwd, args) {
  try {
    const result = await exec("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
    return result?.code === 0 ? String(result.stdout ?? "") : null;
  } catch {
    return null;
  }
}

async function defaultBase(exec, cwd) {
  const head = (
    await git(exec, cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
  )?.trim();
  if (head && SAFE_REF.test(head)) return head;
  for (const candidate of DEFAULT_BASES)
    if ((await git(exec, cwd, ["rev-parse", "--verify", "--quiet", candidate])) !== null)
      return candidate;
  return null;
}

/** Low findings are hints: they are shown only beside a medium one, never alone. */
const reportable = (findings) => (findings.some((item) => item.severity !== "low") ? findings : []);

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The code pass over a branch: diff the working tree against the merge base
 * with the default branch (or `base`), run the checks over what was added, and
 * say what they found. Only read-only git commands run. `exec` matches pi.exec.
 */
export async function reviewBranch(exec, cwd, base) {
  if (base !== undefined && !SAFE_REF.test(base))
    return `deslop code: ${JSON.stringify(base)} is not a usable base ref.`;
  const against = base ?? (await defaultBase(exec, cwd));
  if (!against)
    return "deslop code: could not find a default branch to compare against. Pass one: /deslop code <base>.";
  const mergeBase = (await git(exec, cwd, ["merge-base", "HEAD", against]))?.trim();
  if (!mergeBase) return `deslop code: could not find a merge base between HEAD and ${against}.`;
  const diff = await git(exec, cwd, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "-U3",
    mergeBase,
    "--",
  ]);
  if (diff === null) return "deslop code: git diff failed.";
  if (!diff.trim()) return `deslop code: no changes since ${against}.`;

  const findings = reportable(findCodeSlop(diff));
  const examined = parseDiff(diff).filter((file) => !file.skipped).length;
  const proposals = findings.reduce((sum, item) => sum + item.count, 0);
  const cut =
    diff.length > MAX_DIFF_CHARS ? ` The diff was cut at ${MAX_DIFF_CHARS} characters.` : "";
  const where = `in ${plural(examined, "file")} changed since ${against}`;
  if (proposals === 0) return `deslop code: no proposals ${where}.${cut}`;
  return [
    `deslop code: ${plural(proposals, "proposal")} ${where}.${cut}`,
    formatFindings(findings),
    "These are heuristic proposals: each is a place to look, and none is a rewrite. " +
      "Nothing was edited. Files git does not track yet are not included.",
  ].join("\n");
}
