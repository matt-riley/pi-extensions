// policy.mjs — the deterministic half of the guardrail.
//
// Answers one question fast, before anything is executed: what could this tool
// call destroy? No network, no model, no filesystem reads — pure text in,
// verdict out, so every rule is a test case.
//
//   allow   — provably harmless, or destructive only to regenerable output
//             (/tmp, node_modules, dist, .cache, logs, build artefacts)
//   judge   — destructive shape, but whether it matters depends on context
//             only a semantic judgment can read (is this file tracked? does the
//             request imply deleting it?). Escalates to the TypeSafe judge.
//   confirm — dangerous and legible enough that no judgment is needed; the
//             human decides, with the reason shown
//   block   — catastrophic and irreversible; refused without a dialog, because
//             a tired "Enter" should not be able to wipe ~ or leak a key
//
// Verdicts combine by taking the worst across every segment of a command and
// every target of a shape: one bad segment condemns the whole command, which
// is why `git status && rm -rf ~` cannot sneak through on the strength of its
// first half.
//
// Scope note, stated because it is a real limit: this is a guardrail, not a
// sandbox. It reads what the model wrote, not what a binary or an obfuscated
// payload does. One level of script indirection (node script.mjs, bash x.sh,
// sh -c "…") is followed; printf-decoded or fetched-at-runtime code is not.

import path from "node:path";
import { homedir } from "node:os";

import {
  collectSubstitutions,
  findHead,
  redirectTargets,
  splitSegments,
  stripHeredocs,
  tokenize,
} from "../../shared/shell-parse.mjs";

const VERDICT_RANK = { allow: 0, judge: 1, confirm: 2, block: 3 };

/** The more severe of two verdicts. */
export function worst(a, b) {
  return (VERDICT_RANK[b] ?? 0) > (VERDICT_RANK[a] ?? 0) ? b : a;
}

/** The most severe verdict in a list. */
function worstOf(verdicts) {
  return verdicts.reduce((acc, v) => worst(acc, v), "allow");
}

// ---------------------------------------------------------------------------
// Path classification

// Regenerable: rebuilding or re-running recreates it, so destroying it costs
// time, not data. Checked before every other class — `node_modules` inside a
// repo is regenerable, a key inside one is not.
const REGENERABLE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)(dist|build|out|target|coverage|\.next|\.nuxt|\.svelte-kit|\.cache|\.parcel-cache|\.turbo|__pycache__|\.venv|venv|\.pytest_cache|\.mypy_cache)(\/|$)/,
  // A lock file is the one thing inside .git that exists to be deleted.
  /(^|\/)\.git\/[^/]*\.lock$/,
  /^\/tmp(\/|$)/,
  /^\/(private\/)?var\/folders(\/|$)/,
  /^\/(private\/)?tmp(\/|$)/,
  /\.(log|tmp|tgz|tar\.gz|zip|DS_Store)$/,
  /(^|\/)\.DS_Store$/,
];

// Secrets and VCS internals: destroying these is not recoverable from a
// rebuild, and a key that existed in one place may exist nowhere else.
const SECRET = [
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.(git)(\/|$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)authorized_keys$/,
  /(^|\/)(credentials|service-account[^/]*)\.json$/,
  /(^|\/)auth\.json$/,
];

const SYSTEM_PREFIXES = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/sys",
  "/proc",
  "/dev",
  "/System",
  "/Library",
  "/Applications",
  "/opt",
  "/private/etc",
  "/private/var",
];

const HOME_PREFIXES = [
  /^~(\/|$)/,
  /^\$HOME(\/|$)/,
  /^\$\{HOME\}(\/|$)/,
  /^\/(Users|home)\/[^/]+(\/|$)/,
];

function isRegenerablePath(token) {
  return REGENERABLE.some((re) => re.test(token));
}

export function isSecretPath(token) {
  return SECRET.some((re) => re.test(token));
}

/** A dotenv file: secrets, but a routine one to create and overwrite. */
export function isEnvFile(token) {
  return (
    /(^|\/)\.env(\.[^/]*)?$/.test(token) ||
    /(^|\/)\.env\.(local|development|production|test)$/.test(token)
  );
}

/**
/**
 * Directories that count as "the workspace": the session's cwd, plus wherever
 * this command `cd`-ed to before acting.
 *
 * The session cwd alone is not enough. A session often runs from a parent
 * directory (or one repo) while the work happens in another: every write to
 * ~/.pi/agent/extensions/pi-extensions/knip.json then looked like an edit
 * outside the workspace and prompted. $HOME and the filesystem root are never
 * workspace roots — `cd ~ && rm -rf Documents` is still a home delete.
 */
function workspaceRoots(roots, cwd) {
  const candidates = Array.isArray(roots) ? roots : [roots, cwd];
  const out = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const resolved = path.resolve(candidate);
    if (resolved === path.parse(resolved).root) continue;
    if (homedir() === resolved) continue;
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/**
 * Classify a path token as one of:
 *   regenerable | secret | system | workspace | home | unknown
 *
 * `workspace` means "inside the session's cwd" and is checked after the
 * absolute-danger classes: the guardrail must not flag every edit in a repo
 * that happens to live under ~/Documents.
 */
/**
 * Classify a path token as one of:
 *   regenerable | secret | system | workspace | home | unknown
 *
 * `cwd` is the directory the command will actually run in (after any leading
 * `cd`); the third argument is the workspace root, or the set of roots, and
 * defaults to `cwd`. A path inside any root is workspace.
 */
export function classifyTarget(rawToken, cwd, rootCwd = cwd) {
  const token = String(rawToken ?? "")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (!token) return "unknown";
  if (token === "/dev/null") return "regenerable";

  // Command substitution hides the real target; a variable or glob hides it too.
  const opaque = /[$`]/.test(token) || /[*?]/.test(token);
  // The shell expands these before the command sees them, so resolving them
  // against a cwd would invent a directory literally named `~`.
  const tildeish = /^(~|\$HOME|\$\{HOME\})(\/|$)/.test(token);
  const home = homedir();

  if (isRegenerablePath(token)) return "regenerable";
  if (isSecretPath(token)) return "secret";
  if (SYSTEM_PREFIXES.some((p) => token === p || token.startsWith(`${p}/`))) return "system";
  if (/^\/(Users|home)\/[^/]+(\/\.ssh|\/\.aws|\/\.gnupg)(\/|$)/.test(token)) return "secret";

  if (!opaque) {
    const base = tildeish ? home : cwd;
    if (base && typeof base === "string" && base.trim()) {
      const resolved = path.resolve(base, token);
      if (isRegenerablePath(resolved)) return "regenerable";
      for (const root of workspaceRoots(rootCwd, cwd)) {
        if (resolved === root || resolved.startsWith(root + path.sep)) return "workspace";
      }
      if (home && (resolved === home || resolved.startsWith(home + path.sep))) return "home";
    }
  }

  if (HOME_PREFIXES.some((re) => re.test(token))) return "home";
  return "unknown";
}

// ---------------------------------------------------------------------------
// What each shape means by default, per target class
//
// null = defer to the shape's own default, because a regenerable target makes
// the shape harmless (rm -rf dist) and a workspace target is context, not
// danger (rm src/foo.ts may be exactly what was asked for).

const CLASS_VERDICT = {
  regenerable: "allow",
  workspace: null,
  unknown: null,
  home: "confirm",
  system: "block",
  secret: "block",
};

// Per-shape exceptions to the table above, where the shape changes what a
// class means: truncating a file with `>` is how a report gets written, so a
// home-directory target is a judgment rather than an interruption.
const SHAPE_CLASS_OVERRIDE = {
  // Truncating a file with a redirect is how output gets written, not a
  // destructive act: `> ~/notes.md` names its target and the TUI shows it. Same
  // conclusion the file tools reached, for the same reason. Deleting from home
  // still asks, and secrets or system paths still refuse.
  overwrite: { home: "allow" },
};

const SHAPE_DEFAULT = {
  delete: "judge",
  overwrite: "allow", // a redirect into the workspace is how work gets written
  history: "judge", // local history rewriting: recoverable from reflog/remote
  remote: "confirm", // irreversible on a remote: force push, drop table, repo delete
  privilege: "confirm", // sudo, chmod -R, process kills: disruptive, not silent
  wipe: "block", // mkfs, fdisk, diskutil erase: no judgment makes this fine
};

const READ_HEADS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "base64",
  "xxd",
  "od",
  "strings",
  "openssl",
  "dd",
  "cp",
  "rsync",
  "scp",
  "tar",
  "zip",
]);
const NETWORK_HEADS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "http",
  "httpie",
]);
const UPLOAD_FLAGS = new Set([
  "-d",
  "--data",
  "--data-binary",
  "--data-raw",
  "-T",
  "--upload-file",
  "-F",
  "--form",
  "--post-file",
]);

const INTERPRETER_HEADS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "bash",
  "sh",
  "zsh",
  "fish",
  "osascript",
  "awk",
]);

function nonFlagArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "-e") {
      // Takes a value; skip both the flag and its value.
      out.push(args[++i] ?? "");
      continue;
    }
    if (a.startsWith("-")) continue;
    // Redirections are not targets: `rm -rf x 2>/dev/null` deletes x.
    if (/^\d*[<>]/.test(a)) continue;
    if (a) out.push(a);
  }
  return out.filter(Boolean);
}

function hasFlag(args, ...flags) {
  return args.some((a) => flags.includes(a));
}

// ---------------------------------------------------------------------------
// Shape detection, one segment at a time

function gitShape(head, args) {
  if (head !== "git") return null;
  const [sub] = nonFlagArgs(args);
  if (!sub) return null;
  const rest = args.slice(args.indexOf(sub) + 1);

  if (sub === "clean") return { id: "delete", detail: "git clean", targets: ["."] };
  if (sub === "branch" && hasFlag(rest, "-D", "--delete")) {
    return { id: "delete", detail: "git branch -D", targets: nonFlagArgs(rest) };
  }
  if (sub === "reset" && rest.includes("--hard"))
    return { id: "history", detail: "git reset --hard", targets: ["."] };
  if (sub === "checkout" && (rest.includes("--") || rest.includes(".")))
    return { id: "history", detail: "git checkout -- (discards uncommitted work)", targets: ["."] };
  if (sub === "restore")
    return { id: "history", detail: "git restore (discards uncommitted work)", targets: ["."] };
  if (sub === "stash" && hasFlag(rest, "drop", "clear"))
    return { id: "delete", detail: `git stash ${rest[0]}`, targets: ["."] };
  if (sub === "filter-branch" || sub === "reflog")
    return { id: "history", detail: `git ${sub}`, targets: ["."] };
  if (sub === "push") {
    const forced = hasFlag(rest, "-f", "--force");
    const leases = rest.some((a) => a.startsWith("--force-with-lease"));
    if (forced && !leases)
      return { id: "remote", detail: "git push --force (rewrites remote history)", targets: [] };
  }
  return null;
}

function remoteShape(head, whole) {
  if (/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)/i.test(whole))
    return { id: "remote", detail: "SQL DROP/TRUNCATE", targets: [] };
  if (head === "kubectl" && /\bdelete\b/.test(whole))
    return { id: "remote", detail: "kubectl delete", targets: [] };
  if (head === "terraform" && /\bdestroy\b/.test(whole))
    return { id: "remote", detail: "terraform destroy", targets: [] };
  if (head === "docker" && /\b(system\s+prune|rm\s+-f|volume\s+rm)\b/.test(whole))
    return { id: "remote", detail: "docker prune/force-remove", targets: [] };
  if (head === "npm" && /\bpublish\b/.test(whole))
    return { id: "remote", detail: "npm publish", targets: [] };
  if (head === "gh" && /\b(repo|release)\s+delete\b/.test(whole))
    return { id: "remote", detail: "gh delete", targets: [] };
  if ((head === "aws" || head === "gcloud") && /\b(s3\s+rm|delete-|rm\b)/.test(whole))
    return { id: "remote", detail: `${head} delete`, targets: [] };
  return null;
}

function privilegeShape(head, args, whole) {
  if (head === "sudo" || head === "su") return { id: "privilege", detail: head, targets: [] };
  if (
    (head === "chmod" || head === "chown" || head === "chgrp") &&
    hasFlag(args, "-R", "--recursive")
  ) {
    return { id: "privilege", detail: `${head} -R`, targets: nonFlagArgs(args) };
  }
  if (head === "killall" || head === "pkill") return { id: "privilege", detail: head, targets: [] };
  if (["shutdown", "reboot", "halt", "poweroff"].includes(head))
    return { id: "privilege", detail: head, targets: [] };
  if (head === "launchctl" && /\b(bootout|unload|remove|disable)\b/.test(whole))
    return { id: "privilege", detail: "launchctl", targets: [] };
  if (head === "defaults" && /\bwrite\b/.test(whole))
    return { id: "privilege", detail: "defaults write", targets: [] };
  if (head === "diskutil" && /erase|reformat|zeroDisk|partitionDisk/i.test(whole))
    return { id: "wipe", detail: "diskutil erase", targets: [] };
  if (/^mkfs(\.|$)/.test(head ?? "") || head === "fdisk" || head === "newfs")
    return { id: "wipe", detail: head, targets: [] };
  return null;
}

function deleteShape(head, args, whole) {
  if (["rm", "shred", "unlink", "rmdir"].includes(head)) {
    return { id: "delete", detail: head, targets: nonFlagArgs(args) };
  }
  if (head === "find" && /\s-delete\b/.test(whole)) {
    return {
      id: "delete",
      detail: "find -delete",
      targets: nonFlagArgs(args).filter((a) => a !== "-delete"),
    };
  }
  if (head === "truncate" && /\s-s\s*0\b|\s--size[= ]0\b/.test(whole)) {
    return { id: "delete", detail: "truncate -s 0", targets: nonFlagArgs(args) };
  }
  if (head === "shred") return { id: "delete", detail: "shred", targets: nonFlagArgs(args) };
  return null;
}

function overwriteShape(head, args, segment) {
  const writes = [];
  const redirects = redirectTargets(segment).filter((r) => r.op === ">" && r.target);
  for (const r of redirects) writes.push(r.target);

  if (head === "dd") {
    const of = args.find((a) => a.startsWith("of="));
    if (of) writes.push(of.slice(3));
  }
  if (head === "sed" && args.some((a) => a === "-i" || a.startsWith("-i") || a === "--in-place")) {
    // The script is not a target: `sed -i s|a|b| file.txt` writes file.txt.
    const values = nonFlagArgs(args);
    const explicit = args.some(
      (a) => a === "-e" || a === "--expression" || a === "-f" || a === "--file",
    );
    return {
      id: "overwrite",
      detail: "sed -i (in-place edit)",
      targets: explicit ? values : values.slice(-1),
    };
  }
  if (head === "tee" && !args.some((a) => a === "-a" || a === "--append")) {
    return { id: "overwrite", detail: "tee (truncates)", targets: nonFlagArgs(args) };
  }
  if (writes.length)
    return { id: "overwrite", detail: "output redirect truncates", targets: writes };
  return null;
}

/** One segment's shapes: a segment can both overwrite and delete. */
function detectShapes(segment) {
  const tokens = tokenize(segment);
  if (!tokens.length) return [];
  const { head, args } = findHead(tokens);
  if (!head) return [];
  const whole = ` ${segment} `;
  const found = [
    gitShape(head, args),
    deleteShape(head, args, whole),
    overwriteShape(head, args, segment),
    privilegeShape(head, args, whole),
    remoteShape(head, whole),
  ].filter(Boolean);
  return found;
}

// ---------------------------------------------------------------------------
// Indirection: interpreters, inline code and script files

const INLINE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-E"]);

/** Script files a command would execute, and inline source passed directly. */
function collectIndirection(command) {
  const scriptRefs = [];
  const inline = [];
  for (const segment of splitSegments(String(command ?? ""))) {
    const tokens = tokenize(segment);
    const { head, args } = findHead(tokens);
    if (!head || !INTERPRETER_HEADS.has(head)) continue;
    if (head === "awk") continue; // awk programs mutate only via redirection or system()
    const flag = args.find((a) => INLINE_FLAGS.has(a));
    if (flag) {
      const value = args[args.indexOf(flag) + 1];
      if (value) inline.push({ head, text: value });
      continue;
    }
    const file = nonFlagArgs(args).find((a) =>
      /\.(mjs|cjs|js|ts|tsx|py|rb|pl|php|sh|bash|zsh)$/.test(a),
    );
    if (file) scriptRefs.push(file);
    else if (tokens.length > 1) inline.push({ head, text: args.join(" ") });
  }
  return { scriptRefs, inline };
}

// Destructive APIs in source text, for the one level of indirection the
// command line cannot show (node -e "fs.rmSync(x,{recursive:true})"). These are
// API-shaped, so a match is a match wherever it appears, quotes and all.
const SOURCE_API_SHAPES = [
  [
    /\b(rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink)\s*\(\s*[^)]*recursive/i,
    "filesystem delete (recursive)",
  ],
  [/\bshutil\.rmtree\s*\(/i, "shutil.rmtree"],
  [/\bos\.(remove|unlink|rmdir)\s*\(/i, "os.remove"],
  [/\b(rimraf|fs\.rm|fs\.rmdir|fs\.unlink)\b/i, "filesystem delete"],
  [
    /\b(child_process|subprocess|execSync|spawnSync|system)\s*[.(][^)]*\brm\s+-/i,
    "shells out to rm",
  ],
];

// Command-shaped patterns are also what a fixture or a help string contains,
// so they are matched against source with string literals blanked: a script
// that *mentions* `rm -rf` is not a script that runs one. Measured: three of
// the fifteen prompts in one session came from this repo's own measurement
// scripts quoting the commands they classify.
const SOURCE_TEXT_SHAPES = [
  [/\bgit\s+push\b[^\n"'`]*--force/i, "force push"],
  [/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/i, "rm -rf"],
  [/\bchmod\s+-R\s+777\b/i, "chmod -R 777"],
];

/** SQL statements, which only ever appear inside string literals. */
const SOURCE_RAW_SHAPES = [
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, "SQL DROP"],
  [/\bTRUNCATE\s+TABLE\b/i, "SQL TRUNCATE"],
];

const SOURCE_CATASTROPHIC = [
  /\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*\s+(\/|~|\$HOME)(\s|$|["'`;])/i,
  /\bshutil\.rmtree\s*\(\s*["'`]?\//i,
  /\bmkfs(\.|\s)/i,
  /\bDROP\s+DATABASE\b/i,
  /\bdd\s+[^\n]*of=\/dev\/(disk|rdisk)/i,
];

/**
 * Source text with string literals and comments blanked out.
 *
 * Patterns are matched against this rather than the raw text, because a
 * fixture, a help string, or this repo's own measurement scripts quote the
 * commands they classify — and quoting a command is not running one. Written
 * as a scanner rather than a regex: a regex cannot tell a quote inside a
 * template literal from one that opens a string, so `\`node -e "…"\`` used to
 * leak its contents once the inner quotes were stripped.
 *
 * Length is preserved (blanked, not removed) so nothing sensitive is glued
 * together by the removal.
 */
function stripSourceLiterals(src) {
  const text = String(src ?? "");
  let out = "";
  let quote = null;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
        out += " ";
        i++;
        continue;
      }
      out += " ";
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += " ";
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += " ";
        i++;
      }
      out += i < n ? "  " : "";
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Classify source text (a script, or an inline -e/-c payload). */
function evaluateSourceText(text, label = "inline code") {
  const src = String(text ?? "");
  const code = stripSourceLiterals(src);
  const hits = [];
  // SQL is written inside string literals, so blanking them would hide every
  // statement: those patterns read the raw text.
  for (const [re, name] of SOURCE_RAW_SHAPES) {
    if (re.test(src)) hits.push(name);
  }
  for (const [re, name] of SOURCE_API_SHAPES) {
    if (re.test(code)) hits.push(name);
  }
  for (const [re, name] of SOURCE_TEXT_SHAPES) {
    if (re.test(code)) hits.push(name);
  }

  if (!hits.length) {
    return { verdict: "allow", reason: null, evidence: { source: label, shapes: [] } };
  }
  const cats = SOURCE_CATASTROPHIC.filter((re) => re.test(code));
  if (cats.length) {
    return {
      verdict: "block",
      reason: `${label} looks catastrophic (${cats.length} pattern${cats.length > 1 ? "s" : ""})`,
      evidence: { source: label, shapes: hits },
    };
  }
  return {
    verdict: "judge",
    reason: `${label} may destroy data: ${hits.slice(0, 3).join(", ")}`,
    evidence: { source: label, shapes: hits },
  };
}

// ---------------------------------------------------------------------------
// Shell command evaluation

const READ_TOKEN =
  /(^|\/)(\.ssh|\.aws|\.gnupg)(\/|$)|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|authorized_keys/;

// Wiping a filesystem or home root is the one deletion that no judgment makes
// acceptable: there is no "was this what the user meant?" that ends in yes.
const CATASTROPHIC_TARGETS = [
  /^~\/?$/,
  /^\$HOME\/?$/,
  /^\$\{HOME\}\/?$/,
  /^\/(Users|home)\/?$/,
  /^\/$/,
  /^\/\*$/,
  /^\/(etc|usr|var|bin|sbin|lib|System|Library)\/?$/,
];

/** Inline code is either a shell command (classify precisely) or source. */
// Interpreters whose payload is code, not shell. Reading `node -e` source with
// the shell rules made every `=>` look like a redirect.
const SHELL_HEADS = new Set(["bash", "sh", "zsh", "fish", "dash", "ksh"]);

function evaluateInline(interpreter, text, cwd) {
  if (SHELL_HEADS.has(interpreter)) return evaluateBashCommand(text, { cwd });
  return evaluateSourceText(text, `${interpreter} inline`);
}

function secretReadVsNetwork(segments) {
  let readsSecret = false;
  let uploadsSecret = false;
  let network = false;
  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (!tokens.length) continue;
    const { head, args } = findHead(tokens);
    const touchesSecret = tokens
      .filter((t) => !t.endsWith(".pub") && !t.startsWith("-"))
      .some((t) => READ_TOKEN.test(t) || isSecretPath(t) || isEnvFile(t));
    if (NETWORK_HEADS.has(head)) {
      network = true;
      const uploadIdx = args.findIndex((a) => UPLOAD_FLAGS.has(a) || a.startsWith("@"));
      if (uploadIdx >= 0) {
        const value = args[uploadIdx];
        const pathInFlag = value.startsWith("@") ? value.slice(1) : args[uploadIdx + 1];
        if (pathInFlag && READ_TOKEN.test(pathInFlag)) uploadsSecret = true;
      }
      if (tokens.some((t) => t.startsWith("@") && READ_TOKEN.test(t))) uploadsSecret = true;
    }
    if (READ_HEADS.has(head) && touchesSecret) readsSecret = true;
  }
  return { readsSecret, uploadsSecret, network };
}

/**
 * Evaluate a whole bash command. Pure: no process, no filesystem.
 * `scriptTexts` maps a script path to its text when the caller has read it —
 * the caller does the reading, so this stays testable.
 */
export function evaluateBashCommand(command, options = {}) {
  const { cwd, scriptTexts } = options;
  // Heredoc bodies are data written to a file, not shell to be run: parse the
  // command lines only, and expand an unquoted body's substitutions below.
  const { text, bodies } = stripHeredocs(String(command ?? ""));
  const segments = splitSegments(text);
  const evidence = { shapes: [], targets: [], scriptRefs: [], inline: [] };
  let verdict = "allow";
  let reason = null;
  // `cd /tmp && rm -rf scratch` is scratch, not a workspace delete. Chained
  // commands are read in order, so a leading cd re-bases the targets that
  // follow — without it the most common cleanup idiom in real sessions looks
  // like an attack on the repo.
  let effectiveCwd = typeof cwd === "string" ? cwd : undefined;
  // Every directory this command works in counts as a workspace root: the
  // session cwd, and each `cd` destination along the way. Without this, work in
  // a repo other than the session's cwd reads as "outside the workspace".
  const roots = typeof cwd === "string" && cwd.trim() ? [path.resolve(cwd)] : [];

  for (const segment of segments) {
    const head = findHead(tokenize(segment));
    if (head.head === "cd" && effectiveCwd) {
      const dest = nonFlagArgs(head.args)[0];
      if (!dest) effectiveCwd = undefined; // bare `cd` lands in $HOME: unknowable
      else if (dest !== "-") {
        // Expand a leading ~ rather than resolving it: path.resolve(home, "~")
        // would invent a directory named `~` inside the home directory, and
        // then treat everything under it as the workspace.
        const tilde = /^(~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(dest);
        effectiveCwd = tilde
          ? path.join(homedir(), dest.slice(tilde[1].length))
          : path.resolve(effectiveCwd, dest);
        roots.push(effectiveCwd);
      }
      continue;
    }
    for (const shape of detectShapes(segment)) {
      evidence.shapes.push(`${shape.id}: ${shape.detail}`);
      const fallback = SHAPE_DEFAULT[shape.id] ?? "judge";
      const targets = shape.targets.length ? shape.targets : [null];
      const perTarget = targets.map((target) => {
        const klass = target === null ? null : classifyTarget(target, effectiveCwd, roots);
        if (target !== null) evidence.targets.push(`${target} → ${klass}`);
        // A target class both raises and lowers the shape's default: rm -rf
        // dist is harmless and rm -rf .git is not, yet both are "delete".
        const byClass = klass
          ? (SHAPE_CLASS_OVERRIDE[shape.id]?.[klass] ?? CLASS_VERDICT[klass])
          : null;
        return { target, klass, verdict: byClass ?? fallback };
      });
      let shapeVerdict = worstOf(perTarget.map((t) => t.verdict));
      const wipe = perTarget.find(
        (t) =>
          t.target !== null && CATASTROPHIC_TARGETS.some((re) => re.test(String(t.target).trim())),
      );
      const touchesSecret = shape.targets.some(
        (t) => classifyTarget(t, effectiveCwd, roots) === "secret",
      );
      if (shape.id === "delete" && wipe) {
        shapeVerdict = "block";
        reason = `refusing to delete ${String(wipe.target).trim()}`;
      } else if (touchesSecret) {
        shapeVerdict = "block";
        reason = `${shape.detail} would destroy credentials or VCS internals`;
      } else if (shapeVerdict !== "allow") {
        const controlling = perTarget.find((t) => t.verdict === shapeVerdict);
        reason = `${shape.id} (${shape.detail}) on ${controlling?.klass ?? "this command"}`;
      }
      verdict = worst(verdict, shapeVerdict);
    }
  }

  // Exfiltration needs the whole command, because the pipe is the evidence.
  const { readsSecret, uploadsSecret, network } = secretReadVsNetwork(segments);
  if (uploadsSecret || (readsSecret && network)) {
    evidence.shapes.push("exfil: secret read with a network command");
    verdict = "block";
    reason = "credentials piped to a network command";
  } else if (readsSecret) {
    evidence.shapes.push("secret read");
    if (verdict === "allow") reason = "reads credential material";
    verdict = worst(verdict, "judge");
  }

  const indirection = collectIndirection(command);
  evidence.scriptRefs = indirection.scriptRefs;
  evidence.inline = indirection.inline.map((i) => `${i.head}: ${String(i.text).slice(0, 80)}`);
  for (const item of indirection.inline) {
    const inlineVerdict = evaluateInline(item.head, item.text, effectiveCwd);
    if (inlineVerdict.verdict !== "allow") {
      reason ??= `${item.head} runs inline code with destructive operations`;
      verdict = worst(verdict, inlineVerdict.verdict);
    }
  }

  // Command substitution hides a command inside an argument: `echo $(rm -rf
  // ~)` reads as `echo` to anything that only looks at the first word. An
  // unquoted heredoc body expands the same way before it is written.
  const substitutions = [
    ...collectSubstitutions(text),
    ...bodies.filter((b) => !b.quoted).flatMap((b) => collectSubstitutions(b.body)),
  ];
  for (const inner of substitutions) {
    const sub = evaluateBashCommand(inner, { cwd: effectiveCwd, scriptTexts: {} });
    if (sub.verdict !== "allow") {
      reason ??= sub.reason
        ? `substitution: ${sub.reason}`
        : `substitution runs ${inner.trim().slice(0, 60)}`;
      verdict = worst(verdict, sub.verdict);
    }
  }

  // Contract: a caller that read the referenced scripts passes `scriptTexts`
  // (possibly empty) plus `unresolvedScripts` for anything it could not read.
  // A caller that passes nothing is treated as having inspected nothing, so
  // unread code is judged rather than waved through.
  const unresolved = Array.isArray(options.unresolvedScripts) ? options.unresolvedScripts : [];
  if (scriptTexts && typeof scriptTexts === "object") {
    for (const [scriptPath, scriptSrc] of Object.entries(scriptTexts)) {
      const scriptVerdict = evaluateSourceText(scriptSrc, scriptPath).verdict;
      if (scriptVerdict !== "allow") {
        reason ??= `${scriptPath} contains destructive operations`;
        verdict = worst(verdict, scriptVerdict);
      }
    }
  } else if (indirection.scriptRefs.length) {
    verdict = worst(verdict, "judge");
    reason ??= `runs ${indirection.scriptRefs[0]}, which has not been inspected`;
  }
  if (unresolved.length) {
    verdict = worst(verdict, "judge");
    reason ??= `could not inspect ${unresolved[0]}`;
  }

  return { verdict, reason, evidence };
}

// ---------------------------------------------------------------------------
// File tools (edit / write) and unknown tools

const PATH_KEYS = new Set(["path", "file_path", "filePath", "target", "filename", "destination"]);
const COMMAND_KEYS = new Set(["command", "cmd", "script", "shell"]);

function collectPaths(input, out = []) {
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && PATH_KEYS.has(key)) out.push(value);
    else if (value && typeof value === "object") collectPaths(value, out);
  }
  return out;
}

function collectCommands(input, out = []) {
  if (!input || typeof input !== "object") return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && COMMAND_KEYS.has(key)) out.push(value);
    else if (value && typeof value === "object") collectCommands(value, out);
  }
  return out;
}

function evaluateFileTool(toolName, input, { cwd } = {}) {
  const evidence = { targets: [], shapes: [] };
  let verdict = "allow";
  let reason = null;

  const paths = collectPaths(input);
  if (!paths.length) return { verdict: "allow", reason: null, evidence };

  for (const target of paths) {
    const klass = classifyTarget(target, cwd);
    evidence.targets.push(`${target} → ${klass}`);
    let targetVerdict = "allow";
    if (klass === "secret") {
      targetVerdict = "block";
      reason = `${toolName} would modify ${target} (credential or VCS internals)`;
    } else if (klass === "system") {
      targetVerdict = "block";
      reason = `${toolName} would modify a system path: ${target}`;
    } else if (isEnvFile(target)) {
      // Dotenv secrets are a human decision wherever they live.
      targetVerdict = "confirm";
      reason ??= `${toolName} would overwrite ${target} (dotenv secrets)`;
    } else if (klass === "home") {
      // Anything else outside the workspace is routine: sessions work across
      // repositories, and a config file is not a secret. Measured: the rule
      // that used to judge these produced 8 of the 15 prompts in one session,
      // every one of them a legitimate config write in a sibling repo.
      targetVerdict = "allow";
    }
    if (targetVerdict !== "allow") evidence.shapes.push(`${toolName}: ${target}`);
    verdict = worst(verdict, targetVerdict);
  }
  return { verdict, reason, evidence };
}

// Tools that only ever read. Anything not listed here and not a known writer
// is inspected for command- or path-shaped arguments instead of being trusted.
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "ls",
  "find",
  "glob",
  "read_file",
  "list_dir",
  "code_search",
  "file_outline",
  "find_definition",
  "repo_map",
  "web_fetch",
  "batch_web_fetch",
  "web_search",
  "plan_fetch_url",
  "typesafe_ask",
  "skill_select",
  "plan_mode_question",
  "plan_mode_complete",
  "todo_read",
  "task_list",
]);

function isReadOnlyToolName(name) {
  const n = String(name ?? "").toLowerCase();
  return (
    READ_ONLY_TOOLS.has(n) ||
    /^(get|list|search|read|fetch|query|describe|show|recall)_/.test(n) ||
    n.startsWith("lore_")
  );
}

/**
 * The single entry point: classify one tool call before it runs.
 * Returns { verdict, reason, evidence }.
 */
export function evaluateToolCall({ toolName, input, cwd, scriptTexts, unresolvedScripts } = {}) {
  const name = String(toolName ?? "");
  const lower = name.toLowerCase();

  if (isReadOnlyToolName(lower))
    return { verdict: "allow", reason: null, evidence: { shapes: [] } };

  // Command-shaped arguments run the shell rules, whatever the tool is called.
  // That covers bash, and any future extension tool that shells out — a
  // tool's name is a promise, its arguments are the evidence.
  const commands = collectCommands(input);
  if (commands.length) {
    let verdict = "allow";
    let reason = null;
    const evidence = { shapes: [], targets: [], scriptRefs: [], inline: [] };
    for (const command of commands) {
      const result = evaluateBashCommand(command, { cwd, scriptTexts, unresolvedScripts });
      verdict = worst(verdict, result.verdict);
      reason ??= result.reason;
      evidence.shapes.push(...(result.evidence.shapes ?? []));
      evidence.targets.push(...(result.evidence.targets ?? []));
      // The caller needs these to follow one level of indirection: dropping
      // them here means scripts are never read and never reclassified.
      evidence.scriptRefs.push(...(result.evidence.scriptRefs ?? []));
      evidence.inline.push(...(result.evidence.inline ?? []));
    }
    return { verdict, reason, evidence };
  }

  // Path-shaped arguments: secrets and system paths are refused whoever is
  // asking; anything else is routine, because sessions work across repos.
  // because nagging about every read of a home-directory path would be noise.
  const fileish = evaluateFileTool(name, input, { cwd });
  if (fileish.verdict !== "allow") return fileish;
  return { verdict: "allow", reason: null, evidence: { shapes: [] } };
}
