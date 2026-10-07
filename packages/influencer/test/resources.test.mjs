import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listRecipes,
  loadRecipe,
  parseFrontmatter,
  renderRecipe,
  substituteSlots,
} from "../resources.mjs";

test("parseFrontmatter reads scalar and inline array metadata", () => {
  const parsed = parseFrontmatter("---\ntitle: Example\nslots: [outfit, setting]\n---\nBody");
  assert.deepEqual(parsed.metadata, { title: "Example", slots: ["outfit", "setting"] });
  assert.equal(parsed.body, "Body");
});

test("bundled recipes are discoverable by id and alias", async () => {
  const recipes = await listRecipes();
  assert.deepEqual(
    recipes.map((recipe) => recipe.id),
    ["character-sheet", "foundational", "seedance-video"],
  );
  const sheet = await loadRecipe("sheet");
  assert.equal(sheet.id, "character-sheet");
  const video = await loadRecipe("video");
  assert.equal(video.mode, "video");
  assert.equal(video.guidance, "seedance-2-5");
});

test("recipe slots render defaults and explicit variations", async () => {
  const recipe = await loadRecipe("character-sheet");
  const defaultBody = renderRecipe(recipe);
  const variantBody = renderRecipe(recipe, { outfit: "a red leather jacket" });

  assert.match(defaultBody, /established outfit from the locked identity/);
  assert.match(variantBody, /a red leather jacket/);
  assert.doesNotMatch(variantBody, /\{\{/);
});

test("video recipe defaults render without unresolved placeholders", async () => {
  const recipe = await loadRecipe("seedance-video");
  const rendered = renderRecipe(recipe);
  assert.match(rendered, /Seedance 2.5 video-generation prompt/);
  assert.match(rendered, /Platform: fal.ai/);
  assert.match(rendered, /16:9 horizontal/);
  assert.doesNotMatch(rendered, /\{\{/);
});

test("recipe rendering rejects unknown or missing slots", async () => {
  const recipe = await loadRecipe("character-sheet");
  assert.throws(() => renderRecipe(recipe, { mood: "dramatic" }), /Unknown recipe slots/);
  assert.throws(() => substituteSlots("Use {{outfit}}", {}), /Missing recipe slots: outfit/);
});
