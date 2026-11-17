// index.ts — pi extension: architecture.
//
// `/architecture` and the deferred `architecture_check` tool check the repository
// against a rules file a person wrote (.pi/architecture.json: which directories
// may not import which) and report import cycles. TypeScript and JavaScript only.
// What it cannot follow (dynamic imports, aliases that point nowhere, files past a
// cap) is listed as incomplete coverage, so a result is never "clean" by omission.
// Deterministic: no model, no key, no network. Read-only: it never writes the rules
// file or anything else.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { piExec } from "../../shared/exec.mjs";
import { LOCAL_READ } from "../../shared/tool-annotations.mjs";
import { findRepoRoot, listRepoFiles } from "../../shared/inventory.mjs";
import { formatReport, runArchitectureCheck } from "./check.mjs";

const RULES_PATH = ".pi/architecture.json";

export default function piArchitectureExtension(pi: ExtensionAPI) {
  const exec = piExec(pi);

  const check = async (ctx: ExtensionContext) => {
    const { root } = await findRepoRoot(ctx.cwd ?? process.cwd(), exec);
    const { files, truncated } = await listRepoFiles({ root, exec });
    const read = (rel: string) => readFile(join(root, rel), "utf8").catch(() => null);
    return runArchitectureCheck({
      files,
      readFile: read,
      rulesText: await read(RULES_PATH),
      inventoryCapped: truncated,
    });
  };

  pi.registerCommand("architecture", {
    description: "Check directory-boundary rules (.pi/architecture.json) and import cycles",
    handler: async (_args, ctx) => {
      const report = await check(ctx);
      ctx.ui?.notify?.(formatReport(report), report.ok ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "architecture_check",
    label: "architecture_check",
    exposure: "deferred",
    annotations: LOCAL_READ,
    description:
      "Read-only architecture check of the repository: which imports break the directory-boundary " +
      "rules in .pi/architecture.json, and which import cycles exist. TypeScript and JavaScript only. " +
      "The result lists what it could not follow (dynamic imports, unresolved aliases, files past a cap); " +
      "treat coverage 'INCOMPLETE' as 'not checked', never as 'clean'. Deterministic; changes nothing.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const report = await check(ctx);
      return {
        content: [{ type: "text", text: formatReport(report) }],
        structuredContent: report,
      };
    },
  });
}
