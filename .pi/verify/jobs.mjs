#!/usr/bin/env node
// Real Pi TUI/PTY acceptance, using tmux only as an isolated test terminal.
// No personal config, provider credentials or external requests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { revisionSnapshot } from "../../shared/revision.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const fixture = await mkdtemp(path.join(tmpdir(), "pi-jobs-ui-"));
const cwd = path.join(fixture, "workspace");
const agent = path.join(fixture, "agent");
const socket = "pi-jobs-" + process.pid;
const owned = new Set();
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  req.resume();
  res.writeHead(500);
  res.end("This human-only acceptance must not call a model.");
});
const pause = () => new Promise((done) => setTimeout(done, 50));
const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], {
  encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
});
const screen = () => tmux("capture-pane", "-p", "-t", "jobs");
const send = (text) => tmux("send-keys", "-t", "jobs", "-l", text);
const key = (...keys) => tmux("send-keys", "-t", "jobs", ...keys);
async function waitFor(pattern, absent = false) {
  for (let i = 0; i < 120; i++) {
    const text = screen();
    if (pattern.test(text) !== absent) return text;
    await pause();
  }
  throw new Error("UI did not show " + pattern + "\n" +
    tmux("capture-pane", "-p", "-t", "jobs", "-S", "-150"));
}
async function command(text) {
  key("C-u");
  send(text);
  key("Enter");
  await pause();
}
async function launch(commandText, pty = false) {
  await command("/jobs " + (pty ? "pty " : "run ") + commandText);
  const text = await waitFor(/Job [a-f\d]{8} started/);
  const matches = [...text.matchAll(/Job ([a-f\d]{8}) started/g)];
  return matches.at(-1)[1];
}
async function pidFile(file) {
  for (let i = 0; i < 100; i++) {
    try {
      const pid = Number(await readFile(path.join(cwd, file), "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        owned.add(pid);
        return pid;
      }
    } catch {}
    await pause();
  }
  throw new Error("No fixture pid in " + file);
}
async function gone(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); }
    catch (error) {
      assert.equal(error.code, "ESRCH");
      owned.delete(pid);
      return;
    }
    await pause();
  }
  throw new Error("Owned fixture process survived: " + pid);
}
const git = (...args) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", timeout: 10000,
});

try {
  for (const binary of ["pi", "tmux", "git"])
    execFileSync(binary, [binary === "tmux" ? "-V" : "--version"], { timeout: 10000 });
  await mkdir(cwd);
  await mkdir(agent);
  await writeFile(path.join(cwd, "seed.txt"), "fixture\n");
  git("init", "-q");
  git("add", ".");
  git("-c", "commit.gpgsign=false", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid", "commit", "-qm", "test: seed jobs fixture");
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: {
    "jobs-local": {
      baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
      api: "openai-completions", apiKey: "fixture",
      models: [{
        id: "fixture", name: "Offline jobs fixture", input: ["text"],
        contextWindow: 100000, maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    },
  } }));
  await writeFile(path.join(agent, "settings.json"),
    JSON.stringify({ quietStartup: true, retry: { enabled: false }, compaction: { enabled: false } }));
  tmux("new-session", "-d", "-s", "jobs", "-x", "100", "-y", "35", "-c", cwd,
    "/usr/bin/env", "-i", "PATH=" + process.env.PATH, "HOME=" + fixture,
    "XDG_CONFIG_HOME=" + fixture, "TERM=xterm-256color", "PI_OFFLINE=1", "PI_TELEMETRY=0",
    "PI_CODING_AGENT_DIR=" + agent, "PI_CODING_AGENT_SESSION_DIR=" + path.join(fixture, "sessions"),
    "pi", "--offline", "--no-extensions", "--no-mcp", "--no-context-files",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-approve",
    "--provider", "jobs-local", "--model", "fixture", "--thinking", "off",
    "-e", path.join(root, "packages/jobs/index.ts"),
    "-e", path.join(root, "packages/footer/index.ts"),
    "-e", path.join(root, "packages/exit/index.ts"));
  await waitFor(/ready/);

  const logs = await launch(
    "printf 'START_LOG\\n'; for i in {1..80}; do printf 'log-%s\\n' \"$i\"; done; sleep 0.2; printf 'END_LOG\\n'");
  await command("/jobs " + logs);
  await waitFor(/END_LOG/);
  key("Home");
  await waitFor(/START_LOG/);
  key("End");
  await waitFor(/END_LOG/);
  tmux("resize-window", "-t", "jobs", "-x", "65", "-y", "20");
  await waitFor(/END_LOG/);
  key("Escape");
  await waitFor(/Job [a-f\d]{8} —/, true);
  console.log("ok: real Pi live logs follow, scroll, resize and cancel without model calls");

  tmux("resize-window", "-t", "jobs", "-x", "100", "-y", "35");
  const terminal = await launch(
    'test -t 0 || exit 88; printf "$$" > terminal.pid; stty -echo; printf "TTY_READY\\n"; ' +
    'while IFS= read -r answer; do if [[ "$answer" == exit ]]; then exit 7; fi; stty size; printf "SAME_TTY:%s\\n" "$answer"; done',
    true);
  const terminalPid = await pidFile("terminal.pid");
  await command("/jobs " + terminal);
  await waitFor(/TTY_READY/);
  key("a");
  await waitFor(/Ctrl\+\] detaches/);
  send("alpha"); key("Enter");
  await waitFor(/SAME_TTY:alpha/);
  tmux("resize-window", "-t", "jobs", "-x", "80", "-y", "26");
  // Wait for propagated dimensions, not a fixed sleep against async SIGWINCH/stty.
  for (let i = 0; i < 100 && !/26 80/.test(screen()); i++) {
    send("size-probe"); key("Enter");
    await pause();
  }
  await waitFor(/26 80/);
  send("beta"); key("Enter");
  await waitFor(/SAME_TTY:beta/);
  key("C-]");
  await waitFor(/Job [a-f\d]{8} —/);
  key("a");
  await waitFor(/Ctrl\+\] detaches/);
  send("gamma"); key("Enter");
  await waitFor(/SAME_TTY:gamma/);
  assert.equal(Number(await readFile(path.join(cwd, "terminal.pid"), "utf8")), terminalPid);
  send("exit"); key("Enter");
  await waitFor(/exited \(exit 7\)/);
  await gone(terminalPid);
  key("Escape");
  await waitFor(/Job [a-f\d]{8} —/, true);
  console.log("ok: same PTY accepts native input, resize, detach/reattach and preserves exit 7");

  const interrupt = await launch('printf INTERRUPT_READY; exec sleep 30', true);
  await command("/jobs " + interrupt);
  await waitFor(/INTERRUPT_READY/);
  key("a");
  await waitFor(/Ctrl\+\] detaches/);
  key("C-c");
  const interrupted = await waitFor(/exited \(exit [1-9]\d*\)/);
  assert.match(interrupted, /Job [a-f\d]{8} —/);
  key("Escape");
  await waitFor(/Job [a-f\d]{8} —/, true);
  console.log("ok: Ctrl+C reaches the foreground PTY program and returns to a live Pi");

  const pipe = await launch('printf PIPE_READY; read answer; printf "PIPE_GOT:%s\\n" "$answer"; exit 7');
  await command("/jobs " + pipe);
  await waitFor(/PIPE_READY/);
  key("i");
  await waitFor(/Send one line/);
  send("human"); key("Enter");
  await waitFor(/PIPE_GOT:human/);
  await waitFor(/exited \(exit 7\)/);
  key("Escape");
  await waitFor(/Job [a-f\d]{8} —/, true);
  console.log("ok: explicit human line input reaches the owned pipe job");

  await launch('printf "$$" > reload.pid; exec sleep 30', true);
  const reloadPid = await pidFile("reload.pid");
  await command("/reload");
  await gone(reloadPid);
  await command("/jobs");
  await waitFor(/No jobs/);
  await launch('printf "$$" > session.pid; exec sleep 30');
  const sessionPid = await pidFile("session.pid");
  await command("/new");
  await gone(sessionPid);
  await command("/jobs");
  await waitFor(/No jobs/);
  await launch('printf "$$" > shutdown.pid; exec sleep 30');
  const shutdownPid = await pidFile("shutdown.pid");
  await command("/exit");
  await gone(shutdownPid);
  assert.equal(requests, 0, "human controls must not make unsolicited model requests");
  console.log("ok: reload, session changes and shutdown stop owned processes without model calls");
  const revision = await revisionSnapshot(root);
  console.log("Local real-TUI jobs acceptance passed at HEAD " + revision.head.slice(0, 7) +
    " plus working tree " + revision.fingerprint + ".");
} finally {
  try { tmux("kill-server"); } catch {}
  for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch {} }
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(fixture, { recursive: true, force: true });
}
