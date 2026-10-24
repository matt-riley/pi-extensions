// policy-bash.mjs — what a shell command actually runs: indirection through
// interpreters and script files, source-text heuristics, and the per-segment verdict.

import path from "node:path";
import { homedir } from "node:os";
import {
  collectSubstitutions,
  findHead,
  splitSegments,
  stripHeredocs,
  tokenize,
} from "../../shared/shell-parse.mjs";

import { worst, worstOf } from "./policy-verdict.mjs";
import { resolvedTarget, isSecretPath, isEnvFile, classifyTarget } from "./policy-targets.mjs";
import {
  CLASS_VERDICT,
  SHAPE_CLASS_OVERRIDE,
  SHAPE_DEFAULT,
  READ_HEADS,
  NETWORK_HEADS,
  UPLOAD_FLAGS,
  INTERPRETER_HEADS,
  nonFlagArgs,
  detectShapes,
} from "./policy-shapes.mjs";

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

function evaluateInline(interpreter, text, cwd, resolvePath) {
  if (SHELL_HEADS.has(interpreter)) return evaluateBashCommand(text, { cwd, resolvePath });
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
  const { cwd, scriptTexts, resolvePath } = options;
  // Heredoc bodies are data written to a file, not shell to be run: parse the
  // command lines only, and expand an unquoted body's substitutions below.
  const { text, bodies } = stripHeredocs(String(command ?? ""));
  const segments = splitSegments(text);
  const evidence = { shapes: [], targets: [], scriptRefs: [], inline: [], approvalScopes: [] };
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
      if (shape.scope)
        evidence.approvalScopes.push(
          `external:${resolvedTarget(effectiveCwd || cwd || ".", cwd, resolvePath)}:${shape.scope}`,
        );
      const fallback = SHAPE_DEFAULT[shape.id] ?? "judge";
      const targets = shape.targets.length ? shape.targets : [null];
      const perTarget = targets.map((target) => {
        const klass =
          target === null ? null : classifyTarget(target, effectiveCwd, roots, resolvePath);
        if (target !== null) evidence.targets.push(`${target} → ${klass}`);
        if (klass === "control")
          evidence.approvalScopes.push(
            `control:${shape.id}:${resolvedTarget(target, effectiveCwd, resolvePath)}`,
          );
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
        (t) => classifyTarget(t, effectiveCwd, roots, resolvePath) === "secret",
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
    const inlineVerdict = evaluateInline(item.head, item.text, effectiveCwd, resolvePath);
    evidence.approvalScopes.push(...(inlineVerdict.evidence?.approvalScopes ?? []));
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
    const sub = evaluateBashCommand(inner, { cwd: effectiveCwd, scriptTexts: {}, resolvePath });
    evidence.approvalScopes.push(...(sub.evidence?.approvalScopes ?? []));
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
      const result = /\.(sh|bash|zsh)$/.test(scriptPath)
        ? evaluateBashCommand(scriptSrc, { cwd: effectiveCwd, scriptTexts: {}, resolvePath })
        : evaluateSourceText(scriptSrc, scriptPath);
      evidence.approvalScopes.push(...(result.evidence?.approvalScopes ?? []));
      const scriptVerdict = result.verdict;
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
