// systemone-session.mjs — the async store that carries Pi's context and token
// usage into every handler, and the binding that puts them there. Split out so
// both the transport and the request entry can reach one store without a cycle.

import { AsyncLocalStorage } from "node:async_hooks";
import { isPlainObject } from "./systemone-request.mjs";

/** The extension context for the in-flight Pi handler, plus classify usage. */
const systemOneAls = new AsyncLocalStorage();

function emptySessionUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addSessionUsage(total, usage) {
  total.input += usage.input || 0;
  total.output += usage.output || 0;
  total.cacheRead += usage.cacheRead || 0;
  total.cacheWrite += usage.cacheWrite || 0;
  total.totalTokens += usage.totalTokens || 0;
  const cost = isPlainObject(usage.cost) ? usage.cost : {};
  total.cost.input += cost.input || 0;
  total.cost.output += cost.output || 0;
  total.cost.cacheRead += cost.cacheRead || 0;
  total.cost.cacheWrite += cost.cacheWrite || 0;
  total.cost.total += cost.total || 0;
}

/**
 * The store runWithSystemOneContext sets, or undefined outside a bound handler.
 * Callers read context and Pi from here; the store itself stays private.
 */
export function sessionStore() {
  return systemOneAls.getStore();
}

export function recordSessionUsage(usage) {
  const bucket = systemOneAls.getStore()?.usage;
  if (!bucket || !isPlainObject(usage) || typeof usage.input !== "number") return;
  bucket.push(usage);
}

function takeSessionUsage() {
  const bucket = systemOneAls.getStore()?.usage;
  if (!bucket?.length) return undefined;
  const total = emptySessionUsage();
  for (const usage of bucket) addSessionUsage(total, usage);
  bucket.length = 0;
  return total;
}

function combineUsage(left, right) {
  if (!isPlainObject(left)) return right;
  if (!isPlainObject(right)) return left;
  const total = emptySessionUsage();
  addSessionUsage(total, left);
  addSessionUsage(total, right);
  return total;
}

/**
 * Pi's tool_result handler replaces `event.usage` with whatever the handler
 * returns. Jev's tokens have to be added to the tool's own usage, including
 * when the handler returns nothing — otherwise a nudge drops the failed
 * call's cost. Tool execute has the same trap when `result.usage` is already
 * set.
 */
function withSessionUsage(result, priorUsage) {
  const jev = takeSessionUsage();
  if (!jev) return result;
  const combined = combineUsage(priorUsage, jev);
  if (result == null || typeof result !== "object" || Array.isArray(result)) {
    return { usage: combined };
  }
  const own = isPlainObject(result.usage) && result.usage !== priorUsage ? result.usage : undefined;
  return { ...result, usage: own ? combineUsage(combined, own) : combined };
}

/**
 * Run `fn` where askSystemOne can see `ctx.modelRegistry`. Nested calls share
 * the outer usage bucket. `attachUsage` copies Pi-shaped classify usage onto a
 * returned tool result; compaction drafts use `compactionUsage` instead,
 * because that usage belongs on the entry Pi actually records.
 */
function runWithSystemOneContext(ctx, fn, { attachUsage = false, priorUsage, pi } = {}) {
  const parent = systemOneAls.getStore();
  const usage = parent?.usage ?? [];
  return systemOneAls.run({ ctx: ctx ?? parent?.ctx, pi: pi ?? parent?.pi, usage }, async () => {
    const result = await fn();
    if (!attachUsage || parent?.usage) return result;
    return withSessionUsage(result, priorUsage);
  });
}

/** Put this turn's classify usage on a compaction draft, when there is any. */
export function compactionUsage(entry) {
  const usage = takeSessionUsage();
  if (!usage || !entry || typeof entry !== "object" || Array.isArray(entry) || entry.usage) {
    return entry;
  }
  return { ...entry, usage };
}

// One wrapper per host object. Every extension that asks Jev calls this, so an
// unguarded second call would nest the async context once per package.
const boundHosts = new WeakSet();

/**
 * Thread the Pi context into every handler this extension registers.
 *
 * Called before the extension's own `on` / `registerTool` / `registerCommand`
 * / `registerVirtualModel`. The .mjs judges keep calling `askSystemOne()`
 * with no context argument; the registry arrives through the async store, so
 * it never becomes part of a memo key.
 */
export function bindSystemOne(pi) {
  if (!pi || typeof pi !== "object" || boundHosts.has(pi)) return pi;
  boundHosts.add(pi);
  if (typeof pi.on === "function") {
    const originalOn = pi.on.bind(pi);
    pi.on = (event, handler) =>
      originalOn(event, (payload, ctx) =>
        runWithSystemOneContext(ctx, () => handler(payload, ctx), {
          attachUsage: event === "tool_result",
          priorUsage: event === "tool_result" ? payload?.usage : undefined,
          pi,
        }),
      );
  }
  if (typeof pi.registerTool === "function") {
    const originalRegisterTool = pi.registerTool.bind(pi);
    pi.registerTool = (def) =>
      originalRegisterTool({
        ...def,
        execute:
          typeof def?.execute === "function"
            ? (...args) =>
                runWithSystemOneContext(args[4], () => def.execute(...args), {
                  attachUsage: true,
                  pi,
                })
            : def?.execute,
      });
  }
  if (typeof pi.registerCommand === "function") {
    const originalRegisterCommand = pi.registerCommand.bind(pi);
    pi.registerCommand = (name, def) =>
      originalRegisterCommand(
        name,
        def && typeof def.handler === "function"
          ? {
              ...def,
              handler: (...args) =>
                runWithSystemOneContext(args[1], () => def.handler(...args), { pi }),
            }
          : def,
      );
  }
  if (typeof pi.registerVirtualModel === "function") {
    const originalRegisterVirtualModel = pi.registerVirtualModel.bind(pi);
    pi.registerVirtualModel = (def) =>
      originalRegisterVirtualModel(
        def && typeof def.route === "function"
          ? {
              ...def,
              route: (request, ctx) =>
                runWithSystemOneContext(ctx, () => def.route(request, ctx), { pi }),
            }
          : def,
      );
  }
  return pi;
}
