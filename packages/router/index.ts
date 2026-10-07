// index.ts — pi extension: a virtual model that routes each request to a model
// that fits the task.
//
// Select `router/auto` and pi calls route() before every request. This answers
// with a physical model and thinking level, and pi records the selection once
// and the dispatch per assistant message. Routing decisions live in router
// state on the session branch, so they follow forks and survive compaction.
//
// The shape is not taste, it is what the measurements said:
//
//   - Per-turn switching costs more than it saves. Sticky escalation without a
//     way down measured +1665% on this corpus, and a per-turn chooser +848%.
//   - Model choice was mostly per session anyway (one session produced 293 of
//     the 293 requests on the frontier model; another 9 of 9), so the unit that
//     matches how the work actually happens is the task, not the turn.
//   - Rules cannot do it: they scored 30% recall at 7% precision and were
//     confidently wrong on the two most expensive turns in the corpus. A
//     graded difficulty rating from TypeSafe scores AUC 0.70, and at >= 1.5 is
//     77% precise at 48% recall, catching 12 of the top 12 turns by spend.
//
// So: ask Jev how hard the task is, escalate at the threshold, hold the
// decision while the task continues, and return to the base at a new task.
// Only a task boundary may come back down — a stuck turn rated easy is still a
// stuck turn.
//
// Escape hatches: `/route off`, `PI_ROUTER=off`, and selecting a physical
// model, which deselects the router entirely.

import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRoute,
  ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";

import { askSystemOne } from "../../shared/systemone.mjs";
import { ensureRouterConfig, readRouterConfig, routerConfigPath } from "./config.mjs";
import { gateTurn } from "./lib.mjs";
import {
  buildDifficultyState,
  buildQuestions,
  chooseModelForTier,
  DIFFICULTY_THRESHOLD,
  FRONTIER_THRESHOLD,
  latestContextTokens,
  modelKey,
  pairOrder,
  routeFromDifficulty,
  routePair,
  THINKING_LEVELS,
  thinkingRank,
  tierOf,
  tierRank,
  turnsFromMessages,
  WINDOW,
} from "./model-battery.mjs";

const PROVIDER = "router";
const MODEL_ID = "auto";
const COMMAND = "route";
/** The tier the router holds when a task is not rated above the base. */
const BASE_TIER = "base";
/** Default thinking for the virtual selection when pi does not supply one. */
const DEFAULT_THINKING = "medium";
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

type RouteTier = "base" | "mid" | "frontier";

/**
 * Routing state pi persists on the session branch and hands back each request.
 *
 * It carries only what the transcript cannot tell us: how many judgements this
 * task has spent, whether a dead judge is cooling down, and which tier the task
 * is routed at. The model that answered is already on the assistant messages.
 */
interface RouterState {
  task: number;
  attempts: number;
  cooldown: number;
  tier: RouteTier;
  /** "provider/id" in force, or null before the first decision. */
  model: string | null;
  /** Physical thinking level in force for that model. */
  thinking: string | null;
  /** The base the last decision held at; router.json re-resolves it. */
  base: string | null;
}

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

function parseThinking(raw, fallback, levels = THINKING_LEVELS) {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase();
  return levels.includes(value) ? value : fallback;
}

function isRouteTier(value: unknown): value is RouteTier {
  return value === "base" || value === "mid" || value === "frontier";
}

/** Router state is JSON from a session branch: validate it, or start fresh. */
function readState(value: unknown): RouterState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.task !== "number" ||
    typeof raw.attempts !== "number" ||
    typeof raw.cooldown !== "number" ||
    !isRouteTier(raw.tier)
  ) {
    return null;
  }
  return {
    task: raw.task,
    attempts: raw.attempts,
    cooldown: raw.cooldown,
    tier: raw.tier,
    model: typeof raw.model === "string" ? raw.model : null,
    thinking: typeof raw.thinking === "string" ? raw.thinking : null,
    base: typeof raw.base === "string" ? raw.base : null,
  };
}

/** The model inside a `{ model, thinkingLevel }` scope wrapper, or the entry. */
function unwrap(entry: unknown) {
  const value = (entry as { model?: unknown })?.model ?? entry;
  return (value as { [key: string]: unknown }) ?? null;
}

export default function piRouterExtension(
  pi: ExtensionAPI,
  deps: { ask?: typeof askSystemOne; configPath?: string } = {},
) {
  const ask = deps.ask ?? askSystemOne;
  const configPath = deps.configPath ?? routerConfigPath();
  // First run: leave a file with the built-in lists to open and edit.
  ensureRouterConfig(configPath);
  // Captured at factory time, not per request: pi-subagents sets
  // PI_SUBAGENT_CHILD only while a child's extensions load. Children must still
  // register the virtual model they inherit, but they get the base model
  // without a judgement.
  const isSubagentChild = String(process.env?.PI_SUBAGENT_CHILD ?? "").trim() === "1";
  // What the judgement is allowed to send: the prompt alone, or the last few
  // turns as well. Escalation also means the conversation is served by another
  // provider, which is a data-flow decision, not a routing detail.
  const shareWindow =
    String(process.env?.PI_ROUTER_SHARE ?? "window")
      .trim()
      .toLowerCase() !== "prompt";

  const config = {
    enabled: envFlag(),
    threshold: envNumber("PI_ROUTER_THRESHOLD", DIFFICULTY_THRESHOLD),
    frontierThreshold: envNumber("PI_ROUTER_FRONTIER_THRESHOLD", FRONTIER_THRESHOLD),
    timeoutMs: envNumber("PI_ROUTER_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  };

  // Counters are for /route status, not decisions; the authoritative routing
  // state lives on the session branch. A fork's counters are the process's,
  // not the branch's.
  const counters = {
    turns: 0,
    judged: 0,
    escalated: 0,
    steppedDown: 0,
    held: 0,
    tooBig: 0,
  };
  let last: { difficulty: number; reason: string } | null = null;
  let lastState: RouterState | null = null;

  const notify = (ctx: ExtensionContext, text: string, level = "info") => {
    try {
      ctx?.ui?.notify?.(text, level);
    } catch {
      // A missing UI must never turn into a failed request.
    }
  };

  // The footer shows the routed model itself now, so the status line carries
  // the judgement, which the footer does not.
  const setStatus = (ctx: ExtensionContext, text: string) => {
    try {
      ctx?.ui?.setStatus?.("router", text);
    } catch {
      // Status is decoration; losing it must not affect routing.
    }
  };

  // Every judgement is persisted as a custom entry, which does not enter LLM
  // context, so the report can join decisions to what actually happened later:
  // a held decision followed by a manual escalation is a miss, and an
  // escalation followed by a manual retreat is a needless one.
  const record = (fields: Record<string, unknown>) => {
    try {
      pi.appendEntry?.("router-decision", fields);
    } catch {
      // Telemetry is never worth failing a request over.
    }
  };

  // The model lists live in a JSON file and are re-read per judgement, so an
  // edit takes effect at the next task. A broken file narrows routing to the
  // built-in defaults and says so once.
  let configErrorNotified = false;
  function modelTiers(ctx: ExtensionContext) {
    const loaded = readRouterConfig(configPath);
    if (loaded.error && !configErrorNotified) {
      configErrorNotified = true;
      notify(ctx, `Router: ${loaded.error} — using the built-in model lists.`, "warning");
    }
    return { base: loaded.base, mid: loaded.mid, frontier: loaded.frontier };
  }

  /** Every physical model the router may choose: the session's scope wins. */
  async function candidates(ctx: ExtensionContext) {
    const scoped = ctx?.scopedModels;
    let list: unknown[] = [];
    if (Array.isArray(scoped) && scoped.length) {
      list = scoped;
    } else {
      try {
        const available = await Promise.resolve(ctx?.modelRegistry?.getAvailable?.());
        list = Array.isArray(available) ? available : [];
      } catch {
        list = [];
      }
    }
    // The virtual model is a selection, never a destination.
    return list.filter((entry) => modelKey(entry) !== `${PROVIDER}/${MODEL_ID}`);
  }

  /** Resolve a "provider/id" against the candidate list, then the registry. */
  function resolveKey(offers: unknown[], ctx: ExtensionContext, key: string | null) {
    if (!key) return null;
    const match = offers.find((entry) => modelKey(entry) === key);
    if (match) return unwrap(match);
    const slash = key.indexOf("/");
    if (slash <= 0) return null;
    try {
      return (
        ctx?.modelRegistry?.find?.(key.slice(0, slash), key.slice(slash + 1)) ??
        ctx?.modelRegistry?.getModel?.(key.slice(0, slash), key.slice(slash + 1)) ??
        null
      );
    } catch {
      return null;
    }
  }

  /**
   * The session's baseline: the first configured base in scope, then the last
   * physical model the session used, then whatever the catalogue lists first.
   * Degrading beats erroring — a missing subscription should narrow routing,
   * not break the session.
   */
  function pickBase(
    offers: unknown[],
    ctx: ExtensionContext,
    previousKey: string | null,
    tiers: Record<string, unknown[]>,
    thinkingCap: string,
  ) {
    const configured = chooseModelForTier(offers, BASE_TIER, tiers, undefined, thinkingCap);
    if (configured) {
      return {
        model: configured.model as unknown,
        key: String(configured.key),
        thinking: configured.thinking,
      };
    }
    if (previousKey) {
      const model = resolveKey(offers, ctx, previousKey);
      if (model) return { model, key: previousKey, thinking: null };
    }
    const first = offers[0];
    if (!first) return null;
    return { model: unwrap(first), key: modelKey(first), thinking: null };
  }

  /**
   * Candidates the next request could fit inside.
   *
   * The base model here reads 1M tokens while the Codex frontier models hold
   * 272K, and this machine's p90 request context is 452K. Escalating anyway
   * would compact the session — losing the context the escalation was meant to
   * reason over.
   */
  function fitting(offers: unknown[], contextTokens: number) {
    const used = contextTokens * CONTEXT_GROWTH_MARGIN + OUTPUT_RESERVE;
    if (!Number.isFinite(used) || used <= 0) return offers;
    return offers.filter((entry) => {
      const value = unwrap(entry);
      const window = Number(value?.contextWindow);
      if (!Number.isFinite(window) || window <= 0) return true; // unknown, not empty
      return used <= window;
    });
  }

  /** Raise thinking, never lower it, for a model that already fits the tier. */
  function raiseThinking(wanted: string | null, currentLevel: string | null) {
    if (!wanted) return currentLevel;
    if (thinkingRank(wanted) > thinkingRank(currentLevel ?? "")) return wanted;
    return currentLevel;
  }

  async function route(
    request: ModelRouteRequest<RouterState>,
    ctx: ExtensionContext,
  ): Promise<ModelRoute<RouterState>> {
    const reason = request?.reason ?? "user";
    const selected = parseThinking(request?.thinkingLevel, DEFAULT_THINKING);
    const offers = await candidates(ctx);
    const tiers = modelTiers(ctx);
    const branchState = readState(request?.state);
    const previousKey = modelKey(request?.previous?.model ?? null);

    // Re-resolved every request, so editing router.json moves the base at the
    // next task rather than at the next session.
    const base = pickBase(offers, ctx, previousKey, tiers, selected);

    const heldKey = branchState?.model ?? previousKey ?? base?.key ?? null;
    const heldModel = resolveKey(offers, ctx, heldKey) ?? base?.model ?? null;
    const heldThinking = branchState?.thinking ?? base?.thinking ?? selected;

    // Disabled, a child session, or a request outside the agent loop: hold the
    // base (or the last decision) without judging. `direct` covers compaction
    // summaries and extension calls, and carries no state.
    if (!config.enabled || isSubagentChild || reason === "direct") {
      const model = base?.model ?? heldModel;
      if (!model) throw new Error("Router: no physical model is available to route to");
      return { model, thinkingLevel: base?.thinking ?? selected };
    }

    if (!heldModel) throw new Error("Router: no physical model is available to route to");

    // Continuations and retries keep the model that handled the turn. Thinking
    // signatures and prompt caches stay valid, and a retry is not a new task.
    if (reason === "continuation" || reason === "retry") {
      return {
        model: heldModel,
        thinkingLevel: heldThinking,
        state: branchState ?? undefined,
      };
    }

    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const turns = turnsFromMessages(messages, WINDOW + 1);
    // A turn with no reply yet is the one in flight, so the previous completed
    // turn is what the gate and the failure count need.
    const tail = turns[turns.length - 1];
    const includesCurrent = Boolean(tail && !tail.lastResponse && !tail.toolCalls.length);
    const history = (includesCurrent ? turns.slice(0, -1) : turns).slice(-WINDOW);
    const previousTurn = history[history.length - 1] ?? null;
    const prompt = String(tail?.prompt ?? "").slice(0, 2000);
    const boundary = gateTurn({ prompt, previousTurn });
    const failuresLastTurn = (previousTurn?.toolCalls ?? []).filter((call) => call.isError).length;

    counters.turns++;
    const cooldown = Math.max(0, (branchState?.cooldown ?? 0) - 1);
    // A new task starts a new budget. Resetting only per session meant three
    // judgements spent early made every later task unroutable.
    const task = boundary.route ? (branchState?.task ?? 0) + 1 : (branchState?.task ?? 1);
    const attempts = boundary.route ? 0 : (branchState?.attempts ?? 0);
    const startedAt = Date.now();
    const contextTokens = latestContextTokens(history);

    const currentKey = heldKey ?? base?.key ?? null;
    const currentModel = resolveKey(offers, ctx, currentKey) ?? heldModel;
    const currentRank = tierRank(tierOf(currentKey, tiers));

    // Task boundaries and stuck turns are worth a judgement; anything else
    // holds the decision already made. The cap counts attempts, not just
    // successes, so an unavailable judge cannot be retried forever, and a
    // failure earns a short cooldown before the next try.
    const worthJudging = boundary.route || failuresLastTurn >= STUCK_FAILURES || attempts === 0;
    const judgeable =
      Boolean(prompt) && worthJudging && attempts < MAX_JUDGEMENTS_PER_TASK && cooldown === 0;

    let nextAttempts = attempts + (judgeable ? 1 : 0);
    let nextTier: RouteTier = branchState?.tier ?? BASE_TIER;
    let nextModel: unknown = currentModel;
    let nextKey = currentKey;
    let nextThinking: string | null = heldThinking;
    let outcome = "held";
    let decided: ReturnType<typeof routeFromDifficulty> | null = null;

    if (judgeable) {
      try {
        const result = await ask({
          state: buildDifficultyState({
            prompt,
            window: shareWindow ? history : [],
            cwd: ctx?.cwd,
          }),
          questions: buildQuestions(),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        decided = routeFromDifficulty(result?.answers, {
          threshold: config.threshold,
          frontierThreshold: config.frontierThreshold,
        });
        counters.judged++;
        // Anything that happened while the judgement was in flight invalidates
        // it — most importantly /route off.
        if (!config.enabled) {
          return { model: base?.model ?? currentModel, thinkingLevel: selected };
        }
      } catch (error) {
        // A judgement that fails keeps the model that was working.
        nextAttempts = attempts + 1;
        const failed: RouterState = {
          task,
          attempts: nextAttempts,
          cooldown: FAILURE_COOLDOWN_TURNS,
          tier: nextTier,
          model: nextKey,
          thinking: nextThinking,
          base: base?.key ?? branchState?.base ?? null,
        };
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
        last = {
          difficulty: 0,
          reason: `judge unavailable: ${error instanceof Error ? error.message : String(error)}`,
        };
        lastState = failed;
        return { model: currentModel, thinkingLevel: nextThinking ?? selected, state: failed };
      }
    }

    if (decided) {
      if (decided.escalate === null) {
        // No usable rating: keep what is running. Never a reason to spend less.
        outcome = "no-rating";
      } else if (decided.escalate) {
        const targetRank = tierRank(decided.tier);
        const fittingOffers = fitting(offers, contextTokens);
        const pick = chooseModelForTier(fittingOffers, decided.tier, tiers, undefined, selected);
        if (!pick) {
          outcome = `no-${decided.tier}-model`;
          if (offers.length > fittingOffers.length) {
            counters.tooBig++;
            setStatus(ctx, `router: ${Math.round(contextTokens / 1000)}k, no ${decided.tier} fits`);
            notify(
              ctx,
              `Router: staying on ${currentKey ?? "the current model"} — this session reads ${Math.round(contextTokens / 1000)}k tokens and no available ${decided.tier} model fits it`,
              "warning",
            );
          } else {
            notify(
              ctx,
              `Router: this task rates ${decided.difficulty.toFixed(2)} but no ${decided.tier} model is available`,
              "warning",
            );
          }
        } else {
          const targetThinking = pick.thinking ?? selected;
          const currentPairOrder = pairOrder(currentKey, heldThinking, decided.tier, tiers);
          const capExceeded = thinkingRank(heldThinking ?? "") > thinkingRank(selected);
          const betterPair =
            targetRank > currentRank ||
            (targetRank === currentRank &&
              (capExceeded || (currentPairOrder !== null && pick.order < currentPairOrder)));

          if (pick.key === currentKey) {
            // Same model: raise to the selected pair, but never lower it unless
            // the user explicitly lowered the virtual model's cap.
            if (tierOf(currentKey, tiers) === decided.tier) {
              nextThinking = capExceeded
                ? (targetThinking ?? selected)
                : raiseThinking(targetThinking, nextThinking);
              nextTier = decided.tier;
            }
          } else if (betterPair) {
            nextModel = pick.model;
            nextKey = pick.key;
            nextTier = decided.tier;
            // The pair is selected as a unit. Do not choose Astra first and
            // then silently clamp it when Sol@xhigh fits under the cap.
            nextThinking = targetThinking ?? nextThinking;
            outcome = "escalated";
          }
        }
      } else {
        // Easy task. Only a task boundary may come back down: a stuck turn
        // rated easy is still a stuck turn.
        if (boundary.route && base?.model) {
          if ((branchState?.tier ?? BASE_TIER) !== BASE_TIER) outcome = "stepped-down";
          nextModel = base.model;
          nextKey = base.key;
          nextTier = BASE_TIER;
          nextThinking = base.thinking ?? selected;
        }
      }
    }

    const nextState: RouterState = {
      task,
      attempts: nextAttempts,
      cooldown,
      tier: nextTier,
      model: nextKey,
      thinking: nextThinking,
      base: base?.key ?? branchState?.base ?? null,
    };
    lastState = nextState;

    const shared = {
      at: Date.now(),
      latencyMs: Date.now() - startedAt,
      difficulty: decided?.difficulty ?? null,
      tier: decided?.tier ?? null,
      threshold: config.threshold,
      boundary: boundary.route,
      contextTokens,
      from: currentKey,
    };
    if (decided) {
      const short = (key: string | null) => key?.split("/").pop() ?? "?";
      if (outcome === "escalated") {
        counters.escalated++;
        record({ ...shared, outcome, to: nextKey, toThinking: nextThinking });
        setStatus(
          ctx,
          `router: ${short(nextKey)}@${nextThinking ?? selected} · ${decided.difficulty.toFixed(1)}`,
        );
        notify(
          ctx,
          `Router: ${nextKey} — difficulty ${decided.difficulty.toFixed(2)} (${boundary.route ? boundary.reason : "task continues"})`,
        );
      } else if (outcome === "stepped-down") {
        counters.steppedDown++;
        record({ ...shared, outcome, to: nextKey, toThinking: nextThinking });
        setStatus(ctx, `router: back to ${short(nextKey)}@${nextThinking ?? selected}`);
        notify(ctx, `Router: back to ${nextKey} — difficulty ${decided.difficulty.toFixed(2)}`);
      } else {
        counters.held++;
        record({ ...shared, outcome });
        // no-rating and no-<tier>-model carry no difficulty to print.
        const label = Number.isFinite(decided.difficulty)
          ? `${decided.difficulty.toFixed(1)} held`
          : outcome.replace(/-/g, " ");
        setStatus(ctx, `router: ${label}`);
      }
      last = { difficulty: decided.difficulty ?? 0, reason: decided.reason };
    } else {
      counters.held++;
    }

    return { model: nextModel, thinkingLevel: nextThinking ?? selected, state: nextState };
  }

  pi.registerVirtualModel<RouterState>({
    provider: PROVIDER,
    id: MODEL_ID,
    name: "Auto (judged)",
    thinkingLevels: THINKING_LEVELS,
    // Left unset: the routed model's own limits are the honest ones, and a
    // declaration here would apply before the first response.
    route,
  });

  pi.on("session_start", (_event, ctx) => {
    counters.turns = 0;
    counters.judged = 0;
    counters.escalated = 0;
    counters.steppedDown = 0;
    counters.held = 0;
    counters.tooBig = 0;
    last = null;
    lastState = null;
    const selected = modelKey(ctx?.model ?? null) === `${PROVIDER}/${MODEL_ID}`;
    setStatus(
      ctx,
      !config.enabled
        ? "router: off"
        : selected
          ? "router: armed"
          : "router: idle — /model router/auto",
    );
  });

  pi.registerCommand(COMMAND, {
    description: "Show or toggle judged model routing for this session",
    handler: async (args, ctx) => {
      const action = String(args ?? "")
        .trim()
        .toLowerCase();
      if (action === "off" || action === "disable") {
        config.enabled = false;
        setStatus(ctx, "router: off");
        notify(ctx, "Router off. /route on to re-arm.", "warning");
        return;
      }
      if (action === "on" || action === "enable") {
        config.enabled = true;
        setStatus(ctx, "router: armed");
        notify(ctx, "Router on.", "info");
        return;
      }
      const c = counters;
      const loaded = readRouterConfig(configPath);
      const lists = (values: unknown[]) =>
        values.length
          ? values
              .map((entry) => {
                const pair = routePair(entry);
                return pair ? `${pair.model}${pair.thinking ? `@${pair.thinking}` : ""}` : "?";
              })
              .join(", ")
          : "(none)";
      const lastLine = last
        ? `last judgement: difficulty ${last.difficulty.toFixed(2)} — ${last.reason}`
        : "no judgement yet";
      notify(
        ctx,
        [
          `Router ${config.enabled ? "on" : "OFF"} · select ${PROVIDER}/${MODEL_ID} to route · cap is the selected reasoning level · threshold ${config.threshold}/${config.frontierThreshold} · sharing ${shareWindow ? "prompt + recent turns" : "prompt only"}`,
          `models ${configPath}${loaded.error ? ` (broken: ${loaded.error}; using defaults)` : ""}`,
          `base ${lists(loaded.base)} · mid ${lists(loaded.mid)} · frontier ${lists(loaded.frontier)}`,
          `${c.turns} turns · ${c.judged} judged · ${c.escalated} escalated · ${c.steppedDown} stepped down · ${c.held} held · ${c.tooBig} too big to switch`,
          lastState
            ? `routed to ${lastState.model ?? "?"} (${lastState.tier}) · base ${lastState.base ?? "?"}`
            : "no routing decision yet",
          lastLine,
        ].join("\n"),
      );
    },
  });
}
