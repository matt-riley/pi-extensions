#!/usr/bin/env node
/**
 * verify-tools.mjs — one command to check this repo's tools are intact.
 *
 * Offline by default:
 *   1. loads both extension entrypoints through a stub pi and asserts the
 *      tool names register (i.e. pi will offer them)
 *   2. discovers the local skill library and shows a sample ranking
 *   3. reports whether a TypeSafe key is visible to the environment
 *
 * `--live` adds one real TypeSafe call so the whole chain is exercised.
 *
 * Usage:
 *   npm run verify
 *   npm run verify -- --live
 */

import { homedir } from "node:os";

import { discoverSkills, rankSkills, resolveRoots } from "../packages/skill-select/library.mjs";
import { SKILL_SELECT_TOOLS } from "../packages/skill-select/tools.mjs";
import { askSystemOne, formatAnswers } from "../shared/systemone.mjs";
import { TYPESAFE_TOOLS } from "../packages/typesafe/tools.mjs";

const SAMPLE_QUERIES = ["typescript any eliminator", "acquire codebase knowledge"];

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// 1. Registration: stub pi, load the real entrypoints, capture tool names.
const registered = [];
const stubPi = {
  registerTool: (definition) => registered.push(definition.name),
  on() {},
  registerCommand() {},
  registerFlag() {},
  registerShortcut() {},
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
};
try {
  const { default: typesafe } = await import("../packages/typesafe/index.ts");
  const { default: skillSelect } = await import("../packages/skill-select/index.ts");
  typesafe(stubPi);
  skillSelect(stubPi);
  for (const tool of [...TYPESAFE_TOOLS, ...SKILL_SELECT_TOOLS]) {
    check(`${tool} registers with pi`, registered.includes(tool));
  }
} catch (error) {
  check(
    "extension entrypoints load",
    false,
    error instanceof Error ? error.message : String(error),
  );
}

// 2. Skill library: real roots, real files.
try {
  const skills = await discoverSkills({
    roots: resolveRoots({ cwd: process.cwd(), home: homedir(), env: process.env }),
  });
  check("skill library discovered", skills.length > 0, `${skills.length} skills`);
  for (const query of SAMPLE_QUERIES) {
    const top = rankSkills(skills, query, { limit: 1 })[0];
    check(`skill_select ranks "${query}"`, Boolean(top), top ? top.name : "no match");
  }
} catch (error) {
  check("skill library discovered", false, error instanceof Error ? error.message : String(error));
}

// 3. Credentials, and optionally a real round trip.
const apiKey =
  String(process.env.TYPESAFE_API_KEY ?? "").trim() ||
  String(process.env.LORE_TYPESAFE_API_KEY ?? "").trim();
check(
  "TypeSafe key visible",
  Boolean(apiKey),
  apiKey ? "found" : "set TYPESAFE_API_KEY or LORE_TYPESAFE_API_KEY",
);

if (process.argv.includes("--live")) {
  if (!apiKey) {
    check("live TypeSafe call", false, "skipped: no key");
  } else {
    try {
      const result = await askSystemOne({
        state: { task: "migration", skippedTests: 2, failingTests: 0 },
        questions: {
          complete: { type: "noul", instructions: "Is this work complete?" },
        },
      });
      const answer = result.answers?.complete?.noul;
      check(
        "live TypeSafe call",
        Number.isFinite(Number(answer)),
        `${result.model} noul=${answer}`,
      );
      console.log(formatAnswers(result));
    } catch (error) {
      check("live TypeSafe call", false, error instanceof Error ? error.message : String(error));
    }
  }
} else if (apiKey) {
  console.log("     (pass --live to also make one real TypeSafe call)");
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length > 0 ? 1 : 0;
