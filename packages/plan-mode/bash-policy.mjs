// bash-policy.mjs — mutator guard for plan mode.
//
// Plan mode lets the agent run bash for read-only exploration. This policy
// blocks high-confidence mutating commands, output/input redirection, and any
// command chain (&&, ||, |, ;) containing a blocked segment. It is fail-open
// beyond that: this is an accidental-mutation guardrail, not a sandbox.
// The model is additionally instructed in the plan-mode prompt not to mutate.

// First-token mutators: blocked outright, even with read-only-looking flags.
const BLOCKED_TOKENS = new Set([
  // file/fs mutation
  "rm", "mv", "cp", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp", "ln",
  "dd", "tee", "truncate", "install", "unlink",
  // privilege / process control
  "sudo", "su", "kill", "pkill", "killall", "passwd", "nohup", "tmux", "screen",
  "systemctl", "service", "fdisk", "mkfs", "mount", "umount",
  // build/package installation
  "make", "cmake", "ninja", "brew", "apt", "apt-get", "dnf", "yum", "pacman",
  "pip", "pip3", "gem", "bundle", "mvn", "gradle",
  // network transfers (write side effects, exfiltration)
  "curl", "wget", "scp", "sftp", "rsync", "ssh",
  // editors / in-place rewriting
  "vim", "vi", "nvim", "nano", "emacs", "code", "sed",
  // shells spawning a nested interpreter
  "sh", "bash", "zsh", "fish",
  // databases
  "psql", "mysql", "sqlite3", "redis-cli", "mongosh",
  // misc
  "xargs", "watch", "docker", "podman", "kubectl", "terraform", "pulumi",
]);

// npm/pnpm/yarn/bun: bare or blocked subcommand = mutation; test/run-style
// inspection checks are allowed (they may still write caches/build output).
const PKG_TOKENS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PKG_SUBCOMMANDS_BLOCKED = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "init", "create", "update",
  "upgrade", "dedupe", "rebuild", "link", "unlink", "publish", "pack", "set",
  "config", "ci", "store", "pm", "exec",
]);

// cargo / go get their own sets: `cargo run` and `go run` execute programs.
const CARGO_SUBCOMMANDS_BLOCKED = new Set([
  "install", "uninstall", "new", "init", "add", "remove", "publish", "run", "generate",
]);
const GO_SUBCOMMANDS_BLOCKED = new Set(["install", "get", "run", "generate"]);

// Git: block subcommands that mutate the repository or working tree.
const GIT_BLOCKED = new Set([
  "add", "commit", "push", "pull", "fetch", "reset", "revert", "checkout",
  "switch", "restore", "merge", "rebase", "cherry-pick", "stash", "clean",
  "rm", "mv", "apply", "am", "tag", "branch", "remote", "config", "init",
  "clone", "submodule", "worktree", "gc", "prune",
]);

// Validate a single command segment (no &&/||/|/; chaining inside).
// Returns a human-readable description of the first blocked element, or
// undefined when the segment is acceptable.
export function blockedBashSegment(segment) {
  const trimmed = String(segment ?? "").trim();
  if (!trimmed) return undefined;

  // Redirects (>, >>, <, 2>, &>) can write or mutate state.
  if (/[<>]/.test(trimmed)) return `redirect in: ${trimmed}`;

  const tokens = trimmed.split(/\s+/);
  // Skip leading flags so `git -C src status` is examined correctly.
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-")) i++;
  const head = tokens[i]?.toLowerCase();
  if (!head) return undefined;

  if (BLOCKED_TOKENS.has(head)) return `${head} …`;

  if (head === "git") {
    const sub = tokens[i + 1]?.toLowerCase();
    if (sub && GIT_BLOCKED.has(sub)) return `git ${sub} …`;
    return undefined;
  }

  if (PKG_TOKENS.has(head)) {
    const sub = tokens[i + 1]?.toLowerCase();
    // Bare `yarn`/`npm` means install in most package managers — block it.
    if (!sub || PKG_SUBCOMMANDS_BLOCKED.has(sub)) {
      return sub ? `${head} ${sub} …` : `${head} (bare) …`;
    }
    return undefined;
  }

  if (head === "cargo" || head === "go") {
    const blocked = head === "cargo" ? CARGO_SUBCOMMANDS_BLOCKED : GO_SUBCOMMANDS_BLOCKED;
    const sub = tokens[i + 1]?.toLowerCase();
    if (!sub || blocked.has(sub)) {
      return sub ? `${head} ${sub} …` : `${head} (bare) …`;
    }
    return undefined;
  }

  return undefined;
}

// Validate a full bash command, splitting on chain operators so a blocked
// segment anywhere in a pipeline/chain fails the whole command.
export function blockedBashCommand(command) {
  const segments = String(command ?? "").split(/(?:&&|\|\||[|;])/);
  for (const segment of segments) {
    const blocked = blockedBashSegment(segment);
    if (blocked) return blocked;
  }
  return undefined;
}
