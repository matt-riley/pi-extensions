// Gate observable failed-fix attempts, not the semantic quality of a diagnosis.
import { Type } from "typebox";
import { resolve } from "node:path";
import { blockedBashCommand } from "../../shared/bash-policy.mjs";
import { hasRedirectOutsideQuotes } from "../../shared/shell-parse.mjs";
import { LOCAL_READ } from "../../shared/tool-annotations.mjs";
import { revisionSnapshot } from "../../shared/revision.mjs";
import { isVerifyCommand } from "../done-gate/gate.mjs";
import { completedJobCheck } from "../../shared/job-evidence.mjs";

const ENTRY = "diagnosis-checkpoint";
const REASON =
  "Two revised checks failed. Further mutations are paused. Use diagnosis_checkpoint " +
  "to name their shared premise and execute a different read-only observation, or rerun the exact failing check. " +
  "Only the user can override with /diagnosis reset.";
const READERS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "repo_map",
  "code_search",
  "file_outline",
  "find_definition",
  "read_relevant",
  "skill_select",
  "typesafe_ask",
  "lore_recall",
  "lore_search",
  "codemode",
  "tool_search",
  "diagnosis_checkpoint",
  "terminal_read",
  "terminal_list",
  "terminal_stop", // Cleanup of owned processes remains possible while mutations are paused.
]);
const readonly = (command) =>
  typeof command === "string" &&
  command.trim() &&
  !blockedBashCommand(command.replace(/^rtk\s+/, ""));

export function installCheckpoint(pi, { envFacts } = {}) {
  let state;
  let epoch = 0;
  let diagnosing = false;
  const running = new Map();
  const backgrounds = new Map();
  const pending = () => state?.checks.some((check) => check.failures.length >= 2);
  const persist = () => pi.appendEntry(ENTRY, structuredClone(state));
  const restore = async (_event, ctx) => {
    const token = ++epoch;
    running.clear();
    backgrounds.clear();
    diagnosing = false;
    const cwd = resolve(ctx.cwd ?? process.cwd());
    const saved = ctx.sessionManager
      ?.getBranch?.()
      .findLast((entry) => entry.type === "custom" && entry.customType === ENTRY)?.data;
    if (saved?.version === 1 && saved.cwd === cwd && Array.isArray(saved.checks)) {
      state = structuredClone(saved);
    } else {
      const baseline = await revisionSnapshot(cwd);
      if (token !== epoch) return;
      state = { version: 1, cwd, baseline, checks: [] };
      persist();
    }
  };
  for (const name of ["session_start", "session_tree"]) pi.on(name, restore);

  pi.on("tool_call", async (event, ctx) => {
    if (!state) await restore({}, ctx);
    const command = event.input?.command;
    if (pending() || diagnosing) {
      const knownCheck =
        ["bash", "terminal_start"].includes(event.toolName) &&
        state.checks.some((check) => check.command === command);
      const reader =
        READERS.has(event.toolName) ||
        pi
          .getAllTools?.()
          .some((tool) => tool.name === event.toolName && tool.annotations?.readOnlyHint === true);
      if (!(reader || knownCheck || (event.toolName === "bash" && readonly(command))))
        return { block: true, reason: REASON };
    }
    if (
      !["bash", "terminal_start"].includes(event.toolName) ||
      !isVerifyCommand(command) ||
      hasRedirectOutsideQuotes(command)
    )
      return;
    const token = epoch;
    const before = event.toolName === "terminal_start" ? null : await revisionSnapshot(state.cwd);
    if (token === epoch) running.set(event.toolCallId, { before, command, epoch: token });
  });

  pi.on("tool_result", async (event) => {
    const background = event.toolName === "terminal_read";
    const job = event.details?.job;
    const check = background ? backgrounds.get(job?.id) : running.get(event.toolCallId);
    running.delete(event.toolCallId);
    if (!check || check.epoch !== epoch) return;
    if (event.toolName === "terminal_start") {
      if (job?.version === 1 && job.command === check.command && typeof job.id === "string")
        backgrounds.set(job.id, { ...check, before: job.before });
      return;
    }
    const after = await revisionSnapshot(state.cwd);
    const observed = background ? completedJobCheck(event, state.cwd, after) : event;
    if (!observed) return;
    if (background) backgrounds.delete(job.id);
    if (
      check.epoch !== epoch ||
      !check.before?.fingerprint ||
      check.before.fingerprint !== after?.fingerprint
    )
      return;
    let record = state.checks.find((item) => item.command === check.command);
    if (!record) {
      record = { command: check.command, last: state.baseline?.fingerprint, failures: [] };
      state.checks.push(record);
    }
    if (observed.isError === false) record.failures = [];
    else if (
      observed.isError === true &&
      record.last &&
      record.last !== after.fingerprint &&
      !record.failures.includes(after.fingerprint)
    )
      record.failures.push(after.fingerprint);
    else if (observed.isError !== true) return;
    record.last = after.fingerprint;
    persist();
    if (pending()) return { content: [...(event.content ?? []), { type: "text", text: REASON }] };
  });

  pi.registerCommand("diagnosis", {
    description: "Show failed-fix checkpoint status, list env facts, or reset the checkpoint gate",
    handler: async (args, ctx) => {
      const factsMessage = await envFacts?.handleDiagnosisFactsCommand?.(args);
      if (factsMessage != null) {
        ctx.ui?.notify(factsMessage, "info");
        return;
      }
      if (!state) await restore({}, ctx);
      if (args.trim() === "reset") {
        epoch++;
        running.clear();
        backgrounds.clear();
        diagnosing = false;
        state.baseline = await revisionSnapshot(state.cwd);
        state.checks = [];
        persist();
      }
      ctx.ui?.notify(pending() ? REASON : "Diagnosis checkpoint: no pending gate.", "info");
    },
  });

  pi.registerTool({
    name: "diagnosis_checkpoint",
    label: "diagnosis_checkpoint",
    exposure: "deferred",
    annotations: LOCAL_READ,
    reachesTools: () => ["bash"],
    outputSchema: Type.Object({
      premise: Type.String(),
      command: Type.String(),
      expected_observation: Type.String(),
      observation: Type.String(),
      scope: Type.String(),
      revision: Type.Object({ head: Type.String(), fingerprint: Type.String() }),
    }),
    description:
      "After two failed revised checks, unblock mutations by naming their shared premise " +
      "and running a different read-only observation. Executes through normal tool hooks. " +
      "Records an observation, not proof that the premise is correct.",
    parameters: Type.Object({
      premise: Type.String({ minLength: 8, maxLength: 2000 }),
      command: Type.String({ minLength: 1, maxLength: 4000 }),
      expected_observation: Type.String({ minLength: 8, maxLength: 2000 }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!pending()) throw new Error("No failed-fix checkpoint is pending.");
      if (diagnosing) throw new Error("A checkpoint is already running.");
      if (
        !params ||
        [params.premise, params.expected_observation].some(
          (value) => typeof value !== "string" || value.trim().length < 8 || value.length > 2000,
        ) ||
        !readonly(params.command) ||
        params.command.length > 4000
      )
        throw new Error("Supply a premise, expected observation and a read-only command.");
      const token = epoch;
      diagnosing = true;
      try {
        const before = await revisionSnapshot(state.cwd);
        if (!before || token !== epoch) throw new Error("Revision unavailable or session changed.");
        signal?.throwIfAborted();
        const execution = await ctx.executeTool(
          "bash",
          { command: params.command, timeout: 30 },
          { signal },
        );
        signal?.throwIfAborted();
        const result = execution.result?.structuredContent;
        const observation = typeof result?.output === "string" ? result.output.trim() : "";
        const after = await revisionSnapshot(state.cwd);
        signal?.throwIfAborted();
        if (
          execution.isError !== false ||
          result?.exit_code !== 0 ||
          result.truncated !== false ||
          !observation ||
          token !== epoch ||
          before.fingerprint !== after?.fingerprint
        )
          throw new Error(
            "Checkpoint failed, produced no observation, or changed revision/session.",
          );
        for (const check of state.checks) {
          check.failures = [];
          check.last = after.fingerprint;
        }
        persist();
        const evidence = {
          premise: params.premise,
          command: params.command,
          expected_observation: params.expected_observation,
          observation,
          revision: after,
          scope: "Command observation only; premise relevance and truth are not machine-verified.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(evidence) }],
          structuredContent: evidence,
          details: evidence,
        };
      } finally {
        if (token === epoch) diagnosing = false;
      }
    },
  });
}
