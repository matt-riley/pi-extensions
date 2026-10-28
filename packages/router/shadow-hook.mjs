// shadow-hook.mjs — wire shadow logging into the router extension entry.

import path from "node:path";

import { readRouterConfig, writeShadowLogFlag } from "./config.mjs";
import { modelKey } from "./model-battery.mjs";
import { evaluateShadowTurn } from "./shadow-eval.mjs";
import {
  appendShadowLine,
  formatShadowReport,
  readShadowLines,
  summarizeShadowLog,
} from "./shadow-log.mjs";

export function createShadowLogger({
  configPath,
  config,
  shareWindow,
  isSubagentChild,
  virtualModelKey,
  parseThinking,
  defaultThinking,
  candidates,
  modelTiers,
  usageCaps,
  clock,
  judge,
  notify,
}) {
  let shadowOverride = null;
  const shadowStates = new Map();
  const shadowLogFile = () => path.join(path.dirname(configPath), "router-shadow.jsonl");

  function shadowEnabled() {
    const loaded = readRouterConfig(configPath);
    return shadowOverride ?? loaded.shadowLog ?? false;
  }

  function sessionKey(ctx) {
    const id = ctx?.sessionId ?? ctx?.session?.id;
    return typeof id === "string" && id.trim() ? id.trim() : "local";
  }

  async function runShadowLog(event, ctx) {
    if (!shadowEnabled() || isSubagentChild) return;
    if (event?.messageType !== "user") return;
    if (modelKey(ctx?.model ?? null) === virtualModelKey) return;
    const prompt = String(event?.prompt ?? "")
      .trim()
      .slice(0, 2000);
    if (!prompt) return;

    const actualKey = modelKey(ctx?.model ?? null);
    if (!actualKey) return;

    const selected = parseThinking(ctx?.thinkingLevel, defaultThinking);
    const offers = await candidates(ctx);
    const tiers = modelTiers(ctx);
    const cooling = usageCaps.active(clock());
    const branch = ctx?.sessionManager?.getBranch?.() ?? [];
    const sid = sessionKey(ctx);
    const state = shadowStates.get(sid) ?? null;

    const { entry, nextState } = await evaluateShadowTurn({
      prompt,
      branch,
      shadowState: state,
      actualKey,
      actualThinking: selected,
      sessionId: sid,
      selected,
      offers,
      tiers,
      ctx,
      cooling,
      threshold: config.threshold,
      frontierThreshold: config.frontierThreshold,
      timeoutMs: config.timeoutMs,
      shareWindow,
      judge,
      prefetched: null,
      clock,
    });
    shadowStates.set(sid, nextState);
    appendShadowLine(shadowLogFile(), entry);
  }

  function handleShadowCommand(action, ctx) {
    if (action === "shadow on" || action === "shadow enable") {
      shadowOverride = true;
      try {
        writeShadowLogFlag(configPath, true);
      } catch {
        // A read-only config must not block the in-session toggle.
      }
      notify(ctx, "Router shadow log on.", "info");
      return true;
    }
    if (action === "shadow off" || action === "shadow disable") {
      shadowOverride = false;
      try {
        writeShadowLogFlag(configPath, false);
      } catch {
        // A read-only config must not block the in-session toggle.
      }
      notify(ctx, "Router shadow log off.", "info");
      return true;
    }
    if (action === "shadow report") {
      const summary = summarizeShadowLog(readShadowLines(shadowLogFile()));
      notify(ctx, formatShadowReport(summary));
      return true;
    }
    return false;
  }

  function resetShadowSession() {
    shadowStates.clear();
  }

  return { runShadowLog, handleShadowCommand, resetShadowSession };
}
