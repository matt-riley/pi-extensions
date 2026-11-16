// index.ts — pi extension: affected.
//
// `/affected [base]` and the deferred `affected_tests` tool name the test files that
// can reach what changed (working-tree edits, plus everything since `base` when one
// is given), by walking the repository's import graph backwards. TypeScript and
// JavaScript only. They report the gaps (changed files no test reaches, non-JS
// files, deleted files) and, when the graph is incomplete, say to run the
// package-level test command instead. Nothing is run and nothing is written: this
// is selection, not execution. No model, no key, no network.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { LOCAL_READ } from "../../shared/tool-annotations.mjs";
import { findRepoRoot, listRepoFiles } from "../../shared/inventory.mjs";
import { formatAffected, selectAffected } from "./affected.mjs";
import { changedFiles } from "./changed.mjs";

export default function piAffectedExtension(pi: ExtensionAPI) {
  const exec = async (cmd: string, args: string[], opts?: { timeout?: number }) => {
    const result = await pi.exec(cmd, args, { timeout: opts?.timeout ?? 10_000 });
    return {
      code: result.code,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  };

  const run = async (ctx: ExtensionContext, base?: string, explicit?: string[]) => {
    const { root } = await findRepoRoot(ctx.cwd ?? process.cwd(), exec);
    let changed = explicit ?? [];
    if (!explicit) {
      const result = await changedFiles({ exec, root, base });
      if (result.error) return { error: result.error };
      changed = result.files;
    }
    const { files, truncated } = await listRepoFiles({ root, exec });
    const report = await selectAffected({
      files,
      readFile: (rel: string) => readFile(join(root, rel), "utf8").catch(() => null),
      changed,
      inventoryCapped: truncated,
    });
    return { report };
  };

  pi.registerCommand("affected", {
    description: "Name the test files that can reach your changes (usage: /affected [base-ref])",
    handler: async (args, ctx) => {
      const base = String(args ?? "").trim() || undefined;
      const { report, error } = await run(ctx, base);
      if (error || !report) {
        ctx.ui?.notify?.(`Affected tests: ${error}`, "warning");
        return;
      }
      ctx.ui?.notify?.(formatAffected(report), report.mode === "fallback" ? "warning" : "info");
    },
  });

  pi.registerTool({
    name: "affected_tests",
    label: "affected_tests",
    exposure: "deferred",
    annotations: LOCAL_READ,
    description:
      "Read-only test selection: which test files can reach the changed files (working-tree edits, " +
      "plus everything since an optional base ref), by walking the TypeScript/JavaScript import graph " +
      "backwards. Reports gaps (changed files no test reaches, non-JS files, deleted files) and, when the " +
      "graph is incomplete (computed import(), unresolved imports, file caps), returns mode 'fallback' with " +
      "the package-level test command to run instead. It runs no tests and changes nothing.",
    parameters: Type.Object({
      base: Type.Optional(
        Type.String({ description: "Git ref to compare against, for example origin/main." }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description: "Repo-relative changed files to use instead of asking git.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { report, error } = await run(ctx, params?.base, params?.files);
      if (error || !report) {
        return { content: [{ type: "text", text: `Affected tests: ${error}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: formatAffected(report) }],
        structuredContent: report,
      };
    },
  });
}
