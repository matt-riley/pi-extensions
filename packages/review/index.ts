// index.ts — pi extension: semantic review of a change.
//
// Registers:
//   lint_change      — judge a staged/worktree change against the preferences
//                      AGENTS.md states as judgement calls, and check the
//                      Conventional Commit shape of a message in code
//   verify_findings  — check review findings against the diff they claim to
//                      be about, dropping the ones that quote code that is
//                      not there
//
// Both are advisory: they return text the agent reads, and neither blocks a
// tool call. Both are on demand, because a Jev request on every edit would be
// paid for on changes nobody asked about.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bindSystemOne } from "../../shared/systemone.mjs";
import { OPEN_READ } from "../../shared/tool-annotations.mjs";

import { formatVerified, verifyFindings } from "./findings.mjs";
import { MAX_DIFF_CHARS, formatFindings, lintChange } from "./lint.mjs";

const GIT_TIMEOUT_MS = 5_000;
const DIFF_ARGS = ["--no-color", "-U3"];

const SCOPE_DESC =
  "What to judge: staged (default), worktree (unstaged), or range (a ref through the worktree).";

/** git, with a failure returned as null rather than thrown into a tool call. */
async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | null> {
  const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return result.code === 0 ? result.stdout : null;
}

function selector(scope: string, ref?: string): string[] | null {
  if (scope === "worktree") return ["diff"];
  if (scope === "range") return ref ? ["diff", ref] : null;
  return ["diff", "--cached"];
}

function formatLint(result: {
  findings: { id: string; probability: number; label: string }[];
  subject: string[];
  judged: boolean;
  truncated: boolean;
  reason?: string;
}): string {
  const lines: string[] = [];
  if (!result.judged) {
    lines.push("Not judged: " + (result.reason ?? "no judgment"));
  }
  if (result.truncated) {
    lines.push("Diff cut at " + MAX_DIFF_CHARS + " characters; only the first part was judged.");
  }
  for (const problem of result.subject ?? []) {
    lines.push("subject: " + problem);
  }
  const body = formatFindings(result.findings ?? []);
  if (body) lines.push(body);
  else if (result.judged) lines.push("No findings above threshold.");
  return lines.join("\n");
}

export default function piReviewExtension(pi: ExtensionAPI) {
  bindSystemOne(pi);
  pi.registerTool({
    name: "lint_change",
    label: "lint_change",
    annotations: OPEN_READ,
    description:
      "Judge a staged or working-tree change against the repository's stated preferences — the ones a linter " +
      "cannot decide: more machinery than the problem needs, an abstraction nothing calls for, speculative " +
      "scaffolding, a reinvented dependency, scope creep, weak tests. With a commit message it also judges " +
      "whether the subject describes the diff, whether the change is one logical commit, and whether the " +
      "Conventional Commit type matches. The subject's mechanical shape (type, lowercase, punctuation) is checked " +
      "in code. Returns one line per suspected violation with its probability; advisory only. Requires " +
      "TYPESAFE_API_KEY.",
    promptSnippet:
      "lint_change(scope?, message?, task?): semantic preference and commit-message lint over a git diff, one line per finding with probability",
    promptGuidelines: [
      "Run lint_change on the staged diff before committing when the repo's conventions are prose rather than lint rules; treat its lines as findings to weigh, not a gate.",
      "Pass message when you are about to commit: it also checks that the subject describes the diff and that the change is a single concern.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal("staged"), Type.Literal("worktree"), Type.Literal("range")], {
          description: SCOPE_DESC,
        }),
      ),
      ref: Type.Optional(
        Type.String({ description: "With scope=range: the base ref to diff from (e.g. main)." }),
      ),
      message: Type.Optional(
        Type.String({
          description:
            "The commit message about to be used; enables the subject and single-concern checks.",
        }),
      ),
      task: Type.Optional(
        Type.String({
          description:
            "What the user asked for. Enables the scope-creep check, which needs something to compare against.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const scope = params?.scope ?? "staged";
      const base = selector(scope, params?.ref);
      if (!base) {
        return {
          content: [{ type: "text", text: "Rejected: scope=range needs a ref." }],
          isError: true,
        };
      }
      const [diff, files] = await Promise.all([
        git(pi, cwd, [...base, ...DIFF_ARGS]),
        git(pi, cwd, [...base, "--name-only"]),
      ]);
      if (diff === null || files === null) {
        return {
          content: [{ type: "text", text: "lint_change failed: git could not read the change." }],
          isError: true,
        };
      }
      if (!diff.trim()) {
        return {
          content: [
            {
              type: "text",
              text:
                scope === "staged"
                  ? "Nothing staged. Pass scope: worktree to judge unstaged changes."
                  : "No change to judge.",
            },
          ],
        };
      }
      const result = await lintChange({
        diff,
        files: files.split("\n").filter(Boolean),
        message: params?.message,
        task: params?.task,
        signal,
      });
      return { content: [{ type: "text", text: formatLint(result) }] };
    },
  });

  pi.registerTool({
    name: "verify_findings",
    label: "verify_findings",
    annotations: OPEN_READ,
    description:
      "Check review findings against the diff they claim to be about. A finding that quotes code absent from the " +
      "diff is dropped without a judgment — a string comparison — and the rest are asked whether the diff shows " +
      "the defect and how serious it is. Returns the findings that hold, strongest first, with support and " +
      "severity, plus what was dropped and why. Use it after writing a review, before handing the findings to " +
      "someone who has to act on them. Requires TYPESAFE_API_KEY.",
    promptSnippet:
      "verify_findings(findings, diff?): drop findings whose quoted code is not in the diff, then rank the rest by support and severity",
    promptGuidelines: [
      "After producing review findings, run verify_findings on them so the ones reported are the ones the diff supports.",
      "Quote the exact code in each finding; a finding with a correct quotation is kept even when the judgment is uncertain.",
    ],
    parameters: Type.Object({
      findings: Type.Array(Type.String(), {
        description: "Review findings as written, one string each; at most 10.",
      }),
      diff: Type.Optional(
        Type.String({
          description:
            "The diff the findings are about. Defaults to git diff HEAD (staged and unstaged tracked changes).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const findings = Array.isArray(params?.findings) ? params.findings : [];
      if (findings.length === 0) {
        return {
          content: [{ type: "text", text: "Rejected: no findings to verify." }],
          isError: true,
        };
      }
      const diff = params?.diff ?? (await git(pi, cwd, ["diff", "HEAD", ...DIFF_ARGS])) ?? "";
      if (!String(diff).trim()) {
        return {
          content: [
            {
              type: "text",
              text: "No change to verify against. Pass the diff the findings describe.",
            },
          ],
        };
      }
      const result = await verifyFindings({ findings, diff, signal });
      return { content: [{ type: "text", text: formatVerified(result) }] };
    },
  });
}
