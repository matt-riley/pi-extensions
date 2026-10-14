// Every Jev question set in this repo, driven through the code that builds it,
// with a stand-in provider that runs the production validators on each request.
// A question set that names state its caller does not send is answered from
// nothing, and the null answer reads as "keep" — so it has to fail here, not in
// a compaction.
import assert from "node:assert/strict";
import test from "node:test";

import { validateRequest } from "../shared/systemone.mjs";
import { buildJudgeState, buildQuestionSet, judgeToolCall } from "../packages/guardrail/judge.mjs";
import {
  buildClaimQuestionSet,
  buildClaimState,
  judgeDoneClaim,
} from "../packages/done-gate/claim.mjs";
import { TIEBREAK_ENV, selectSkills } from "../packages/skill-select/select.mjs";
import { checkDiffScope, preflightTask, triageResult } from "../packages/subagents/judge.mjs";
import { judgeFailure } from "../packages/diagnosis-nudge/triage.mjs";
import { buildTaskTypeQuestion } from "../packages/router/playbook.mjs";
import { buildDifficultyState, buildQuestions } from "../packages/router/model-battery.mjs";
import { buildQuestions as buildRewriteQuestions } from "../packages/prompt-coach/battery.mjs";
import { rateCandidates } from "../shared/spans.mjs";
import {
  judgeSegment,
  pickGoal,
  verifyCoverage,
  verifyEntries,
} from "../packages/safe-compact/judge.mjs";

const segment = (id, role, text) => ({ id, role, tool: "read", path: null, text });
const user = (text) => segment("s0", "user", text);

/** A provider that answers every question plausibly and validates the request. */
function standIn() {
  const calls = [];
  const problems = [];
  const ask = async (request) => {
    calls.push(request);
    try {
      validateRequest(request);
    } catch (error) {
      problems.push(error.message);
    }
    return { model: "test", usage: null, answers: answerPlausibly(request.questions) };
  };
  return { ask, calls, problems };
}

/** Choice questions take a criterion key; noul and score take a number. */
function answerPlausibly(questions) {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      question.type === "choice" ? Object.keys(question.criteria)[0] : 0.5,
    ]),
  );
}

const CASES = {
  "guardrail judge": (ask) =>
    judgeToolCall({
      action: "rm -rf build",
      toolName: "bash",
      cwd: "/repo",
      userRequest: "clean the build directory",
      ask,
      env: {},
    }),
  "guardrail builders": (ask) =>
    ask({
      state: buildJudgeState({ action: "ls", toolName: "bash" }),
      questions: buildQuestionSet(),
    }),
  "done-gate judge": (ask) =>
    judgeDoneClaim({
      claim: "All tests pass and the loader is fixed.",
      files: ["src/loader.mjs"],
      verificationSeen: false,
      ask,
      env: {},
    }),
  "done-gate builders": (ask) =>
    ask({
      state: buildClaimState({ claim: "done", files: ["a.mjs"], verificationSeen: true }),
      questions: buildClaimQuestionSet(),
    }),
  // The key is what makes selection ask at all, and it is resolved from the
  // injected env or the machine's config file. Without it in the env this case
  // asks nothing on a machine with no config — CI has none — and the sweep
  // passed there while exercising no question set at all. The key is a value in
  // the env, never a request: the stand-in above is the only ask.
  "skill-select tiebreak": (ask) =>
    selectSkills({
      skills: [
        { name: "radius-api", description: "Radius organization administration." },
        { name: "skill-select", description: "Choose a skill for a task." },
      ],
      query: "review the go code in this repo and tell me what to fix",
      env: { [TIEBREAK_ENV]: "1", TYPESAFE_API_KEY: "test-key" },
      ask,
    }),
  "diagnosis triage": (ask) =>
    judgeFailure({
      toolName: "bash",
      action: "pnpm dev",
      cwd: "/repo",
      output: "Error: listen EADDRINUSE: address already in use :::3000",
      ask,
    }),
  "subagents preflight": (ask) =>
    preflightTask({
      agent: "worker",
      task: "rewrite the config loader",
      writeCapable: true,
      askImpl: ask,
    }),
  "subagents triage": (ask) =>
    triageResult({
      agent: "worker",
      task: "rewrite the loader",
      text: "Done, tests pass.",
      askImpl: ask,
    }),
  "subagents diff scope": (ask) =>
    checkDiffScope({
      task: "fix the loader",
      diff: "--- a/x\n+++ b/x\n@@\n-old\n+new",
      askImpl: ask,
    }),
  "router difficulty": (ask) =>
    ask({
      state: buildDifficultyState({
        prompt: "add a retry to the uploader",
        window: [{ prompt: "fix the test", lastResponse: "done", toolCalls: [{ name: "bash" }] }],
        cwd: "/repo",
      }),
      questions: buildQuestions(),
    }),
  "router task type": (ask) =>
    ask({
      state: buildDifficultyState({ prompt: "the build is broken", window: [], cwd: "/repo" }),
      questions: { task_type: buildTaskTypeQuestion() },
    }),
  // The prompt-coach state is built inline in its entrypoint (index.ts), so this
  // is that literal rather than a builder.
  "prompt-coach rewrite": (ask) =>
    ask({
      state: {
        original_prompt: "make the loader retry twice",
        rewritten_prompt: "Make the config loader retry twice on failure.",
        repository_probe: "src/loader.mjs: 42 lines",
      },
      questions: buildRewriteQuestions(),
    }),
  "safe-compact candidate rating": (ask) =>
    rateCandidates({
      context: "A working session between a user and a coding agent.",
      candidates: ["fix the loader", "thanks!", "now add tests"],
      instruction: "Does the candidate state the overall task or goal the user wants accomplished?",
      ask,
    }),
  "safe-compact segment": (ask) =>
    judgeSegment({
      goal: "fix the loader",
      segment: segment("s1", "assistant", "the loader reads config"),
      next: segment("s2", "user", "now add tests"),
      ask,
    }),
  "safe-compact goal": (ask) => pickGoal({ userSegments: [user("fix the loader")], ask }),
  "safe-compact faithfulness": (ask) =>
    verifyEntries({
      entries: [{ entry: "the loader is fixed", source: "the loader reads config" }],
      ask,
    }),
  "safe-compact coverage": (ask) =>
    verifyCoverage({
      handoff: "- the loader reads config",
      segments: [segment("s1", "assistant", "the loader reads config")],
      ask,
    }),
};

test("every Jev question set validates against the state its caller builds", async (t) => {
  for (const [name, run] of Object.entries(CASES)) {
    await t.test(name, async () => {
      const { ask, calls, problems } = standIn();
      await run(ask);
      assert.ok(calls.length > 0, "asked Jev at least once");
      assert.deepEqual(problems, []);
    });
  }
});
