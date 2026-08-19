// bash-policy.mjs — fail-closed read-only guard for plan mode.
//
// Plan mode lets the agent run bash for read-only exploration. This policy is
// fail-closed, modeled on the reference plan-mode extension's allow/deny
// classification:
//
//   - known mutators are blocked outright (MUTATOR_HEADS),
//   - known read-only commands pass, subject to per-command rules that forbid
//     their dangerous flags/subcommands (sed -i, find -exec/-delete, tar
//     extract/create, git write subcommands, npm install, script interpreters,
//     ...),
//   - anything not known to be read-only is blocked.
//
// Redirects (outside quotes) and command substitution ($(…) / backticks) are
// rejected. Chain operators (&&, ||, |, ;, &, newline) split the command and
// every segment must pass. Parsing is quote-aware, so quoted < > ; | && never
// false-positive. This is a guardrail, not a sandbox: deliberately scripted
// mutations (e.g. an awk program that writes a file) are out of scope, and the
// model is additionally instructed not to mutate.

// ---------------------------------------------------------------------------
// Classification tables

const MUTATOR_HEADS = new Set([
  // file/fs mutation
  "rm", "mv", "cp", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp", "ln",
  "dd", "tee", "truncate", "install", "unlink", "shred",
  // privilege / process control
  "sudo", "su", "kill", "pkill", "killall", "passwd", "nohup", "tmux", "screen",
  "systemctl", "service", "launchctl", "fdisk", "mkfs", "mount", "umount",
  "reboot", "poweroff", "halt", "shutdown", "init", "telinit", "sync", "fuser",
  // build/package installation
  "make", "cmake", "ninja", "brew", "apt", "apt-get", "dnf", "yum", "pacman",
  "pip", "pip3", "gem", "bundle", "mvn", "gradle", "dpkg", "rpm", "port",
  "npx", "nvm", "fnm", "volta", "asdf", "uv", "poetry", "pipx", "conda", "mamba",
  // network transfers (write side effects, exfiltration)
  "curl", "wget", "scp", "sftp", "rsync", "ssh",
  // editors / in-place rewriting
  "vim", "vi", "nvim", "nano", "emacs", "code", "subl",
  // shells spawning a nested interpreter
  "sh", "bash", "zsh", "fish",
  // databases
  "psql", "mysql", "sqlite3", "redis-cli", "mongosh",
  // vcs that mutate
  "svn", "hg",
  // misc
  "xargs", "watch", "docker", "podman", "kubectl", "terraform", "pulumi",
  // macOS system mutation
  "defaults", "osascript", "plutil", "diskutil", "pbcopy", "open",
  "softwareupdate", "mdutil",
]);

const READ_ONLY_HEADS = new Set([
  // navigation / info
  "cd", "pwd", "ls", "which", "whereis", "type", "dirname", "basename",
  "realpath", "readlink", "env", "printenv", "hostname", "uname", "whoami",
  "id", "date", "cal", "uptime", "who", "w", "last",
  // file inspection
  "cat", "head", "tail", "wc", "sort", "uniq", "diff", "comm",
  "cmp", "file", "stat", "du", "df", "tree", "strings", "nm", "objdump",
  "readelf", "xxd", "hexdump", "od", "base64", "md5", "md5sum", "shasum",
  "sha1sum", "sha256sum", "sha512sum", "test",
  // search
  "grep", "egrep", "fgrep", "rg", "find", "fd", "ag", "ack", "locate",
  // text processing
  "echo", "printf", "awk", "sed", "tr", "cut", "paste", "join", "nl", "fold",
  "expand", "unexpand", "rev", "tac", "column", "shuf", "seq", "jq", "yq",
  "xmllint",
  // processes / system (top gated to its terminating batch forms below;
  // less/more/htop/watch are absent: interactive pagers/monitors never exit
  // in a headless tool call and hang the agent until the bash timeout)
  "ps", "top", "free", "lsof", "netstat", "ss", "sysctl", "vm_stat",
  "iostat", "dmesg",
  // archives (list/test/stdout only, enforced below)
  "tar", "unzip", "zipinfo", "zcat", "bzcat", "xzcat", "gzip", "bzip2", "xz",
  // version/help-only interpreters (enforced below)
  "node", "deno", "python", "python3", "ruby", "perl", "php",
  // package managers (read-only subcommands, enforced below)
  "npm", "pnpm", "yarn", "bun", "cargo", "go",
  // git (read-only subcommands, enforced below)
  "git",
]);

// branch, tag, remote, config, stash, submodule, and worktree are
// deliberately absent from both sets below: blockedGit() special-cases each
// of them BEFORE consulting these sets (they have both read-only and
// write forms), so an entry here would be dead/unreachable and misleading.
const GIT_BLOCKED = new Set([
  "add", "commit", "push", "pull", "fetch", "reset", "revert", "checkout",
  "switch", "restore", "merge", "rebase", "cherry-pick", "clean",
  "rm", "mv", "apply", "am", "init",
  "clone", "gc", "prune",
]);

const GIT_READ_ONLY = new Set([
  "status", "log", "diff", "show",
  "rev-parse", "show-ref", "ls-files", "ls-tree", "ls-remote", "grep", "blame",
  "whatchanged", "describe", "shortlog", "count-objects", "fsck", "merge-base",
  "name-rev", "cherry", "diff-tree", "diff-index", "diff-files", "cat-file",
  "for-each-ref", "var", "version", "help",
  "verify-commit", "verify-tag", "verify-pack",
]);

const PKG_READ_ONLY = {
  npm: new Set([
    "list", "ls", "view", "info", "search", "outdated", "audit", "ping",
    "whoami", "help", "version", "root", "prefix", "explain", "config",
  ]),
  pnpm: new Set(["list", "view", "info", "search", "outdated", "audit", "why", "help", "version"]),
  yarn: new Set(["list", "info", "why", "audit", "outdated", "help", "version"]),
  bun: new Set(["pm"]),
};

const CARGO_READ_ONLY = new Set(["metadata", "tree", "search", "info", "locate-project", "version", "help"]);
const GO_READ_ONLY = new Set(["env", "list", "version", "help", "doc"]);

// Interpreters may only be invoked for version/help output; anything else
// runs a script or REPL.
const INTERPRETER_FLAGS = {
  node: new Set(["-v", "--version", "-h", "--help"]),
  deno: new Set(["--version", "-h", "--help"]),
  python: new Set(["-V", "--version", "-h", "--help"]),
  python3: new Set(["-V", "--version", "-h", "--help"]),
  ruby: new Set(["-v", "--version", "-h", "--help"]),
  perl: new Set(["-v", "--version", "-h", "--help"]),
  php: new Set(["-v", "--version", "-h", "--help"]),
};

// Flag-level rules for otherwise read-only commands: return a reason string
// when a dangerous flag/subcommand is present.
const HEAD_RULES = {
  sed: (args) =>
    args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")
      ? "sed -i (in-place edit) …"
      : undefined,
  find: (args) => {
    if (args.some((a) => a === "-exec" || a === "-execdir" || a === "-ok" || a === "-delete")) {
      return "find -exec/-delete …";
    }
    if (args.some((a) => a === "-fprint" || a === "-fprintf" || a === "-fls")) {
      return "find -fprint/-fprintf/-fls (writes a file) …";
    }
    return undefined;
  },
  sort: (args) =>
    args.some((a) => a === "-o" || a.startsWith("-o") || a === "--output" || a.startsWith("--output="))
      ? "sort -o (writes a file) …"
      : undefined,
  shuf: (args) =>
    args.some((a) => a === "-o" || a.startsWith("-o") || a === "--output" || a.startsWith("--output="))
      ? "shuf -o (writes a file) …"
      : undefined,
  tar: (args) => {
    const list = args.some((a) => a === "-t" || a === "--list" || /^-[a-zA-Z]*t[a-zA-Z]*$/.test(a));
    if (!list) return "tar (not list-only) …";
    if (
      args.some(
        (a) =>
          /^-[a-zA-Z]*[xcu][a-zA-Z]*$/.test(a) ||
          a === "--extract" || a === "--create" || a === "--append" ||
          a === "--update" || a === "--delete",
      )
    ) {
      return "tar (extract/create) …";
    }
    return undefined;
  },
  unzip: (args) =>
    args.some((a) => a === "-l" || a === "-p" || a === "-Z")
      ? undefined
      : "unzip (not list-only) …",
  gzip: (args) =>
    args.some((a) => /^-[a-zA-Z]*[tlc][a-zA-Z]*$/.test(a) || a === "--test" || a === "--list" || a === "--stdout")
      ? undefined
      : "gzip (not list/test/stdout) …",
  bzip2: (args) =>
    args.some((a) => /^-[a-zA-Z]*[tc][a-zA-Z]*$/.test(a) || a === "--test" || a === "--stdout")
      ? undefined
      : "bzip2 (not test/stdout) …",
  xz: (args) =>
    args.some((a) => /^-[a-zA-Z]*[tlc][a-zA-Z]*$/.test(a) || a === "--test" || a === "--list" || a === "--stdout")
      ? undefined
      : "xz (not list/test/stdout) …",
  env: (args) =>
    args.every((a) => a.includes("=")) ? undefined : "env (executes command) …",
  // Interactive top never exits in a headless tool call; only the batch
  // forms terminate (Linux: top -b -n1, macOS: top -l 1).
  top: (args) =>
    args.some((a) => a === "-b" || a === "-l")
      ? undefined
      : "top (interactive — use top -b -n1 or top -l 1) …",
  sysctl: (args) =>
    args.some((a) => a === "-w" || a.startsWith("-w") || a === "--write")
      ? "sysctl -w (write) …"
      : undefined,
  xmllint: (args) =>
    args.some((a) => a === "-o" || a === "--output")
      ? "xmllint --output (write) …"
      : undefined,
};

// ---------------------------------------------------------------------------
// Parsing helpers (quote-aware)

const CHAIN_OPS = ["&&", "&", "||", "|", ";", "\n"];

// Split a command on chain operators that appear outside quotes.
function splitSegments(input) {
  const parts = [];
  let segStart = 0;
  let i = 0;
  let quote = null;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    const op = CHAIN_OPS.find((o) => input.startsWith(o, i));
    if (op) {
      parts.push(input.slice(segStart, i));
      i += op.length;
      segStart = i;
      continue;
    }
    i++;
  }
  parts.push(input.slice(segStart));
  return parts;
}

// Shell-like tokenizer: whitespace-split outside quotes, strip surrounding
// quotes, resolve backslash escapes.
function tokenize(segment) {
  const tokens = [];
  let i = 0;
  const n = segment.length;
  while (i < n) {
    while (i < n && /\s/.test(segment[i])) i++;
    if (i >= n) break;
    let tok = "";
    let quote = null;
    while (i < n) {
      const ch = segment[i];
      if (quote) {
        if (quote === '"' && ch === "\\") { tok += segment[i + 1] ?? ""; i += 2; continue; }
        if (ch === quote) { quote = null; i++; continue; }
        tok += ch; i++;
        continue;
      }
      if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
      if (/\s/.test(ch)) break;
      if (ch === "\\") { tok += segment[i + 1] ?? ""; i += 2; continue; }
      tok += ch; i++;
    }
    tokens.push(tok);
  }
  return tokens;
}

// Any < or > outside quotes is a redirection operator (quoted ones are
// literal, e.g. grep "<div").
function hasRedirectOutsideQuotes(segment) {
  let quote = null;
  let i = 0;
  const n = segment.length;
  while (i < n) {
    const ch = segment[i];
    if (quote) {
      if (quote === '"' && ch === "\\") { i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "<" || ch === ">") return true;
    i++;
  }
  return false;
}

// Command substitution ($(…) or backticks) executes code. Single quotes
// suppress it; double quotes and unquoted positions do not.
function hasCommandSubstitution(segment) {
  let quote = null;
  let i = 0;
  const n = segment.length;
  while (i < n) {
    const ch = segment[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") { i += 2; continue; }
      if (ch === '"') { quote = null; i++; continue; }
      // $() and backticks expand inside double quotes too.
      if (ch === "`") return true;
      if (ch === "$" && segment[i + 1] === "(") return true;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i++; continue; }
    if (ch === "\\") { i += 2; continue; }
    if (ch === "`") return true;
    if (ch === "$" && segment[i + 1] === "(") return true;
    i++;
  }
  return false;
}

// Find the command head: skip leading env assignments (FOO=bar) and flags.
function findHead(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.includes("=") && !t.startsWith("=") && i < tokens.length - 1) { i++; continue; }
    if (t.startsWith("-")) { i++; continue; }
    break;
  }
  return { head: tokens[i]?.toLowerCase(), args: tokens.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Per-tool validators

function blockedGit(args) {
  // Skip leading flags, including value-taking ones like -C <dir>.
  const FLAG_WITH_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
  let j = 0;
  while (j < args.length && args[j].startsWith("-")) {
    const flag = args[j];
    if (!flag.includes("=") && FLAG_WITH_VALUE.has(flag)) j += 2;
    else j += 1;
  }
  const sub = args[j]?.toLowerCase();
  const rest = args.slice(j + 1);
  if (!sub) return undefined; // bare git / --version / --help

  // Read-only variants of subcommands that also have write forms must be
  // checked before the blocklist, which would otherwise short-circuit them.
  // branch, tag, remote, config, stash, submodule, and worktree are handled
  // exclusively here — they are intentionally absent from GIT_BLOCKED and
  // GIT_READ_ONLY above.
  if (sub === "branch") {
    const readOnly = rest.some(
      (a) =>
        /^-[avr]+$/.test(a) || a === "--list" || a.startsWith("--merged") ||
        a.startsWith("--no-merged") || a.startsWith("--contains") ||
        a.startsWith("--points-at") || a.startsWith("--sort"),
    );
    if (!readOnly && rest.some((a) => !a.startsWith("-"))) return "git branch (create/delete) …";
    return undefined;
  }
  if (sub === "tag") {
    const readOnly = rest.some(
      (a) => a === "-l" || a === "--list" || a.startsWith("--sort") ||
        a.startsWith("--contains") || a.startsWith("--merged") ||
        a.startsWith("--points-at") || /^-[a-zA-Z]*n/.test(a),
    );
    if (!readOnly && rest.some((a) => !a.startsWith("-"))) return "git tag (write) …";
    return undefined;
  }
  if (sub === "remote") {
    const first = rest[0];
    if (
      first && first !== "-v" && first !== "--verbose" &&
      first !== "show" && first !== "get-url" && !first.startsWith("-")
    ) {
      return "git remote (write) …";
    }
    return undefined;
  }
  if (sub === "config") {
    if (rest.some((a) => a.includes("=")) || rest.filter((a) => !a.startsWith("-")).length > 1) {
      return "git config (write) …";
    }
    return undefined;
  }
  if (sub === "stash") {
    if (rest[0] !== "list" && rest[0] !== "show") return "git stash …";
    return undefined;
  }
  if (sub === "submodule") {
    if (rest[0] !== "status") return "git submodule …";
    return undefined;
  }
  if (sub === "worktree") {
    if (rest[0] !== "list") return "git worktree …";
    return undefined;
  }

  if (GIT_BLOCKED.has(sub)) return `git ${sub} …`;
  if (!GIT_READ_ONLY.has(sub)) return `git ${sub} (not read-only) …`;
  return undefined;
}

function blockedPkg(head, args) {
  let j = 0;
  while (j < args.length && args[j].startsWith("-")) j++;
  const sub = args[j]?.toLowerCase();
  const rest = args.slice(j + 1);
  if (!sub) {
    // Bare invocation: npm/pnpm/bun print help; yarn runs install.
    if (head === "yarn" && (args.length === 0 || !args.every((a) => a.startsWith("-")))) {
      return "yarn (bare) …";
    }
    return undefined;
  }
  if (!PKG_READ_ONLY[head].has(sub)) return `${head} ${sub} …`;
  if (head === "npm" && sub === "config") {
    const action = rest[0];
    if (action !== "get" && action !== "list" && action !== "ls") return "npm config (write) …";
    return undefined;
  }
  if (head === "bun" && sub === "pm") {
    const action = rest[0];
    if (action === "ls" || action === "view") return undefined;
    // `bun pm cache` prints the cache dir; `bun pm cache clean/rm` deletes it.
    if (action === "cache" && rest.length === 1) return undefined;
    return "bun pm …";
  }
  return undefined;
}

function blockedCargo(args) {
  let j = 0;
  while (j < args.length && args[j].startsWith("-")) j++;
  const sub = args[j]?.toLowerCase();
  if (!sub) return undefined; // bare cargo prints help
  if (!CARGO_READ_ONLY.has(sub)) return `cargo ${sub} …`;
  return undefined;
}

function blockedGo(args) {
  let j = 0;
  while (j < args.length && args[j].startsWith("-")) j++;
  const sub = args[j]?.toLowerCase();
  const rest = args.slice(j + 1);
  if (!sub) return undefined; // bare go prints help
  if (sub === "env" && rest.some((a) => a === "-w" || a.startsWith("-w"))) return "go env -w (write) …";
  if (!GO_READ_ONLY.has(sub)) return `go ${sub} …`;
  return undefined;
}

function blockedInterpreter(head, args, tokenCount) {
  if (tokenCount === 1) return `${head} (bare REPL) …`;
  if (!args.every((a) => INTERPRETER_FLAGS[head].has(a))) return `${head} <script> …`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API

// Validate a single command segment (no chaining inside). Returns a
// human-readable reason when the segment must be blocked, or undefined when
// it is acceptable.
export function blockedBashSegment(segment) {
  const trimmed = String(segment ?? "").trim();
  if (!trimmed) return undefined;

  if (hasRedirectOutsideQuotes(trimmed)) return `redirect in: ${trimmed}`;
  if (hasCommandSubstitution(trimmed)) return `command substitution in: ${trimmed}`;

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return undefined;
  const { head, args } = findHead(tokens);
  if (!head) return undefined;

  if (MUTATOR_HEADS.has(head)) return `${head} …`;

  if (head === "git") return blockedGit(args);
  if (head in PKG_READ_ONLY) return blockedPkg(head, args);
  if (head === "cargo") return blockedCargo(args);
  if (head === "go") return blockedGo(args);
  if (INTERPRETER_FLAGS[head]) return blockedInterpreter(head, args, tokens.length);

  const rule = HEAD_RULES[head];
  if (rule) {
    const blocked = rule(args);
    if (blocked) return blocked;
  }

  if (!READ_ONLY_HEADS.has(head)) return `${head} (not in read-only allowlist) …`;
  return undefined;
}

// Validate a full bash command, splitting on chain operators so a blocked
// segment anywhere in a pipeline/chain fails the whole command.
export function blockedBashCommand(command) {
  const segments = splitSegments(String(command ?? ""));
  for (const segment of segments) {
    const blocked = blockedBashSegment(segment);
    if (blocked) return blocked;
  }
  return undefined;
}
