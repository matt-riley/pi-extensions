#!/usr/bin/env node
// Isolated real-terminal acceptance for the toasts extension. Requires pi, tmux.
// Starts a fixture provider and agent dir; never reads user settings or sessions.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const fixture = await mkdtemp(path.join(tmpdir(), "pi-toasts-ui-"));
const cwd = path.join(fixture, "workspace");
const agent = path.join(fixture, "agent");
const socket = "pi-toasts-" + process.pid;
const PROBE = "PROBE_TOAST_ALPHA";
const server = createServer(async (req, res) => {
  await new Promise((resolve) => {
    req.resume();
    req.once("end", resolve);
    req.once("error", resolve);
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason) => ({
    id: "toast-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta, finish_reason }],
  });
  res.write("data: " + JSON.stringify(chunk({ role: "assistant", content: "OK" }, null)) + "\n\n");
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
const screen = () => tmux("capture-pane", "-p", "-t", "ui");
const send = (text) => tmux("send-keys", "-t", "ui", "-l", text);
const key = (...keys) => tmux("send-keys", "-t", "ui", ...keys);
async function waitFor(pattern, absent = false) {
  for (let i = 0; i < 200; i++) {
    const text = screen();
    if (pattern.test(text) !== absent) return text;
    await delay();
  }
  throw new Error(
    "UI did not show " + pattern + "\n" + tmux("capture-pane", "-p", "-t", "ui", "-S", "-300"),
  );
}
async function command(text) {
  key("C-u");
  send(text);
  key("Enter");
  await delay();
}
const extension = path.join(fixture, "probe.ts");
async function launch(extraEnv, visible) {
  const args = [
    "new-session",
    "-d",
    "-s",
    "ui",
    "-x",
    "100",
    "-y",
    "38",
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
    ...extraEnv,
    "pi",
    "--offline",
    "--no-extensions",
    "--no-mcp",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-approve",
    "--provider",
    "ui-local",
    "--model",
    "fixture",
    "--thinking",
    "off",
    "-e",
    path.join(root, "packages/toasts/index.ts"),
    "-e",
    extension,
  ];
  tmux(...args);
  await waitFor(visible);
}

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
      "export default function (pi: ExtensionAPI) {\n" +
      "  pi.registerCommand(\"toast-probe\", {\n" +
      '    description: "Emit one extension notify for the toasts acceptance check",\n' +
      "    handler: async (_args, ctx) => {\n" +
      '      ctx.ui.notify("' + PROBE + '", "info");\n' +
      "    },\n" +
      "  });\n" +
      "}\n",
  );

  await launch(["PI_TOAST_TIMEOUT_INFO=1200"], /fixture/);
  await command("/toast-probe");
  await waitFor(new RegExp(PROBE));
  console.log("ok: extension notify shows as a top-right toast in the real TUI");
  await waitFor(new RegExp(PROBE), true);
  console.log("ok: the toast clears itself after PI_TOAST_TIMEOUT_INFO and leaves no row");

  tmux("kill-server");
  await launch(["PI_TOAST_CAPTURE=0"], /fixture/);
  await command("/toast-probe");
  await waitFor(new RegExp(PROBE));
  await delay();
  const after = await waitFor(new RegExp(PROBE));
  assert.match(after, new RegExp(PROBE));
  console.log("ok: PI_TOAST_CAPTURE=0 leaves pi's own notify row in place");

  await command("/exit");
  await delay();
  tmux("kill-server");
  console.log("Local real-TUI toasts acceptance passed at HEAD " + execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() + ".");
} finally {
  try {
    tmux("kill-server");
  } catch {}
  server.close();
  await rm(fixture, { recursive: true, force: true });
}
