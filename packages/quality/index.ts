import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatQuality, runQuality } from "./quality.mjs";
import { qualityPrompt } from "./workflow.mjs";

export default function piQualityExtension(pi: ExtensionAPI) {
  pi.registerCommand("quality", {
    description: "Clean up repository-wide code smells and add native lint prevention: /quality",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui?.notify?.("Usage: /quality", "info");
        return;
      }
      const report = await runQuality({
        cwd: ctx.cwd ?? process.cwd(),
        exec: (cmd, argv, opts) => pi.exec(cmd, argv, opts),
        signal: ctx.signal,
      });
      ctx.ui?.notify?.(formatQuality(report), report.ok ? "info" : "warning");
      if (report.root && !ctx.signal?.aborted) {
        pi.sendUserMessage(qualityPrompt(report), { deliverAs: "followUp" });
      }
    },
  });
}
