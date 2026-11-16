// index.ts — pi extension: docs-drift.
//
// `/docs-drift [--json] [path...]` says, for each README, `docs/` page and
// AGENTS.md-style file, whether the code it describes changed after the doc's last
// commit. The doc is mapped to code by the paths and identifiers it mentions (and
// its own directory, for a README), and judged by git history alone: `stale`,
// `current`, or `can't tell` when it cannot map the doc or trust the history.
// Deterministic: no model, no key, no network. Read-only: it writes nothing.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { findRepoRoot, normalizeRel } from "../../shared/inventory.mjs";
import { checkDocs, formatJson, formatText } from "./stale.mjs";

const USAGE = "Usage: /docs-drift [--json] [path...]";

export default function piDocsDriftExtension(pi: ExtensionAPI) {
  const exec = async (cmd: string, args: string[], opts?: { timeout?: number }) => {
    const result = await pi.exec(cmd, args, { timeout: opts?.timeout ?? 10_000 });
    return {
      code: result.code,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  };

  pi.registerCommand("docs-drift", {
    description:
      "Say which docs describe code that changed after their last commit (usage: /docs-drift [--json] [path...])",
    handler: async (args, ctx) => {
      const words = String(args ?? "")
        .split(/\s+/)
        .filter(Boolean);
      const flags = words.filter((word) => word.startsWith("-"));
      if (flags.some((flag) => flag !== "--json")) {
        ctx.ui?.notify?.(USAGE, "info");
        return;
      }
      const prefixes = words.filter((word) => !word.startsWith("-")).map(normalizeRel);
      const { root } = await findRepoRoot(ctx.cwd ?? process.cwd(), exec);
      const result = await checkDocs({
        exec,
        root,
        readFile: (rel: string) => readFile(join(root, rel), "utf8").catch(() => null),
        prefixes,
      });
      const text = flags.length > 0 ? formatJson(result) : formatText(result);
      ctx.ui?.notify?.(text, result.summary.stale > 0 ? "warning" : "info");
    },
  });
}
