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

/** @param {ts.Node} node @returns {string[]} */
function narration(node) {
  if (ts.isReturnStatement(node) && node.expression && ts.isIdentifier(node.expression))
    return [`return ${node.expression.text.toLowerCase()}`];
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
    const findings = lintComments(file, readFileSync(target, "utf8"));
    for (const finding of findings)
      console.error(`${file}:${finding.line}: ${finding.rule}: ${finding.message}`);
    errors += findings.length;
  }
  if (!errors)
    console.log("Comment lint passes (exact statement narration; documentation preserved)");
  process.exitCode = errors ? 1 : 0;
}
