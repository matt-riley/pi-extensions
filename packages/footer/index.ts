// Personal footer: workspace and actual work state first; accounting on demand.
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fmtCost, fmtTokens, workLabel, workspaceLine } from "./workspace.mjs";

interface BranchEntry {
  type?: string;
  message?: {
    role?: string;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
  };
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let requestRender: (() => void) | undefined;
  let readStatuses: (() => ReadonlyMap<string, string>) | undefined;

  const refresh = () => {
    if (enabled) requestRender?.();
  };
  for (const event of [
    "model_select",
    "thinking_level_select",
    "message_end",
    "session_compact",
    "agent_start",
    "agent_end",
    "agent_settled",
    "session_tree",
  ])
    pi.on(event, refresh);

  pi.registerCommand("footer", {
    description: "Toggle the personal footer, or /footer details for usage and extension status",
    handler: async (args, ctx) => {
      if (args.trim() === "details") {
        let input = 0,
          output = 0,
          cost = 0;
        for (const entry of (ctx.sessionManager?.getBranch?.() ?? []) as BranchEntry[]) {
          if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
          input += entry.message.usage?.input ?? 0;
          output += entry.message.usage?.output ?? 0;
          cost += entry.message.usage?.cost?.total ?? 0;
        }
        const statuses = Array.from(readStatuses?.().values() ?? []).join(" · ");
        ctx.ui?.notify?.(
          "Usage: ↑" +
            fmtTokens(input) +
            " ↓" +
            fmtTokens(output) +
            " " +
            fmtCost(cost) +
            (statuses ? "\n" + statuses : "") +
            "\n/session for native session details.",
          "info",
        );
        return;
      }
      enabled = !enabled;
      if (enabled) installFooter(ctx);
      else {
        ctx.ui?.setFooter?.(undefined);
        requestRender = undefined;
        readStatuses = undefined;
      }
      ctx.ui?.notify?.(enabled ? "Personal footer on" : "Default footer restored", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (enabled) installFooter(ctx);
  });
  pi.on("session_shutdown", () => {
    requestRender = undefined;
    readStatuses = undefined;
  });

  function installFooter(ctx: ExtensionContext) {
    if (!ctx.ui?.setFooter) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender?.();
      readStatuses = () => footerData.getExtensionStatuses?.() ?? new Map();
      const dispose = footerData.onBranchChange?.(refresh);
      const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;
      return {
        invalidate() {},
        dispose,
        render(width: number): string[] {
          const statuses = footerData.getExtensionStatuses?.() ?? new Map();
          const model = ctx.model;
          return [
            workspaceLine(
              {
                project: basename(ctx.cwd || process.cwd()),
                branch: footerData.getGitBranch?.(),
                state: workLabel(ctx.isIdle ? !ctx.isIdle() : false, statuses),
                model: model?.id ? (model.provider ? model.provider + "/" : "") + model.id : "",
                level: ctx.thinkingLevel,
                percent: ctx.getContextUsage?.()?.percent,
                savedDraft: statuses.has("workbench"),
              },
              width,
              fg,
            ),
          ];
        },
      };
    });
  }
}
