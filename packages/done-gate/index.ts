// index.ts — pi extension: the done-gate.
//
// A run that edits code and settles without running the repo's checks is about
// to report "done" on faith. At `agent_before_settle` — the last boundary that
// can still act — this appends one reminder and requests one continuation so
// the model reads it before the turn closes. It also lists `[DEBUG-` tags left
// in the working-tree diff.
//
// Quiet on purpose. The reminder is `display: false`: the model reads it as a
// user message, the transcript does not, and it asks for the closing message to
// carry the explanation rather than a report about the reminder.
//
// It also refuses to judge what the repo's checks cannot cover. Only edits
// inside `ctx.cwd` arm the gate, and at settle only paths the working tree
// still has a change for are reported — a `/tmp` probe, a home dotfile, or an
// edit reverted before settling is not a finding.
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

import { installMeasurement } from "./measurement.mjs";
import { messageText } from "../../shared/message-text.mjs";
import { bindSystemOne } from "../../shared/systemone-session.mjs";
import { revisionSnapshot } from "../subagents/evidence.mjs";
// Namespace import too: /reload can serve a cached gate.mjs, and a binding added
// since the process started has to be read as a property, where a named import
// fails. See the livePaths call below.
import * as gateModule from "./gate.mjs";
import { claimLine, couldClaimRemote, judgeDoneClaim } from "./claim.mjs";
import {
  DIFF_ARGS,
  buildNudge,
  createGateState,
  debugTagsInDiff,
  debugTagsInFile,
  invalidateEvidence,
  isVerifyCommand,
  isRemoteVerifyCommand,
  observeToolResult,
  observeToolStart,
  resetGateState,
  shouldNudge,
} from "./gate.mjs";

const CUSTOM_TYPE = "done-gate";
const GIT_TIMEOUT_MS = 5_000;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 1_000_000;

export default function piDoneGateExtension(pi: ExtensionAPI) {
  bindSystemOne(pi);
  installMeasurement(pi);
  const state = createGateState();
  let lastClaim: string | undefined;
  let generation = 0;
  const checks = new Map<string, { before: any; generation: number }>();

  // null means git could not answer — no repo, no HEAD, git missing. That is
  // not the same as "nothing changed", so callers must not read it as one.
  const git = async (cwd: string, args: string[]): Promise<string | null> => {
    const result = await pi.exec("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
    return result.code === 0 ? result.stdout : null;
  };

  const snapshot = async (cwd: string) => {
    try {
      const revision = await revisionSnapshot(cwd);
      if (!revision) return null;
      const status = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]);
      return { ...revision, clean: status !== null && !status.trim() };
    } catch {
      return null;
    }
  };

  const listUntracked = async (cwd: string): Promise<string[] | null> => {
    const out = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    return out === null ? null : out.split("\0").filter(Boolean);
  };

  // Paths the tree still carries a change for, relative to the cwd. Ignored and
  // generated files never appear, so writing build output does not arm the gate.
  const findLiveFiles = async (cwd: string, untracked: string[] | null) => {
    const tracked = await git(cwd, ["diff", "--name-only", "--relative", "HEAD"]);
    if (tracked === null || untracked === null) {
      return null;
    }
    return [...tracked.split("\n"), ...untracked].filter(Boolean);
  };

  // Best effort: outside a git repo, or if git fails, there are simply no hits.
  const findDebugTags = async (cwd: string, untracked: string[] | null) => {
    try {
      const hits = debugTagsInDiff((await git(cwd, DIFF_ARGS)) ?? "");
      for (const path of (untracked ?? []).slice(0, MAX_UNTRACKED_FILES)) {
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
    generation++;
    checks.clear();
    resetGateState(state);
    lastClaim = undefined;
  });

  pi.on("input", async () => {
    generation++;
    checks.clear();
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

  pi.on("tool_call", async (event, ctx) => {
    if (
      event.toolName !== "bash" ||
      !(isVerifyCommand(event.input?.command) || isRemoteVerifyCommand(event.input?.command))
    )
      return;
    const epoch = generation;
    observeToolStart(state, event);
    const before = await snapshot(ctx.cwd ?? process.cwd());
    if (epoch === generation) checks.set(event.toolCallId, { before, generation: epoch });
  });

  pi.on("tool_result", async (event, ctx) => {
    const check = checks.get(event.toolCallId);
    checks.delete(event.toolCallId);
    const after = check ? await snapshot(ctx.cwd ?? process.cwd()) : null;
    if (check && check.generation !== generation) return;
    observeToolResult(state, {
      before: check?.before,
      after,
      content: event.content,
      toolName: event?.toolName,
      input: event?.input,
      isError: event?.isError,
      cwd: ctx?.cwd,
    });
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (state.verificationSeen || state.remoteVerificationSeen) {
      invalidateEvidence(state, await snapshot(ctx.cwd ?? process.cwd()));
    }
    const needsVerify = shouldNudge(state, event?.outcome);
    // A run that changed nothing can still claim "CI is green" after checking
    // only this machine. The claim is the whole trigger here, so it is read
    // before anything is asked: no claim of remote success, no request.
    const completed = event?.outcome === undefined || event?.outcome === "completed";
    const checkRemote =
      completed &&
      !state.remoteNudged &&
      !state.remoteVerificationSeen &&
      couldClaimRemote(lastClaim);
    if (!needsVerify && !checkRemote) {
      return;
    }

    const cwd = ctx.cwd ?? process.cwd();
    const untracked = await listUntracked(cwd);
    // A stale gate.mjs (see the namespace import) means no filter yet: keep the
    // unfiltered paths rather than throwing into the settle boundary.
    const live = await findLiveFiles(cwd, untracked);
    const files =
      typeof gateModule.livePaths === "function"
        ? gateModule.livePaths([...state.dirty], live)
        : [...state.dirty];
    if (needsVerify && files.length === 0) {
      // Everything was reverted, committed, ignored, or lives outside this repo.
      return;
    }

    // Both are best effort and neither may fail the run: the debug scan
    // swallows its own errors, and the judge reports every failure as
    // "unjudged". The judge takes its own timeout rather than `ctx.signal`,
    // because an inherited abort would drop the judgment silently.
    const [debugHits, judged] = await Promise.all([
      needsVerify ? findDebugTags(cwd, untracked) : Promise.resolve([]),
      judgeDoneClaim({
        claim: lastClaim,
        files,
        verificationSeen: state.verificationSeen,
        remoteVerificationSeen: state.remoteVerificationSeen,
      }),
    ]);

    if (!needsVerify) {
      // Only the specific overclaim earns a line here: the generic "unclosed
      // claim" nudge already had its run, and repeating it is noise.
      if (judged.verdict !== "remote_overreach") {
        return;
      }
      state.remoteNudged = true;
      return {
        entries: [
          ...(event?.entries ?? []),
          {
            type: "custom_message",
            customType: CUSTOM_TYPE,
            content: claimLine(judged),
            display: false,
          },
        ],
        continue: true,
      };
    }

    state.dirty = new Set(files);
    const content = buildNudge(state, debugHits, claimLine(judged));
    // Keep earlier handlers' drafts; only ever set continue to true so another
    // extension's continuation is never cleared.
    return {
      entries: [
        ...(event?.entries ?? []),
        // display: false — the model still receives this as a user message
        // (see message-types.md); the terminal keeps the explanation and the
        // checks instead of a block about them.
        { type: "custom_message", customType: CUSTOM_TYPE, content, display: false },
      ],
      continue: true,
    };
  });
}
