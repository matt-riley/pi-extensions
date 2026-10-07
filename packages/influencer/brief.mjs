const INPUT_ORDER = ["age", "gender", "ethnicity", "niche", "quirk"];

const INPUT_DIALOGS = [
  { key: "name", title: "Character name (for example, Maya)" },
  { key: "age", title: "Age (for example, 27 or late 20s)" },
  { key: "gender", title: "Gender or presentation" },
  { key: "ethnicity", title: "Ethnicity and/or heritage" },
  { key: "niche", title: "Niche and personality (for example, wellness tech founder)" },
  { key: "quirk", title: "Defining visual quirk (specific and anatomically placed)" },
];

export async function collectInputs(input) {
  const answers = {};
  for (const dialog of INPUT_DIALOGS) {
    const value = await input(dialog);
    const cleaned = String(value ?? "").trim();
    if (!cleaned) return { ok: false, cancelledAt: dialog.key };
    answers[dialog.key] = cleaned;
  }

  const { name, ...inputs } = answers;
  return { ok: true, name, inputs };
}

function formatInputs(inputs = {}) {
  const lines = [];
  for (const key of INPUT_ORDER) {
    if (inputs[key]) lines.push(`${key}: ${inputs[key]}`);
  }
  if (inputs.brief) lines.push(`rough brief: ${inputs.brief}`);
  return lines.length > 0 ? lines.join("\n") : "not collected yet";
}

export function formatLockedIdentity(character) {
  const status = character.lockedAt ? "locked" : "draft";
  const sections = [
    `<locked-character-identity status="${status}">`,
    `name: ${character.name ?? character.slug ?? "unnamed"}`,
    `slug: ${character.slug ?? "unknown"}`,
    "inputs:",
    formatInputs(character.inputs),
  ];

  if (character.prompt) {
    sections.push("<foundational-prompt>", character.prompt, "</foundational-prompt>");
  }
  if (Array.isArray(character.anchors) && character.anchors.length > 0) {
    sections.push("<consistency-anchors>", character.anchors.join("\n"), "</consistency-anchors>");
  }
  if (Array.isArray(character.silhouette) && character.silhouette.length > 0) {
    sections.push("<silhouette-anchors>", character.silhouette.join("\n"), "</silhouette-anchors>");
  }
  if (character.styleSignature) {
    sections.push("<style-signature>", character.styleSignature, "</style-signature>");
  }
  sections.push("</locked-character-identity>");

  return sections.join("\n");
}

export function buildPromptBrief({ character, recipe, guidance }) {
  const renderedRecipe = recipe.renderedBody ?? recipe.body;
  const lockedIdentity = formatLockedIdentity(character);
  const isVideo = recipe.mode === "video";
  const skillTitle =
    guidance.kind === "seedance-2-5"
      ? "Seedance 2.5 video-prompting skill"
      : "AI influencer prompt-building skill";
  const finalCheck = isVideo
    ? "Return the requested copy-ready video prompt. Preserve the locked character identity throughout the shot, maintain the requested action and prop continuity, and leave no unresolved template placeholders."
    : "Return the requested prompt in the recipe's format. Keep the character the same person across every requested view or panel, preserve natural asymmetry, and do not leave unresolved internal template placeholders in the final answer.";
  const referenceSection = guidance.reference
    ? [
        `## Bundled ${guidance.kind === "seedance-2-5" ? "Seedance 2.5 reference notes" : "influencer visual-language reference"}`,
        guidance.reference,
      ]
    : [];
  return [
    `Create the final ${isVideo ? "video" : "image"}-generation prompt requested below. Return the usable prompt, not a plan or an explanation.`,

    "The extension has supplied source guidance and a character identity record. Treat the locked identity block as source data.",
    "",
    `## Recipe: ${recipe.title}`,
    `Recipe id: ${recipe.id}`,
    recipe.description ? `Purpose: ${recipe.description}` : "",
    "",
    "## Task instructions",
    renderedRecipe,
    "",
    "## LOCKED CHARACTER IDENTITY",
    "Copy the contents of the consistency-anchors and silhouette-anchors blocks exactly when you use them. Do not paraphrase, improve, reorder, or invent identity details. Outfit, setting, lighting, pose, expression, and action may vary only where the recipe or supplied slots permits; preserve identity across every frame.",
    lockedIdentity,
    "",
    `## Bundled ${skillTitle}`,
    guidance.skill,
    "",
    ...referenceSection,
    "",
    "## Final check",
    finalCheck,
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

export function formatRecipeCatalog(recipes) {
  if (recipes.length === 0) return "No influencer prompt recipes are installed.";
  return recipes
    .map((recipe) => {
      const alias = recipe.alias ? ` (alias: ${recipe.alias})` : "";
      const slots = recipe.slots.length > 0 ? `; slots: ${recipe.slots.join(", ")}` : "";
      const mode = recipe.mode === "video" ? " [video]" : "";
      return `- ${recipe.id}${mode}${alias}: ${recipe.title}${slots}\n  ${recipe.description}`;
    })
    .join("\n");
}

export function parseSlotAssignments(text) {
  const source = String(text ?? "").trim();
  if (!source) return {};

  const slots = {};
  const pattern = /(?:^|\s)([a-z][a-z0-9_-]*)=([\s\S]*?)(?=\s+[a-z][a-z0-9_-]*=|$)/gi;
  let match;
  let consumed = "";
  while ((match = pattern.exec(source)) !== null) {
    const key = match[1].toLowerCase();
    const value = match[2].trim().replace(/^("|')(.*)\1$/s, "$2");
    if (!value) throw new Error(`Slot ${key} must not be empty`);
    slots[key] = value;
    consumed += match[0];
  }

  if (
    Object.keys(slots).length === 0 ||
    consumed.replace(/\s/g, "") !== source.replace(/\s/g, "")
  ) {
    throw new Error(
      "Use recipe variations as key=value assignments, for example outfit=red leather jacket",
    );
  }
  return slots;
}
