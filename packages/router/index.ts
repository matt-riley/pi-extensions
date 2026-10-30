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
//     77% precise at 48% recall, catching 7 of the 12 most expensive turns in
//     the judged sample (packages/router/README.md).
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

import { flagOff } from "../../shared/env-flag.mjs";
import { askSystemOne } from "../../shared/systemone.mjs";
import { bindSystemOne } from "../../shared/systemone-session.mjs";
import {
  ensureRouterConfig,
  readRouterConfig,
  routerConfigPath,
  unmatchedPatterns,
} from "./config.mjs";
import { fitting } from "./decide.mjs";
import { routingLadder } from "./ladder.mjs";
import { gateTurn, stuckCheckDescription } from "./lib.mjs";
import {
  classifyProviderError,
  createUsageCaps,
  offersExceptCooling,
  usageCapFromMessages,
  usageCooldownMs,
} from "./usage-cap.mjs";
import {
  buildTaskTypeQuestion,
  loadPlaybook,
  NO_PLAYBOOK,
  taskTypeFromAnswer,
} from "./playbook.mjs";
import {
  buildDifficultyState,
  buildDifficultyQuestions,
  chooseModelForTier,
  DIFFICULTY_THRESHOLD,
  FRONTIER_THRESHOLD,
  latestContextTokens,
  modelKey,
  routeFromDifficulty,
  routePair,
  THINKING_LEVELS,
  turnsFromMessages,
  WINDOW,
} from "./model-battery.mjs";
import { pinnedPhysicalModelKey } from "./parent-physical.mjs";
import {
  BASE_TIER,
  pickBase,
  planUserRouteTurn,
  readBranchState,
  resolveKey,
} from "./route-turn.mjs";
import { createShadowLogger } from "./shadow-hook.mjs";
import { parseTierOverridePrefix } from "./tier-override.mjs";
import {
  baselinePath,
  gitRepoKey,
  recordCompletedTurnBaseline,
  stuckBaselineForRepo,
} from "./turn-baseline.mjs";

const PROVIDER = "router";
const MODEL_ID = "auto";
const COMMAND = "route";
/** Default thinking for the virtual selection when pi does not supply one. */
const DEFAULT_THINKING = "medium";
const DEFAULT_TIMEOUT_MS = 4000;
/** The playbook judgment blocks the first request of a task; it gets less time than routing does. */
const PLAYBOOK_TIMEOUT_MS = 1500;

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
  /** Manual !tier override for this task, cleared at the next task boundary. */
  forcedTier?: RouteTier | null;
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

function failedErrorText(request: ModelRouteRequest<RouterState> | undefined): string {
  const message = request?.failed?.message;
  if (!message || typeof message !== "object") return "";
  const text = (message as { errorMessage?: unknown }).errorMessage;
  return typeof text === "string" ? text : "";
}

function readState(value: unknown): RouterState | null {
  return readBranchState(value) as RouterState | null;
}

export default function piRouterExtension(
  pi: ExtensionAPI,
  deps: {
    ask?: typeof askSystemOne;
    configPath?: string;
    turnBaselinePath?: string;
    now?: () => number;
  } = {},
) {
  bindSystemOne(pi);
  const ask = deps.ask ?? askSystemOne;
  const usageCaps = createUsageCaps();
  const clock = deps.now ?? (() => Date.now());
  let generation = 0;
  const judgments = new Set<AbortController>();
  const judge: typeof askSystemOne = async (input) => {
    const controller = new AbortController();
    judgments.add(controller);
    try {
      return await ask({
        ...input,
        signal: AbortSignal.any([controller.signal, input.signal ?? AbortSignal.timeout(4000)]),
      });
    } finally {
      judgments.delete(controller);
    }
  };
  const configPath = deps.configPath ?? routerConfigPath();
  const turnBaselinePath = deps.turnBaselinePath ?? baselinePath();
  // First run: leave a file with the built-in lists to open and edit.
  ensureRouterConfig(configPath);
  let cachedShadowLog = readRouterConfig(configPath).shadowLog ?? false;
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

  const playbooksEnabled = !flagOff(process.env?.PI_ROUTER_PLAYBOOKS);

  const config = {
    enabled: !flagOff(process.env?.PI_ROUTER),
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
  // The playbook judged for the current task: held until the next task
  // boundary, so a task is judged once and keeps its playbook on follow-ups.
  // `undefined` means nothing has been judged in this process yet.
  let playbook: { type: string; text: string | null } | undefined;
  // Difficulty answers fetched in before_agent_start for this prompt, so
  // route() can use them instead of asking again for the same task.
  let pending: { prompt: string; answers: unknown } | null = null;
  let pendingForcedTier: RouteTier | null = null;
  let pendingForcedPrompt: string | null = null;

  /** Baseline for stuck-turn detection in this cwd. */
  function stuckBaseline(ctx: ExtensionContext) {
    return stuckBaselineForRepo(turnBaselinePath, gitRepoKey(ctx?.cwd), process.env);
  }

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
  let staleNotified = false;
  function modelTiers(ctx: ExtensionContext) {
    const loaded = readRouterConfig(configPath);
    cachedShadowLog = loaded.shadowLog ?? false;
    if (loaded.error && !configErrorNotified) {
      configErrorNotified = true;
      notify(ctx, `Router: ${loaded.error} — using the built-in model lists.`, "warning");
    }
    return { base: loaded.base, mid: loaded.mid, frontier: loaded.frontier, error: loaded.error };
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

  const { runShadowLog, handleShadowCommand, resetShadowSession } = createShadowLogger({
    configPath,
    config,
    shareWindow,
    isSubagentChild,
    virtualModelKey: `${PROVIDER}/${MODEL_ID}`,
    parseThinking,
    defaultThinking: DEFAULT_THINKING,
    candidates,
    modelTiers,
    usageCaps,
    clock,
    judge,
    notify,
    getShadowLogEnabled: () => cachedShadowLog,
    turnBaselinePath,
    stuckBaselineForRepo,
    gitRepoKey,
  });

  async function route(
    request: ModelRouteRequest<RouterState>,
    ctx: ExtensionContext,
  ): Promise<ModelRoute<RouterState>> {
    const epoch = generation;
    const reason = request?.reason ?? "user";
    const selected = parseThinking(request?.thinkingLevel, DEFAULT_THINKING);
    const offers = await candidates(ctx);
    const tiers = modelTiers(ctx);
    const cooling = usageCaps.active(clock());
    const liveOffers = offersExceptCooling(offers, cooling);
    // A broken file already said so; its stand-in defaults are not the user's list.
    if (!staleNotified && !tiers.error && offers.length) {
      staleNotified = true;
      const stale = unmatchedPatterns(tiers, offers.map(modelKey).filter(Boolean));
      if (stale.length)
        notify(
          ctx,
          `Router: ${configPath} names models not available here: ${stale.join(", ")}`,
          "warning",
        );
    }
    const branchState = readState(request?.state);
    const previousKey = modelKey(request?.previous?.model ?? null);

    // Re-resolved every request, so editing router.json moves the base at the
    // next task rather than at the next session.
    // A cooling model stays available as a last resort, so an empty live list
    // degrades to the full catalogue instead of throwing.
    const base =
      pickBase(liveOffers, ctx, previousKey, tiers, selected) ??
      pickBase(offers, ctx, previousKey, tiers, selected);

    const heldKey = branchState?.model ?? previousKey ?? base?.key ?? null;
    const heldModel = resolveKey(offers, ctx, heldKey) ?? base?.model ?? null;
    const heldThinking = branchState?.thinking ?? base?.thinking ?? selected;

    // Disabled, a child session, or a request outside the agent loop: hold the
    // base (or the last decision) without judging. `direct` covers compaction
    // summaries and extension calls, and carries no state.
    if (epoch !== generation || !config.enabled || isSubagentChild || reason === "direct") {
      if (isSubagentChild) {
        const pinnedKey = pinnedPhysicalModelKey(request);
        if (pinnedKey) {
          const model = resolveKey(offers, ctx, pinnedKey);
          if (!model) throw new Error("Router: no physical model is available to route to");
          // pi passes the child's thinking already clamped to the user's cap.
          return { model, thinkingLevel: selected };
        }
        const model = base?.model ?? heldModel;
        if (!model) throw new Error("Router: no physical model is available to route to");
        return { model, thinkingLevel: selected };
      }
      const model = base?.model ?? heldModel;
      if (!model) throw new Error("Router: no physical model is available to route to");
      return { model, thinkingLevel: base?.thinking ?? selected };
    }

    if (!heldModel) throw new Error("Router: no physical model is available to route to");

    // Continuations keep the model that handled the turn. A retry does too,
    // except a usage-limit error, which cannot succeed on that model: cool it
    // down and take the next pair in the same tier. Overloads, throttles and
    // every other retry, including context overflow, stay put.
    if (reason === "continuation" || reason === "retry") {
      if (reason === "retry" && classifyProviderError(failedErrorText(request)) === "usage") {
        const failedKey = modelKey(request?.failed) ?? heldKey;
        const tier = branchState?.tier ?? BASE_TIER;
        if (failedKey)
          usageCaps.record(failedKey, usageCooldownMs(failedErrorText(request)), clock());
        const pick = chooseModelForTier(
          offersExceptCooling(offers, usageCaps.active(clock())),
          tier,
          tiers,
          undefined,
          selected,
        );
        if (pick) {
          record({
            at: Date.now(),
            outcome: "failover",
            from: heldKey,
            to: pick.key,
            toThinking: pick.thinking ?? heldThinking,
            tier,
          });
          const state: RouterState = {
            task: branchState?.task ?? 1,
            attempts: branchState?.attempts ?? 0,
            cooldown: branchState?.cooldown ?? 0,
            tier,
            model: String(pick.key),
            thinking: pick.thinking ?? heldThinking,
            base: branchState?.base ?? base?.key ?? null,
          };
          return { model: pick.model, thinkingLevel: pick.thinking ?? heldThinking, state };
        }
        notify(
          ctx,
          `Router: staying on ${failedKey ?? heldKey ?? "the current model"} — every ${tier} model is cooling down after a usage limit`,
          "warning",
        );
      }
      return {
        model: heldModel,
        thinkingLevel: heldThinking,
        state: branchState ?? undefined,
      };
    }

    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const turns = turnsFromMessages(messages, WINDOW + 1);
    const prompt = String(turns.at(-1)?.prompt ?? "").slice(0, 2000);
    counters.turns++;
    const startedAt = Date.now();
    const prefetchedAnswers = pending && pending.prompt === prompt ? pending.answers : null;
    pending = null;
    const forcedTierOverride =
      pendingForcedTier && pendingForcedPrompt === prompt ? pendingForcedTier : null;
    if (pendingForcedPrompt === prompt) {
      pendingForcedTier = null;
      pendingForcedPrompt = null;
    }

    const planned = await planUserRouteTurn({
      messages,
      branchState,
      previousKey,
      offers,
      liveOffers,
      tiers,
      ctx,
      selected,
      cooling,
      threshold: config.threshold,
      frontierThreshold: config.frontierThreshold,
      timeoutMs: config.timeoutMs,
      shareWindow,
      judge,
      prefetchedAnswers,
      shouldAbortAfterJudge: () => !config.enabled || epoch !== generation,
      forcedTier: forcedTierOverride,
      stuckBaseline: stuckBaseline(ctx),
    });

    if (planned.aborted) {
      return {
        model: (base?.model ?? planned.model) as unknown,
        thinkingLevel: planned.thinking ?? selected,
      };
    }

    if (planned.outcome === "judge-failed") {
      record({
        at: Date.now(),
        latencyMs: Date.now() - startedAt,
        boundary: planned.boundary.route,
        contextTokens: planned.contextTokens,
        from: modelKey(planned.model),
        tier: null,
        outcome: "judge-failed",
        error: planned.error ?? "judge unavailable",
      });
      last = {
        difficulty: 0,
        reason: `judge unavailable: ${planned.error ?? "unknown"}`,
      };
      lastState = planned.state as RouterState;
      return {
        model: planned.model as unknown,
        thinkingLevel: planned.thinking ?? selected,
        state: planned.state as RouterState,
      };
    }

    if (planned.decided && !planned.decided.forced) counters.judged++;

    const nextModel = planned.model;
    const nextKey = planned.key;
    const nextThinking = planned.thinking;
    const nextTier = planned.tier as RouteTier;
    const nextState = planned.state as RouterState;
    const decided = planned.decided;
    const boundary = planned.boundary;
    const outcome = planned.outcome;
    const contextTokens = planned.contextTokens;
    const currentKey = modelKey(heldModel) ?? heldKey;

    if (decided && planned.warning === "too-big") {
      counters.tooBig++;
      setStatus(ctx, `router: ${Math.round(contextTokens / 1000)}k, no ${decided.tier} fits`);
      notify(
        ctx,
        `Router: staying on ${currentKey ?? "the current model"} — this session reads ${Math.round(contextTokens / 1000)}k tokens and no available ${decided.tier} model fits it`,
        "warning",
      );
    } else if (planned.warning === "cooling") {
      notify(
        ctx,
        `Router: staying on ${currentKey ?? "the current model"} — every ${decided?.tier ?? nextTier} model is cooling down after a usage limit`,
        "warning",
      );
    } else if (decided && planned.warning === "unavailable") {
      notify(
        ctx,
        `Router: this task rates ${decided.difficulty.toFixed(2)} but no ${decided.tier} model is available`,
        "warning",
      );
    }

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
      if (outcome === "forced") {
        record({ ...shared, outcome, tier: nextTier, to: nextKey, toThinking: nextThinking });
        setStatus(
          ctx,
          `router: ${short(nextKey)}@${nextThinking ?? selected} · forced ${nextTier}`,
        );
        notify(ctx, `Router: ${nextKey} — forced ${nextTier} tier for this task`);
      } else if (outcome === "escalated") {
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
      } else if (outcome === "failover") {
        record({ ...shared, outcome, to: nextKey, toThinking: nextThinking });
        setStatus(ctx, `router: ${short(nextKey)}@${nextThinking ?? selected} · usage cap`);
        notify(
          ctx,
          `Router: ${nextKey} — ${currentKey ?? "the previous model"} is cooling down after a usage limit`,
          "warning",
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
      last = {
        difficulty: decided.difficulty ?? 0,
        reason: decided.forced ? "forced" : decided.reason,
      };
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

  const setPlaybookStatus = (ctx: ExtensionContext, type: string | null) => {
    try {
      ctx?.ui?.setStatus?.(
        "playbook",
        type && type !== NO_PLAYBOOK ? `playbook: ${type}` : undefined,
      );
    } catch {
      // Decoration only.
    }
  };

  pi.on("input", (event, ctx) => {
    if (modelKey(ctx?.model ?? null) !== `${PROVIDER}/${MODEL_ID}`) return;
    const parsed = parseTierOverridePrefix(event?.text ?? "");
    if (!parsed) return;
    if (!parsed.rest) {
      notify(
        ctx,
        "Router: add a prompt after !base, !mid, or !frontier — the tier prefix alone is not sent.",
        "warning",
      );
      return { action: "handled" };
    }
    pendingForcedTier = parsed.tier;
    pendingForcedPrompt = parsed.rest.slice(0, 2000);
    return { action: "transform", text: parsed.rest };
  });

  // A new task gets one judgement: what kind of work it is (and, when the
  // router is the selected model, how hard — the same batched call route()
  // would otherwise make). The playbook rides in the system prompt for every
  // run of that task. No key, an error or an unsure answer injects nothing.
  pi.on("before_agent_start", async (event, ctx) => {
    if (event?.messageType !== "user") return;

    if (config.enabled && playbooksEnabled && !isSubagentChild) {
      const epoch = generation;
      const prompt = String(event?.prompt ?? "")
        .trim()
        .slice(0, 2000);
      if (!prompt) return;

      const forcedPending =
        pendingForcedTier !== null && pendingForcedPrompt === prompt ? pendingForcedTier : null;

      const branch = (ctx?.sessionManager?.getBranch?.() ?? []) as unknown[];
      const turns = turnsFromMessages(branch, WINDOW + 1);
      // The branch may or may not hold the prompt being started yet.
      const tail = turns[turns.length - 1];
      const history = (
        tail && tail.prompt.slice(0, 2000) === prompt && !tail.lastResponse
          ? turns.slice(0, -1)
          : turns
      ).slice(-WINDOW);
      const boundary = gateTurn({
        prompt,
        previousTurn: history[history.length - 1] ?? null,
        baseline: stuckBaseline(ctx),
      });

      if (boundary.route || playbook === undefined) {
        const routing =
          config.enabled && modelKey(ctx?.model ?? null) === `${PROVIDER}/${MODEL_ID}`;
        let type = NO_PLAYBOOK;
        try {
          const result = await judge({
            state: buildDifficultyState({
              prompt,
              window: shareWindow ? history : [],
              cwd: ctx?.cwd,
            }),
            questions: {
              task_type: buildTaskTypeQuestion(),
              ...(routing && !forcedPending ? buildDifficultyQuestions() : {}),
            },
            signal: AbortSignal.timeout(Math.min(config.timeoutMs, PLAYBOOK_TIMEOUT_MS)),
          });
          if (!config.enabled || epoch !== generation) return;
          type = taskTypeFromAnswer(result?.answers?.task_type);
          if (routing && result?.answers && !forcedPending)
            pending = { prompt, answers: result.answers };
        } catch {
          // Judge unavailable: no playbook for this task, and no retry until the next one.
        }
        if (!config.enabled || epoch !== generation) return;
        playbook = { type, text: loadPlaybook(type) };
        try {
          pi.appendEntry?.("router-playbook", { at: Date.now(), type, boundary: boundary.route });
        } catch {
          // Telemetry only.
        }
        setPlaybookStatus(ctx, playbook.text ? type : null);
      }

      // Pi 1.2+: a prompt section, not a full `systemPrompt` replacement.
      if (playbook?.text) event.systemPromptOptions.sections.router_playbook = playbook.text;
    }

    runShadowLog(event, ctx);
  });

  const noteUsageCap = (event, ctx: ExtensionContext) => {
    const messages = Array.isArray(event?.messages)
      ? event.messages
      : (ctx?.sessionManager?.getBranch?.() ?? []);
    const cap = usageCapFromMessages(messages);
    if (cap) usageCaps.record(cap.key, cap.ms, clock());
  };
  const noteTurnBaseline = (event, ctx: ExtensionContext) => {
    try {
      const messages = Array.isArray(event?.messages)
        ? event.messages
        : (ctx?.sessionManager?.getBranch?.() ?? []);
      recordCompletedTurnBaseline({ file: turnBaselinePath, cwd: ctx?.cwd, messages });
    } catch {
      // Baseline learning must never disturb a session.
    }
  };
  pi.on("agent_end", (event, ctx) => {
    noteUsageCap(event, ctx);
    noteTurnBaseline(event, ctx);
  });
  pi.on("turn_end", noteUsageCap);

  pi.on("session_start", (_event, ctx) => {
    counters.turns = 0;
    counters.judged = 0;
    counters.escalated = 0;
    counters.steppedDown = 0;
    counters.held = 0;
    counters.tooBig = 0;
    last = null;
    lastState = null;
    playbook = undefined;
    pending = null;
    pendingForcedTier = null;
    pendingForcedPrompt = null;
    resetShadowSession();
    setPlaybookStatus(ctx, null);
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

  async function previewRoute(raw: string, ctx: ExtensionContext) {
    let rest = raw.slice("preview".length).trim();
    const asJson = rest.toLowerCase().startsWith("--json");
    if (asJson) rest = rest.slice("--json".length).trim();
    const prompt = rest.slice(0, 2000);
    const selected = parseThinking(ctx?.thinkingLevel, DEFAULT_THINKING);
    const offers = await candidates(ctx);
    const tiers = modelTiers(ctx);
    const cooling = usageCaps.active(clock());
    const liveOffers = offersExceptCooling(offers, cooling);
    const stale = tiers.error ? [] : unmatchedPatterns(tiers, offers.map(modelKey).filter(Boolean));
    const ladder = routingLadder({ offers, tiers, cap: selected });
    const branch = (ctx?.sessionManager?.getBranch?.() ?? []) as unknown[];
    const history = turnsFromMessages(branch, WINDOW).slice(-WINDOW);
    const contextTokens = latestContextTokens(history);
    const fittingOffers = fitting(liveOffers, contextTokens);

    let decided: ReturnType<typeof routeFromDifficulty> | null = null;
    const override = parseTierOverridePrefix(prompt);
    const judgePrompt = override ? override.rest : prompt;
    if (override?.tier) {
      decided = {
        forced: true,
        escalate: true,
        tier: override.tier,
        difficulty: null,
        reason: "forced",
      };
    } else if (judgePrompt) {
      try {
        const result = await judge({
          state: buildDifficultyState({
            prompt: judgePrompt,
            window: shareWindow ? history : [],
            cwd: ctx?.cwd,
          }),
          questions: buildDifficultyQuestions(),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        decided = routeFromDifficulty(result?.answers, {
          threshold: config.threshold,
          frontierThreshold: config.frontierThreshold,
        });
      } catch {
        decided = null;
      }
    }

    const baseline = stuckBaseline(ctx);
    const previewPrompt = judgePrompt || prompt;
    const boundary = gateTurn({
      prompt: previewPrompt,
      previousTurn: history[history.length - 1] ?? null,
      baseline,
    });
    const stuckLine = boundary.stuckCheck ?? stuckCheckDescription(baseline);

    const unknown = !decided || (decided.escalate === null && !decided.forced);
    const tier = decided?.forced
      ? decided.tier
      : unknown
        ? null
        : decided.escalate
          ? decided.tier
          : BASE_TIER;
    const pick = tier ? chooseModelForTier(liveOffers, tier, tiers, undefined, selected) : null;
    const fits = pick ? fittingOffers.some((entry) => modelKey(entry) === pick.key) : null;
    const report = {
      difficulty: unknown ? null : decided.difficulty,
      tier,
      reason: unknown ? "difficulty unknown" : decided.reason,
      pair: pick ? { key: pick.key, thinking: pick.thinking ?? selected } : null,
      contextFit: { tokens: contextTokens, fits },
      cooledDown: cooling,
      stale,
      ladder: ladder.line,
      warnings: ladder.warnings,
      gate: { route: boundary.route, reason: boundary.reason, stuckCheck: stuckLine },
    };
    if (asJson) {
      notify(ctx, JSON.stringify(report));
      return;
    }
    const pairLine = report.pair ? `${report.pair.key} @ ${report.pair.thinking}` : "(not chosen)";
    const difficulty = decided?.forced
      ? `forced ${tier}`
      : unknown
        ? "difficulty unknown"
        : `difficulty ${decided.difficulty.toFixed(2)} — ${tier}`;
    const fitLine =
      fits === null
        ? `context ${contextTokens} tokens`
        : fits
          ? `context fits (${contextTokens} tokens)`
          : `context does not fit (${contextTokens} tokens)`;
    notify(
      ctx,
      [
        "preview",
        difficulty,
        `gate ${boundary.route ? "new task" : "continuation"} (${boundary.reason})`,
        stuckLine,
        `pair ${pairLine}`,
        fitLine,
        `cooled down ${cooling.length ? cooling.join(", ") : "(none)"}`,
        `stale ${stale.length ? stale.join(", ") : "(none)"}`,
        `ladder ${ladder.line}`,
        ...(ladder.warnings.length ? [`warning ${ladder.warnings.join("; ")}`] : []),
      ].join("\n"),
    );
  }

  pi.registerCommand(COMMAND, {
    description: "Show status, preview a prompt, or toggle judged model routing",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const action = raw.toLowerCase();
      if (action === "off" || action === "disable") {
        config.enabled = false;
        generation++;
        for (const controller of judgments) controller.abort();
        playbook = undefined;
        pending = null;
        pendingForcedTier = null;
        pendingForcedPrompt = null;
        setPlaybookStatus(ctx, null);
        setStatus(ctx, "router: off");
        notify(
          ctx,
          "Router off: no routing/playbook judgments or router sharing. /route on to re-arm.",
          "warning",
        );
        return;
      }
      if (action === "on" || action === "enable") {
        config.enabled = true;
        generation++;
        playbook = undefined;
        pending = null;
        pendingForcedTier = null;
        pendingForcedPrompt = null;
        setStatus(ctx, "router: armed");
        notify(ctx, "Router on.", "info");
        return;
      }
      if (action === "preview" || action.startsWith("preview ")) {
        await previewRoute(raw, ctx);
        return;
      }
      if (handleShadowCommand(action, ctx)) return;
      const c = counters;
      const loaded = readRouterConfig(configPath);
      const cap = parseThinking(ctx?.thinkingLevel, DEFAULT_THINKING);
      const ladder = routingLadder({
        offers: await candidates(ctx),
        tiers: loaded,
        cap,
      });
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
          `Router ${config.enabled ? "on" : "OFF"} · select ${PROVIDER}/${MODEL_ID} to route · cap is the selected reasoning level · threshold ${config.threshold}/${config.frontierThreshold} · sharing ${!config.enabled ? "none (off)" : shareWindow ? "prompt + recent turns" : "prompt only"}`,
          `models ${configPath}${loaded.error ? ` (broken: ${loaded.error}; using defaults)` : ""}`,
          `base ${lists(loaded.base)} · mid ${lists(loaded.mid)} · frontier ${lists(loaded.frontier)}`,
          `ladder ${ladder.line}`,
          ...(ladder.warnings.length ? [`warning ${ladder.warnings.join("; ")}`] : []),
          `${c.turns} turns · ${c.judged} judged · ${c.escalated} escalated · ${c.steppedDown} stepped down · ${c.held} held · ${c.tooBig} too big to switch`,
          lastState
            ? `routed to ${lastState.model ?? "?"} (${lastState.tier}) · base ${lastState.base ?? "?"}`
            : "no routing decision yet",
          lastLine,
          `playbooks ${config.enabled && playbooksEnabled ? "on" : "off"} · this task: ${playbook?.type ?? "not judged"}`,
        ].join("\n"),
      );
    },
  });
}
