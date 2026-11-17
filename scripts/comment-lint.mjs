// @ts-check
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/** @typedef {{ rule: string, line: number, message: string }} Finding */

/**
 * Only exact narration of simple statements is a mechanical finding.
 * Documentation and uncertain prose are preserved, not certified accurate.
 * @param {string} filename
 * @param {string} source
 * @returns {Finding[]}
 */
export function lintComments(filename, source) {
  if (!/\.[cm]?[jt]sx?$/.test(filename)) return [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  /** @type {Finding[]} */
  const findings = [];
  /** @param {ts.Node} node */
  function visit(node) {
    const phrases = narration(node);
    if (phrases.length) {
      const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
      const range = ranges[0];
      if (ranges.length === 1 && range) {
        const raw = source.slice(range.pos, range.end);
        const lineStart = source.lastIndexOf("\n", range.pos - 1) + 1;
        const gap = source.slice(range.end, node.getStart(tree));
        if (
          !raw.startsWith("/**") &&
          !/[\r\n]/.test(raw) &&
          /^\s*$/.test(source.slice(lineStart, range.pos)) &&
          /^\s*$/.test(gap) &&
          (gap.match(/\n/g) ?? []).length <= 1
        ) {
          const text = raw
            .replace(/^\/\/\s*|^\/\*\s*|\s*\*\/$/g, "")
            .trim()
            .replace(/\.$/, "")
            .toLowerCase();
          if (phrases.includes(text))
            findings.push({
              rule: "no-needless-comment",
              line: tree.getLineAndCharacterOfPosition(range.pos).line + 1,
              message: "Comment only narrates the statement; remove it or explain its reason.",
            });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}

const SUPPRESSION =
  /^\s*\*?\s*(@ts-(?:ignore|expect-error|nocheck)|(?:eslint|oxlint)-disable(?:-next-line|-line)?)(?=[\s:]|$)(.*)$/s;
const MIN_REASON = 10;

/**
 * A suppression directive without a stated reason. Directives are read from the
 * parser's comment ranges, so a string, template or regex that mentions one is
 * not a comment, and a sentence that names one mid-comment is not a directive.
 * The reason goes inline (`-- why` for eslint/oxlint, text after the directive
 * for TypeScript) or in the comment directly above a directive on its own line,
 * the way this repository already writes them.
 * @param {string} filename
 * @param {string} source
 * @returns {Finding[]}
 */
export function lintSuppressions(filename, source) {
  if (!/\.[cm]?[jt]sx?$/.test(filename)) return [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const comments = commentRanges(tree, source);
  /** @type {Finding[]} */
  const findings = [];
  for (const [index, range] of comments.entries()) {
    const match = SUPPRESSION.exec(commentBody(source, range));
    if (!match) continue;
    const [, directive = "", rest = ""] = match;
    const inline = directive.startsWith("@ts-")
      ? rest.replace(/^\s*[:-]?\s*/, "")
      : (/(?:^|\s)--\s*(\S.*)$/s.exec(rest)?.[1] ?? "");
    if (inline.trim().length >= MIN_REASON) continue;
    const above = comments[index - 1];
    if (
      above &&
      startsLine(source, range.pos) &&
      startsLine(source, above.pos) &&
      /^[ \t]*\r?\n[ \t]*$/.test(source.slice(above.end, range.pos)) &&
      !SUPPRESSION.test(commentBody(source, above)) &&
      commentBody(source, above).trim().length >= MIN_REASON
    )
      continue;
    findings.push({
      rule: "suppression-needs-reason",
      line: tree.getLineAndCharacterOfPosition(range.pos).line + 1,
      message: `\`${directive}\` has no reason. Fix the finding, or state why the rule is wrong here.`,
    });
  }
  return findings;
}

/** @param {string} source @param {ts.CommentRange} range */
function commentBody(source, range) {
  return source.slice(range.pos, range.end).replace(/^\/\/|^\/\*|\*\/$/g, "");
}

/** @param {string} source @param {number} pos */
function startsLine(source, pos) {
  return /^[ \t]*$/.test(source.slice(source.lastIndexOf("\n", pos - 1) + 1, pos));
}

/**
 * Every comment in the file, in order. Trivia is read around each token the
 * parser produced, so a comment after a `{` or inside an empty block counts too.
 * JSX text is skipped: `<p>// text</p>` is markup, not a comment.
 * @param {ts.SourceFile} tree
 * @param {string} source
 * @returns {ts.CommentRange[]}
 */
function commentRanges(tree, source) {
  /** @type {Map<number, ts.CommentRange>} */
  const found = new Map();
  /** @type {Array<[number, number]>} */
  const markup = [];
  /** @param {ts.Node} node */
  function walk(node) {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    if (ts.isJsxText(node)) markup.push([node.pos, node.end]);
    const children = node.getChildren(tree);
    if (children.length) {
      for (const child of children) walk(child);
      return;
    }
    for (const range of [
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
      ...(ts.getTrailingCommentRanges(source, node.end) ?? []),
    ])
      found.set(range.pos, range);
  }
  walk(tree);
  return [...found.values()]
    .filter((range) => !markup.some(([start, end]) => range.pos >= start && range.pos < end))
    .sort((a, b) => a.pos - b.pos);
}

/** @param {ts.Node} node @returns {string[]} */
function narration(node) {
  if (ts.isReturnStatement(node) && node.expression) {
    const expression = node.expression;
    if (ts.isIdentifier(expression)) return [`return ${expression.text.toLowerCase()}`];
    if (isLiteral(expression)) return [`return ${expression.getText().toLowerCase()}`];
  }
  if (ts.isVariableStatement(node)) {
    const declarations = node.declarationList.declarations;
    if (declarations.length !== 1) return [];
    const declaration = declarations[0];
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return [];
    const name = declaration.name.text.toLowerCase();
    return [`define ${name}`, `declare ${name}`, `initialize ${name}`, `initialise ${name}`];
  }
  if (!ts.isExpressionStatement(node)) return [];
  const expr = node.expression;
  if (
    (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) &&
    ts.isIdentifier(expr.operand)
  ) {
    const action =
      expr.operator === ts.SyntaxKind.PlusPlusToken
        ? "increment"
        : expr.operator === ts.SyntaxKind.MinusMinusToken
          ? "decrement"
          : null;
    if (action)
      return [
        `${action} ${expr.operand.text.toLowerCase()}`,
        `${action} the ${expr.operand.text.toLowerCase()}`,
      ];
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression))
    return [`call ${expr.expression.text.toLowerCase()}`];
  return [];
}

/** @param {ts.Expression} node */
function isLiteral(node) {
  return (
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  );
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dirname, ".."));
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  ).split("\0");
  let errors = 0;
  for (const file of new Set(files)) {
    if (!/\.[cm]?[jt]sx?$/.test(file) || file.startsWith("node_modules/")) continue;
    const target = resolve(root, file);
    if (!statSync(target, { throwIfNoEntry: false })?.isFile()) continue;
    const source = readFileSync(target, "utf8");
    const findings = [...lintComments(file, source), ...lintSuppressions(file, source)];
    for (const finding of findings)
      console.error(`${file}:${finding.line}: ${finding.rule}: ${finding.message}`);
    errors += findings.length;
  }
  if (!errors)
    console.log(
      "Comment lint passes (exact statement narration, suppressions with reasons; documentation preserved)",
    );
  process.exitCode = errors ? 1 : 0;
}
