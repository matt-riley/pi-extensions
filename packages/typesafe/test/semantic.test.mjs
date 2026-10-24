import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findCode } from "../semantic.mjs";
import { validateRequest } from "../../../shared/systemone-request.mjs";

const noGit = async () => ({ code: 1, stdout: "" });
const answer = (noul) => ({ answers: { implements: { type: "noul", noul } } });

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "semantic-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "src"));
  await writeFile(
    join(cwd, "src/enrol.mjs"),
    "export function enrol() {\n  return insertAccount();\n}\n",
  );
  await writeFile(join(cwd, "src/theme.mjs"), "export const color = 'blue';\n");
  return cwd;
}

test("finds implementations by meaning and returns only real source locations", async (t) => {
  const cwd = await fixture(t);
  const calls = [];
  const result = await findCode({
    goal: "where is user registration performed",
    path: "src",
    cwd,
    exec: noGit,
    ask: async (request) => {
      validateRequest(request);
      calls.push(request);
      return answer(request.state.file.path === "src/enrol.mjs" ? 0.95 : 0.1);
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.status, "matches");
  assert.equal(result.judged, 2);
  assert.deepEqual(result.matches, [
    {
      path: "src/enrol.mjs",
      probability: 0.95,
      ranges: [{ start: 1, end: 4 }],
    },
  ]);
  assert.ok(!JSON.stringify(result).includes("insertAccount"), "source stays out of the reply");
});

test("missing, malformed and failed judgments are unknown, never negative matches", async (t) => {
  const cwd = await fixture(t);
  for (const value of [null, true, "0.9", -1, 2, undefined]) {
    const result = await findCode({
      goal: "register users",
      cwd,
      exec: noGit,
      ask: async () => answer(value),
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.judged, 0);
    assert.equal(result.unknown.length, 2);
    assert.equal(result.matches.length, 0);
  }
  const partial = await findCode({
    goal: "register users",
    cwd,
    exec: noGit,
    ask: async ({ state }) => {
      if (state.file.path.endsWith("theme.mjs")) throw new Error("offline");
      return answer(0.95);
    },
  });
  assert.equal(partial.status, "incomplete");
  assert.equal(partial.matches.length, 1);
  assert.equal(partial.unknown.length, 1);
});

test("honest no-match requires successful judgments; limits and skips are explicit", async (t) => {
  const cwd = await fixture(t);
  const negative = await findCode({
    goal: "billing webhook",
    cwd,
    exec: noGit,
    ask: async () => answer(0.1),
  });
  assert.equal(negative.status, "no_match");
  assert.equal(negative.judged, 2);
  await writeFile(join(cwd, "src/large.mjs"), "x".repeat(48_001));
  await writeFile(join(cwd, ".env"), "DO_NOT_SEND");
  await symlink(join(tmpdir(), "not-in-repo"), join(cwd, "src/escape.mjs"));
  const limited = await findCode({
    goal: "billing webhook",
    cwd,
    exec: noGit,
    ask: async ({ state }) => {
      assert.ok(!state.file.content.includes("DO_NOT_SEND"));
      return answer(0.1);
    },
  });
  assert.equal(limited.status, "incomplete");
  assert.ok(limited.skipped.some((s) => s.path.endsWith("large.mjs")));
  assert.ok(limited.skipped.some((s) => s.path === ".env"));
  assert.ok(limited.skipped.some((s) => s.path.endsWith("escape.mjs")));
});

test("refuses an empty goal, outside scope and excessive scans before asking", async (t) => {
  const cwd = await fixture(t);
  const ask = async () => assert.fail("must not ask");
  await assert.rejects(findCode({ goal: " ", cwd, exec: noGit, ask }), /goal/);
  await assert.rejects(
    findCode({ goal: "registration", path: "..", cwd, exec: noGit, ask }),
    /outside/,
  );
  await Promise.all(
    Array.from({ length: 101 }, (_, i) => writeFile(join(cwd, "src", i + ".js"), "")),
  );
  await assert.rejects(findCode({ goal: "registration", cwd, exec: noGit, ask }), /narrower/);
});

test("large candidates use existing ranges and report unavailable locations honestly", async (t) => {
  const cwd = await fixture(t);
  const lines = Array.from({ length: 180 }, (_, i) =>
    i === 90 ? "export function enrol() { return insertAccount(); }" : "// unrelated",
  );
  await writeFile(join(cwd, "src/enrol.mjs"), lines.join("\n"));
  const locate = async ({ state, questions }) => {
    if (questions.implements) return answer(0.95);
    return {
      answers: { rating: { type: "noul", noul: state.candidate.includes("enrol") ? 0.95 : 0.1 } },
    };
  };
  const found = await findCode({
    goal: "register users",
    path: "src/enrol.mjs",
    cwd,
    exec: noGit,
    ask: locate,
  });
  assert.equal(found.status, "matches");
  assert.ok(found.matches[0].ranges.some((range) => range.start <= 91 && range.end >= 91));
  for (const mode of ["offline", "negative"]) {
    const unavailable = await findCode({
      goal: "register users",
      path: "src/enrol.mjs",
      cwd,
      exec: noGit,
      ask: async ({ questions }) => {
        if (questions.implements) return answer(0.95);
        if (mode === "offline") throw new Error("offline");
        return { answers: { rating: { type: "noul", noul: 0.1 } } };
      },
    });
    assert.equal(unavailable.status, "incomplete");
    assert.deepEqual(unavailable.matches[0].ranges, []);
    assert.match(unavailable.unknown[0].reason, /locations unavailable/);
  }
});

test("cancellation stops the search without reporting no-match", async (t) => {
  const cwd = await fixture(t);
  await assert.rejects(
    findCode({
      goal: "registration",
      cwd,
      exec: noGit,
      signal: AbortSignal.abort(),
      ask: async () => assert.fail("must not ask"),
    }),
    /abort/i,
  );
});
