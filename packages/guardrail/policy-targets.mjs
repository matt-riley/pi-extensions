// policy-targets.mjs — what a path or token is before anything runs: regenerable,
// secret, control-plane, workspace. Pure classification, no verdicts.

import path from "node:path";
import { homedir } from "node:os";

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

// Pure path matching; the host supplies realpath resolution for symlink aliases.
export function resolvedTarget(raw, cwd, resolvePath = (value) => value) {
  const expanded = String(raw).replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
  return resolvePath(path.resolve(cwd || process.cwd(), expanded));
}

function isControlPlanePath(raw, cwd, resolvePath, inNestedWorkspace) {
  const target = resolvedTarget(raw, cwd, resolvePath);
  const agent = resolvedTarget(
    process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi/agent"),
    cwd,
    resolvePath,
  );
  const rel = path.relative(agent, target).split(path.sep).join("/");
  if (isRegenerablePath(rel)) return false;
  return (
    path.basename(target) === "AGENTS.md" ||
    rel === "" ||
    /^(AGENTS\.md|settings\.json|models\.json|router\.json|mcp\.json|trust\.json|keybindings\.json)$/.test(
      rel,
    ) ||
    (/^(extensions|skills|prompts|agents)(\/|$)/.test(rel) && !inNestedWorkspace) ||
    /(^|\/)\.pi\/(settings\.json|models\.json|router\.json|mcp\.json|trust\.json|extensions(\/|$)|skills(\/|$)|prompts(\/|$)|agents(\/|$))/.test(
      target,
    )
  );
}

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
 * Checkouts can live under the agent directory (this repo does). Their files
 * are workspace, not Pi control plane. Only roots inside an extension package
 * get the override; entering installed skills, prompts or agents does not.
 */
function workspaceInsideAgent(roots, cwd, resolvePath) {
  const agent = resolvedTarget(
    process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi/agent"),
    cwd,
    resolvePath,
  );
  return roots.filter((root) => {
    const rel = path.relative(agent, root).split(path.sep).join("/");
    return /^extensions\/[^/]+(\/|$)/.test(rel);
  });
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
export function classifyTarget(rawToken, cwd, rootCwd = cwd, resolvePath) {
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
  const base = tildeish ? home : cwd;
  const resolved =
    !opaque && base && typeof base === "string" && base.trim()
      ? (resolvePath ?? ((value) => value))(path.resolve(base, token))
      : null;
  const roots = workspaceRoots(rootCwd, cwd);
  const inNestedWorkspace =
    resolved !== null &&
    workspaceInsideAgent(roots, cwd, resolvePath).some(
      (root) => resolved === root || resolved.startsWith(root + path.sep),
    );

  if (isSecretPath(token)) return "secret";
  const control = isControlPlanePath(token, cwd, resolvePath, inNestedWorkspace);
  if (!control && isRegenerablePath(token)) return "regenerable";
  if (SYSTEM_PREFIXES.some((p) => token === p || token.startsWith(`${p}/`))) return "system";
  if (control) return "control";
  if (/^\/(Users|home)\/[^/]+(\/\.ssh|\/\.aws|\/\.gnupg)(\/|$)/.test(token)) return "secret";

  if (resolved !== null) {
    if (isRegenerablePath(resolved)) return "regenerable";
    for (const root of roots) {
      if (resolved === root || resolved.startsWith(root + path.sep)) return "workspace";
    }
    if (home && (resolved === home || resolved.startsWith(home + path.sep))) return "home";
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
