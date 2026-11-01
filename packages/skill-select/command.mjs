import { homedir } from "node:os";
import { discoverSkills, rankSkills, formatMatches, resolveRoots } from "./library.mjs";

/** Human discovery stays local; choosing a result prepares a prompt for review. */
export function installSkillSearch(pi, { discover = discoverSkills, env = process.env } = {}) {
  pi.registerCommand("skill-search", {
    description: "Search local skills by task; choose one to prepare a prompt (no model call)",
    handler: async (args, ctx) => {
      const query = args.trim();
      const skills = await discover({
        roots: resolveRoots({ cwd: ctx.cwd ?? process.cwd(), home: homedir(), env }),
      });
      const matches = rankSkills(skills, query);
      if (
        !matches.length ||
        ctx.mode !== "tui" ||
        ctx.hasUI === false ||
        !ctx.ui?.select ||
        !ctx.ui?.getEditorText ||
        !ctx.ui?.setEditorText
      ) {
        pi.sendMessage(
          {
            customType: "skill-search",
            content: formatMatches(matches, { query, total: skills.length }),
            display: true,
          },
          { triggerTurn: false, deliverAs: "followUp" },
        );
        return;
      }
      const options = matches.map(
        (match) => `${match.name} — ${match.description} (${match.path})`,
      );
      const choice = await ctx.ui.select("Local skills — choose to prepare a prompt", options);
      const match = matches[options.indexOf(choice)];
      if (!match) return;
      // Read the draft after the dialog: another UI action may have changed it.
      const draft = ctx.ui.getEditorText();
      const instruction = `Read the skill at ${JSON.stringify(match.path)} and follow it${query ? ` for this task: ${query}` : "."}`;
      ctx.ui.setEditorText(draft ? `${draft}\n\n${instruction}` : instruction);
      ctx.ui.notify?.("Skill prompt prepared — press Enter to send.", "info");
    },
  });
}
