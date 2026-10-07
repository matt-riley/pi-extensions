import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPromptBrief,
  collectInputs,
  formatLockedIdentity,
  parseSlotAssignments,
} from "../brief.mjs";
import { loadGuidance, loadRecipe, renderRecipe } from "../resources.mjs";

test("collectInputs returns all five inputs and the character name", async () => {
  const answers = [
    "Maya",
    "27",
    "woman",
    "mixed Black and Southeast Asian",
    "wellness",
    "left nose stud",
  ];
  let index = 0;
  const result = await collectInputs(async () => answers[index++]);

  assert.deepEqual(result, {
    ok: true,
    name: "Maya",
    inputs: {
      age: "27",
      gender: "woman",
      ethnicity: "mixed Black and Southeast Asian",
      niche: "wellness",
      quirk: "left nose stud",
    },
  });
});

test("collectInputs cancels without returning partial answers", async () => {
  let calls = 0;
  const result = await collectInputs(async () => {
    calls += 1;
    return calls === 3 ? undefined : `answer-${calls}`;
  });

  assert.deepEqual(result, { ok: false, cancelledAt: "gender" });
});

test("locked identity formatting preserves anchor text exactly", () => {
  const identity = formatLockedIdentity({
    slug: "maya",
    name: "Maya",
    lockedAt: "now",
    inputs: { niche: "wellness" },
    anchors: ["Warm hazel eyes, slightly almond-shaped", "a gap between her front teeth"],
    silhouette: ["long loose curls falling below the shoulders"],
  });

  assert.match(identity, /Warm hazel eyes, slightly almond-shaped/);
  assert.match(identity, /a gap between her front teeth/);
  assert.match(identity, /long loose curls falling below the shoulders/);
  assert.match(identity, /status="locked"/);
});

test("prompt briefs contain the recipe, guidance, and no unresolved slots", async () => {
  const [recipe, guidance] = await Promise.all([loadRecipe("character-sheet"), loadGuidance()]);
  const brief = buildPromptBrief({
    character: {
      slug: "maya",
      name: "Maya",
      lockedAt: "now",
      inputs: { niche: "wellness" },
      anchors: ["warm hazel eyes"],
      silhouette: ["long loose curls falling below the shoulders"],
    },
    recipe: { ...recipe, renderedBody: renderRecipe(recipe, { outfit: "a sage linen set" }) },
    guidance,
  });

  assert.match(brief, /Photorealistic character identity sheet/);
  assert.match(brief, /a sage linen set/);
  assert.match(brief, /warm hazel eyes/);
  assert.match(brief, /influencer-visual-language/);
  assert.doesNotMatch(brief, /Seedance 2.5 video-prompting skill/);
  assert.doesNotMatch(brief, /\{\{/);
});

test("video recipes load Seedance guidance and use a video-specific brief", async () => {
  const [recipe, guidance] = await Promise.all([
    loadRecipe("seedance-video"),
    loadGuidance({ seedance: true }),
  ]);
  const brief = buildPromptBrief({
    character: {
      slug: "maya",
      name: "Maya",
      lockedAt: "now",
      inputs: { niche: "beauty and fashion creator" },
      anchors: ["Slightly almond-shaped vivid emerald-green eyes with a softly hooded upper lid"],
      silhouette: [
        "Chest-length dark espresso-brown hair with loose natural waves and a center part",
      ],
    },
    recipe: { ...recipe, renderedBody: renderRecipe(recipe) },
    guidance,
  });

  assert.equal(guidance.kind, "seedance-2-5");
  assert.match(guidance.reference, /fal.ai/);
  assert.match(brief, /final video-generation prompt/);
  assert.match(brief, /Seedance 2.5 video-prompting skill/);
  assert.match(brief, /exact labels shown by the target interface/);
  assert.match(brief, /Platform: fal.ai/);
  assert.match(brief, /@Image1/);
  assert.doesNotMatch(brief, /Influencer Visual Language Reference/);
  assert.doesNotMatch(brief, /\{\{/);
});

test("command slot assignments support values containing spaces", () => {
  assert.deepEqual(parseSlotAssignments("outfit=red leather jacket setting=neutral studio wall"), {
    outfit: "red leather jacket",
    setting: "neutral studio wall",
  });
  assert.throws(() => parseSlotAssignments("red leather jacket"), /key=value/);
});
