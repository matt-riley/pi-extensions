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
  chooseModelForTier,
  DEFAULT_FRONTIER_PATTERNS,
  DEFAULT_MID_PATTERNS,
  DEFAULT_TIER_THINKING,
  DIFFICULTY_THRESHOLD,
  FRONTIER_THRESHOLD,
  latestContextTokens,
  modelKey,
  routeFromDifficulty,
  THINKING_LEVELS,
  thinkingForTier,
  thinkingRank,
  tierOf,
  turnsFromBranch,
  WINDOW,
} from "./model-battery.mjs";

const COMMAND = "route";
const DEFAULT_TIMEOUT_MS = 4000;
/** Judgements per task, so a long task cannot spend a call on every turn. */
const MAX_JUDGEMENTS_PER_TASK = 3;
/** A task is "stuck" when the previous turn ended with this many failures. */
const STUCK_FAILURES = 2;
/** Turns to wait after a failed judgement, so a dead judge is not retried per turn. */
const FAILURE_COOLDOWN_TURNS = 3;
/** Room the next request needs beyond what the last one read. */
const CONTEXT_GROWTH_MARGIN = 1.05;
/** Output and reasoning tokens to keep free in the target window. */
const OUTPUT_RESERVE = 16000;
/** Tier order: a target escalates only when it outranks the model in use. */
const TIER_RANK: Record<string, number> = { mid: 1, frontier: 2 };

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

function envPatterns(name, fallback, env = process.env) {
  const raw = String(env?.[name] ?? "").trim();
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseThinking(raw, fallback, levels = THINKING_LEVELS) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return levels.includes(value) ? value : fallback;
}

export default function piRouterExtension(
  pi: ExtensionAPI,
  deps: { ask?: typeof askSystemOne } = {},
) {
  const ask = deps.ask ?? askSystemOne;
  // Captured at factory time, not per prompt: pi-subagents sets
  // PI_SUBAGENT_CHILD only while loading and creating a child session, and
  // clears it before the child's first prompt — so a runtime check would never
  // see it, and children would be routed after all.
  const isSubagentChild = String(process.env?.PI_SUBAGENT_CHILD ?? "").trim() === "1";
  // What the judgement is allowed to send: the prompt alone, or the last few
  // turns as well. Escalation also means the conversation is served by another
  // provider, which is a data-flow decision, not a routing detail.
  const shareWindow =
    String(process.env?.PI_ROUTER_SHARE ?? "window")
      .trim()
      .toLowerCase() !== "prompt";
  const state = {
    enabled: envFlag(),
    threshold: envNumber("PI_ROUTER_THRESHOLD", DIFFICULTY_THRESHOLD),
    frontierThreshold: envNumber("PI_ROUTER_FRONTIER_THRESHOLD", FRONTIER_THRESHOLD),
    timeoutMs: envNumber("PI_ROUTER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    tiers: {
      frontier: envPatterns("PI_ROUTER_FRONTIER", DEFAULT_FRONTIER_PATTERNS),
      mid: envPatterns("PI_ROUTER_MID", DEFAULT_MID_PATTERNS),
    },
    thinking: {
      mid: parseThinking(process.env.PI_ROUTER_MID_THINKING, DEFAULT_TIER_THINKING.mid),
      frontier: parseThinking(
        process.env.PI_ROUTER_FRONTIER_THINKING,
        DEFAULT_TIER_THINKING.frontier,
      ),
    },
    userModel: null as unknown, // the model the user was on before the router touched anything
    userThinking: null as string | null,
    routerChosenKey: null as string | null,
    /** True after the router successfully set thinking; cleared on a manual change. */
    ownsThinking: false,
    /** True after thinking_level_select that was not the router's own write. */
    userChoseThinking: false,
    attemptsThisTask: 0,
    /** Turns to wait after a failed judgement before trying again. */
    failureCooldown: 0,
    /** True while the router itself is calling setModel. */
    settingModel: false,
    /** True while the router itself is calling setThinkingLevel. */
    settingThinking: false,
    taskIndex: 0,
    counters: {
      turns: 0,
      judged: 0,
      escalated: 0,
      held: 0,
      steppedDown: 0,
      tooBig: 0,
    },
    last: null as null | { difficulty: number; reason: string },
  };

  const notify = (ctx: ExtensionContext, text: string, level = "info") => {
    try {
      ctx?.ui?.notify?.(text, level);
    } catch {
      // A missing UI must never turn into a failed turn.
    }
  };

  // The footer shows extension statuses joined with " · ", so the router keeps
  // one short line there. Without it there is no way to tell a loaded router
  // that is deliberately holding from a router that is not loaded at all —
  // which is exactly how a session started before this extension existed
  // behaved.
  const setStatus = (ctx: ExtensionContext, text: string) => {
    try {
      ctx?.ui?.setStatus?.("router", text);
    } catch {
      // Status is decoration; losing it must not affect routing.
    }
  };

  // Every judgement is persisted as a custom entry, which does not enter LLM
  // context, so the report can join decisions to what actually happened later:
  // a held decision followed by a manual escalation is a missed one, and an
  // escalation followed by a manual retreat is a needless one.
  const record = (fields: Record<string, unknown>) => {
    try {
      pi.appendEntry?.("router-decision", fields);
    } catch {
      // Telemetry is never worth failing a turn over.
    }
  };

  const readThinking = (ctx: ExtensionContext) =>
    ctx?.thinkingLevel ?? pi.getThinkingLevel?.() ?? state.userThinking;

  // Thinking is never worth failing a turn over: same swallow as notify/setStatus.
  const writeThinking = (level: string) => {
    if (typeof pi.setThinkingLevel !== "function") return false;
    state.settingThinking = true;
    try {
      pi.setThinkingLevel(level);
      return true;
    } catch {
      return false;
    } finally {
      state.settingThinking = false;
    }
  };

  /** Set thinking and take ownership. `from` is the level before this write. */
  const takeThinking = (level: string | null, from: string | null) => {
    if (!level) return {};
    if (!state.ownsThinking) state.userThinking = from ?? state.userThinking;
    if (!writeThinking(level)) return {};
    state.ownsThinking = true;
    state.userChoseThinking = false;
    return { thinking: level, fromThinking: from ?? null, toThinking: level };
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

  // A model the user picked by hand is theirs: the router gives up ownership
  // and treats it as the new baseline to step back down to. Without this, a
  // session that went A → (user picks B) → (router picks F) would restore A.
  pi.on("model_select", (event, ctx) => {
    if (state.settingModel) return; // our own switch
    const chosen = event?.model ?? null;
    if (modelKey(chosen) !== state.routerChosenKey) {
      state.routerChosenKey = null;
      state.userModel = chosen ?? state.userModel;
      setStatus(ctx, `router: ${modelKey(chosen)?.split("/").pop() ?? "model"} (yours)`);
    }
  });

  // Mirror of model ownership: a thinking level the user picked by hand is
  // theirs. setModel can clamp thinking, so ignore the event while we are the
  // ones switching the model too.
  pi.on("thinking_level_select", (event, ctx) => {
    if (state.settingThinking || state.settingModel) return;
    state.ownsThinking = false;
    state.userChoseThinking = true;
    state.userThinking = event?.level ?? readThinking(ctx) ?? state.userThinking;
  });

  pi.on("session_start", (_event, ctx) => {
    state.userModel = ctx?.model ?? null;
    state.userThinking = readThinking(ctx) ?? null;
    state.routerChosenKey = null;
    state.ownsThinking = false;
    state.userChoseThinking = false;
    state.attemptsThisTask = 0;
    state.failureCooldown = 0;
    state.taskIndex = 0;
    setStatus(ctx, state.enabled ? "router: armed" : "router: off");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!state.enabled) return undefined;
    if (isSubagentChild) return undefined;

    const prompt = String(event?.prompt ?? "");
    if (!prompt.trim()) return undefined;
    state.counters.turns++;
    if (state.failureCooldown > 0) state.failureCooldown--;

    const branch = (() => {
      try {
        return ctx?.sessionManager?.getBranch?.() ?? [];
      } catch {
        return [];
      }
    })();
    const turns = turnsFromBranch(branch, WINDOW + 1);
    // Whether the branch already contains the turn being started is a lifecycle
    // detail, so identify it by shape rather than by text: a turn with no reply
    // yet is the one in flight. Matching on text alone would treat a repeated
    // "keep going" as current and hide the previous completed turn — including
    // its failures and its context measurement.
    const tail = turns[turns.length - 1];
    const includesCurrent = Boolean(
      tail && tail.prompt.trim() === prompt.trim() && !tail.lastResponse && !tail.toolCalls.length,
    );
    const history = (includesCurrent ? turns.slice(0, -1) : turns).slice(-WINDOW);
    const previousTurn = history[history.length - 1] ?? null;

    const boundary = gateTurn({ prompt, previousTurn });
    const failuresLastTurn = (previousTurn?.toolCalls ?? []).filter((call) => call.isError).length;
    // A new task starts a new budget. Resetting only on session_start meant
    // three judgements spent early made every later task unroutable, and the
    // model that happened to be active became permanent.
    if (boundary.route) {
      state.taskIndex++;
      state.attemptsThisTask = 0;
    }
    const taskIndexAtStart = state.taskIndex;

    // Task boundaries and stuck turns are worth a judgement; anything else
    // holds the decision already made for this task. The cap counts attempts,
    // not just successes, so an unavailable judge cannot be retried forever,
    // and a failure earns a short cooldown before the next try.
    const worthJudging =
      boundary.route || failuresLastTurn >= STUCK_FAILURES || state.attemptsThisTask === 0;
    if (
      !worthJudging ||
      state.attemptsThisTask >= MAX_JUDGEMENTS_PER_TASK ||
      state.failureCooldown > 0
    ) {
      state.counters.held++;
      return undefined;
    }

    const currentKey = modelKey(ctx?.model ?? null);
    const startedAt = Date.now();
    const contextTokens = latestContextTokens(history);
    state.attemptsThisTask++;
    let decision;
    try {
      const result = await ask({
        state: buildDifficultyState({ prompt, window: shareWindow ? history : [], cwd: ctx?.cwd }),
        questions: buildQuestions(),
        signal: AbortSignal.timeout(state.timeoutMs),
      });
      decision = routeFromDifficulty(result?.answers, {
        threshold: state.threshold,
        frontierThreshold: state.frontierThreshold,
      });
    } catch (error) {
      // A judgement that fails keeps the model that was working.
      state.failureCooldown = FAILURE_COOLDOWN_TURNS;
      record({
        at: Date.now(),
        latencyMs: Date.now() - startedAt,
        boundary: boundary.route,
        contextTokens,
        from: currentKey,
        tier: null,
        outcome: "judge-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      state.last = {
        difficulty: 0,
        reason: `judge unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
      return undefined;
    }

    // Anything that happened while the judgement was in flight invalidates it:
    // the user may have disabled the router, moved to another task, or picked a
    // model by hand. A stale decision must not switch anything.
    if (!state.enabled || state.taskIndex !== taskIndexAtStart) return undefined;
    if (modelKey(ctx?.model ?? null) !== currentKey) return undefined;

    state.counters.judged++;
    // The shared fields every decision record carries, so the report can join a
    // rating to what happened next within the same turn.
    const decided = {
      at: Date.now(),
      latencyMs: Date.now() - startedAt,
      difficulty: decision.difficulty,
      tier: decision.tier,
      threshold: state.threshold,
      boundary: boundary.route,
      contextTokens,
      from: currentKey,
    };
    state.last = {
      difficulty: decision.difficulty ?? 0,
      reason: decision.reason,
    };
    setStatus(
      ctx,
      `router: ${decision.difficulty === null ? "?" : decision.difficulty.toFixed(1)} ${decision.escalate ? "hard" : "held"}`,
    );

    // No usable rating: keep what is running. Never a reason to spend less.
    if (decision.escalate === null) {
      record({ ...decided, outcome: "no-rating" });
      return undefined;
    }

    // Escalate only when the target tier outranks the model in use. A session
    // already on the target — or better — holds; an unknown or economy model
    // ranks 0 and moves to whatever the rating asks for. Nothing here ever
    // downgrades a task in flight.
    const currentTier = tierOf(modelKey(ctx?.model ?? null), state.tiers);
    const currentRank = TIER_RANK[currentTier ?? ""] ?? 0;
    const targetRank = TIER_RANK[decision.tier ?? ""] ?? 0;
    // Read before any setModel: a model switch can clamp thinking, and the
    // user baseline is whatever was in effect before we touched the pair.
    const thinkingBefore = readThinking(ctx) ?? null;
    let thinkingFields: Record<string, unknown> = {};
    if (decision.escalate && targetRank > currentRank) {
      // Filter before choosing: the best-ranked model is useless if the session
      // would not fit inside it, and a later candidate may. The reservation is
      // generous on purpose — the next request is bigger than the last one, and
      // the response has to fit too.
      const usedWithHeadroom = contextTokens * CONTEXT_GROWTH_MARGIN + OUTPUT_RESERVE;
      const offers = await candidates(ctx);
      const fitting = offers.filter((entry: unknown) => {
        // ctx.scopedModels hands out { model, thinkingLevel? } wrappers, so the
        // window lives on the unwrapped model. Reading entry.contextWindow here
        // saw undefined, treated every scoped model as unbounded, and let an
        // oversized session escalate into a window it could not hold.
        const value = (entry as { model?: unknown })?.model ?? entry;
        const window = Number((value as { contextWindow?: number })?.contextWindow);
        if (!Number.isFinite(window) || window <= 0) return true; // unknown, not empty
        return usedWithHeadroom <= window;
      });
      const pick = chooseModelForTier(fitting, decision.tier, state.tiers);
      if (!pick) {
        if (offers.length > fitting.length) {
          state.counters.tooBig++;
          const used = contextTokens;
          setStatus(ctx, `router: ${Math.round(used / 1000)}k, no ${decision.tier} fits`);
          notify(
            ctx,
            `Router: staying on ${currentKey ?? "the current model"} — this session reads ${Math.round(used / 1000)}k tokens and no available ${decision.tier} model fits it`,
            "warning",
          );
        } else {
          notify(
            ctx,
            `Router: this task rates ${decision.difficulty.toFixed(2)} but no ${decision.tier} model is available`,
            "warning",
          );
        }
        record({ ...decided, outcome: `no-${decision.tier}-model` });
        return undefined;
      }
      if (modelKey(pick.model) === currentKey) return undefined;

      // Capture the baseline immediately before switching, not at session start:
      // a model the user picked in between is the one to come back to.
      state.userModel = ctx?.model ?? state.userModel;
      state.settingModel = true;
      let ok: boolean | undefined;
      try {
        ok = await Promise.resolve(pi.setModel?.(pick.model));
      } finally {
        // A throwing setModel must not leave the flag set, or every later
        // manual model change would be mistaken for the router's own.
        state.settingModel = false;
      }
      if (ok === false) {
        notify(
          ctx,
          `Router: no authentication for ${pick.key} — staying on ${currentKey ?? "the current model"}`,
          "error",
        );
        record({ ...decided, outcome: "no-auth", to: pick.key });
        return undefined;
      }
      state.routerChosenKey = pick.key;
      state.counters.escalated++;
      // Model first, then thinking: setModel can clamp the level. A switch
      // always sets the target tier's thinking, even when that is lower — do
      // not carry Luna-max onto Astra.
      thinkingFields = takeThinking(thinkingForTier(decision.tier, state.thinking), thinkingBefore);
      record({ ...decided, outcome: "escalated", to: pick.key, ...thinkingFields });
      setStatus(ctx, `router: ${pick.key.split("/").pop()} @ ${decision.difficulty.toFixed(1)}`);
      notify(
        ctx,
        `Router: ${pick.key} — difficulty ${decision.difficulty.toFixed(2)} (${boundary.route ? boundary.reason : "task continues"})`,
        "info",
      );
      return undefined;
    }

    // Same model, same tier: only raise thinking, never lower in flight, and
    // never crank thinking on a higher-tier model for a mid-rated task. A
    // manual thinking_level_select is not fought.
    if (
      decision.escalate &&
      decision.tier &&
      currentTier === decision.tier &&
      !state.userChoseThinking
    ) {
      const wanted = thinkingForTier(decision.tier, state.thinking);
      if (wanted && thinkingRank(wanted) > thinkingRank(thinkingBefore)) {
        thinkingFields = takeThinking(wanted, thinkingBefore);
      }
    }

    // Back down at a task boundary, and only from a model the router chose.
    // The boundary check is the point: without it a stuck turn could step the
    // model down mid-failure, which is when the rule matters most.
    if (decision.escalate === false && boundary.route && state.routerChosenKey && state.userModel) {
      const stillOurs = modelKey(ctx?.model ?? null) === state.routerChosenKey;
      if (stillOurs && currentKey !== modelKey(state.userModel)) {
        const ok = await Promise.resolve(pi.setModel?.(state.userModel));
        if (ok !== false) {
          state.routerChosenKey = null;
          state.counters.steppedDown++;
          if (state.ownsThinking && state.userThinking) {
            const restored = state.userThinking;
            if (writeThinking(restored)) {
              thinkingFields = {
                thinking: restored,
                fromThinking: thinkingBefore,
                toThinking: restored,
              };
            }
            state.ownsThinking = false;
          }
          record({
            ...decided,
            outcome: "stepped-down",
            to: modelKey(state.userModel),
            ...thinkingFields,
          });
          setStatus(ctx, `router: back to ${modelKey(state.userModel)?.split("/").pop()}`);
          notify(
            ctx,
            `Router: back to ${modelKey(state.userModel)} — difficulty ${decision.difficulty.toFixed(2)}`,
            "info",
          );
        }
      }
    }
    record({ ...decided, outcome: "held", ...thinkingFields });
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
        setStatus(ctx, "router: off");
        notify(ctx, "Router off. /route on to re-arm.", "warning");
        return;
      }
      if (action === "on" || action === "enable") {
        state.enabled = true;
        setStatus(ctx, "router: armed");
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
          `Router ${state.enabled ? "on" : "OFF"} · threshold ${state.threshold}/${state.frontierThreshold} · mid@${state.thinking.mid} frontier@${state.thinking.frontier} · ${state.tiers.frontier[0]} first · sharing ${shareWindow ? "prompt + recent turns" : "prompt only"}`,
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
