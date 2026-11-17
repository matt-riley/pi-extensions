// rerun.mjs — rerun_findings: keep only the adversary findings whose command
// still fails when the parent runs it. The adversary's pasted output is never
// trusted; each command runs again through the normal bash tool, so guardrail
// and the other tool hooks see it like any command the model typed.

import { stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { LOCAL_DESTRUCTIVE } from "../../shared/tool-annotations.mjs";

const FENCE = /```json\s*([\s\S]*?)```\s*$/;
const MAX_FINDINGS = 20;
const OUTPUT_LINES = 30;

export const RERUN_CAVEAT =
  "A non-zero exit proves the command fails, not that the failure breaks the intent: judge each kept finding against the intent before reporting it.";

/** Findings from the trailing ```json block of an adversary's final text. */
export function parseFindings(text) {
  const m = FENCE.exec(String(text ?? "").trim());
  if (!m) return { findings: [], error: "no trailing json block" };
  let parsed;
  try {
    parsed = JSON.parse(m[1]);
  } catch (error) {
    return { findings: [], error: `bad json: ${error instanceof Error ? error.message : error}` };
  }
  if (!Array.isArray(parsed?.findings)) return { findings: [], error: "findings is not an array" };
  return {
    findings: parsed.findings.filter(
      (f) => typeof f?.title === "string" && typeof f?.command === "string" && f.command.trim(),
    ),
  };
}

const tail = (text, n) =>
  String(text ?? "")
    .trimEnd()
    .split("\n")
    .slice(-n)
    .join("\n");

/**
 * @param {{source:string, cwd:string, findings:object[]}[]} reports
 * @param {(cwd:string, command:string) => Promise<{code:number|null, output:string, reason?:string}>} run
 *   `code: null` means the command did not run to an exit (blocked, timed out, aborted).
 */
export async function rerun(reports, run, { max = MAX_FINDINGS, signal } = {}) {
  const kept = [];
  const dropped = [];
  let runs = 0;
  for (const { source, cwd, findings } of reports) {
    for (const f of findings) {
      if (runs >= max) {
        dropped.push({ source, title: f.title, reason: `over the ${max}-finding cap; not run` });
        continue;
      }
      signal?.throwIfAborted();
      runs += 1;
      const r = await run(cwd, f.command);
      if (typeof r.code !== "number")
        dropped.push({ source, title: f.title, reason: r.reason || "did not run to an exit" });
      else if (r.code === 0) dropped.push({ source, title: f.title, reason: "command exited 0" });
      else kept.push({ source, cwd, ...f, exit: r.code, output: tail(r.output, OUTPUT_LINES) });
    }
  }
  return { kept: mergeByCommand(kept), dropped };
}

/** The same command from two adversaries is one finding with two sources. */
function mergeByCommand(items) {
  const by = new Map();
  for (const item of items) {
    const prev = by.get(item.command);
    if (prev) prev.sources.push(item.source);
    else {
      const { source, ...rest } = item;
      by.set(item.command, { ...rest, sources: [source] });
    }
  }
  return [...by.values()];
}

function formatRerun({ kept, dropped, errors = [] }) {
  const lines = [`kept: ${kept.length} finding(s) whose command still fails on rerun`];
  for (const k of kept) {
    lines.push(
      "",
      `## ${k.title}`,
      `sources: ${k.sources.join(", ")}`,
      `command (in ${k.cwd}): ${k.command}`,
      `exit: ${k.exit}`,
    );
    if (typeof k.required === "string" && k.required) lines.push(`intent requires: ${k.required}`);
    lines.push("output (rerun, last lines):", k.output || "(no output)");
  }
  if (!kept.length) lines.push("no verified findings");
  lines.push("", `dropped: ${dropped.length}`);
  for (const d of dropped) lines.push(`- ${d.source}: ${d.title}: ${d.reason}`);
  for (const e of errors) lines.push(`- ${e.source}: no findings read: ${e.error}`);
  lines.push("", RERUN_CAVEAT);
  return lines.join("\n");
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function installRerun(pi) {
  pi.registerTool({
    name: "rerun_findings",
    label: "rerun_findings",
    exposure: "deferred",
    annotations: LOCAL_DESTRUCTIVE,
    reachesTools: () => ["bash"],
    description:
      "Rerun each finding command from adversary reports and keep only the ones that still exit non-zero. " +
      "Pass each adversary's final text (ending in its ```json findings block) and the worktree it ran in. " +
      "Every command runs again through the normal bash tool, from that directory, so guardrail sees it; " +
      "the adversary's pasted output is ignored. A kept finding proves a failure, not that it breaks the intent.",
    promptSnippet:
      "rerun_findings(reports, timeout?): rerun adversary repro commands; keep only those that still fail",
    parameters: Type.Object({
      reports: Type.Array(
        Type.Object({
          source: Type.String({ description: "Who reported it, e.g. the seat's model" }),
          cwd: Type.String({ description: "Absolute path of the worktree the adversary ran in" }),
          text: Type.String({ description: "The adversary's final text, unedited" }),
        }),
        { minItems: 1, maxItems: 6 },
      ),
      timeout: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 120, description: "Seconds per command (default 60)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const timeout = params?.timeout ?? 60;
      const reports = [];
      const errors = [];
      for (const report of Array.isArray(params?.reports) ? params.reports : []) {
        const source = String(report?.source ?? "").trim() || "unnamed";
        const cwd = String(report?.cwd ?? "");
        const isDir = path.isAbsolute(cwd) && (await stat(cwd).catch(() => null))?.isDirectory();
        if (!isDir) {
          errors.push({ source, error: `cwd is not an absolute directory: ${cwd || "(empty)"}` });
          continue;
        }
        const { findings, error } = parseFindings(report?.text);
        if (error) errors.push({ source, error });
        reports.push({ source, cwd, findings });
      }
      const run = async (cwd, command) => {
        const execution = await ctx.executeTool(
          "bash",
          { command: `cd ${shellQuote(cwd)} && ${command}`, timeout },
          { signal },
        );
        const result = execution?.result?.structuredContent;
        if (typeof result?.exit_code !== "number") {
          const text = (execution?.result?.content ?? [])
            .map((part) => part?.text ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .slice(0, 160);
          return {
            code: null,
            output: "",
            reason: `did not run to an exit: ${text || "no result"}`,
          };
        }
        return { code: result.exit_code, output: String(result.output ?? "") };
      };
      const outcome = await rerun(reports, run, { signal });
      const text = formatRerun({ ...outcome, errors });
      return { content: [{ type: "text", text }], details: { ...outcome, errors } };
    },
  });
}
