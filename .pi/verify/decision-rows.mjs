#!/usr/bin/env node
// Isolated real-terminal acceptance for decision-rows. Requires pi, tmux.
// A probe command appends one entry of each type; the drive checks the rows the
// real TUI draws, the details ctrl+o adds, and that the next provider request
// carries none of it. Never reads user settings or sessions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const fixture = await mkdtemp(path.join(tmpdir(), "pi-decision-rows-ui-"));
const cwd = path.join(fixture, "workspace");
const agent = path.join(fixture, "agent");
const socket = "pi-decision-rows-" + process.pid;
const MARK = "ROWMARK";
const HELD = "HELDMARK";
const SECRET = "SECRETPROMPT";
const bodies = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  await new Promise((resolve) => {
    req.on("data", (chunk) => chunks.push(chunk));
    req.once("end", resolve);
    req.once("error", resolve);
  });
  bodies.push(Buffer.concat(chunks).toString("utf8"));
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason) => ({
    id: "rows-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason }],
  });
  res.write("data: " + JSON.stringify(chunk({ role: "assistant", content: "REPLYOK" }, null)) + "\n\n");
  res.write("data: " + JSON.stringify(chunk({}, "stop")) + "\n\n");
  res.end("data: [DONE]\n\n");
});
const delay = () => new Promise((resolve) => setTimeout(resolve, 40));
const tmux = (...args) =>
  execFileSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
const screen = () => tmux("capture-pane", "-p", "-t", "ui", "-S", "-200");
const send = (text) => tmux("send-keys", "-t", "ui", "-l", text);
const key = (...keys) => tmux("send-keys", "-t", "ui", ...keys);
async function waitFor(pattern) {
  for (let i = 0; i < 200; i++) {
    const text = screen();
    if (pattern.test(text)) return text;
    await delay();
  }
  throw new Error("UI did not show " + pattern + "\n" + screen());
}
async function command(text) {
  key("C-u");
  send(text);
  key("Enter");
  await delay();
}

// One entry per type, shaped like what each writer stores. The held router
// decision and the routine Jev answer are the quiet kinds that draw nothing.
const entries = [
  ["router-decision", { outcome: "escalated", from: "p/base", to: `p/${MARK}-big`, toThinking: "high", difficulty: 0.72, tier: "frontier", threshold: 0.6, boundary: true, contextTokens: 41000, latencyMs: 300 }],
  ["router-decision", { outcome: "held", from: `p/${HELD}`, difficulty: 0.1, tier: "base" }],
  ["router-playbook", { type: "debug", boundary: true }],
  ["jev-decision", { v: 1, feature: "guardrail", model: "jev-1.13.0", requestedModel: "jev-1.13.0", questions: [], answers: null, latencyMs: 3000, outcome: "error", errorClass: "timeout" }],
  ["jev-decision", { v: 1, feature: HELD, model: "jev-1.13.0", outcome: "ok", latencyMs: 10 }],
  ["jev-decision", { v: 1, feature: "done-gate", model: "jev-1.13.0", requestedModel: "jev-1.13.0", answers: { asserts_verified: { type: "noul", noul: 0.93 } }, latencyMs: 150, outcome: "ok" }],
  ["verifier-verdict", { verdict: "verified", head: "0123456789abcdef", patchId: "fedcba9876543210", base: "origin/main", at: "2026-11-17T10:00:00.000Z", id: "v1" }],
  ["prompt-coach-decision", { at: 1, version: 3, original: SECRET, candidate: SECRET, placed: SECRET, action: "rewritten", intentProbability: 0.81, filesRead: [`${SECRET}.md`], probe: { branch: SECRET }, model: "fixture", subscription: false, concise: false }],
];

const extension = path.join(fixture, "probe.ts");
try {
  for (const binary of ["pi", "tmux"])
    execFileSync(binary, [binary === "tmux" ? "-V" : "--version"], {
      stdio: "pipe",
      timeout: 10000,
    });
  await mkdir(cwd);
  await mkdir(agent);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "ui-local": {
          baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
          api: "openai-completions",
          apiKey: "fixture",
          models: [
            {
              id: "fixture",
              name: "Offline UI fixture",
              input: ["text"],
              contextWindow: 100000,
              maxTokens: 100,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    path.join(agent, "settings.json"),
    JSON.stringify({ quietStartup: true, retry: { enabled: false }, compaction: { enabled: false } }),
  );
  await writeFile(
    extension,
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n' +
      "const entries = " + JSON.stringify(entries) + ";\n" +
      "export default function (pi: ExtensionAPI) {\n" +
      '  pi.registerCommand("rows-probe", {\n' +
      '    description: "Append one decision entry of each type",\n' +
      "    handler: async () => {\n" +
      "      for (const [type, data] of entries) pi.appendEntry(type, data);\n" +
      "    },\n" +
      "  });\n" +
      "}\n",
  );

  tmux(
    "new-session", "-d", "-s", "ui", "-x", "110", "-y", "50", "-c", cwd,
    "/usr/bin/env", "-i",
    "PATH=" + process.env.PATH,
    "HOME=" + fixture,
    "XDG_CONFIG_HOME=" + fixture,
    "TERM=xterm-256color",
    "PI_CODING_AGENT_DIR=" + agent,
    "PI_CODING_AGENT_SESSION_DIR=" + path.join(fixture, "sessions"),
    "PI_OFFLINE=1",
    "PI_TELEMETRY=0",
    "pi", "--offline", "--no-extensions", "--no-mcp", "--no-context-files", "--no-skills",
    "--no-prompt-templates", "--no-themes", "--no-approve",
    "--provider", "ui-local", "--model", "fixture", "--thinking", "off",
    "-e", path.join(root, "packages/decision-rows/index.ts"),
    "-e", extension,
  );
  await waitFor(/fixture/);

  await command("/rows-probe");
  const rows = await waitFor(/prompt-coach rewritten/);
  for (const line of [
    new RegExp(`router escalated → ${MARK}-big@high · difficulty 0\\.72 · frontier`),
    /router playbook debug/,
    /jev guardrail failed: timeout · 3000ms/,
    /jev done-gate · asserts_verified 0\.93/,
    /verifier verified · at 0123456789ab/,
    /prompt-coach rewritten · intent 0\.81 · fixture/,
  ])
    assert.match(rows, line);
  assert.doesNotMatch(rows, new RegExp(HELD));
  assert.doesNotMatch(rows, new RegExp(SECRET));
  assert.doesNotMatch(rows, /patch id:/);
  if (process.env.SHOW_ROWS) console.log(rows.trimEnd());
  console.log("ok: six collapsed rows drawn, done-gate answer included; held router decision and routine Jev answer draw nothing");

  key("C-o");
  // 12 characters: the width shared/revision.mjs shortSha gives every hash.
  const expanded = await waitFor(/patch id: fedcba987654\b/);
  assert.match(expanded, /new task: yes/);
  assert.match(expanded, /files read: 1/);
  assert.doesNotMatch(expanded, new RegExp(SECRET));
  console.log("ok: ctrl+o adds detail lines, and prompt-coach text stays unprinted");

  await command("say hi");
  await waitFor(/REPLYOK/);
  assert.ok(bodies.length >= 1, "the provider received a request");
  const last = bodies.at(-1);
  assert.ok(last.includes("say hi"), "the captured request is the one for this prompt");
  for (const marker of [MARK, HELD, SECRET, "fedcba987654", "playbook debug"])
    assert.ok(!last.includes(marker), `request body leaked ${marker}`);
  console.log("ok: the next provider request carries no entry data and no row text");

  await command("/exit");
  await delay();
  tmux("kill-server");
  console.log(
    "Local real-TUI decision-rows acceptance passed at HEAD " +
      execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() +
      ".",
  );
} finally {
  try {
    tmux("kill-server");
  } catch {}
  server.close();
  await rm(fixture, { recursive: true, force: true });
}
