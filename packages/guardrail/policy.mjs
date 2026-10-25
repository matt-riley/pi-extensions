// policy.mjs — the deterministic half of the guardrail.
//
// No network, no model, no filesystem reads: pure text in, verdict out, so every
// rule is a test case. Verdicts combine by taking the worst across every segment of
// a command and every target of a shape, which is why `git status && rm -rf ~`
// cannot sneak through on the strength of its first half.
//
// Scope note, stated because it is a real limit: this is a guardrail, not a
// sandbox. It reads what the model wrote, not what a binary or an obfuscated
// payload does. One level of script indirection (node script.mjs, bash x.sh,
// sh -c "…") is followed; printf-decoded or fetched-at-runtime code is not.
//
// The pieces live next door, each with one job: policy-targets.mjs (what the
// target is), policy-shapes.mjs (what the command does), policy-bash.mjs (what a
// shell command really runs). This file owns the verdicts and the tool entry.

import { createHash } from "node:crypto";
import { trustedReadOnlyHint } from "../../shared/tool-annotations.mjs";

import { worst } from "./policy-verdict.mjs";
import { resolvedTarget, isEnvFile, classifyTarget } from "./policy-targets.mjs";
import { evaluateBashCommand } from "./policy-bash.mjs";

const PATH_KEYS = new Set(["path", "file_path", "filePath", "target", "filename", "destination"]);

const COMMAND_KEYS = new Set(["command", "cmd", "script", "shell"]);

function collectPaths(input, out = []) {
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && PATH_KEYS.has(key)) out.push(value);
    else if (value && typeof value === "object") collectPaths(value, out);
  }
  return out;
}

function collectCommands(input, out = []) {
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && COMMAND_KEYS.has(key)) out.push(value);
    else if (value && typeof value === "object") collectCommands(value, out);
  }
  return out;
}

function evaluateFileTool(toolName, input, { cwd, resolvePath } = {}) {
  const evidence = { targets: [], shapes: [], approvalScopes: [] };
  let verdict = "allow";
  let reason = null;

  const paths = collectPaths(input);
  if (!paths.length) return { verdict: "allow", reason: null, evidence };

  for (const target of paths) {
    const klass = classifyTarget(target, cwd, cwd, resolvePath);
    evidence.targets.push(`${target} → ${klass}`);
    let targetVerdict = "allow";
    if (klass === "secret") {
      targetVerdict = "block";
      reason = `${toolName} would modify ${target} (credential or VCS internals)`;
    } else if (klass === "system") {
      targetVerdict = "block";
      reason = `${toolName} would modify a system path: ${target}`;
    } else if (klass === "control") {
      targetVerdict = "confirm";
      reason ??= `${toolName} would modify human-owned Pi instructions/configuration`;
      evidence.approvalScopes.push(`control:overwrite:${resolvedTarget(target, cwd, resolvePath)}`);
    } else if (isEnvFile(target)) {
      // Dotenv secrets are a human decision wherever they live.
      targetVerdict = "confirm";
      reason ??= `${toolName} would overwrite ${target} (dotenv secrets)`;
    } else if (klass === "home") {
      // Anything else outside the workspace is routine: sessions work across
      // repositories, and a config file is not a secret. Measured: the rule
      // that used to judge these produced 8 of the 15 prompts in one session,
      // every one of them a legitimate config write in a sibling repo.
      targetVerdict = "allow";
    }
    if (targetVerdict !== "allow") evidence.shapes.push(`${toolName}: ${target}`);
    verdict = worst(verdict, targetVerdict);
  }
  return { verdict, reason, evidence };
}

// Fallback for tools that do not declare a trusted hint — pi's built-ins and
// other packages. An outside readOnlyHint: true is not trusted (Pi copies MCP
// hints unverified). A missing hint, or an untrusted true, keeps this name
// rule. Tools in this repo are not listed here; without their own hint they
// are inspected unless the name itself matches.
const UNANNOTATED_READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "ls",
  "find",
  "glob",
  "read_file",
  "list_dir",
  "todo_read",
  "task_list",
]);

function isReadOnlyToolName(name) {
  const n = String(name ?? "").toLowerCase();
  return (
    UNANNOTATED_READ_ONLY_TOOLS.has(n) ||
    /^(get|list|search|read|fetch|query|describe|show|recall)_/.test(n) ||
    n.startsWith("lore_")
  );
}

/**
 * The single entry point: classify one tool call before it runs.
 * Returns { verdict, reason, evidence }.
 */
export function evaluateToolCall({
  toolName,
  input,
  cwd,
  scriptTexts,
  unresolvedScripts,
  resolvePath,
  external = false,
  annotations,
} = {}) {
  const name = String(toolName ?? "");
  const lower = name.toLowerCase();
  // false from anyone is inspected. true is the fast path only for this
  // repo's tools. Anything else keeps the name rule above.
  const hinted = trustedReadOnlyHint(lower, annotations);
  const readOnly = hinted === null ? isReadOnlyToolName(lower) : hinted;

  const needsAuthorization =
    external && (annotations?.readOnlyHint !== true || annotations?.destructiveHint === true);
  const authorize = (result) => {
    if (!needsAuthorization || result.verdict === "block") return result;
    return {
      ...result,
      verdict: worst(result.verdict, "confirm"),
      reason: result.reason || "external tool effects require scoped human authorization",
      evidence: {
        ...result.evidence,
        approvalScopes: [
          ...(result.evidence?.approvalScopes ?? []),
          `tool:${name}:${JSON.stringify(input ?? {})}`,
        ],
      },
    };
  };

  // Bytes sent to an existing program can accept consent or execute code.
  // Scope approval to this job and this exact payload, not a reusable "yes".
  if (lower === "terminal_send") {
    const digest = createHash("sha256")
      .update(JSON.stringify(input ?? {}))
      .digest("hex");
    return authorize({
      verdict: "confirm",
      reason:
        "Terminal input can answer a consent prompt or run commands; approve these exact bytes for this job.",
      evidence: {
        shapes: ["interactive terminal input"],
        approvalScopes: ["terminal-input:" + String(input?.id ?? "") + ":" + digest],
      },
    });
  }

  if (readOnly && !needsAuthorization)
    return { verdict: "allow", reason: null, evidence: { shapes: [] } };

  // Command-shaped arguments run the shell rules, whatever the tool is called.
  // That covers bash, and any future extension tool that shells out — a
  // tool's name is a promise, its arguments are the evidence.
  const commands = collectCommands(input);
  if (commands.length) {
    const file = evaluateFileTool(name, input, { cwd, resolvePath });
    let { verdict, reason } = file;
    const evidence = {
      ...file.evidence,
      scriptRefs: [],
      inline: [],
      approvalScopes: file.evidence.approvalScopes ?? [],
    };
    for (const command of commands) {
      const result = evaluateBashCommand(command, {
        cwd,
        scriptTexts,
        unresolvedScripts,
        resolvePath,
      });
      verdict = worst(verdict, result.verdict);
      reason ??= result.reason;
      evidence.shapes.push(...(result.evidence.shapes ?? []));
      evidence.targets.push(...(result.evidence.targets ?? []));
      // The caller needs these to follow one level of indirection: dropping
      // them here means scripts are never read and never reclassified.
      evidence.scriptRefs.push(...(result.evidence.scriptRefs ?? []));
      evidence.inline.push(...(result.evidence.inline ?? []));
      evidence.approvalScopes.push(...(result.evidence.approvalScopes ?? []));
    }
    return authorize({ verdict, reason, evidence });
  }

  // Path-shaped arguments: secrets and system paths are refused whoever is
  // asking; anything else is routine, because sessions work across repos.
  // because nagging about every read of a home-directory path would be noise.
  return authorize(evaluateFileTool(name, input, { cwd, resolvePath }));
}
