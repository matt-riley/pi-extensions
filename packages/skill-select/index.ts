// index.ts — pi extension: on-demand skill selection.
//
// Registers skill_select, which searches every skill in the local library and
// returns the closest matches with their SKILL.md paths. Skills kept in the
// library root (PI_SKILL_LIBRARY, default ~/.pi/agent/skill-library) are never
// listed by pi's skill discovery, so the catalog costs no context until it is
// searched. Zero runtime dependencies: node: built-ins + pi's typebox.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  discoverSkills,
  formatMatches,
  rankSkills,
  resolveRoots,
} from "./library.mjs";
import { tiebreakMatches } from "./tiebreak.mjs";
import { SKILL_SELECT_TOOLS } from "./tools.mjs";

const SELECT_TOOL = SKILL_SELECT_TOOLS[0];

export default function piSkillSelectExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: SELECT_TOOL,
    label: "skill_select",
    description:
      "Find a specialist skill by task. Searches the whole local skill library — including skills deliberately kept " +
      "out of the system prompt — and returns the closest matches with the path to each SKILL.md. Call it before " +
      "improvising a workflow a skill may already cover (for example Cloudflare, sandboxes, reviews, prompt " +
      "crafting), then read the chosen SKILL.md and follow it. Treat the returned description as a hint, not the " +
      "skill itself: the file is the source of truth.",
    promptSnippet:
      "skill_select(query, limit?): find a skill by task from the full local library — returns name, description and SKILL.md path; read the chosen file and follow it",
    promptGuidelines: [
      "Call skill_select when a task matches a specialist workflow (Cloudflare, sandboxes, code review, prompt crafting, and similar): select the skill, read its SKILL.md, then follow it. The full skill library is not listed in the system prompt.",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Plain-language description of the task, e.g. "migrate a sandbox app to @cloudflare/sandbox@next".',
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `Maximum matches to return (default ${DEFAULT_LIMIT}).`,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const roots = resolveRoots({
        cwd: ctx?.cwd ?? process.cwd(),
        home: homedir(),
        env: process.env,
      });
      const skills = await discoverSkills({ roots });
      const query = String(params?.query ?? "");
      const matches = rankSkills(skills, query, { limit: params?.limit ?? DEFAULT_LIMIT });
      const adjusted = await tiebreakMatches({ query, matches, env: process.env, signal });
      const note = adjusted.applied
        ? `TypeSafe chose "${adjusted.chosen}" over "${adjusted.over}" (lexical scores ${adjusted.chosenScore} vs ${adjusted.overScore} were too close to call).`
        : null;
      return {
        content: [
          {
            type: "text",
            text: formatMatches(adjusted.matches, { query, total: skills.length, note }),
          },
        ],
      };
    },
  });
}
