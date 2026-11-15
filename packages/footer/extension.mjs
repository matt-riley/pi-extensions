// Personal footer: workspace and actual work state first; accounting on demand.
// `piTui` is pi-tui's `{ visibleWidth, truncateToWidth }`, injected by index.ts.
import { basename } from "node:path";
import { summarizeUsage } from "./usage.mjs";
import { fmtCost, fmtTokens, workLabel, workspaceLine } from "./workspace.mjs";

export function installFooter(pi, piTui) {
  let enabled = true;
  let requestRender;
  let readStatuses;

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
        // One definition of "usage" for /usage and /footer details: these are
        // the per-model rows summarizeUsage already validated and grouped.
        const report = summarizeUsage(ctx.sessionManager?.getBranch?.() ?? []);
        const sumBy = (key) => report.models.reduce((total, row) => total + row[key], 0);
        const input = sumBy("input");
        const output = sumBy("output");
        const cost = report.models.reduce((total, row) => total + (row.cost ?? 0), 0);
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
      if (enabled) mountFooter(ctx);
      else {
        ctx.ui?.setFooter?.(undefined);
        requestRender = undefined;
        readStatuses = undefined;
      }
      ctx.ui?.notify?.(enabled ? "Personal footer on" : "Default footer restored", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (enabled) mountFooter(ctx);
  });
  pi.on("session_shutdown", () => {
    requestRender = undefined;
    readStatuses = undefined;
  });

  function mountFooter(ctx) {
    if (!ctx.ui?.setFooter) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender?.();
      readStatuses = () => footerData.getExtensionStatuses?.() ?? new Map();
      const dispose = footerData.onBranchChange?.(refresh);
      const fg = (color, text) => theme?.fg?.(color, text) ?? text;
      return {
        invalidate() {},
        dispose,
        render(width) {
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
              piTui,
            ),
          ];
        },
      };
    });
  }
}
