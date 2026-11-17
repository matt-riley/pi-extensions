// climb-run.mjs — pi wiring for /climb: the baseline, the per-settle attempt,
// the revert check and the TSV log. Decisions live in climb.mjs.
//
// The loop reports and the agent reverts: an extension that resets the user's
// tree would be a destructive action. What the loop does enforce is that a
// rejected attempt is undone before the next one counts, by comparing the
// tree's content with the last accepted state.

import { parseCounters } from "../../shared/measure.mjs";
import { appendRunRow, startRunLog } from "../../shared/runs.mjs";
import {
  CLIMB_TSV_HEADER,
  IDLE_LIMIT,
  attemptMessage,
  climbKickoff,
  decideClimb,
  formatRange,
  hypothesisOf,
  idleMessage,
  parseClimbArgs,
  reachesTarget,
  spread,
} from "./climb.mjs";
import { workingTreeId } from "./tree.mjs";
import { messageText } from "../../shared/message-text.mjs";

const COMMAND_TIMEOUT_MS = 10 * 60_000;
const STATUS_ID = "climb";

/** Run the gate, then the metric `runs` times. Returns the observation decideClimb takes. */
async function observe(exec, loop) {
  const gate = await exec("sh", ["-c", loop.gate], { timeout: COMMAND_TIMEOUT_MS });
  if (gate.code !== 0) return { gateCode: gate.code, samples: [], workOk: false };
  const samples = [];
  for (let i = 0; i < loop.runs; i++) {
    const result = await exec("sh", ["-c", loop.metric], { timeout: COMMAND_TIMEOUT_MS });
    if (result.code !== 0)
      return { gateCode: 0, samples, workOk: false, why: `metric exited ${result.code}` };
    try {
      const sample = parseCounters(result.stdout);
      if (!Number.isFinite(sample.value)) throw new Error("metric printed no finite value");
      samples.push(sample.value);
    } catch (error) {
      return { gateCode: 0, samples, workOk: false, why: error.message };
    }
  }
  return { gateCode: 0, samples, workOk: true };
}

/** Register /climb. `isOtherLoopActive` keeps it from running alongside /until. */
export function installClimb(pi, { isOtherLoopActive = () => false, treeId = workingTreeId } = {}) {
  let loop;
  let lastText = "";
  const exec = (cmd, args, opts) => pi.exec(cmd, args, opts);

  const log = (cells) => {
    if (loop) appendRunRow(loop.logPath, cells);
  };
  const finish = (ctx, title, level) => {
    loop = undefined;
    ctx.ui?.setStatus?.(STATUS_ID, undefined);
    ctx.ui?.notify?.(title, level);
  };
  const resume = (event, content) => ({
    entries: [
      ...(event?.entries ?? []),
      { type: "custom_message", customType: "climb", content, display: true },
    ],
    continue: true,
  });
  const idle = (event, ctx, reason) => {
    loop.idle += 1;
    log([loop.iteration, "", "", "", "", "", reason]);
    if (loop.idle >= IDLE_LIMIT)
      return finish(
        ctx,
        `climb: stopped after ${IDLE_LIMIT} settles with no attempt counted`,
        "warning",
      );
    return resume(event, idleMessage(reason));
  };

  pi.on("session_start", (_event, ctx) => {
    loop = undefined;
    ctx.ui?.setStatus?.(STATUS_ID, undefined);
  });

  pi.on("message_end", (event) => {
    if (event?.message?.role !== "assistant") return;
    const text = messageText(event.message.content).trim();
    if (text) lastText = text;
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!loop) return;
    if (event?.outcome !== "completed") {
      log([loop.iteration, "", "", "", "", "", `run ${event?.outcome}`]);
      return finish(ctx, `climb: run ${event?.outcome}; loop stopped`, "warning");
    }
    const cwd = ctx.cwd ?? process.cwd();
    const tree = await treeId(cwd);
    if (!tree) return finish(ctx, "climb: cannot read the git tree; loop stopped", "error");

    if (loop.awaitingRevert) {
      if (tree !== loop.acceptedTree) return idle(event, ctx, "unreverted");
      loop.awaitingRevert = false;
      loop.idle = 0;
      log([loop.iteration, "", "", "", "", "", "reverted"]);
      return resume(event, idleMessage("reverted"));
    }
    if (tree === loop.acceptedTree) return idle(event, ctx, "unchanged");

    loop.idle = 0;
    const hypothesis = hypothesisOf(lastText);
    lastText = "";
    const before = formatRange(loop.best);
    const decision = decideClimb(loop, await observe(exec, loop));
    const after = { median: decision.m, min: decision.lo, max: decision.hi };
    loop.iteration = decision.iteration;
    loop.kept = decision.kept;
    log([
      decision.iteration,
      hypothesis,
      before,
      Number.isFinite(decision.m) ? decision.m : "",
      Number.isFinite(decision.m) ? `[${decision.lo}, ${decision.hi}]` : "",
      decision.verdict.why.startsWith("gate") ? decision.verdict.why : "pass",
      `${decision.verdict.keep ? "kept" : "rejected"}: ${decision.verdict.why} (tree ${tree.slice(0, 12)})`,
    ]);
    if (decision.verdict.keep) {
      loop.best = after;
      loop.acceptedTree = tree;
    } else {
      loop.awaitingRevert = true;
    }

    if (decision.action === "done")
      return finish(
        ctx,
        `climb: target ${loop.target} reached, best ${formatRange(loop.best)} after ${decision.iteration} attempt(s), ${decision.kept} kept`,
        "info",
      );
    if (decision.action === "cap")
      return finish(
        ctx,
        `climb: cap ${loop.max} reached, best ${formatRange(loop.best)}, ${decision.kept} kept${decision.verdict.keep ? "" : "; the last attempt was rejected, revert it"}`,
        "warning",
      );
    ctx.ui?.setStatus?.(
      STATUS_ID,
      `climb ${decision.iteration}/${loop.max} best ${loop.best.median}`,
    );
    return resume(event, attemptMessage(loop, decision));
  });

  pi.registerCommand("climb", {
    description:
      'Metric loop, one change per measurement: /climb [--max N] [--min N] [--runs N] [--higher|--lower] --target <n> --gate "<cmd>" <metric-cmd> [-- task] | stop',
    handler: async (args, ctx) => {
      const parsed = parseClimbArgs(args);
      if (parsed.kind === "error") {
        ctx.ui?.notify?.(`climb: ${parsed.message}`, "error");
        return;
      }
      if (parsed.kind === "status") {
        ctx.ui?.notify?.(
          loop
            ? `climb: attempt ${loop.iteration}/${loop.max}, best ${formatRange(loop.best)}, target ${loop.target}, log ${loop.logPath}`
            : "climb: no loop running",
          "info",
        );
        return;
      }
      if (parsed.kind === "stop") {
        if (!loop) {
          ctx.ui?.notify?.("climb: no loop running", "info");
          return;
        }
        log([loop.iteration, "", "", "", "", "", "stopped by user"]);
        finish(ctx, "climb: stopped", "info");
        return;
      }
      if (loop || isOtherLoopActive()) {
        ctx.ui?.notify?.("climb: a loop is already running; stop it first", "error");
        return;
      }

      const cwd = ctx.cwd ?? process.cwd();
      const acceptedTree = await treeId(cwd);
      if (!acceptedTree) {
        ctx.ui?.notify?.("climb: needs a git work tree to check reverts", "error");
        return;
      }
      ctx.ui?.notify?.("climb: measuring the baseline on the untouched tree", "info");
      const baseline = await observe(exec, parsed);
      if (baseline.gateCode !== 0) {
        ctx.ui?.notify?.(
          `climb: the gate exits ${baseline.gateCode} on the untouched tree; make it pass first`,
          "error",
        );
        return;
      }
      if (!baseline.workOk) {
        ctx.ui?.notify?.(`climb: baseline measurement failed: ${baseline.why}`, "error");
        return;
      }
      const best = spread(baseline.samples);
      let logPath;
      try {
        logPath = startRunLog(cwd, "climb", CLIMB_TSV_HEADER);
      } catch (error) {
        ctx.ui?.notify?.(`climb: cannot write the log: ${String(error)}`, "error");
        return;
      }
      loop = {
        ...parsed,
        best,
        acceptedTree,
        iteration: 0,
        kept: 0,
        idle: 0,
        awaitingRevert: false,
        logPath,
      };
      log([
        0,
        "baseline",
        "",
        best.median,
        `[${best.min}, ${best.max}]`,
        "pass",
        `baseline (tree ${acceptedTree.slice(0, 12)})`,
      ]);
      if (reachesTarget(loop.direction, best.median, loop.target)) {
        finish(
          ctx,
          `climb: the baseline ${formatRange(best)} already meets target ${loop.target}`,
          "info",
        );
        return;
      }
      ctx.ui?.setStatus?.(STATUS_ID, `climb 0/${loop.max} best ${best.median}`);
      await pi.sendUserMessage(climbKickoff(loop), { deliverAs: "followUp" });
    },
  });

  return { active: () => loop !== undefined };
}
