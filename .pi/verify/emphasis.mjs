#!/usr/bin/env node
// Isolated real-terminal acceptance for pi-emphasis. Requires pi, tmux and git on PATH.
// A local fixture model replies with pills; the drawn screen and the request's
// system prompt are checked with the extension on, then with PI_EMPHASIS=0.
// No personal configuration, credentials, external providers or session edits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const fixture = await mkdtemp(path.join(tmpdir(), "pi-emphasis-ui-"));
const cwd = path.join(fixture, "workspace");
const agent = path.join(fixture, "agent");
const socket = "pi-emphasis-" + process.pid;
const ESC = String.fromCharCode(27);
const REPLY = "**Cause:** [[Failed: 3 tests]] then [[Passed on CI]], literal `[[Done]]` stays.";
const RULE = "Pills are required, not optional.";
let sawRule = [];

const server = createServer(async (req, res) => {
  // Read the request only to learn whether the rule reached the prompt; never log it.
  let body = "";
  req.setEncoding("utf8");
  for await (const chunk of req) body += chunk;
  sawRule.push(body.includes(RULE));
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason) => ({
    id: "emphasis-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason }],
  });
  res.write("data: " + JSON.stringify(chunk({ role: "assistant", content: REPLY }, null)) + "\n\n");
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
const screen = (escapes = false) =>
  tmux("capture-pane", "-p", ...(escapes ? ["-e"] : []), "-t", "ui");
async function waitFor(pattern) {
  for (let i = 0; i < 200; i++) {
    const text = screen();
    if (pattern.test(text)) return text;
    await delay();
  }
  throw new Error("UI did not show " + pattern + "\n" + screen());
}

/** Start pi in tmux with `env`, send one prompt, and return the plain and escaped reply line. */
async function run(env) {
  sawRule = [];
  tmux(
    "new-session",
    "-d",
    "-s",
    "ui",
    "-x",
    "120",
    "-y",
    "30",
    "-c",
    cwd,
    "/usr/bin/env",
    "-i",
    "PATH=" + process.env.PATH,
    "HOME=" + fixture,
    "XDG_CONFIG_HOME=" + fixture,
    "TERM=xterm-256color",
    "PI_CODING_AGENT_DIR=" + agent,
    "PI_CODING_AGENT_SESSION_DIR=" + path.join(fixture, "sessions"),
    "PI_OFFLINE=1",
    "PI_TELEMETRY=0",
    ...env,
    "pi",
    "--offline",
    "--no-extensions",
    "--no-mcp",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-approve",
    "--provider",
    "emphasis-local",
    "--model",
    "fixture",
    "--thinking",
    "off",
    "--tui-mode",
    "regular",
    "-e",
    path.join(root, "packages/emphasis/index.ts"),
  );
  await waitFor(/fixture/);
  tmux("send-keys", "-t", "ui", "-l", "show the pills");
  tmux("send-keys", "-t", "ui", "Enter");
  const plain = await waitFor(/stays\./);
  const line = (text) => text.split("\n").find((row) => row.includes("stays.")) ?? "";
  // Pills join their words with no-break spaces so they cannot wrap; compare as plain spaces.
  const result = { plain: line(plain).replaceAll(" ", " "), escaped: line(screen(true)), sawRule: sawRule.slice() };
  tmux("kill-session", "-t", "ui");
  return result;
}

try {
  for (const binary of ["pi", "tmux", "git"])
    execFileSync(binary, [binary === "tmux" ? "-V" : "--version"], { stdio: "pipe", timeout: 10000 });
  await mkdir(cwd);
  await mkdir(agent);
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    path.join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "emphasis-local": {
          baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
          api: "openai-completions",
          apiKey: "fixture",
          models: [
            {
              id: "fixture",
              name: "Offline emphasis fixture",
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
    JSON.stringify({
      quietStartup: true,
      theme: "dark",
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );

  const on = await run([]);
  assert.deepEqual(on.sawRule, [true], "the reply_style section reached the model");
  assert.ok(on.plain.includes(" Failed: 3 tests"), "pill drawn with its icon: " + on.plain);
  assert.ok(on.plain.includes(" Passed on CI"), "detail kept: " + on.plain);
  assert.ok(on.plain.includes(" Cause:"), "lead label icon: " + on.plain);
  assert.ok(!on.plain.includes("[[Failed"), "pill markers replaced: " + on.plain);
  assert.ok(on.plain.includes("[[Done]]"), "inline code left alone: " + on.plain);
  // The style just before each pill's text: a panel background on a theme with one,
  // otherwise reverse video. Failed and Passed must not look alike.
  const style = (word) => {
    const at = on.escaped.indexOf(word);
    return at < 0 ? "" : on.escaped.slice(Math.max(0, at - 40), at);
  };
  for (const word of ["Failed", "Passed"])
    assert.ok(style(word).includes(ESC + "[48;"), word + " pill has a panel background");
  assert.notEqual(style("Failed"), style("Passed"), "tones are colored apart");
  console.log("ok: pills, label icons and the reply_style section in a real TUI");

  const off = await run(["PI_EMPHASIS=0"]);
  assert.deepEqual(off.sawRule, [false], "no reply_style section with PI_EMPHASIS=0");
  assert.ok(off.plain.includes("[[Failed: 3 tests]]"), "pills left as typed: " + off.plain);
  console.log("ok: PI_EMPHASIS=0 leaves replies and the prompt untouched");

  const head = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  }).trim();
  console.log("Local real-TUI emphasis acceptance passed at HEAD " + head + " (plus working tree)");
} finally {
  try {
    tmux("kill-server");
  } catch {
    /* Server may already have exited. */
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
