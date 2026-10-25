import test from "node:test";
import assert from "node:assert/strict";
import { Jobs } from "../jobs.mjs";
import { setTimeout as delay } from "node:timers/promises";

test("background commands return immediately and preserve their actual failure and output", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const job = await jobs.start({
    command: "sleep 0.1; printf 'background output'; exit 7",
    cwd: process.cwd(),
  });
  assert.equal(job.status, "running");
  assert.equal(job.exit_code, null);
  const finished = await jobs.wait(job.id, { timeoutMs: 3000 });
  assert.equal(finished.status, "exited");
  assert.equal(finished.exit_code, 7);
  assert.equal(finished.output, "background output");
  jobs.forget(job.id);
  assert.equal(jobs.list().length, 0);
  assert.throws(() => jobs.read(job.id), /Unknown job/);
});

test("waiting for an exited check also waits for its revision evidence", async (t) => {
  const revision = { head: "head", fingerprint: "same" };
  let finishSnapshot,
    calls = 0;
  const pending = new Promise((done) => {
    finishSnapshot = done;
  });
  const jobs = new Jobs({
    snapshot: async () => {
      if (calls++) await pending;
      return revision;
    },
  });
  t.after(async () => {
    finishSnapshot();
    await jobs.shutdown();
  });
  const job = await jobs.start({ command: "node --test missing.test.mjs" });
  for (let i = 0; i < 100 && jobs.read(job.id).status === "running"; i++) await delay(10);
  assert.equal(jobs.read(job.id).status, "exited");
  let returned = false;
  const waiting = jobs.wait(job.id, { timeoutMs: 3000 }).then(() => {
    returned = true;
  });
  await delay(20);
  assert.equal(
    returned,
    false,
    "an exit without its final revision is not a completed observation",
  );
  finishSnapshot();
  await waiting;
  assert.deepEqual(jobs.evidence(job.id).after, revision);
});

test("completion also reaps background children that ignore TERM and hold no output pipe", async (t) => {
  const jobs = new Jobs();
  let pid;
  t.after(async () => {
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await jobs.shutdown();
  });
  const program = String.raw`
    const {spawn}=require("node:child_process");
    const child=spawn("/bin/bash",["-c",'trap "" TERM; printf "$$" >&3; exec sleep 30'],
      {stdio:["ignore","ignore","ignore","pipe"]});
    child.stdio[3].once("data",data=>process.stdout.write(data,()=>process.exit(0)));
  `;
  const job = await jobs.start({ command: "node -e '" + program.replaceAll("'", "'\\''") + "'" });
  await jobs.wait(job.id, { timeoutMs: 3000 });
  pid = Number(jobs.read(job.id).output);
  assert.ok(Number.isInteger(pid) && pid > 0);
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await delay(10);
  }
  assert.fail("The owned process group survived completion");
});

async function outputContains(jobs, id, text) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (jobs.read(id).output.includes(text)) return;
    await delay(20);
  }
  assert.fail("Job did not output " + text + ": " + jobs.read(id).output);
}

test("cleanup errors remain visible without rejecting lifecycle listeners or hanging shutdown", async (t) => {
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid, signal) => {
    if (pid < 0 && signal === "SIGKILL")
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return kill(pid, signal);
  });
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const job = await jobs.start({ command: "true" });
  const result = await jobs.wait(job.id, { timeoutMs: 3000 });
  assert.equal(result.status, "exited");
  assert.equal(result.exit_code, 0);
  assert.equal(result.cleanup_error, "kill EPERM");
  await jobs.shutdown();
});

test("line input reaches the same process and disqualifies verification evidence", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const job = await jobs.start({
    command: "printf ready; read answer; printf 'got:%s' \"$answer\"",
  });
  await outputContains(jobs, job.id, "ready");
  await jobs.send(job.id, { text: "hello", keys: ["enter"] });
  const result = await jobs.wait(job.id, { timeoutMs: 3000 });
  assert.equal(result.exit_code, 0);
  assert.equal(result.output, "readygot:hello");
  assert.equal(jobs.evidence(job.id).interacted, true);
  await assert.rejects(jobs.send(job.id, { text: "another command" }), /not running/i);
});

test(
  "native PTYs support terminal-only input, real failure codes and resizing",
  {
    skip: !["darwin", "linux"].includes(process.platform),
  },
  async (t) => {
    const jobs = new Jobs();
    t.after(() => jobs.shutdown());
    const job = await jobs.start({
      pty: true,
      command:
        "test -t 0 || exit 88; printf 'PTY ready\\n'; read answer; stty size; printf 'got:%s\\n' \"$answer\"; exit 9",
    });
    await outputContains(jobs, job.id, "PTY ready");
    await jobs.resize(job.id, 90, 25);
    jobs.takeover(job.id);
    await assert.rejects(jobs.send(job.id, { text: "agent" }), /human/i);
    await jobs.humanInput(job.id, "native\n");
    jobs.release(job.id);
    const result = await jobs.wait(job.id, { timeoutMs: 3000 });
    assert.equal(result.status, "exited");
    assert.equal(result.exit_code, 9);
    assert.match(result.output, /25 90/);
    assert.match(result.output, /got:native/);
    assert.equal(result.interacted, true);
  },
);

test(
  "stop reaps the PTY foreground group even when it ignores terminal hangup",
  {
    skip: !["darwin", "linux"].includes(process.platform),
  },
  async (t) => {
    const jobs = new Jobs();
    let pid;
    t.after(async () => {
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await jobs.shutdown();
    });
    const job = await jobs.start({
      pty: true,
      command: 'trap "" HUP TERM; printf "foreground:%s\\n" "$$"; exec sleep 30',
    });
    await outputContains(jobs, job.id, "foreground:");
    pid = Number(jobs.read(job.id).output.match(/foreground:(\d+)/)[1]);
    await jobs.stop(job.id);
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(pid, 0);
      } catch (error) {
        assert.equal(error.code, "ESRCH");
        return;
      }
      await delay(10);
    }
    assert.fail("The owned PTY foreground process survived stop");
  },
);

test("output is bounded and terminal controls cannot execute in the log viewer", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const job = await jobs.start({
    command: "printf '%70000s' x; printf '\\033[31mred\\033[0m\\033]52;c;ignored\\007'",
  });
  const result = await jobs.wait(job.id, { timeoutMs: 3000 });
  assert.equal(result.status, "exited");
  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= 64000);
  assert.ok(result.output.endsWith("xred"));
  assert.ok(!result.output.includes(String.fromCharCode(27)));
  assert.ok(!result.output.includes("ignored"));
});

test("stop terminates the owned process group, including an inherited-pipe child", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const job = await jobs.start({ command: "sleep 30 & printf 'child:%s\\n' \"$!\"; wait" });
  await outputContains(jobs, job.id, "child:");
  const pid = Number(jobs.read(job.id).output.match(/child:(\d+)/)[1]);
  const result = await jobs.stop(job.id);
  assert.equal(result.status, "stopped");
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await delay(20);
  }
  assert.fail("A child process survived stop");
});

test("a shell cannot leave an untracked background child holding the job open", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const job = await jobs.start({ command: "sleep 30 & printf done" });
  const result = await jobs.wait(job.id, { timeoutMs: 1500 });
  assert.equal(result.status, "exited");
  assert.equal(result.exit_code, 0);
  assert.equal(result.output, "done");
});

test("invalid starts, unknown keys and cancellation fail without launching extra work", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  await assert.rejects(jobs.start({ command: "" }), /command/i);
  await assert.rejects(jobs.start({ command: "pwd", cwd: "/no-such-pi-jobs-directory" }), /ENOENT/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(jobs.start({ command: "sleep 30", signal: controller.signal }), /abort/i);
  const job = await jobs.start({ command: "read answer; printf '%s' \"$answer\"" });
  await assert.rejects(jobs.send(job.id, { text: "not sent", keys: ["invalid-key"] }), /key/i);
  await assert.rejects(jobs.send(job.id, { keys: Array(17).fill("enter") }), /key/i);
  assert.equal(jobs.read(job.id).interacted, false);
  await jobs.send(job.id, { text: "only", keys: ["enter"] });
  assert.equal((await jobs.wait(job.id, { timeoutMs: 3000 })).output, "only");
});

test("parallel starts reserve shared running and retained-job limits", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const running = await Promise.all(
    Array.from({ length: 4 }, () => jobs.start({ command: "read answer" })),
  );
  assert.equal(jobs.list().length, 4);
  await assert.rejects(jobs.start({ command: "true" }), /4 running/);
  assert.throws(() => jobs.forget(running[0].id), /Stop/);
  await Promise.all(running.map((job) => jobs.stop(job.id)));
  for (let i = 4; i < 20; i++) {
    const job = await jobs.start({ command: "true" });
    await jobs.wait(job.id, { timeoutMs: 3000 });
  }
  assert.equal(jobs.list().length, 20);
  await assert.rejects(jobs.start({ command: "true" }), /20 job/);
  jobs.forget(running[0].id);
  const replacement = await jobs.start({ command: "true" });
  await jobs.wait(replacement.id, { timeoutMs: 3000 });
  assert.equal(jobs.list().length, 20);
});

test("shutdown during revision capture cancels launch and cannot leak a process", async () => {
  let release;
  const snapshot = new Promise((done) => (release = done));
  const jobs = new Jobs({ snapshot: () => snapshot });
  const starting = jobs.start({ command: "npm test" });
  const failed = assert.rejects(starting, /closed/i);
  const stopping = jobs.shutdown();
  release(null);
  await Promise.all([failed, stopping]);
  assert.equal(jobs.list().length, 0);
  await assert.rejects(jobs.start({ command: "true" }), /closed/i);
});
