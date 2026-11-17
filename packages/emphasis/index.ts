// index.ts — pi extension: emphasis.
//
// Replies you can scan: `[[Done]]`, `[[Failed]]` and `[[Needs you]]` become
// colored pills with icons, known headings and lead labels take an icon, and
// bold text, arrows and tree lines take theme colors. Display only: the stored
// message, copied text and exports keep the original Markdown.
//
// The rules that teach the agent to write pills travel with the renderer: a
// `reply_style` prompt section is added only in the terminal interface, the one
// mode that draws them. `ctx.hasUI` is also true in RPC mode, so this checks
// `ctx.mode`. No model call, no network.
//
// Tied to the collection (marks.mjs): a checked-claim pill written over edits
// done-gate saw no check cover is drawn as a question, and an inline code path
// missing under the cwd is marked. Extension messages and summaries are drawn
// too, without those marks.
//
// Adapted from pi-emphasis by John Lindquist (MIT); see emphasis.mjs.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { flagOff } from "../../shared/env-flag.mjs";
import { createPalette, decorate, replyGuidance } from "./emphasis.mjs";
import { createStaleLookup, replyMarks } from "./marks.mjs";

/** `PI_EMPHASIS=0` turns drawing and guidance off. */
const ENABLED_ENV = "PI_EMPHASIS";
/** `PI_EMPHASIS_GUIDANCE=0` keeps the drawing and adds no prompt section. */
const GUIDANCE_ENV = "PI_EMPHASIS_GUIDANCE";
/** `PI_EMPHASIS_EVIDENCE=0` draws claim pills as written, whatever done-gate saw. */
const EVIDENCE_ENV = "PI_EMPHASIS_EVIDENCE";
/** `PI_EMPHASIS_PATHS=0` checks no paths. */
const PATHS_ENV = "PI_EMPHASIS_PATHS";
const SECTION = "reply_style";
/** Surfaces drawn. pi before 1.5.1 ignores the option and offers only user, assistant and thinking. */
const SURFACES = ["assistant", "custom", "summary"];

export default function piEmphasisExtension(pi: ExtensionAPI) {
  let ui: ExtensionContext["ui"] | undefined;
  let cwd: string | undefined;
  let built: { theme: unknown; palette: any } | undefined;
  const stale = createStaleLookup();

  pi.on("session_start", async (_event, ctx) => {
    ui = ctx.mode === "tui" ? ctx.ui : undefined;
    cwd = ctx.cwd ?? process.cwd();
    built = undefined;
  });

  pi.on("before_agent_start", async (event) => {
    const sections = event.systemPromptOptions.sections;
    if (ui && !flagOff(process.env[ENABLED_ENV]) && !flagOff(process.env[GUIDANCE_ENV])) {
      sections[SECTION] = replyGuidance();
    } else {
      delete sections[SECTION];
    }
  });

  pi.registerMarkdownTransformer(
    (markdown, context) => {
      const theme = ui?.theme;
      if (
        !theme?.fg ||
        !SURFACES.includes(context.messageType) ||
        flagOff(process.env[ENABLED_ENV])
      ) {
        return markdown;
      }
      // Rebuilt when the theme object changes, so /theme recolors new output.
      if (built?.theme !== theme) {
        built = {
          theme,
          palette: createPalette(theme, {
            boldColor: process.env.PI_EMPHASIS_COLOR || "mdLink",
            roundCaps: !flagOff(process.env.PI_EMPHASIS_ROUND_CAPS),
            icons: !flagOff(process.env.PI_EMPHASIS_PILL_ICONS),
          }),
        };
      }
      // Only the agent's own replies make claims about this run and this tree.
      const marks =
        context.messageType === "assistant"
          ? replyMarks(markdown, context, {
              cwd,
              stale,
              evidence: !flagOff(process.env[EVIDENCE_ENV]),
              paths: !flagOff(process.env[PATHS_ENV]),
            })
          : {};
      return decorate(markdown, built.palette, marks);
    },
    { messageTypes: SURFACES },
  );
}
