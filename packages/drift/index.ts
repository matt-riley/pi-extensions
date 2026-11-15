// index.ts — pi extension: drift.
//
// Files can change under a session between its runs: an editor, another
// terminal, a git checkout. The agent's earlier reads are then stale and it may
// overwrite the change from memory. When a run settles the tree is fingerprinted;
// when the next user prompt arrives it is fingerprinted again, and if it
// differs, one short prompt section names the files that changed outside the
// session so the agent re-reads them.
//
// While a subagent or job the session started is still running, its writes
// cannot be told from anyone else's, so the check pauses rather than blame it.
// Git repos only. No model call, no network, never blocks anything.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  createTracker,
  driftBetween,
  driftSection,
  isBusy,
  noteJobs,
  noteSubagent,
  takeSnapshot,
} from "./drift.mjs";

const SUBAGENT_EVENTS = [
  "subagents:started",
  "subagents:completed",
  "subagents:failed",
  "subagents:stopped",
];

export default function piDriftExtension(pi: ExtensionAPI) {
  const tracker = createTracker();
  let baseline: any = null;

  for (const name of SUBAGENT_EVENTS) {
    pi.events?.on?.(name, (payload) => noteSubagent(tracker, name, payload));
  }

  pi.on("session_start", async () => {
    baseline = null;
    tracker.subagents.clear();
    tracker.jobs.clear();
  });

  pi.on("tool_result", async (event) => {
    noteJobs(tracker, event);
  });

  // The tree as the run left it, unless the run was cut short or background work could still be writing.
  pi.on("agent_settled", async (event, ctx) => {
    baseline =
      event?.aborted || isBusy(tracker) ? null : await takeSnapshot(ctx.cwd ?? process.cwd());
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (event?.messageType !== "user") return;
    const cwd = ctx.cwd ?? process.cwd();
    const current = isBusy(tracker) ? null : await takeSnapshot(cwd);
    const drift = await driftBetween(cwd, baseline, current);
    // Whatever happens next starts from this tree, so a change is reported once.
    baseline = current;
    if (drift) event.systemPromptOptions.sections.drift = driftSection(drift);
  });
}
