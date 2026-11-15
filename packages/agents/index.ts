// index.ts — pi extension: agents.
//
// `/agents [dir]` ensures the chosen directory has an AGENTS.md, the context
// file pi loads for work in that directory and below. A missing file gets a
// small scaffold plus the directory's package.json scripts. An existing file is
// never rewritten: only a missing Commands section is appended, after the
// existing bytes. No model, no key, no network, and no project rules invented:
// what it adds is read from package.json.

import { readdir, readFile, realpath, rename, unlink, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AGENTS_FILE, planAgentsFile } from "./scaffold.mjs";

/** package.json scripts in this directory, or {} when absent, unreadable or invalid. */
async function packageScripts(dir: string) {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    return parsed && typeof parsed.scripts === "object" && parsed.scripts ? parsed.scripts : {};
  } catch {
    return {};
  }
}

/** The entry named `name`, matched case-insensitively so AGENTS.MD is found too. */
async function findEntry(dir: string, name: string) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.find((entry) => entry.name.toLowerCase() === name) ?? null;
}

/**
 * Write atomically without replacing a symlink with a regular file: resolve the
 * link first, then put the temp file beside the real target.
 */
async function writeKeepingLink(path: string, content: string) {
  const target = await realpath(path).catch(() => path);
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Short display path: relative inside the session, absolute outside it. */
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
      const info = await stat(dir).catch(() => null);
      if (!info) {
        ctx.ui?.notify?.(`agents: ${label(cwd, dir)}: no such directory`, "error");
        return;
      }
      if (!info.isDirectory()) {
        ctx.ui?.notify?.(`agents: ${label(cwd, dir)} is not a directory`, "error");
        return;
      }
      const existing = await findEntry(dir, AGENTS_FILE.toLowerCase());
      if (!existing) {
        const override = await findEntry(dir, "agents.override.md");
        if (override) {
          ctx.ui?.notify?.(
            `agents: ${label(cwd, join(dir, override.name))} replaces AGENTS.md here; edit it instead`,
            "warning",
          );
          return;
        }
      }
      const path = existing ? join(dir, existing.name) : join(dir, AGENTS_FILE);
      target = path;
      const content = existing ? await readFile(path, "utf8") : null;
      const scripts = await packageScripts(dir);
      const plan = planAgentsFile(content, { scripts });
      if (plan.action === "unchanged") {
        const reason = plan.commandCount
          ? "already documents commands"
          : "there are no package.json scripts to add";
        ctx.ui?.notify?.(`agents: ${label(cwd, path)}: ${reason}`, "info");
        return;
      }
      await writeKeepingLink(path, plan.content);
      ctx.ui?.notify?.(
        plan.action === "create"
          ? `agents: created ${label(cwd, path)}`
          : `agents: updated ${label(cwd, path)}: added Commands, existing content kept`,
        "info",
      );
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
