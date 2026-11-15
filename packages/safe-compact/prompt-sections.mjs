// prompt-sections.mjs — what the request's prompt is made of, as estimates.
//
// Extensions add system-prompt sections (plan mode, the router playbook, the
// orchestrator brief) and tools add declarations; the context counter only
// reports one total. These helpers size each piece so view_context can say
// where the tokens went. Everything here is an estimate, from the same
// estimator the handoff budget uses, and none of it is ever sent to the model.

import { estimateTokens } from "./segment.mjs";

const NOT_SHOWN = new Set(["deferred", "hidden"]);
const TOP_SECTIONS = 3;

/** Non-empty text sections with estimated tokens, largest first. */
export function sectionSizes(sections) {
  if (!sections || typeof sections !== "object") return [];
  return Object.entries(sections)
    .filter(([, text]) => typeof text === "string" && text.trim())
    .map(([name, text]) => ({ name, tokens: estimateTokens(text) }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
}

/** Estimated size of the declarations of tools that are active and shown to the model. */
export function toolFootprint(tools, active) {
  const on = new Set(Array.isArray(active) ? active : []);
  let count = 0;
  let tokens = 0;
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!on.has(tool?.name) || NOT_SHOWN.has(tool?.exposure)) continue;
    count += 1;
    tokens += estimateTokens(
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }),
    );
  }
  return { count, tokens };
}

/** `sections` is sectionSizes() output, or null when no request has been seen. */
export function describePrompt({ sections, tools, active } = {}) {
  const footprint = toolFootprint(tools, active);
  const base = { estimate: true, tools: footprint };
  if (!sections) {
    return {
      ...base,
      sections: null,
      note: "Estimates, not provider counts. No request yet: prompt sections appear after the first prompt.",
    };
  }
  return {
    ...base,
    sections,
    sectionTokens: sections.reduce((sum, section) => sum + section.tokens, 0),
    note: "Estimates, not provider counts: sections as the last prompt left them for this extension (extensions loaded after it are not seen), tool declarations from the active list.",
  };
}

/** One short line for the info command. */
export function promptLine(prompt) {
  if (!prompt.sections) return "prompt sections: not seen yet";
  const top = prompt.sections
    .slice(0, TOP_SECTIONS)
    .map((section) => `${section.name} ${section.tokens}`)
    .join(", ");
  const tools = prompt.tools.count ? `, ${prompt.tools.count} tools ${prompt.tools.tokens}` : "";
  return `prompt ≈ ${prompt.sectionTokens} tokens in sections (${top || "none"})${tools} (estimate)`;
}
