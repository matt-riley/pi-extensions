// index.ts — pi extension: /until <predicate>, an exit-condition loop.
//
// `agent_before_settle` is pi's last actionable boundary before a run settles:
// a handler can append a custom_message draft (it reaches the model as a user
// message) and return `continue: true` for one more model request. That is the
// whole loop — re-check the predicate there, and either stop or send the
// failing output back.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { TSV_HEADER, decide, kickoffMessage, parseArgs, tsvRow } from "./loop.mjs";

const PREDICATE_TIMEOUT_MS = 10 * 60_000;
const STATUS_ID = "until";

interface Loop {
  command: string;
  task: string;
  max: number;
  iteration: number;
  logPath: string;
}

export default function piUntilExtension(pi: ExtensionAPI) {
  let loop: Loop | undefined;

  const log = (cells: unknown[]) => {
    if (!loop) return;
    try {
      appendFileSync(loop.logPath, tsvRow([new Date().toISOString(), ...cells]));
    } catch {
      // The log is a convenience; never let it break the loop.
    }
  };

  const finish = (ctx: ExtensionContext, title: string, level: string) => {
    loop = undefined;
    ctx.ui?.setStatus?.(STATUS_ID, undefined);
    ctx.ui?.notify?.(title, level);
  };

  pi.on("session_start", (_event, ctx) => {
    loop = undefined;
    ctx.ui?.setStatus?.(STATUS_ID, undefined);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!loop) return;
    const result =
      event?.outcome === "completed"
        ? await pi.exec("sh", ["-c", loop.command], { timeout: PREDICATE_TIMEOUT_MS })
        : { code: -1, stdout: "", stderr: "" };
    const decision = decide(loop, event?.outcome, result);
    loop.iteration = decision.iteration;
    log([decision.iteration, result.code, decision.summary]);

    if (decision.action === "done") {
      return finish(
        ctx,
        `until: \`${loop.command}\` passed after ${decision.iteration} run(s)`,
        "info",
      );
    }
    if (decision.action === "halt") {
      return finish(ctx, `until: ${decision.summary}`, "warning");
    }
    if (decision.action === "cap") {
      return finish(ctx, `until: gave up, ${decision.summary}`, "warning");
    }
    ctx.ui?.setStatus?.(STATUS_ID, `until ${decision.iteration}/${loop.max}`);
    return {
      entries: [
        ...(event?.entries ?? []),
        { type: "custom_message", customType: "until", content: decision.message, display: true },
      ],
      continue: true,
    };
  });

  pi.registerCommand("until", {
    description: "Loop until a shell command exits 0: /until [--max N] <cmd> [-- task] | stop",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.kind === "error") {
        ctx.ui?.notify?.(`until: ${parsed.message}`, "error");
        return;
      }
      if (parsed.kind === "status") {
        ctx.ui?.notify?.(
          loop
            ? `until: \`${loop.command}\` run ${loop.iteration}/${loop.max}, log ${loop.logPath}`
            : "until: no loop running",
          "info",
        );
        return;
      }
      if (parsed.kind === "stop") {
        if (!loop) {
          ctx.ui?.notify?.("until: no loop running", "info");
          return;
        }
        log([loop.iteration, "", "stopped by user"]);
        finish(ctx, "until: stopped", "info");
        return;
      }

      const dir = join(ctx.cwd ?? process.cwd(), ".pi", "runs");
      const logPath = join(dir, `until-${new Date().toISOString().replace(/[:.]/g, "-")}.tsv`);
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(logPath, TSV_HEADER);
      } catch (error) {
        ctx.ui?.notify?.(`until: cannot write ${logPath}: ${String(error)}`, "error");
        return;
      }
      loop = { command: parsed.command, task: parsed.task, max: parsed.max, iteration: 0, logPath };
      ctx.ui?.setStatus?.(STATUS_ID, `until 0/${loop.max}`);
      await pi.sendUserMessage(kickoffMessage(loop));
    },
  });
}
