import { safe } from "../workbench/screens.mjs";

export async function showLogs(ctx, jobs, id, state, { ScrollView, matchesKey, truncateToWidth }) {
  let cleanup = () => {};
  try {
    return await ctx.ui.custom(
      (tui, theme, keys, done) => {
        let lines = [],
          height = 1;
        const body = {
          render: (width) => lines.map((line) => truncateToWidth(line, Math.max(1, width))),
          invalidate() {},
        };
        const view = new ScrollView(body);
        const refresh = (job) => {
          if (job?.id !== id) return;
          view.invalidate();
          tui.requestRender();
        };
        jobs.on("change", refresh);
        cleanup = () => jobs.removeListener("change", refresh);
        return {
          render(width) {
            const job = jobs.read(id);
            lines = job.output.replaceAll("\t", "    ").split("\n");
            height = Math.max(1, Math.min(24, tui.terminal.rows - 7));
            view.updateLayout(lines.length, height, () => tui.requestRender());
            if (state.follow) view.scrollToEnd();
            else view.scrollTo(state.offset);
            state.offset = view.scrollTop;
            return [
              theme.fg(
                "accent",
                "Job " +
                  id +
                  " — " +
                  job.status +
                  (job.signal
                    ? " (signal " + job.signal + ")"
                    : job.exit_code !== null && job.exit_code !== undefined
                      ? " (exit " + job.exit_code + ")"
                      : ""),
              ),
              theme.fg("muted", safe(job.command)),
              theme.fg(
                "dim",
                (job.pty ? "PTY" : "pipes") +
                  " · log tail · " +
                  (job.cleanup_error ? "cleanup unverified · " : "") +
                  (state.follow ? "following" : "paused") +
                  (job.truncated ? " · older output discarded" : ""),
              ),
              ...view.render(width).slice(view.scrollTop, view.scrollTop + height),
              theme.fg("dim", "↑↓/PgUp/PgDn/Home/End scroll · f follow"),
              theme.fg("dim", "a terminal · i send line · s stop · x forget · Esc back"),
            ].map((line) => truncateToWidth(line, Math.max(1, width)));
          },
          handleInput(data) {
            if (keys.matches(data, "tui.select.cancel")) return done(undefined);
            for (const [key, action] of [
              ["a", "attach"],
              ["i", "input"],
              ["s", "stop"],
              ["x", "forget"],
            ])
              if (matchesKey(data, key)) return done(action);
            if (matchesKey(data, "f")) state.follow = !state.follow;
            else if (matchesKey(data, "end")) {
              state.follow = true;
              view.scrollToEnd();
            } else {
              state.follow = false;
              if (matchesKey(data, "home")) view.scrollToStart();
              else if (keys.matches(data, "tui.select.up")) view.scrollBy(-1);
              else if (keys.matches(data, "tui.select.down")) view.scrollBy(1);
              else if (keys.matches(data, "tui.select.pageUp")) view.scrollBy(-height);
              else if (keys.matches(data, "tui.select.pageDown")) view.scrollBy(height);
            }
            state.offset = view.scrollTop;
            tui.requestRender();
          },
          invalidate() {
            view.invalidate();
          },
          dispose: cleanup,
        };
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "95%", maxHeight: "90%" } },
    );
  } finally {
    cleanup();
  }
}

async function attachTerminal(ctx, jobs, id) {
  if (ctx.isIdle?.() === false)
    throw new Error("Wait until Pi is idle before taking over a terminal.");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Terminal takeover needs a real terminal.");
  const job = jobs.read(id);
  if (!job.pty || job.status !== "running") throw new Error("Takeover needs a running PTY job.");
  await ctx.ui.custom((tui, _theme, _keys, done) => {
    let finished = false,
      resizeTimer;
    const wasRaw = process.stdin.isRaw;
    const restore = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(resizeTimer);
      process.stdin.removeListener("data", input);
      process.stdout.removeListener("resize", resize);
      jobs.removeListener("output", output);
      jobs.removeListener("exit", exit);
      process.stdin.setRawMode(wasRaw);
      // A detached full-screen program may have left mouse, cursor or alternate
      // screen modes enabled. Pi's own start() re-establishes its terminal modes.
      process.stdout.write(
        "\x1b[?1049l\x1b[?1l\x1b>\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[0m\x1b[?25h",
      );
      jobs.release(id);
      tui.start();
      tui.requestRender(true);
      done(undefined);
      if (error) ctx.ui.notify(error.message ?? String(error), "warning");
    };
    const input = (data) => {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const detach = bytes.indexOf(29); // Ctrl+] belongs to Pi; other keys go to this process.
      const chunk = detach < 0 ? bytes : bytes.subarray(0, detach);
      if (chunk.length) void jobs.humanInput(id, chunk).catch(restore);
      if (detach >= 0) restore();
    };
    const output = (event) => {
      if (event.id === id) process.stdout.write(event.text);
    };
    const exit = (event) => {
      if (event.id === id) restore();
    };
    const resize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void jobs
          .resize(id, process.stdout.columns || 100, process.stdout.rows || 30)
          .catch(restore);
      }, 75);
    };
    jobs.takeover(id);
    tui.stop();
    jobs.on("output", output);
    jobs.on("exit", exit);
    process.stdin.on("data", input);
    process.stdout.on("resize", resize);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(
      "\x1b[2J\x1b[HJob " +
        id +
        " — Ctrl+] detaches; Ctrl+C goes to the process.\r\n" +
        job.output.replaceAll("\n", "\r\n"),
    );
    // Force a SIGWINCH so full-screen programs redraw on reattach. This is
    // native terminal handoff, not an embedded terminal emulator.
    void (async () => {
      await jobs.resize(id, process.stdout.columns || 100, (process.stdout.rows || 30) + 1);
      await jobs.resize(id, process.stdout.columns || 100, process.stdout.rows || 30);
    })().catch(restore);
    return { render: () => [], invalidate() {}, dispose: restore };
  });
}

async function manageJob(ctx, jobs, id, widgets) {
  const state = { follow: true, offset: 0 };
  for (;;) {
    const action = await showLogs(ctx, jobs, id, state, widgets);
    if (!action) return;
    try {
      if (action === "attach") await attachTerminal(ctx, jobs, id);
      else if (action === "input") {
        const text = await ctx.ui.input("Send one line to job " + id + " (Enter is sent)");
        if (text !== undefined) await jobs.send(id, { text, keys: ["enter"] });
      } else if (action === "stop") {
        if (
          await ctx.ui.confirm("Stop job " + id + "?", "Its owned child processes will be stopped.")
        )
          await jobs.stop(id);
      } else if (action === "forget") {
        jobs.forget(id);
        return;
      }
    } catch (error) {
      ctx.ui.notify(error.message ?? String(error), "warning");
    }
  }
}

export async function openJobs(ctx, jobs, widgets, id) {
  if (ctx.mode !== "tui") throw new Error("/jobs requires Pi's TUI; use terminal_* tools in RPC.");
  if (id) return manageJob(ctx, jobs, id, widgets);
  for (;;) {
    const items = jobs.list();
    if (!items.length) {
      ctx.ui.notify("No jobs. Use /jobs run <command> or /jobs pty <command>.", "info");
      return;
    }
    const labels = items.map(
      (job) => job.id + " · " + job.status + " · " + safe(job.command).slice(0, 100),
    );
    const selected = await ctx.ui.select("Jobs — commands keep running in the background", labels);
    if (!selected) return;
    const item = items[labels.indexOf(selected)];
    if (item) await manageJob(ctx, jobs, item.id, widgets);
  }
}
