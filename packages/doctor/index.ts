// index.ts — pi extension: doctor.
//
// `/doctor` and the deferred `doctor_report` tool answer "is my Pi set up the way
// I think it is?": Pi and Node versions, the tool registry (duplicate names,
// deferred tools nothing can reach), and whether router.json and the agent files
// parse. Read-only: it changes no config, deletes no cache and checks no keys.
// A part it cannot see is reported as unknown, never as a failure.

import path from "node:path";

import { VERSION, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { LOCAL_READ } from "../../shared/tool-annotations.mjs";
import { routerConfigPath } from "../router/config.mjs";
import { agentFileChecks, routerState } from "./files.mjs";
import { collectReport, formatReport } from "./report.mjs";

export default function piDoctorExtension(pi: ExtensionAPI) {
  const report = (ctx: ExtensionContext) =>
    collectReport({
      piVersion: VERSION,
      nodeVersion: process.version,
      tools: () => pi.getAllTools(),
      activeTools: () => pi.getActiveTools(),
      router: () => routerState(routerConfigPath()),
      agentFiles: () =>
        agentFileChecks(
          [
            path.join(getAgentDir(), "agents"),
            path.join(ctx.cwd ?? process.cwd(), ".pi", "agents"),
          ],
          { parseFrontmatter },
        ),
    });

  pi.registerCommand("doctor", {
    description: "Read-only health report: versions, tool registry, router.json, agent files",
    handler: async (_args, ctx) => {
      const result = report(ctx);
      ctx.ui?.notify?.(formatReport(result), result.problems.length > 0 ? "warning" : "info");
    },
  });

  pi.registerTool({
    name: "doctor_report",
    label: "doctor_report",
    exposure: "deferred",
    annotations: LOCAL_READ,
    description:
      "Read-only health report of this Pi setup: Pi and Node versions, the tool registry " +
      "(duplicate names, deferred tools nothing can reach), and whether router.json and the agent " +
      "files parse. Use it when a tool is missing, doubled or unreachable, or routing or a subagent " +
      "misbehaves. It changes nothing and checks no keys; a part it cannot see is reported as unknown.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = report(ctx);
      return {
        content: [{ type: "text", text: formatReport(result) }],
        structuredContent: result,
      };
    },
  });
}
