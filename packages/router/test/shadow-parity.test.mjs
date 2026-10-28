// Shadow must match route() on every user turn — same gate, budget, and decideRoute.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import piRouterExtension from "../index.ts";
import { evaluateShadowTurn } from "../shadow-eval.mjs";
import { modelKey } from "../model-battery.mjs";

const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000 };
const SOL = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272000 };

const tempDirs = [];
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text = "done", usage) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...(usage ? { usage } : {}),
});
const failed = () => ({ role: "toolResult", toolName: "bash", isError: true });
const turn = (prompt, { reply = "done", failures = 0 } = {}) => {
  const messages = [user(prompt), assistant(reply)];
  for (let i = 0; i < failures; i++) messages.push(failed());
  return messages;
};

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-parity-"));
  tempDirs.push(dir);
  const file = path.join(dir, "router.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        shadowLog: true,
        frontier: [
          { model: "openai-codex/gpt-6-astra", thinking: "medium" },
          { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("shadow would-be matches route() through a full scripted sequence", async () => {
  const scores = [0.6, 0.6, 1.8, 1.8, 2.6, 0.5, 2.0, 2.2, 2.4];
  let scoreIndex = 0;
  let failNext = false;
  let now = 1_700_000_000_000;
  const configPath = tempConfig();

  let virtualModel = null;
  const handlers = {};
  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerCommand: () => {},
    appendEntry: () => {},
    registerVirtualModel: (def) => {
      virtualModel = def;
    },
  };
  const ctx = {
    cwd: "/repo",
    sessionId: "parity",
    thinkingLevel: "medium",
    modelRegistry: {
      getAvailable: () => [LUNA, ASTRA, SOL],
      find: (provider, id) =>
        [LUNA, ASTRA, SOL].find((m) => m.provider === provider && m.id === id) ?? null,
      getModel: (provider, id) =>
        [LUNA, ASTRA, SOL].find((m) => m.provider === provider && m.id === id) ?? null,
    },
    sessionManager: { getBranch: () => [] },
    ui: { notify: () => {}, setStatus: () => {} },
  };

  const askBox = {
    fn: async () => ({ answers: { difficulty: { type: "score", score: 0.6 } } }),
  };

  piRouterExtension(pi, { configPath, now: () => now, ask: (...args) => askBox.fn(...args) });

  const tiers = {
    base: [
      { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
      { model: "openai-codex/gpt-5.6-luna" },
    ],
    mid: [
      { model: "openai-codex/gpt-6-astra", thinking: "low" },
      { model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" },
    ],
    frontier: [
      { model: "openai-codex/gpt-6-astra", thinking: "medium" },
      { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
    ],
  };

  let routeState = null;
  let shadowState = null;
  let messages = [];
  const offers = [LUNA, ASTRA, SOL];

  async function expectParity(prompt, { reason = "user", previous, cooling = [] } = {}) {
    if (reason === "user") messages = [...messages, user(prompt)];
    let stepScore = null;
    const stepJudge = async () => {
      if (failNext) {
        failNext = false;
        throw new Error("judge down");
      }
      if (stepScore === null) {
        stepScore = scores[Math.min(scoreIndex++, scores.length - 1)] ?? 0.6;
      }
      return { answers: { difficulty: { type: "score", score: stepScore } } };
    };
    askBox.fn = stepJudge;

    const routed = await virtualModel.route(
      {
        reason,
        state: routeState,
        previous,
        thinkingLevel: "medium",
        messages,
      },
      ctx,
    );
    routeState = routed.state ?? routeState;

    if (reason !== "user") {
      assert.equal(modelKey(routed.model), routeState?.model ?? modelKey(LUNA));
      return;
    }

    const { entry, nextState } = await evaluateShadowTurn({
      prompt,
      branch: messages.map((message) => ({ type: "message", message })),
      shadowState,
      actualKey: "openai-codex/gpt-5.6-luna",
      actualThinking: "medium",
      sessionId: "parity",
      selected: "medium",
      offers,
      tiers,
      ctx,
      cooling,
      threshold: 1.5,
      frontierThreshold: 2.5,
      timeoutMs: 4000,
      shareWindow: true,
      judge: stepJudge,
      prefetched: null,
      clock: () => now,
    });
    shadowState = nextState;

    assert.equal(entry.wouldBe.key, modelKey(routed.model), `key for "${prompt.slice(0, 30)}"`);
    assert.equal(
      entry.wouldBe.thinking,
      routed.thinkingLevel,
      `thinking for "${prompt.slice(0, 30)}"`,
    );
    assert.equal(entry.wouldBe.tier, routed.state?.tier, `tier for "${prompt.slice(0, 30)}"`);
  }

  await expectParity("start a new task on the parser rewrite in this repository");
  messages.push(...turn("start a new task on the parser rewrite in this repository"));
  await expectParity("", {
    reason: "continuation",
    previous: { provider: LUNA.provider, id: LUNA.id, thinkingLevel: "medium" },
  });

  messages = [
    ...turn("start a new task on the parser rewrite in this repository", { failures: 2 }),
    user("still failing find the actual race condition"),
  ];
  await expectParity("still failing find the actual race condition");

  await expectParity("fix the failing parser tests in the guardrail package");
  await expectParity("audit the routing design and tell me what is wrong with it");

  failNext = true;
  await expectParity("now rewrite the deploy pipeline notes for a brand new reader");

  messages = [
    ...turn("now rewrite the deploy pipeline notes for a brand new reader"),
    user("keep digging into the parser"),
  ];
  for (const prompt of [
    "keep digging into the parser",
    "keep digging into the parser again",
    "keep digging into the parser once more",
  ]) {
    messages = [...messages.slice(0, -1), user(prompt)];
    await expectParity(prompt);
    messages.push(...turn(prompt, { failures: 3 }));
  }

  messages = [
    ...turn("audit the routing design and tell me what is wrong with it"),
    user("explain the deploy pipeline end to end for a new reader"),
  ];
  await handlers.turn_end?.(
    {
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "You have hit your ChatGPT usage limit. Try again in ~30 min.",
          provider: "openai-codex",
          model: "gpt-6-astra",
        },
      ],
    },
    ctx,
  );
  await expectParity("explain the deploy pipeline end to end for a new reader", {
    cooling: ["openai-codex/gpt-6-astra"],
  });
});
