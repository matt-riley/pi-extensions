import { spawnSync } from "node:child_process";
import path from "node:path";
import { pick, preview, safe } from "./screens.mjs";
import { commandCatalog, referenceText, searchItems } from "./catalog.mjs";
import { projectFiles, changedFiles, previewChange } from "./repository.mjs";
import { commandTypos } from "./typos.mjs";

async function openInNeovim(ctx, root, file) {
  let result;
  await ctx.ui.custom((tui, _theme, _keys, done) => {
    tui.stop();
    try {
      result = spawnSync("nvim", ["-R", "--", path.resolve(root, file)], {
        cwd: root,
        stdio: "inherit",
      });
    } catch (error) {
      result = { error };
    } finally {
      tui.start();
      tui.requestRender(true);
      done(undefined);
    }
    return { render: () => [], invalidate() {} };
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Neovim exited with status " + result.status);
}

export function installWorkbench(pi, widgets) {
  let savedDraft = "";
  let active = false;
  const notify = (ctx, message, level = "info") => ctx.ui?.notify?.(safe(message), level);
  const status = (ctx) =>
    ctx.ui.setStatus?.("workbench", savedDraft ? "draft saved: /ui restore" : undefined);
  const save = (ctx, text) => {
    savedDraft = text;
    pi.appendEntry("workbench-draft", { text });
    status(ctx);
  };
  const restore = (ctx) => {
    if (!savedDraft) return notify(ctx, "No saved draft.");
    const current = ctx.ui.getEditorText();
    ctx.ui.setEditorText(savedDraft);
    save(ctx, current);
  };
  const prepare = (ctx, command) => {
    const current = ctx.ui.getEditorText();
    if (current && savedDraft)
      return notify(
        ctx,
        "Use /ui restore before preparing another command; both drafts are kept.",
        "warning",
      );
    if (current) save(ctx, current);
    ctx.ui.setEditorText(command);
    notify(
      ctx,
      "Prepared " +
        command +
        " — press Enter to run." +
        (savedDraft ? " /ui restore recovers your draft." : ""),
    );
  };
  const guarded = (action) => async (args, ctx) => {
    if (ctx.mode !== "tui")
      return notify(ctx, "Workbench requires an interactive terminal.", "warning");
    if (active) return notify(ctx, "A workbench picker is already open.", "warning");
    // Do not steal focus from an approval dialog or another active tool UI.
    if (ctx.isIdle && !ctx.isIdle())
      return notify(ctx, "Wait for the agent to stop before opening the workbench.", "warning");
    active = true;
    try {
      await action(args.trim(), ctx);
    } catch (error) {
      notify(ctx, error.message, "error");
    } finally {
      active = false;
    }
  };

  const files = guarded(async (query, ctx) => {
    const inventory = await projectFiles(ctx.cwd, pi.exec);
    if (inventory.truncated) notify(ctx, "File inventory limited to 50,000 paths.", "warning");
    const items = [...new Set(inventory.files)].sort().map((file) => ({
      id: file,
      file,
      label: JSON.stringify(file),
      description: "",
      aliases: file,
    }));
    if (!items.length) return notify(ctx, "No project files found.");
    const item = await pick(ctx, "Project files — insert reference", items, { query }, widgets);
    if (!item) return;
    const draft = ctx.ui.getEditorText();
    ctx.ui.setEditorText(
      draft +
        (draft && !/\s$/.test(draft) ? " " : "") +
        referenceText(inventory.root, item.file, ctx.cwd),
    );
  });

  const changes = guarded(async (query, ctx) => {
    const { root } = await projectFiles(ctx.cwd, pi.exec);
    const state = { query };
    const positions = new Map();
    for (;;) {
      const changed = await changedFiles(root, pi.exec);
      if (!changed.length) return notify(ctx, "Working tree clean.");
      const items = changed.map((item) => ({
        ...item,
        id: item.scope + ":" + item.file,
        label: "[" + item.scope + "] " + JSON.stringify(item.file),
        description: item.original ? "from " + JSON.stringify(item.original) : "",
      }));
      const item = await pick(ctx, "Changes — read-only", items, state, widgets);
      if (!item) return;
      const matches = searchItems(items, state.query);
      let index = matches.indexOf(item);
      for (;;) {
        const current = matches[index];
        state.selected = current.id;
        if (!positions.has(current.id)) positions.set(current.id, { offset: 0 });
        const action = await preview(
          ctx,
          current,
          await previewChange(root, current, pi.exec),
          positions.get(current.id),
          widgets,
        );
        if (action === "next" || action === "previous") {
          index = (index + (action === "next" ? 1 : matches.length - 1)) % matches.length;
        } else if (action === "neovim") {
          await openInNeovim(ctx, root, current.file);
        } else if (action === "reference") {
          const draft = ctx.ui.getEditorText();
          ctx.ui.setEditorText(
            draft +
              (draft && !/\s$/.test(draft) ? " " : "") +
              referenceText(root, current.file, ctx.cwd),
          );
          return;
        } else break;
      }
    }
  });

  const centre = guarded(async (query, ctx) => {
    if (query === "restore") return restore(ctx);
    const items = commandCatalog(pi.getCommands());
    if (savedDraft)
      items.unshift({
        id: "restore",
        group: "Draft",
        label: "Restore saved draft",
        description: "Swap with the current editor text",
      });
    const item = await pick(
      ctx,
      "Command centre — Enter prepares, Escape cancels",
      items,
      { query },
      widgets,
    );
    if (!item) return;
    if (item.id === "restore") return restore(ctx);
    if (item.id === "files" || item.id === "changes") {
      // Release our picker guard before handing off to the next native flow.
      active = false;
      return item.id === "files" ? files("", ctx) : changes("", ctx);
    }
    prepare(ctx, item.command);
  });

  function restoreBranch(_event, ctx) {
    savedDraft = "";
    for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
      if (entry.type === "custom" && entry.customType === "workbench-draft") {
        savedDraft = typeof entry.data?.text === "string" ? entry.data.text : "";
      }
    }
    if (ctx.mode === "tui") status(ctx);
  }
  pi.on("input", (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive" || event.images?.length)
      return { action: "continue" };
    const suggestions = commandTypos(event.text, pi.getCommands());
    if (!suggestions.length) return { action: "continue" };
    const current = ctx.ui.getEditorText();
    ctx.ui.setEditorText(event.text + (current ? "\n" + current : ""));
    notify(
      ctx,
      "Did you mean " +
        suggestions.map((name) => "/" + name).join(" or ") +
        "? Nothing ran. Edit the restored command; to send it literally, prefix it with text.",
      "warning",
    );
    return { action: "handled" };
  });
  pi.on("session_start", restoreBranch);
  pi.on("session_tree", restoreBranch);
  for (const [name, handler, description] of [
    [
      "ui",
      centre,
      "Command centre: grouped actions, /ui <words> searches, /ui restore recovers a draft",
    ],
    ["files", files, "Find a project file and insert a plain reference (no contents sent)"],
    ["changes", changes, "Read-only staged/unstaged diffs and open files in Neovim"],
  ])
    pi.registerCommand(name, { description, handler });
  for (const [key, handler, description] of [
    ["ctrl+alt+k", centre, "Open command centre"],
    ["ctrl+alt+f", files, "Find a file reference"],
    ["ctrl+alt+g", changes, "Inspect changes"],
  ])
    pi.registerShortcut(key, { description, handler: (ctx) => handler("", ctx) });
}
