// /footer — always-on status footer.
//
// Replaces pi's built-in footer with one that shows, left to right:
//   🤖 model (provider/id) · 🧠 thinking level badge · extension statuses ·
//   ↑input ↓output tokens · $cost · git branch
// Glyphs are Nerd Font v3 icons (see ICONS in format.mjs) — requires a
// Nerd Font in the terminal. Re-renders when the model, thinking level, or
// an assistant message changes. Toggle with /footer.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { composeLine, fmtCost, fmtTokens, ICONS, thinkColor } from "./format.mjs";

interface BranchEntry {
  type?: string;
  message?: {
    role?: string;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
  };
}

interface Seg {
  text: string;
  color?: string;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let requestRender: (() => void) | undefined;

  const refresh = () => {
    if (enabled) requestRender?.();
  };

  pi.on("model_select", refresh);
  pi.on("thinking_level_select", refresh);
  pi.on("message_end", refresh);

  pi.registerCommand("footer", {
    description: "Toggle the custom status footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) installFooter(ctx);
      else ctx.ui?.setFooter?.(undefined);
      ctx.ui?.notify?.(enabled ? "Custom footer on" : "Default footer restored", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (enabled) installFooter(ctx);
  });

  function installFooter(ctx: ExtensionContext) {
    if (!ctx.ui?.setFooter) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender?.();
      const dispose = footerData.onBranchChange?.(() => tui.requestRender?.());
      const fg = (color: string, text: string) => theme?.fg?.(color, text) ?? text;

      return {
        invalidate() {},
        dispose,
        render(width: number): string[] {
          const model = ctx.model;
          const level = ctx.thinkingLevel ?? "off";

          let input = 0;
          let output = 0;
          let cost = 0;
          for (const entry of (ctx.sessionManager?.getBranch?.() ?? []) as BranchEntry[]) {
            if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
            const usage = entry.message.usage;
            if (!usage) continue;
            input += usage.input ?? 0;
            output += usage.output ?? 0;
            cost += usage.cost?.total ?? 0;
          }

          const left: Seg[] = [];
          if (model?.id) {
            left.push({
              text: `${ICONS.robot} ${model.provider ? `${model.provider}/${model.id}` : model.id}`,
              color: "accent",
            });
          }
          if (left.length) left.push({ text: ` ${ICONS.brain} ~${level}`, color: thinkColor(level) });

          const right: Seg[] = [];
          const statuses = footerData.getExtensionStatuses?.();
          if (statuses?.size) {
            right.push({ text: ` ${Array.from(statuses.values()).join(" · ")}`, color: "dim" });
          }
          right.push({ text: ` ${ICONS.arrowUp} ${fmtTokens(input)}`, color: "sky" });
          right.push({ text: ` ${ICONS.arrowDown} ${fmtTokens(output)}`, color: "peach" });
          right.push({ text: ` ${ICONS.dollar} ${fmtCost(cost)}`, color: "green" });
          const branch = footerData.getGitBranch?.();
          if (branch) right.push({ text: ` ${ICONS.gitBranch} ${branch}`, color: "teal" });

          return [composeLine(left, right, width, fg)];
        },
      };
    });
  }
}
