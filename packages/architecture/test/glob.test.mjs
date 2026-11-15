import { test } from "node:test";
import assert from "node:assert/strict";

import { matchGlob } from "../glob.mjs";

test("a star matches within one path segment and captures it", () => {
  assert.deepEqual(matchGlob("packages/*/index.ts", "packages/doctor/index.ts"), ["doctor"]);
  assert.equal(matchGlob("packages/*/index.ts", "packages/a/b/index.ts"), null);
  assert.equal(matchGlob("packages/*", "packages/a/b"), null);
});

test("a double star crosses directories, including none before a slash", () => {
  assert.deepEqual(matchGlob("shared/**", "shared/x.mjs"), []);
  assert.deepEqual(matchGlob("shared/**", "shared/deep/er/x.mjs"), []);
  assert.deepEqual(matchGlob("**/test/**", "packages/a/test/x.test.mjs"), []);
  assert.deepEqual(matchGlob("**/test/**", "test/x.test.mjs"), []);
  assert.equal(matchGlob("shared/**", "sharedness/x.mjs"), null);
  assert.equal(matchGlob("shared/**", "shared"), null);
});

test("captures from the first pattern fill $1, $2 in a second pattern", () => {
  assert.deepEqual(matchGlob("packages/$1/**", "packages/a/x.ts", ["a"]), []);
  assert.equal(matchGlob("packages/$1/**", "packages/b/x.ts", ["a"]), null);
  assert.deepEqual(matchGlob("$1/$2.ts", "a/b.ts", ["a", "b"]), []);
});

test("a capture is literal text, not a pattern", () => {
  assert.equal(matchGlob("pkg/$1/**", "pkg/a.b/x.ts", ["a*b"]), null);
  assert.deepEqual(matchGlob("pkg/$1/**", "pkg/a*b/x.ts", ["a*b"]), []);
});

test("regular expression characters in a pattern are literal", () => {
  assert.deepEqual(matchGlob("src/a.b+c(1).ts", "src/a.b+c(1).ts"), []);
  assert.equal(matchGlob("src/a.b.ts", "src/aXb.ts"), null);
});

test("a question mark matches one non-slash character", () => {
  assert.deepEqual(matchGlob("f?.ts", "f1.ts"), []);
  assert.equal(matchGlob("f?.ts", "f/.ts"), null);
});
