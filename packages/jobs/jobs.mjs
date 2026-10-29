import { spawnJob, resizePty } from "./process.mjs";
import { EventEmitter, once } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { revisionSnapshot } from "../../shared/revision.mjs";
import { isVerifyCommand } from "../done-gate/gate.mjs";

const MAX_OUTPUT = 64_000;
const MAX_JOBS = 20;
const textOutput = (text) =>
  stripVTControlCharacters(text)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/\p{Cc}/gu, (char) => (char === "\n" || char === "\t" ? char : ""));

/** Session-owned processes. Views are copies; child handles never enter tool results. */
export class Jobs extends EventEmitter {
  #jobs = new Map();
  #closed = false;
  #pending = new Set();
  #snapshot;

  constructor({ snapshot = revisionSnapshot } = {}) {
    super();
    this.#snapshot = snapshot;
  }

  #get(id) {
    const job = this.#jobs.get(id);
    if (!job) throw new Error("Unknown job: " + id);
    return job;
  }

  read(id) {
    const job = this.#get(id);
    return {
      id: job.id,
      command: job.command,
      cwd: job.cwd,
      pty: job.pty,
      status: job.status,
      exit_code: job.exit_code,
      signal: job.signal,
      output: textOutput(job.output),
      truncated: job.truncated,
      interacted: job.interacted,
      owner: job.owner,
      watch: job.watch,
      notify: job.notify,
      cleanup_error: job.cleanup_error,
    };
  }

  list() {
    return [...this.#jobs.keys()].map((id) => this.read(id));
  }

  evidence(id) {
    const job = this.#get(id);
    return structuredClone({
      version: 1,
      ...this.read(id),
      before: job.before,
      after: job.after,
    });
  }

  start(params) {
    const pending = this.#start(params);
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending)).catch(() => {});
    return pending;
  }

  async #start({ command, cwd, pty = false, watch, notify = true, signal } = {}) {
    signal?.throwIfAborted();
    if (this.#closed) throw new Error("This job session is closed.");
    if (typeof command !== "string" || !command.trim() || command.length > 10_000)
      throw new Error("Supply a command of 1–10000 characters.");
    if (typeof pty !== "boolean" || typeof notify !== "boolean")
      throw new Error("pty and notify must be booleans.");
    if (watch !== undefined && (typeof watch !== "string" || !watch.trim() || watch.length > 500))
      throw new Error("A watch condition must contain 1–500 characters.");
    if (this.#jobs.size >= MAX_JOBS) throw new Error("Close a finished job first (20 job limit).");
    if (this.list().filter((job) => job.status === "running").length >= 4)
      throw new Error("Stop a running job first (4 running job limit).");
    const job = {
      id: randomUUID().slice(0, 8),
      command,
      cwd: resolve(cwd ?? process.cwd()),
      pty,
      watch: watch ?? null,
      notify,
      status: "running",
      exit_code: null,
      signal: null,
      cleanup_error: null,
      output: "",
      truncated: false,
      interacted: false,
      owner: "agent",
      before: null,
      after: null,
    };
    // Reserve before awaiting: parallel starts must share the same limits.
    this.#jobs.set(job.id, job);
    try {
      if (isVerifyCommand(command)) job.before = await this.#snapshot(job.cwd);
      signal?.throwIfAborted();
      if (this.#closed) throw new Error("This job session is closed.");
      let finish;
      job.finished = new Promise((done) => (finish = done));
      const child = spawnJob(job);
      let ttyReady;
      const ready = new Promise((done) => (ttyReady = done));
      if (pty) {
        let metadata = "";
        const receive = (chunk) => {
          metadata += chunk;
          if (!metadata.includes("\n") && metadata.length < 128) return;
          child.stdio[3].removeListener("data", receive);
          const match = metadata.match(/^(\/dev\/(?:ttys\d+|pts\/\d+)) ([1-9]\d*)\n/);
          if (match) {
            job.tty = match[1];
            job.ptyPid = Number(match[2]);
          }
          ttyReady(Boolean(match));
        };
        child.stdio[3].setEncoding("utf8").on("data", receive);
      }
      job.child = child;
      const append = (chunk) => {
        const text = String(chunk);
        job.output += text;
        if (job.output.length > MAX_OUTPUT) {
          job.output = job.output.slice(-MAX_OUTPUT);
          job.truncated = true;
        }
        this.emit("output", { id: job.id, text });
        this.emit("change", this.read(job.id));
      };
      child.stdout.setEncoding("utf8").on("data", append);
      child.stderr.setEncoding("utf8").on("data", append);
      child.stdin.on("error", () => {}); // write callbacks report EPIPE to the caller.
      child.once("error", (error) => append(error.message));
      child.once("exit", () => {
        // A completed shell may have left a child holding stdout open.
        this.#kill(job, "SIGTERM");
        job.killTimer ??= setTimeout(() => this.#kill(job, "SIGKILL"), 500);
      });
      child.once("close", async (code, exitSignal) => {
        ttyReady(false);
        this.#kill(job, "SIGKILL"); // No forgotten TERM-resistant descendants, even without open pipes.
        clearTimeout(job.killTimer);
        job.exit_code = code;
        job.signal = exitSignal;
        job.status = job.stopping ? "stopped" : "exited";
        if (job.before) {
          try {
            job.after = await this.#snapshot(job.cwd);
          } catch {
            job.after = null;
          }
        }
        finish();
        if (this.#jobs.has(job.id)) {
          this.emit("change", this.read(job.id));
          this.emit("exit", this.read(job.id));
        }
      });
      await once(child, "spawn");
      if (pty) {
        let timer;
        try {
          const initialized = await Promise.race([
            ready,
            new Promise((done) => (timer = setTimeout(() => done(false), 2000))),
          ]);
          if (!initialized)
            throw new Error(
              "PTY initialization failed; script is required. " + textOutput(job.output),
            );
        } finally {
          clearTimeout(timer);
        }
      }
      signal?.throwIfAborted();
      this.emit("change", this.read(job.id));
      return this.read(job.id);
    } catch (error) {
      if (job.child?.pid) await this.stop(job.id);
      this.#jobs.delete(job.id);
      throw error;
    }
  }

  async wait(id, { timeoutMs = 0, signal } = {}) {
    const job = this.#get(id);
    signal?.throwIfAborted();
    if (job.finished && timeoutMs > 0) {
      let timer, abort;
      try {
        await Promise.race([
          job.finished,
          new Promise((done, reject) => {
            timer = setTimeout(done, timeoutMs);
            abort = () => reject(signal.reason);
            signal?.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    }
    signal?.throwIfAborted();
    return this.read(id);
  }

  #kill(job, signal) {
    if (!job.child?.pid) return; // Failed spawns still emit close.
    let failure;
    for (const pid of [job.child.pid, job.ptyPid].filter(Boolean)) {
      try {
        if (process.platform === "win32") job.child.kill(signal);
        else process.kill(-pid, signal);
      } catch (error) {
        // ESRCH: already gone. EPERM: the target is one of our own children whose
        // leader has exited but not been reaped yet — macOS refuses to signal a
        // zombie group. Nothing is left to kill, and the close-time sweep below
        // still reaps any surviving descendants.
        if (error.code === "ESRCH" || error.code === "EPERM") continue;
        job.cleanup_error = error.message;
        failure ??= error;
      }
    }
    return failure;
  }

  async send(id, { text = "", keys = [] } = {}) {
    const job = this.#get(id);
    if (job.owner === "human") throw new Error("This job is under human control.");
    const values = {
      enter: "\n",
      tab: "\t",
      esc: "\x1b",
      backspace: "\x7f",
      "ctrl+c": "\x03",
      "ctrl+d": "\x04",
      "ctrl+z": "\x1a",
      up: "\x1b[A",
      down: "\x1b[B",
      right: "\x1b[C",
      left: "\x1b[D",
    };
    if (!Array.isArray(keys) || keys.length > 16 || keys.some((key) => !Object.hasOwn(values, key)))
      throw new Error("Unknown terminal key.");
    if (typeof text !== "string" || text.length > 8192 || (!text && !keys.length))
      throw new Error("Supply input of at most 8192 characters or terminal keys.");
    await this.#write(job, text + keys.map((key) => values[key]).join(""));
    return this.read(id);
  }

  async #write(job, text) {
    if (job.status !== "running") throw new Error("The job is not running.");
    job.interacted = true;
    await new Promise((done, reject) =>
      job.child.stdin.write(text, (error) => (error ? reject(error) : done())),
    );
    this.emit("change", this.read(job.id));
  }

  takeover(id) {
    const job = this.#get(id);
    if (!job.pty || job.status !== "running") throw new Error("Takeover needs a running PTY job.");
    job.owner = "human";
    job.interacted = true;
    this.emit("change", this.read(id));
  }

  release(id) {
    const job = this.#get(id);
    job.owner = "agent";
    this.emit("change", this.read(id));
  }

  async humanInput(id, text) {
    const job = this.#get(id);
    if (job.owner !== "human") throw new Error("Take over the job before typing.");
    await this.#write(job, text);
  }

  async resize(id, columns, rows) {
    const job = this.#get(id);
    if (!job.tty || job.status !== "running") return;
    await resizePty(job.tty, columns, rows);
  }

  async stop(id, { force = false } = {}) {
    const job = this.#get(id);
    if (job.owner === "human" && !force) throw new Error("This job is under human control.");
    if (job.status !== "running") {
      await job.finished;
      return this.read(id);
    }
    if (!job.child?.pid) throw new Error("The job is still starting.");
    job.stopping = true;
    const error = this.#kill(job, "SIGTERM");
    if (error) throw error;
    job.killTimer ??= setTimeout(() => this.#kill(job, "SIGKILL"), 500);
    let timer;
    try {
      await Promise.race([
        job.finished,
        new Promise((_done, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Could not stop the owned process group: " +
                    (job.cleanup_error ?? "no completion received"),
                ),
              ),
            2500,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this.read(id);
  }

  forget(id) {
    const job = this.#get(id);
    if (job.status === "running" || job.owner === "human")
      throw new Error("Stop the job and release human control before closing it.");
    this.#jobs.delete(id);
    this.emit("change", null);
  }

  async shutdown() {
    this.#closed = true;
    await Promise.allSettled(this.#pending);
    await Promise.all([...this.#jobs.keys()].map((id) => this.stop(id, { force: true })));
  }
}
