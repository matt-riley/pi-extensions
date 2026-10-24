import path from "node:path";

// One shape for built-ins and discovered commands. Commands are prepared in
// the editor, not sent to the model: sendUserMessage does not dispatch built-ins.
const ACTIONS = [
  [
    "files",
    "Context",
    "Find a file",
    "Insert a file reference without reading its contents",
    "file reference",
  ],
  [
    "changes",
    "Changes",
    "Inspect changes",
    "Browse staged, unstaged and untracked files",
    "git diff review",
  ],
  [
    "resume",
    "Sessions",
    "Resume a session",
    "Return to a previous conversation",
    "history",
    "/resume",
  ],
  [
    "tree",
    "Sessions",
    "Conversation tree",
    "Jump between branches and labelled milestones",
    "bookmarks marks",
    "/tree",
  ],
  [
    "name",
    "Sessions",
    "Name this session",
    "Give this conversation a recognizable name",
    "",
    "/name",
  ],
  [
    "fork",
    "Sessions",
    "Fork this session",
    "Explore an alternative in a separate conversation",
    "branch",
    "/fork",
  ],
  ["new", "Sessions", "New session", "Start a fresh conversation", "", "/new"],
  ["plan", "Work", "Plan", "Open the existing read-only planning controls", "", "/plan"],
  [
    "subagents",
    "Work",
    "Subagents",
    "Open existing child-agent controls; never enable automatically",
    "",
    "/subagents",
  ],
  [
    "model",
    "Interface",
    "Choose a model",
    "Select the model for this session",
    "provider",
    "/model",
  ],
  ["settings", "Interface", "Settings", "Open pi's settings", "preferences", "/settings"],
  [
    "hotkeys",
    "Interface",
    "Keyboard help",
    "Show active shortcuts",
    "keymaps bindings help",
    "/hotkeys",
  ],
  [
    "session",
    "Interface",
    "Session details",
    "Show tokens, cost and session information",
    "usage accounting",
    "/session",
  ],
  [
    "footer",
    "Interface",
    "Toggle footer",
    "Switch between the personal and built-in statusline",
    "",
    "/footer",
  ],
];

export function commandCatalog(commands = []) {
  const loaded = new Set(commands.map((command) => command.name));
  const items = ACTIONS.filter(
    ([id]) => !["plan", "subagents", "footer"].includes(id) || loaded.has(id),
  ).map(([id, group, label, description, aliases, command]) => ({
    id,
    group,
    label,
    description,
    aliases,
    command,
  }));
  const known = new Set(items.map((item) => item.command));
  for (const command of commands) {
    const text = "/" + command.name;
    if (
      command.name === "ui" ||
      command.name === "files" ||
      command.name === "changes" ||
      known.has(text)
    )
      continue;
    known.add(text);
    items.push({
      id: text,
      group: "Commands",
      label: text,
      description: command.description ?? command.source ?? "",
      aliases: "",
      command: text,
    });
  }
  return items;
}

export function searchItems(items, query = "") {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return items
    .filter((item) => {
      const text = [item.label, item.description, item.group, item.aliases]
        .join(" ")
        .toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort(
      (a, b) =>
        Number(words.every((word) => b.label.toLocaleLowerCase().includes(word))) -
        Number(words.every((word) => a.label.toLocaleLowerCase().includes(word))),
    );
}

/** A reference is inert prompt text, not @file (which pi expands on submit). */
export function referenceText(root, file, cwd) {
  return JSON.stringify(path.relative(cwd, path.resolve(root, file)) || ".");
}
