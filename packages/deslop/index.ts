// index.ts — pi extension: deslop.
//
// An agent that edits a README writes the way models write: "it's worth
// noting", "powerful yet simple", a negation set up to be knocked down. This
// reads the prose an `edit` or `write` just added and, when it carries those
// patterns, appends one note to that tool's result so the agent rewrites the
// sentences while the file is still in front of it.
//
// `tool_result` is the post-edit hook pi provides: a handler there cannot inject
// a message, but it can patch the result the model is about to read.
//
// The pattern check is deterministic (patterns.mjs). TypeSafe verifies it twice
// (verify.mjs): that the flagged patterns do make the text worse before the
// agent is asked to rewrite anything, and that the rewrite still says what the
// flagged text said. Prose files inside the session cwd only. It never blocks
// a tool call and never edits a file itself.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { flagOff } from "../../shared/env-flag.mjs";
import { bindSystemOne } from "../../shared/systemone-session.mjs";
import { createDeslopState, observeEdit, resetDeslopState } from "./deslop.mjs";

/** `PI_DESLOP=0` turns the extension off. */
export const DESLOP_ENV = "PI_DESLOP";
/** `PI_DESLOP_VERIFY=0` keeps the pattern check and sends nothing to TypeSafe. */
export const VERIFY_ENV = "PI_DESLOP_VERIFY";

export default function piDeslopExtension(pi: ExtensionAPI) {
  // Before any `on`: Jev's token usage has to land on the tool result it rode on.
  bindSystemOne(pi);
  const state = createDeslopState();

  pi.registerCommand("deslop", {
    description: "Rewrite existing prose plainly: /deslop <file-or-directory>",
    handler: async (args, ctx) => {
      if (flagOff(process.env[DESLOP_ENV])) {
        ctx.ui?.notify?.("deslop is disabled (PI_DESLOP).", "info");
        return;
      }
      const path = args.trim();
      if (!path) {
        ctx.ui?.notify?.("Usage: /deslop <file-or-directory>", "info");
        return;
      }
      pi.sendUserMessage(
        `Inspect the path ${JSON.stringify(path)} relative to the current working directory. ` +
          "If it is a file, read it and deslop its existing prose in place. " +
          "If it is a directory, recursively find its prose files " +
          "(.md, .mdx, .markdown, .txt, .rst, .adoc) and deslop them in place. " +
          "For directory input, change only prose files within that directory; do not follow " +
          "symlinks outside it, and skip dependency, generated and version-control directories. " +
          "Remove filler, sales language, stock contrasts, repetitive punchy sentences and " +
          "unnecessary decoration. Preserve all facts, instructions, caveats, links, code " +
          "and the author's meaning. Keep wording that is already clear; do not invent " +
          "claims or swap one stock phrase for another. Read each complete file before editing, " +
          "change only the selected files (only that file for a file input), and review the diff " +
          "for meaning changes. If the path is missing or unreadable, report that without creating it. " +
          "If a directory contains no prose files, report that without creating any.",
        { deliverAs: "followUp" },
      );
    },
  });

  pi.on("session_start", async () => {
    resetDeslopState(state);
  });

  // A new prompt is a new budget: the notes are per file, per request.
  pi.on("input", async () => {
    resetDeslopState(state);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (flagOff(process.env[DESLOP_ENV])) return;
    const note = await observeEdit(
      state,
      {
        toolName: event?.toolName,
        input: event?.input,
        isError: event?.isError,
        cwd: ctx?.cwd,
      },
      { verify: !flagOff(process.env[VERIFY_ENV]) },
    );
    if (!note || !Array.isArray(event?.content)) return;
    return { content: [...event.content, { type: "text", text: note }] };
  });
}
