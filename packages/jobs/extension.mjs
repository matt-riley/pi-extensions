import { Type } from "typebox";
import { Jobs } from "./jobs.mjs";
import { watchJobs } from "./attention.mjs";
import { openJobs } from "./ui.mjs";
import { bindSystemOne } from "../../shared/systemone-session.mjs";
import { LOCAL_READ, LOCAL_DESTRUCTIVE, OPEN_DESTRUCTIVE } from "../../shared/tool-annotations.mjs";

const JobSchema = Type.Object({
  id: Type.String(),
  command: Type.String(),
  cwd: Type.String(),
  pty: Type.Boolean(),
  status: Type.Union([Type.Literal("running"), Type.Literal("exited"), Type.Literal("stopped")]),
  exit_code: Type.Union([Type.Integer(), Type.Null()]),
  signal: Type.Union([Type.String(), Type.Null()]),
  output: Type.String(),
  truncated: Type.Boolean(),
  cleanup_error: Type.Union([Type.String(), Type.Null()]),
  interacted: Type.Boolean(),
  owner: Type.Union([Type.Literal("agent"), Type.Literal("human")]),
  watch: Type.Union([Type.String(), Type.Null()]),
  notify: Type.Boolean(),
});
const Id = Type.String({ description: "A job id from terminal_start or terminal_list." });

export function installJobs(pi, widgets) {
  bindSystemOne(pi);
  let session;
  const get = (ctx) => {
    if (session) {
      session.ctx = ctx;
      return session;
    }
    const current = { jobs: new Jobs(), ctx, pending: [], closed: false, status: "" };
    session = current;
    const publish = (text, wake) => {
      if (current.closed) return;
      if (current.jobs.list().some((job) => job.owner === "human")) {
        current.pending.push({ text, wake });
        return;
      }
      pi.sendMessage(
        { customType: "background-job", content: text, display: true },
        { deliverAs: "followUp", triggerTurn: wake },
      );
    };
    current.jobs.on("change", () => {
      if (current.closed) return;
      const jobs = current.jobs.list();
      const running = jobs.filter((job) => job.status === "running").length;
      const status = running
        ? "jobs " + running + " running"
        : jobs.length
          ? "jobs " + jobs.length
          : "";
      if (status !== current.status) {
        current.status = status;
        current.ctx.ui?.setStatus?.("jobs", status || undefined);
      }
      if (!jobs.some((job) => job.owner === "human")) {
        for (const notice of current.pending.splice(0)) publish(notice.text, notice.wake);
      }
    });
    current.jobs.on("exit", (job) => {
      if (current.closed) return;
      const outcome =
        (job.signal ? "signal " + job.signal : "exit " + job.exit_code) +
        (job.cleanup_error ? "; cleanup unverified: " + job.cleanup_error : "");
      if (job.notify) {
        publish(
          "Measured: background job " +
            job.id +
            " " +
            job.status +
            " (" +
            outcome +
            "). Process completion is not task verification. Use terminal_read for output and evidence.",
          true,
        );
      } else if (!current.jobs.list().some((item) => item.owner === "human")) {
        current.ctx.ui?.notify?.(
          "Job " + job.id + ": " + outcome,
          job.exit_code === 0 ? "info" : "warning",
        );
      }
    });
    current.closeWatch = watchJobs(current.jobs, {
      onAlert: (job, probability) =>
        publish(
          "Inferred attention hint: Jev p=" +
            probability.toFixed(2) +
            " for job " +
            job.id +
            ", condition " +
            JSON.stringify(job.watch) +
            ". Not verification or permission to act. Inspect with terminal_read.",
          job.notify,
        ),
      onUnavailable: (message) => {
        if (!current.closed) current.ctx.ui?.notify?.(message, "warning");
      },
    });
    return current;
  };
  pi.on("session_start", (_event, ctx) => {
    get(ctx);
  });
  pi.on("session_shutdown", async () => {
    const previous = session;
    session = undefined;
    if (!previous) return;
    previous.closed = true;
    previous.closeWatch();
    await previous.jobs.shutdown();
    previous.ctx.ui?.setStatus?.("jobs", undefined);
  });

  const result = (jobs, id, lines = 200) => {
    const job = jobs.read(id);
    const tail = job.output.split("\n").slice(-lines).join("\n").slice(-12_000);
    const view = {
      ...job,
      output: tail,
      truncated: job.truncated || tail.length < job.output.length,
    };
    return {
      structuredContent: view,
      content: [{ type: "text", text: JSON.stringify(view) }],
      details: { job: { ...jobs.evidence(id), output: tail, truncated: view.truncated } },
      isError:
        Boolean(job.cleanup_error) ||
        (job.status !== "running" && (job.status === "stopped" || job.exit_code !== 0)),
    };
  };
  const tool = (name, description, parameters, annotations, execute, outputSchema = JobSchema) =>
    pi.registerTool({
      name,
      label: name,
      description,
      parameters,
      annotations,
      outputSchema,
      exposure: "deferred",
      namespace: {
        name: "terminal",
        description: "Session-owned background jobs, live logs and optional PTYs in Pi.",
        instructions:
          "Start commands in the foreground; do not daemonize. A running job is not a passed check. " +
          "Use terminal_read after completion for actual exit evidence. Terminal input always needs scoped approval; " +
          "do not automate consent prompts. /jobs is the human TUI. Sessions/reload stop owned processes.",
      },
      execute: async (_id, params, signal, _update, ctx) =>
        execute(get(ctx).jobs, params, signal, ctx),
    });
  tool(
    "terminal_start",
    "Start a background command in this session's working directory and return its id immediately. " +
      "Optional PTY for interactive programs; optional one-shot Jev watch condition. No herdr/tmux required.",
    Type.Object(
      {
        command: Type.String({ minLength: 1, maxLength: 10_000 }),
        pty: Type.Optional(Type.Boolean({ default: false })),
        watch: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 500,
            description:
              "Semantic condition to watch for. Sends redacted 4000-character log excerpts to Jev; not verification.",
          }),
        ),
        notify: Type.Optional(
          Type.Boolean({
            default: true,
            description:
              "Resume the agent once on completion/attention. False means UI-only notifications.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    OPEN_DESTRUCTIVE,
    async (jobs, params, signal, ctx) => {
      const job = await jobs.start({ ...params, cwd: ctx.cwd, signal });
      return result(jobs, job.id);
    },
  );
  tool(
    "terminal_read",
    "Read a bounded log tail and real lifecycle/exit status. Optionally wait up to 30 seconds. " +
      "Only untouched, completed, revision-bound checks count as verification.",
    Type.Object(
      {
        id: Id,
        wait_seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 30 })),
        lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      },
      { additionalProperties: false },
    ),
    LOCAL_READ,
    async (jobs, { id, wait_seconds = 0, lines = 200 }, signal) => {
      await jobs.wait(id, { timeoutMs: wait_seconds * 1000, signal });
      return result(jobs, id, lines);
    },
  );
  tool(
    "terminal_list",
    "List this session's jobs with command previews, owners and status, without logs.",
    Type.Object({}, { additionalProperties: false }),
    LOCAL_READ,
    async (jobs) => {
      const data = {
        jobs: jobs.list().map((job) => ({
          ...job,
          command: job.command.slice(0, 240),
          output: "",
          truncated: job.truncated || job.command.length > 240,
        })),
      };
      return {
        structuredContent: data,
        content: [{ type: "text", text: JSON.stringify(data) }],
        details: {},
      };
    },
    Type.Object({ jobs: Type.Array(JobSchema) }),
  );
  tool(
    "terminal_send",
    "Send exact text/keys to an agent-owned job. Human approval is required: " +
      "input can execute commands or answer consent prompts. Unavailable during human takeover.",
    Type.Object(
      {
        id: Id,
        text: Type.Optional(Type.String({ maxLength: 8192 })),
        keys: Type.Optional(Type.Array(Type.String(), { maxItems: 16 })),
      },
      { additionalProperties: false },
    ),
    LOCAL_DESTRUCTIVE,
    async (jobs, { id, ...input }, signal) => {
      signal?.throwIfAborted();
      await jobs.send(id, input);
      return result(jobs, id);
    },
  );
  tool(
    "terminal_stop",
    "Stop only this session's owned process group. Optionally forget the finished job. " +
      "Cannot stop a human-controlled terminal; unknown ids never target arbitrary processes.",
    Type.Object({ id: Id, forget: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    LOCAL_DESTRUCTIVE,
    async (jobs, { id, forget = false }, signal) => {
      signal?.throwIfAborted();
      await jobs.stop(id);
      const stopped = result(jobs, id);
      if (forget) jobs.forget(id);
      return stopped;
    },
  );

  pi.registerCommand("jobs", {
    description: "Live jobs/logs; /jobs run <command>, /jobs pty <command>, or /jobs <id>",
    handler: async (args, ctx) => {
      const jobs = get(ctx).jobs;
      try {
        const launch = args.match(/^(run|pty)\s+([\s\S]+)$/);
        if (launch) {
          const job = await jobs.start({
            command: launch[2],
            cwd: ctx.cwd,
            pty: launch[1] === "pty",
            notify: false,
          });
          ctx.ui?.notify?.("Job " + job.id + " started — /jobs to view.", "info");
        } else {
          await openJobs(ctx, jobs, widgets, args.trim() || undefined);
        }
      } catch (error) {
        ctx.ui?.notify?.(error.message ?? String(error), "error");
      }
    },
  });
}
