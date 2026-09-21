import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  listCharacters,
  mergeCharacter,
  readCharacter,
  slugify,
  writeCharacter,
} from "../character-store.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-influencer-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("slugify creates stable safe character slugs", () => {
  assert.equal(slugify("Maya Rivera"), "maya-rivera");
  assert.equal(slugify(" Zoë / Test! "), "zoe-test");
  assert.equal(slugify(""), "");
});

test("character records round-trip and preserve the first lock time", async () => {
  const directory = await temporaryDirectory();
  const draft = mergeCharacter(
    null,
    {
      slug: "maya",
      name: "Maya",
      inputs: { age: "27", niche: "wellness" },
    },
    "2026-01-01T00:00:00.000Z",
  );
  await writeCharacter(directory, draft);

  const locked = mergeCharacter(
    draft,
    {
      prompt: "Foundational prompt",
      anchors: ["warm hazel eyes", "gold nose stud on left nostril"],
      silhouette: ["long loose curls falling below the shoulders"],
      styleSignature: "natural documentary photography",
    },
    "2026-01-02T00:00:00.000Z",
  );
  await writeCharacter(directory, locked);
  const reread = await readCharacter(directory, "maya");

  assert.equal(reread.lockedAt, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(reread.anchors, locked.anchors);
  assert.deepEqual(reread.silhouette, locked.silhouette);
  assert.equal(reread.inputs.niche, "wellness");

  const firstBytes = await readFile(path.join(directory, "maya.json"), "utf8");
  await writeCharacter(directory, reread);
  const secondBytes = await readFile(path.join(directory, "maya.json"), "utf8");
  assert.equal(secondBytes, firstBytes);

  const updated = mergeCharacter(
    reread,
    { anchors: ["changed but still locked"] },
    "2026-01-03T00:00:00.000Z",
  );
  assert.equal(updated.lockedAt, reread.lockedAt);
});

test("an empty save cannot erase existing locked anchors", () => {
  const locked = mergeCharacter(
    { slug: "maya", name: "Maya", anchors: ["fixed anchor"], lockedAt: "first" },
    { anchors: [] },
    "later",
  );
  assert.deepEqual(locked.anchors, ["fixed anchor"]);
  assert.equal(locked.lockedAt, "first");
});

test("listCharacters skips malformed records and sorts by update time", async () => {
  const directory = await temporaryDirectory();
  await writeCharacter(directory, mergeCharacter(null, { slug: "old", name: "Old" }, "2026-01-01"));
  await writeCharacter(directory, mergeCharacter(null, { slug: "new", name: "New" }, "2026-01-03"));
  await writeFile(path.join(directory, "broken.json"), "not json", "utf8");

  const records = await listCharacters(directory);
  assert.deepEqual(
    records.map((record) => record.slug),
    ["new", "old"],
  );
});
