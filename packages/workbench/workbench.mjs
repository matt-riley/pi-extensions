import { spawnSync } from "node:child_process";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { commandCatalog, referenceText, searchItems } from "./catalog.mjs";
import { projectFiles, changedFiles, previewChange } from "./repository.mjs";

const SEARCH = "Search…";
const safe = (text) => stripVTControlCharacters(String(text)).replace(/\p{Cc}/gu, "");
const label = (item) => safe(item.label + (item.description ? " — " + item.description : ""));

/** Native dialogs share keyboard/focus/IME handling; no second terminal renderer. */
async function pick(ctx, title, items, query = "") {
  for (;;) {
    const matches = searchItems(items, query);
    const shown = matches.slice(0, 200);
    const labels = shown.map(label);
    const selected = await ctx.ui.select(
      title +
        (query ? " — " + safe(query) : "") +
        (matches.length > 200
          ? " (first 200; Search… to narrow)"
          : matches.length
            ? ""
            : " (no matches; Search… to retry)"),
      [...labels, SEARCH],
    );
    if (selected === undefined) return undefined;
    if (selected !== SEARCH) return shown[labels.indexOf(selected)];
    const next = await ctx.ui.input("Search " + title + " (all words must match)", query);
    if (next === undefined) return undefined;
    query = next;
    if (!searchItems(items, query).length)
      ctx.ui.notify("No matches — change the search or Escape to cancel.", "info");
  }
}

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

export function installWorkbench(pi) {
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
      file,
      label: JSON.stringify(file),
      description: "",
      aliases: file,
    }));
    if (!items.length) return notify(ctx, "No project files found.");
    const item = await pick(ctx, "Project files — insert reference", items, query);
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
    for (;;) {
      const changed = await changedFiles(root, pi.exec);
      if (!changed.length) return notify(ctx, "Working tree clean.");
      const items = changed.map((item) => ({
        ...item,
        label: "[" + item.scope + "] " + JSON.stringify(item.file),
        description: item.original ? "from " + JSON.stringify(item.original) : "",
      }));
      const item = await pick(ctx, "Changes — read-only", items, query);
      if (!item) return;
      const action = await ctx.ui.select(label(item), [
        "Preview diff",
        "Open in Neovim (read-only)",
        "Insert reference",
      ]);
      if (action === "Preview diff") {
        const diff = await previewChange(root, item, pi.exec);
        // The native editor is a disposable scratch view: returned edits are
        // deliberately ignored, and no worktree or index operation follows.
        const preview = diff.replace(/\p{Cc}/gu, (char) =>
          char === "\n" || char === "\t" ? char : JSON.stringify(char).slice(1, -1),
        );
        await ctx.ui.editor(item.scope + " diff — scratch preview; edits discarded", preview);
      } else if (action === "Open in Neovim (read-only)") {
        await openInNeovim(ctx, root, item.file);
      } else if (action === "Insert reference") {
        const draft = ctx.ui.getEditorText();
        ctx.ui.setEditorText(
          draft +
            (draft && !/\s$/.test(draft) ? " " : "") +
            referenceText(root, item.file, ctx.cwd),
        );
        return;
      } else return;
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
    let candidates = items;
    if (!query) {
      const group = await ctx.ui.select("Command centre — choose a group or Search", [
        SEARCH,
        ...new Set(items.map((item) => item.group)),
      ]);
      if (group === undefined) return;
      if (group === SEARCH) {
        query = await ctx.ui.input("Search commands by name or intent");
        if (query === undefined) return;
      } else candidates = items.filter((item) => item.group === group);
    }
    if (!searchItems(candidates, query).length)
      return notify(ctx, "No matches. Try /ui with different search words.");
    const item = await pick(ctx, "Commands — Enter prepares, Escape cancels", candidates, query);
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
