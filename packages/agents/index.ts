// /agents [dir] asks the active agent to initialize or improve scoped guidance.
// Validate the destination first; inspection and edits use normal agent tools.
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AGENTS_FILE, agentsPrompt } from "./scaffold.mjs";

/** Match case-insensitively so AGENTS.MD is improved rather than duplicated. */
async function findEntry(dir: string, name: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.find((entry) => entry.name.toLowerCase() === name) ?? null;
}

function label(cwd: string, path: string) {
  const shown = relative(cwd, path);
  return shown && !shown.startsWith("..") ? shown : path;
}

export default function piAgentsExtension(pi: ExtensionAPI) {
  const run = async (args: string, ctx: ExtensionContext) => {
    const cwd = ctx.cwd ?? process.cwd();
    const dir = resolve(cwd, String(args ?? "").trim() || ".");
    let target = dir;
    try {
      const info = await stat(dir).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) {
        ctx.ui?.notify?.(`agents: ${label(cwd, dir)}: no such directory`, "error");
        return;
      }
      if (!info.isDirectory()) {
        ctx.ui?.notify?.(`agents: ${label(cwd, dir)} is not a directory`, "error");
        return;
      }
      const override = await findEntry(dir, "agents.override.md");
      if (override) {
        ctx.ui?.notify?.(
          `agents: ${label(cwd, join(dir, override.name))} replaces AGENTS.md here; edit it instead`,
          "warning",
        );
        return;
      }
      const existing = await findEntry(dir, AGENTS_FILE.toLowerCase());
      const path = existing ? join(dir, existing.name) : join(dir, AGENTS_FILE);
      target = path;
      if (existing) await readFile(path, "utf8"); // Fail closed on unreadable or broken links.
      const resolvedTarget = existing ? await realpath(path) : path;
      pi.sendUserMessage(agentsPrompt({ dir, path, target: resolvedTarget }), {
        deliverAs: "followUp",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify?.(`agents: ${label(cwd, target)}: ${message}`, "error");
    }
  };

  pi.registerCommand("agents", {
    description: "Create or improve AGENTS.md in a directory: /agents [dir]",
    handler: run,
  });
}
