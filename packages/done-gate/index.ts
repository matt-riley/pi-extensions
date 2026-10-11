// index.ts — pi extension: the done-gate.
//
// A run that edits code and settles without running the repo's checks is about
// to report "done" on faith. At `agent_before_settle` — the last boundary that
// can still act — this appends one reminder and requests one continuation so
// the model reads it before the turn closes. It also lists `[DEBUG-` tags left
// in the working-tree diff.
//
// The reminder cannot read the claim it is answering, so System One does: the
// last assistant message goes to `claim.mjs`, and a claim that reports success
// with the unverified edits unmentioned gains a second sentence. A claim that
// names its gap gets nothing, because the reminder already asked for that.
//
// Text only: it never blocks a tool call. One nudge per user input, only after
// a completed run (not an abort or error), and only for non-doc edits.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { messageText } from "../../shared/message-text.mjs";
import { claimLine, judgeDoneClaim } from "./claim.mjs";
import {
  DIFF_ARGS,
  buildNudge,
  createGateState,
  debugTagsInDiff,
  debugTagsInFile,
  observeToolResult,
  resetGateState,
  shouldNudge,
} from "./gate.mjs";

const CUSTOM_TYPE = "done-gate";
const GIT_TIMEOUT_MS = 5_000;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 1_000_000;

export default function piDoneGateExtension(pi: ExtensionAPI) {
  const state = createGateState();
  let lastClaim: string | undefined;

  const git = async (cwd: string, args: string[]) => {
    const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
    return result.code === 0 ? result.stdout : "";
  };

  // Best effort: outside a git repo, or if git fails, there are simply no hits.
  const findDebugTags = async (cwd: string): Promise<string[]> => {
    try {
      const hits = debugTagsInDiff(await git(cwd, DIFF_ARGS));
      const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
        .split("\0")
        .filter(Boolean)
        .slice(0, MAX_UNTRACKED_FILES);
      for (const path of untracked) {
        const full = join(cwd, path);
        try {
          if ((await stat(full)).size > MAX_UNTRACKED_BYTES) continue;
          hits.push(...debugTagsInFile(path, await readFile(full, "utf8")));
        } catch {
          // An unreadable file (broken symlink, race) must not drop the other hits.
        }
      }
      return hits;
    } catch {
      return [];
    }
  };

  pi.on("session_start", async () => {
    resetGateState(state);
    lastClaim = undefined;
  });

  pi.on("input", async () => {
    resetGateState(state);
    lastClaim = undefined;
  });

  // The claim judgment needs the message that closes the run, so keep the last
  // one that carried text. A tool-call-only assistant message leaves it alone.
  pi.on("message_end", async (event) => {
    if (event?.message?.role !== "assistant") {
      return;
    }
    const text = messageText(event.message.content).trim();
    if (text) {
      lastClaim = text;
    }
  });

  pi.on("tool_result", async (event) => {
    observeToolResult(state, {
      toolName: event?.toolName,
      input: event?.input,
      isError: event?.isError === true,
    });
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!shouldNudge(state, event?.outcome)) {
      return;
    }
    // Both are best effort and neither may fail the run: the debug scan
    // swallows its own errors, and the judge reports every failure as
    // "unjudged". The judge takes its own timeout rather than `ctx.signal`,
    // because an inherited abort would drop the judgment silently.
    const [debugHits, judged] = await Promise.all([
      findDebugTags(ctx.cwd ?? process.cwd()),
      judgeDoneClaim({
        claim: lastClaim,
        files: [...state.dirty],
        verificationSeen: state.verificationSeen,
      }),
    ]);
    const content = buildNudge(state, debugHits, claimLine(judged));
    // Keep earlier handlers' drafts; only ever set continue to true so another
    // extension's continuation is never cleared.
    return {
      entries: [
        ...(event?.entries ?? []),
        { type: "custom_message", customType: CUSTOM_TYPE, content, display: true },
      ],
      continue: true,
    };
  });
}
