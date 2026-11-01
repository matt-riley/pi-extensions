import { fmtCost, fmtTokens } from "./workspace.mjs";

const valid = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Recompute from the active branch so reloads and tree navigation need no state. */
export function summarizeUsage(entries = []) {
  const models = new Map();
  const calls = new Map();
  let requests = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant") continue;
    requests++;
    const model = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
    const row = models.get(model) ?? {
      model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      missingTokenFields: 0,
      cost: null,
      missingCosts: 0,
      zeroCosts: 0,
    };
    row.requests++;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      if (valid(message.usage?.[key])) row[key] += message.usage[key];
      else row.missingTokenFields++;
    }
    const cost = message.usage?.cost?.total;
    if (valid(cost)) {
      row.cost = (row.cost ?? 0) + cost;
      if (cost === 0) row.zeroCosts++;
    } else row.missingCosts++;
    models.set(model, row);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === "toolCall" && block.id && block.name)
        calls.set(block.id, { name: block.name, status: "pending" });
    }
  }
  for (const entry of entries) {
    const message = entry.type === "message" ? entry.message : null;
    if (message?.role !== "toolResult") continue;
    const call = calls.get(message.toolCallId);
    if (call) call.status = message.isError === true ? "failed" : "completed";
  }
  const tools = new Map();
  for (const { name, status } of calls.values()) {
    const row = tools.get(name) ?? { name, calls: 0, failed: 0, pending: 0 };
    row.calls++;
    if (status === "failed") row.failed++;
    if (status === "pending") row.pending++;
    tools.set(name, row);
  }
  return {
    requests,
    models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)),
    tools: [...tools.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function formatUsage(report) {
  const lines = [`Active branch usage — ${report.requests} assistant requests`];
  if (!report.requests) lines.push("No assistant requests recorded on this branch.");
  for (const row of report.models) {
    lines.push(
      `${row.model}: ${row.requests} requests · input ${fmtTokens(row.input)} · output ${fmtTokens(row.output)} · cache read ${fmtTokens(row.cacheRead)} · cache write ${fmtTokens(row.cacheWrite)}`,
      `  Reported cost: ${row.cost === null ? "unknown" : fmtCost(row.cost)} · missing/invalid costs ${row.missingCosts} · zero-cost records ${row.zeroCosts} · missing/invalid token fields ${row.missingTokenFields}`,
    );
  }
  if (report.tools.length) {
    lines.push("Tools (outer session calls):");
    for (const row of report.tools)
      lines.push(
        `  ${row.name}: ${row.calls} calls · ${row.failed} failed · ${row.pending} pending`,
      );
  }
  lines.push(
    "Costs are provider/configuration estimates; missing and zero costs do not prove free usage.",
    "This branch only; child-session usage, hidden nested calls and request latency are not measured here.",
  );
  return lines.join("\n");
}

export function installUsage(pi) {
  pi.registerCommand("usage", {
    description: "Show active-branch model tokens, cache usage, reported costs and tool failures",
    handler: (args, ctx) => {
      if (args.trim() && args.trim() !== "--json") {
        ctx.ui?.notify?.("Usage: /usage [--json]", "warning");
        return;
      }
      if (!ctx.sessionManager?.getBranch) {
        ctx.ui?.notify?.(
          "Usage unavailable: this host exposes no active session branch.",
          "warning",
        );
        return;
      }
      const report = summarizeUsage(ctx.sessionManager.getBranch());
      pi.sendMessage(
        {
          customType: "usage-report",
          content: args.trim() === "--json" ? JSON.stringify(report, null, 2) : formatUsage(report),
          display: true,
        },
        { triggerTurn: false, deliverAs: "followUp" },
      );
    },
  });
}
