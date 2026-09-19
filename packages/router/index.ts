// index.ts — pi extension: route the task to a model that fits it.
//
// Escalation only, decided once per task. That shape is not a preference, it is
// what the measurements said:
//
//   - Per-turn switching costs more than it saves. Sticky escalation without a
//     way down measured +1665% on this corpus, and a per-turn chooser +848%.
//   - Model choice was mostly per session anyway (one session produced 293 of
//     the 293 requests on the frontier model; another 9 of 9), so the unit that
//     matches how the work actually happens is the task, not the turn.
//   - Rules cannot do it: they scored 30% recall at 7% precision and were
//     confidently wrong on the two most expensive turns in the corpus. A
//     graded difficulty rating from TypeSafe scores AUC 0.70, and at >= 1.5 is
//     77% precise at 48% recall, catching 11 of the top 12 turns by spend.
//
// So: ask Jev how hard the task is, escalate at the threshold, hold the
// decision while the task continues, and step back down when a new task
// arrives — but only if the router was the one who escalated, so it never
// fights a model the user chose.
//
// Escape hatches: `/route off`, `PI_ROUTER=off`, and the fact that nothing here
// ever downgrades a task in flight.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { askSystemOne } from "../../shared/systemone.mjs";
import { gateTurn } from "./lib.mjs";
import {
  buildDifficultyState,
  buildQuestions,
  chooseFrontierModel,
  DEFAULT_FRONTIER_PATTERNS,
  DIFFICULTY_THRESHOLD,
  latestContextTokens,
  modelKey,
  routeFromDifficulty,
  turnsFromBranch,
  WINDOW,
} from "./model-battery.mjs";

const COMMAND = "route";
const DEFAULT_TIMEOUT_MS = 4000;
/** Judgements per task, so a long task cannot spend a call on every turn. */
const MAX_JUDGEMENTS_PER_TASK = 3;
/** A task is "stuck" when the previous turn ended with this many failures. */
const STUCK_FAILURES = 2;

function envFlag(env = process.env) {
  const value = String(env?.PI_ROUTER ?? "")
    .trim()
    .toLowerCase();
  return !(value === "off" || value === "0" || value === "false");
}

function envNumber(name, fallback, env = process.env) {
  const value = Number(env?.[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envPatterns(env = process.env) {
  const raw = String(env?.PI_ROUTER_FRONTIER ?? "").trim();
  if (!raw) return DEFAULT_FRONTIER_PATTERNS;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export default function piRouterExtension(
  pi: ExtensionAPI,
  deps: { ask?: typeof askSystemOne } = {},
) {
  const ask = deps.ask ?? askSystemOne;
  const state = {
    enabled: envFlag(),
    threshold: envNumber("PI_ROUTER_THRESHOLD", DIFFICULTY_THRESHOLD),
    timeoutMs: envNumber("PI_ROUTER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    patterns: envPatterns(),
    userModel: null as unknown, // the model the user was on before the router touched anything
    routerChosenKey: null as string | null,
    judgementsThisTask: 0,
    lastPrompt: null,
    taskIndex: 0,
    counters: {
      turns: 0,
      judged: 0,
      escalated: 0,
      held: 0,
      steppedDown: 0,
      unavailable: 0,
      tooBig: 0,
    },
    last: null as null | { difficulty: number; escalate: boolean; reason: string },
  };

  const notify = (ctx: ExtensionContext, text: string, level = "info") => {
    try {
      ctx?.ui?.notify?.(text, level);
    } catch {
      // A missing UI must never turn into a failed turn.
    }
  };

  /** Models the router may choose from: the session's own scope wins. */
  async function candidates(ctx: ExtensionContext) {
    const scoped = ctx?.scopedModels;
    if (Array.isArray(scoped) && scoped.length) return scoped;
    try {
      const available = await Promise.resolve(ctx?.modelRegistry?.getAvailable?.());
      return Array.isArray(available) ? available : [];
    } catch {
      return [];
    }
  }

  function isFrontier(model: unknown) {
    const key = modelKey(model)?.toLowerCase();
    if (!key) return false;
    return state.patterns.some((pattern) => key.includes(String(pattern).toLowerCase()));
  }

  pi.on("session_start", (_event, ctx) => {
    state.userModel = ctx?.model ?? null;
    state.routerChosenKey = null;
    state.judgementsThisTask = 0;
    state.taskIndex = 0;
    state.lastPrompt = null;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled) return undefined;
    if (String(process.env?.PI_SUBAGENT_CHILD ?? "").trim() === "1") return undefined;

    const prompt = String(event?.prompt ?? "");
    if (!prompt.trim()) return undefined;
    state.counters.turns++;

    const branch = (() => {
      try {
        return ctx?.sessionManager?.getBranch?.() ?? [];
      } catch {
        return [];
      }
    })();
    const turns = turnsFromBranch(branch, WINDOW + 1);
    const includesCurrent = turns.length && turns[turns.length - 1].prompt.trim() === prompt.trim();
    const history = includesCurrent ? turns.slice(0, -1) : turns;
    const previousTurn = history[history.length - 1] ?? null;

    const boundary = gateTurn({ prompt, previousTurn });
    const failuresLastTurn = (previousTurn?.toolCalls ?? []).filter((call) => call.isError).length;
    if (boundary.route) state.taskIndex++;

    // Task boundaries and stuck turns are worth a judgement; anything else
    // holds the decision already made for this task. The per-task cap, not a
    // turn counter, is what stops a long task from spending a call per turn —
    // a guard on turns-since-judged suppressed the stuck case it existed for.
    const worthJudging =
      boundary.route || failuresLastTurn >= STUCK_FAILURES || state.judgementsThisTask === 0;
    if (!worthJudging || state.judgementsThisTask >= MAX_JUDGEMENTS_PER_TASK) {
      state.counters.held++;
      return undefined;
    }

    const currentKey = modelKey(ctx?.model ?? null);
    let decision;
    try {
      const result = await ask({
        state: buildDifficultyState({ prompt, window: history, cwd: ctx?.cwd }),
        questions: buildQuestions(),
        signal: AbortSignal.timeout(state.timeoutMs),
      });
      decision = routeFromDifficulty(result?.answers, { threshold: state.threshold });
    } catch (error) {
      // A judgement that fails keeps the model that was working.
      const message = error instanceof Error ? error.message : String(error);
      state.last = { difficulty: 0, escalate: false, reason: `judge unavailable: ${message}` };
      return undefined;
    }

    state.judgementsThisTask++;
    state.counters.judged++;
    state.last = {
      difficulty: decision.difficulty ?? 0,
      escalate: decision.escalate === true,
      reason: decision.reason,
    };

    // No usable rating: keep what is running. Never a reason to spend less.
    if (decision.escalate === null) return undefined;

    if (decision.escalate && !isFrontier(ctx?.model)) {
      const pick = chooseFrontierModel(await candidates(ctx), state.patterns);
      if (!pick) {
        state.counters.unavailable++;
        notify(
          ctx,
          `Router: this task rates ${decision.difficulty.toFixed(2)} but no frontier model is available`,
          "warning",
        );
        return undefined;
      }
      if (modelKey(pick.model) === currentKey) return undefined;

      // Refuse a switch the target cannot hold. A smaller window would compact
      // the session, which defeats the point of escalating into it.
      const targetWindow = Number(pick.model?.contextWindow);
      const used = latestContextTokens(history);
      if (Number.isFinite(targetWindow) && targetWindow > 0 && used > targetWindow) {
        state.counters.tooBig++;
        notify(
          ctx,
          `Router: staying on ${currentKey ?? "the current model"} — this session reads ${Math.round(used / 1000)}k tokens and ${pick.key} holds ${Math.round(targetWindow / 1000)}k`,
          "warning",
        );
        return undefined;
      }

      state.userModel ??= ctx?.model ?? null;
      const ok = await Promise.resolve(pi.setModel?.(pick.model));
      if (ok === false) {
        notify(
          ctx,
          `Router: no authentication for ${pick.key} — staying on ${currentKey ?? "the current model"}`,
          "error",
        );
        return undefined;
      }
      state.routerChosenKey = pick.key;
      state.counters.escalated++;
      notify(
        ctx,
        `Router: ${pick.key} — difficulty ${decision.difficulty.toFixed(2)} (${boundary.route ? boundary.reason : "task continues"})`,
        "info",
      );
      return undefined;
    }

    // Back down at a task boundary, and only from a model the router chose.
    if (decision.escalate === false && state.routerChosenKey && state.userModel) {
      const stillOurs = modelKey(ctx?.model ?? null) === state.routerChosenKey;
      if (stillOurs && currentKey !== modelKey(state.userModel)) {
        const ok = await Promise.resolve(pi.setModel?.(state.userModel));
        if (ok !== false) {
          state.routerChosenKey = null;
          state.counters.steppedDown++;
          notify(
            ctx,
            `Router: back to ${modelKey(state.userModel)} — difficulty ${decision.difficulty.toFixed(2)}`,
            "info",
          );
        }
      }
    }
    return undefined;
  });

  pi.registerCommand(COMMAND, {
    description: "Show or toggle judged model routing for this session",
    handler: async (args, ctx) => {
      const action = String(args ?? "")
        .trim()
        .toLowerCase();
      if (action === "off" || action === "disable") {
        state.enabled = false;
        notify(ctx, "Router off. /route on to re-arm.", "warning");
        return;
      }
      if (action === "on" || action === "enable") {
        state.enabled = true;
        notify(ctx, "Router on.", "info");
        return;
      }
      const c = state.counters;
      const last = state.last
        ? `last judgement: difficulty ${state.last.difficulty.toFixed(2)} — ${state.last.reason}`
        : "no judgement yet";
      notify(
        ctx,
        [
          `Router ${state.enabled ? "on" : "OFF"} · threshold ${state.threshold} · ${state.patterns[0]} first`,
          `${c.turns} turns · ${c.judged} judged · ${c.escalated} escalated · ${c.steppedDown} stepped down · ${c.held} held · ${c.tooBig} too big to switch`,
          state.routerChosenKey
            ? `chosen by router: ${state.routerChosenKey}`
            : "no router-chosen model active",
          last,
        ].join("\n"),
        "info",
      );
    },
  });
}
