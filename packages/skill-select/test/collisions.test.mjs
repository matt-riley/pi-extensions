import assert from "node:assert/strict";
import test from "node:test";

import { findCollisions } from "../collisions.mjs";

const skill = (name, description) => ({ name, description });
const library = [
  skill("unit-testing", "Write unit tests with fixtures and assertions for a module"),
  skill("test-writing", "Write tests with fixtures and assertions for a module"),
  skill("docker-builds", "Build small container images with multi-stage Dockerfiles"),
  skill("no-description", ""),
];

test("descriptions that route to each other collide; distinct ones do not", () => {
  const pairs = findCollisions(library);
  assert.deepEqual(
    pairs.map(({ a, b, mutualTop }) => ({ a, b, mutualTop })),
    [{ a: "test-writing", b: "unit-testing", mutualTop: true }],
  );
  assert.ok(pairs[0].strength >= 0.4 && pairs[0].strength < 1);
});

test("the margin bounds how far below a skill's self score a neighbour may fall", () => {
  const strength = findCollisions(library)[0].strength;
  assert.equal(findCollisions(library, { margin: 1 - strength - 0.01 }).length, 0);
  assert.equal(findCollisions(library, { margin: 1 - strength }).length, 1);
});
