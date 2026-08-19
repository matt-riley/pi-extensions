// widget.mjs — above-editor status strip. Display only.

import { formatTokens } from "./result.mjs";

export function formatWidgetLines(entries, queuedCount) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return undefined;

  const lines = ["● Agents"];
  const queued = Number(queuedCount) || 0;
  list.forEach((entry, index) => {
    const isLast = index === list.length - 1 && queued === 0;
    const branch = isLast ? "└─" : "├─";
    const type = entry.type || "agent";
    const description = entry.description || "task";
    if (entry.status === "queued") {
      lines.push(`${branch} ⠹ ${type}  ${description} · queued`);
      return;
    }
    const turns = entry.maxTurns != null ? `↻${entry.turns ?? 0}≤${entry.maxTurns}` : `↻${entry.turns ?? 0}`;
    const uses = entry.toolUses ?? 0;
    const tools = `${uses} tool${uses === 1 ? "" : "s"}`;
    const tok = formatTokens(entry.tokens ?? 0);
    lines.push(`${branch} ⠹ ${type}  ${description} · ${turns} · ${tools} · ${tok}`);
    if (entry.lastTool) lines.push(`│    ⎿  ${entry.lastTool}`);
  });
  if (queued > 0) lines.push(`└─ ${queued} queued`);
  return lines;
}

export function formatLastTool(event) {
  if (!event) return "";
  const name = event.toolName || "tool";
  const input = event.args && typeof event.args === "object" ? event.args : event.input;
  if (!input || typeof input !== "object") return name;
  if (name === "bash" && typeof input.command === "string") {
    const cmd = input.command.replace(/\s+/g, " ").trim();
    return `$ ${cmd.length > 40 ? `${cmd.slice(0, 39)}…` : cmd}`;
  }
  const file = input.path || input.file_path;
  if ((name === "read" || name === "edit" || name === "write") && typeof file === "string") {
    return `${name} ${file}`;
  }
  if (name === "grep" && typeof input.pattern === "string") {
    return `grep ${input.pattern}`;
  }
  return name;
}
