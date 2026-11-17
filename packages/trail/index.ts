// index.ts — pi extension: the `decision_log` tool, an append-only decision
// trail at .pi/runs/decisions.tsv. The evidence pointer of each row is checked
// at write time, so the end-of-run audit (prompts/trail.md) has less to find.

import { Type } from "typebox";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { LOCAL_DESTRUCTIVE } from "../../shared/tool-annotations.mjs";
import { appendDecision, checkEvidence, describeResult } from "./trail.mjs";

const GIT_TIMEOUT_MS = 10_000;

export default function piTrailExtension(pi: ExtensionAPI) {
  // Whether this session has written a row yet; the first write to an
  // existing log adds a `start` row.
  let started = false;

  pi.on("session_start", () => {
    started = false;
  });

  pi.registerTool({
    name: "decision_log",
    label: "Decision log",
    exposure: "deferred",
    // Appends a file in the workspace, and runs git to resolve commit SHAs.
    annotations: LOCAL_DESTRUCTIVE,
    description:
      "Append one row to this task's decision trail (.pi/runs/decisions.tsv): a fork chosen, a unit " +
      "finished with its check result, a pivot or revert and what triggered it, a blocker. Not every " +
      "action. Evidence is a pointer (commit SHA, path:line, command, PR number, artifact path), never a " +
      "paragraph; paths and SHAs are checked. Rows are never edited: supersede a wrong row with a new one.",
    parameters: Type.Object({
      phase: Type.String({
        minLength: 1,
        maxLength: 80,
        description: "Stage of the task, e.g. plan, fix, verify",
      }),
      decision: Type.String({
        minLength: 1,
        maxLength: 300,
        description: "What was chosen or done, one line, plain words",
      }),
      why: Type.String({
        minLength: 1,
        maxLength: 300,
        description: "What triggered or justified it",
      }),
      evidence: Type.String({
        minLength: 1,
        maxLength: 300,
        description: "commit SHA, path:line, command, PR number, or artifact path",
      }),
      result: Type.String({
        minLength: 1,
        maxLength: 120,
        description: "tests green | reverted | INCONCLUSIVE | open | ...",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const check = await checkEvidence(params.evidence, cwd, (args: string[]) =>
        pi.exec("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS }),
      );
      const file = appendDecision(cwd, params, {
        started,
        session: ctx.sessionManager?.getSessionId?.(),
      });
      started = true;
      const text = describeResult(file, check);
      return {
        content: [{ type: "text", text }],
        details: { file, evidence: check },
      };
    },
  });
}
