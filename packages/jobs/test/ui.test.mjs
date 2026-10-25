import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { showLogs, openJobs } from "../ui.mjs";
import { Jobs } from "../jobs.mjs";
import { terminal, widgets } from "../../workbench/test/ui-fixture.mjs";

test("live logs follow, pause for navigation, resize and release their subscription", async () => {
  const jobs = new EventEmitter();
  const job = {
    id: "a",
    command: "run server",
    status: "running",
    pty: false,
    output: Array.from({ length: 50 }, (_, i) => "line " + i).join("\n"),
  };
  jobs.read = () => ({ ...job });
  const state = { follow: true, offset: 0 };
  const t = terminal([
    (component, render) => {
      assert.ok(render().some((line) => line.includes("line 49")));
      component.handleInput("home");
      assert.ok(render().some((line) => line === "line 0"));
      job.output += "\nnew live line";
      jobs.emit("change", { ...job });
      assert.ok(!render().includes("new live line"));
      component.handleInput("end");
      assert.ok(render().includes("new live line"));
      t.tui.terminal.rows = 12;
      component.invalidate();
      assert.ok(render().length <= 12);
      assert.ok(component.render(15).every((line) => [...line].length <= 15));
      job.status = "exited";
      job.signal = "SIGTERM";
      assert.ok(render().some((line) => line.includes("(signal SIGTERM)")));
      component.handleInput("escape");
    },
  ]);
  assert.equal(await showLogs({ ui: t }, jobs, "a", state, widgets), undefined);
  assert.equal(jobs.listenerCount("change"), 0);
});

test("human line input reaches the same running job through /jobs", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const job = await jobs.start({ command: 'read answer; printf "got:%s" "$answer"' });
  const ui = terminal([["i"], ["escape"]]);
  await openJobs({ mode: "tui", ui: { ...ui, input: async () => "human" } }, jobs, widgets, job.id);
  const result = await jobs.wait(job.id, { timeoutMs: 3000 });
  assert.equal(result.output, "got:human");
  assert.equal(result.interacted, true);
});

test("job selection can cancel a stop, confirm it, then forget the finished job", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  await jobs.start({ command: "sleep 30" });
  const ui = terminal([["s"], ["s"], ["x"]]),
    notices = [];
  let confirmations = 0,
    selections = 0;
  await openJobs(
    {
      mode: "tui",
      ui: {
        ...ui,
        select: async (_title, labels) => {
          selections++;
          assert.equal(labels.length, 1);
          assert.match(labels[0], /running.*sleep 30/);
          return labels[0];
        },
        confirm: async () => ++confirmations === 2,
        notify: (text) => notices.push(text),
      },
    },
    jobs,
    widgets,
  );
  assert.equal(selections, 1);
  assert.equal(confirmations, 2);
  assert.equal(jobs.list().length, 0);
  assert.match(notices[0], /No jobs/);
});

test("RPC and busy-terminal takeover fail without changing process ownership", async (t) => {
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  const job = await jobs.start({ command: "sleep 30", pty: process.platform !== "win32" });
  await assert.rejects(openJobs({ mode: "rpc" }, jobs, widgets), /TUI/);
  const ui = terminal([["a"], ["escape"]]),
    notices = [];
  await openJobs(
    { mode: "tui", isIdle: () => false, ui: { ...ui, notify: (text) => notices.push(text) } },
    jobs,
    widgets,
    job.id,
  );
  assert.match(notices[0], /idle/);
  assert.equal(jobs.read(job.id).owner, "agent");
  assert.equal(jobs.read(job.id).interacted, false);
});

test("log action keys are explicit and arbitrary typing never reaches the process", async () => {
  const jobs = new EventEmitter();
  jobs.read = () => ({
    id: "a",
    command: "read answer",
    status: "running",
    pty: true,
    output: "untrusted plain log",
  });
  const state = { follow: true, offset: 0 };
  const t = terminal([["yes", "a"]]);
  assert.equal(await showLogs({ ui: t }, jobs, "a", state, widgets), "attach");
  assert.equal(jobs.listenerCount("change"), 0);
});
