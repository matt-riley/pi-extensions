import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";

import { createDialogQueue } from "../../shared/dialog-queue.mjs";
import {
  characterDirectory,
  listCharacters,
  mergeCharacter,
  readCharacter,
  slugify,
  writeCharacter,
} from "./character-store.mjs";
import {
  buildPromptBrief,
  collectInputs,
  formatLockedIdentity,
  formatRecipeCatalog,
  parseSlotAssignments,
} from "./brief.mjs";
import { listRecipes, loadGuidance, loadRecipe, renderRecipe } from "./resources.mjs";
import { INFLUENCER_TOOLS } from "./tools.mjs";

const [SAVE_TOOL, SHOW_TOOL, LIST_TOOL, PROMPT_TOOL] = INFLUENCER_TOOLS;
const COMMAND = "influencer";

const INPUTS = Type.Object({
  age: Type.Optional(Type.String()),
  gender: Type.Optional(Type.String()),
  ethnicity: Type.Optional(Type.String()),
  niche: Type.Optional(Type.String()),
  quirk: Type.Optional(Type.String()),
});

const SAVE_PARAMETERS = Type.Object({
  slug: Type.String({ description: "Stable character slug, for example maya." }),
  name: Type.Optional(Type.String({ description: "Human-readable character name." })),
  inputs: Type.Optional(INPUTS),
  prompt: Type.Optional(Type.String({ description: "The full foundational character prompt." })),
  anchors: Type.Optional(Type.Array(Type.String())),
  silhouette: Type.Optional(Type.Array(Type.String())),
  styleSignature: Type.Optional(Type.String()),
});

const SHOW_PARAMETERS = Type.Object({
  slug: Type.String({ description: "Saved character slug." }),
});

const PROMPT_PARAMETERS = Type.Object({
  character: Type.Optional(Type.String({ description: "Saved character slug." })),
  recipe: Type.Optional(
    Type.String({ description: "Recipe id or alias, for example character-sheet or sheet." }),
  ),
  slots: Type.Optional(Type.Record(Type.String(), Type.String())),
});

function notify(ctx: ExtensionContext, text: string, level = "info") {
  try {
    ctx.ui?.notify?.(text, level);
  } catch {
    // UI feedback must never make the command fail.
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toolError(text: string) {
  return {
    content: [{ type: "text", text }],
    isError: true,
  };
}

function toolText(text: string, details?: unknown) {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { details }),
  };
}

function formatRoster(records) {
  if (records.length === 0) return "No saved influencer characters.";
  return records
    .map((record) => {
      const status = record.lockedAt ? "locked" : "draft";
      const niche = record.inputs?.niche ? ` — ${record.inputs.niche}` : "";
      return `${record.slug} — ${record.name} — ${status}${niche}`;
    })
    .join("\n");
}

function ensureRecipeBody(recipe, slots) {
  return { ...recipe, renderedBody: renderRecipe(recipe, slots) };
}

async function sendBrief(pi, ctx, brief) {
  try {
    await pi.sendUserMessage(brief);
  } catch (error) {
    notify(ctx, `Could not submit the influencer brief: ${errorText(error)}`, "error");
  }
}

async function submitDraft(pi, ctx, directory, enqueueDialog) {
  if (!ctx.hasUI || !ctx.ui?.input) {
    notify(ctx, "Usage: /influencer, or /influencer <character> <recipe> key=value", "warning");
    return;
  }

  const input = ctx.ui.input;
  const collected = await enqueueDialog(() => collectInputs((dialog) => input(dialog.title)));
  if (!collected.ok) {
    notify(ctx, `Cancelled at ${collected.cancelledAt}; no character was saved.`, "warning");
    return;
  }

  const slug = slugify(collected.name);
  if (!slug) {
    notify(ctx, "That character name does not produce a usable slug.", "error");
    return;
  }

  const existing = await readCharacter(directory, slug);
  if (existing?.lockedAt) {
    notify(ctx, `${slug} is already locked; choose a new character name.`, "warning");
    return;
  }

  const draft = mergeCharacter(
    existing,
    { slug, name: collected.name, inputs: collected.inputs },
    new Date().toISOString(),
  );
  await writeCharacter(directory, draft);

  const recipe = ensureRecipeBody(await loadRecipe("foundational"), {});
  const guidance = await loadGuidance();
  await sendBrief(pi, ctx, buildPromptBrief({ character: draft, recipe, guidance }));
}

async function submitCommandRequest(pi, ctx, directory, typed) {
  if (typed === "list") {
    notify(ctx, formatRoster(await listCharacters(directory)));
    return;
  }

  const [first, ...rest] = typed.split(/\s+/);
  const candidateSlug = slugify(first);
  const existing = candidateSlug ? await readCharacter(directory, candidateSlug) : null;
  if (!existing) {
    const recipe = ensureRecipeBody(await loadRecipe("foundational"), {});
    const guidance = await loadGuidance();
    const roughBrief = {
      slug: "rough-brief",
      name: "New character from rough brief",
      inputs: { brief: typed },
      lockedAt: null,
      anchors: [],
      silhouette: [],
    };
    await sendBrief(pi, ctx, buildPromptBrief({ character: roughBrief, recipe, guidance }));
    return;
  }

  const recipe = await loadRecipe(rest[0] || "foundational");
  const slots = parseSlotAssignments(rest.slice(1).join(" "));
  const renderedRecipe = ensureRecipeBody(recipe, slots);
  const guidance = await loadGuidance({ seedance: recipe.guidance === "seedance-2-5" });
  await sendBrief(
    pi,
    ctx,
    buildPromptBrief({ character: existing, recipe: renderedRecipe, guidance }),
  );
}

export default function piInfluencerExtension(pi: ExtensionAPI) {
  const directory = characterDirectory(homedir());
  const enqueueDialog = createDialogQueue();

  pi.registerTool({
    name: SAVE_TOOL,
    label: SAVE_TOOL,
    description:
      "Save or update an AI influencer character. Use this after creating a foundational prompt so the prompt, consistency anchors, silhouette anchors, and style signature persist across sessions.",
    promptSnippet:
      "influencer_save: persist a character's foundational prompt and locked identity anchors",
    promptGuidelines: [
      "Use influencer_save after a foundational character prompt is agreed; save the exact consistency and silhouette anchor phrases, not paraphrases.",
    ],
    parameters: SAVE_PARAMETERS,
    async execute(_toolCallId, params) {
      try {
        const slug = slugify(params?.slug);
        if (!slug) return toolError("influencer_save requires a non-empty slug.");
        const existing = await readCharacter(directory, slug);
        const record = mergeCharacter(existing, { ...params, slug });
        const filename = await writeCharacter(directory, record);
        return toolText(
          `Saved ${record.slug} (${record.lockedAt ? "locked" : "draft"}) to ${filename}.`,
          { slug: record.slug, locked: Boolean(record.lockedAt), filename },
        );
      } catch (error) {
        return toolError(`Could not save influencer character: ${errorText(error)}`);
      }
    },
  });

  pi.registerTool({
    name: SHOW_TOOL,
    label: SHOW_TOOL,
    description:
      "Show a saved AI influencer's identity block. Use it before generating a new image so the locked anchors can be copied verbatim.",
    promptSnippet:
      "influencer_show: retrieve a saved character's identity and locked anchors verbatim",
    promptGuidelines: [
      "Use influencer_show before drafting a prompt for an existing character; copy its consistency and silhouette anchors verbatim and never retype them from memory.",
    ],
    parameters: SHOW_PARAMETERS,
    async execute(_toolCallId, params) {
      try {
        const slug = slugify(params?.slug);
        if (!slug) return toolError("influencer_show requires a character slug.");
        const record = await readCharacter(directory, slug);
        if (!record) return toolError(`No character named ${slug}. Use influencer_list first.`);
        return toolText(formatLockedIdentity(record), { slug, locked: Boolean(record.lockedAt) });
      } catch (error) {
        return toolError(`Could not show influencer character: ${errorText(error)}`);
      }
    },
  });

  pi.registerTool({
    name: LIST_TOOL,
    label: LIST_TOOL,
    description:
      "List saved AI influencer characters and whether each identity is still a draft or locked.",
    promptSnippet: "influencer_list: list saved AI influencer characters",
    parameters: Type.Object({}),
    async execute() {
      try {
        const records = await listCharacters(directory);
        return toolText(formatRoster(records), { count: records.length });
      } catch (error) {
        return toolError(`Could not list influencer characters: ${errorText(error)}`);
      }
    },
  });

  pi.registerTool({
    name: PROMPT_TOOL,
    label: PROMPT_TOOL,
    description:
      "Build an on-demand AI influencer image or Seedance 2.5 video prompt brief from bundled specialist guidance, a saved character, and a reusable recipe.",
    promptSnippet:
      "influencer_prompt: build an image or Seedance video prompt brief from bundled guidance, a saved character, and a recipe",
    promptGuidelines: [
      "Use influencer_prompt for AI influencer image prompts, visual turnaround sheets, and Seedance 2.5 prompts for fal.ai; the extension reads only the selected recipe's bundled guidance on demand.",
    ],
    parameters: PROMPT_PARAMETERS,
    async execute(_toolCallId, params) {
      try {
        if (!params?.recipe) {
          const recipes = await listRecipes();
          return toolText(formatRecipeCatalog(recipes), { recipes });
        }
        if (!params.character)
          return toolError("influencer_prompt requires character when a recipe is selected.");

        const slug = slugify(params.character);
        const character = await readCharacter(directory, slug);
        if (!character) return toolError(`No character named ${slug}. Use influencer_list first.`);
        const loadedRecipe = await loadRecipe(params.recipe);
        const recipe = ensureRecipeBody(loadedRecipe, params.slots ?? {});
        const guidance = await loadGuidance({ seedance: loadedRecipe.guidance === "seedance-2-5" });
        return toolText(buildPromptBrief({ character, recipe, guidance }), {
          character: slug,
          recipe: recipe.id,
          slots: params.slots ?? {},
        });
      } catch (error) {
        return toolError(`Could not build influencer prompt: ${errorText(error)}`);
      }
    },
  });

  pi.registerCommand(COMMAND, {
    description: "Create an AI influencer character or build a recipe-based prompt brief",
    handler: async (args, ctx) => {
      if (ctx.isIdle && !ctx.isIdle()) {
        notify(ctx, "Influencer prompts wait until the agent is idle.", "warning");
        return;
      }

      const typed = String(args ?? "").trim();
      try {
        if (!typed) {
          await submitDraft(pi, ctx, directory, enqueueDialog);
        } else {
          await submitCommandRequest(pi, ctx, directory, typed);
        }
      } catch (error) {
        notify(ctx, `Influencer request failed: ${errorText(error)}`, "error");
      }
    },
  });
}
