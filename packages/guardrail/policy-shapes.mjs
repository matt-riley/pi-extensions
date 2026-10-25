// policy-shapes.mjs — what a command does, one segment at a time: git, remote,
// authorization, privilege, delete, overwrite. Shapes are facts, not verdicts.

import { findHead, redirectTargets, tokenize } from "../../shared/shell-parse.mjs";

export const CLASS_VERDICT = {
  regenerable: "allow",
  workspace: null,
  control: "confirm",
  unknown: null,
  home: "confirm",
  system: "block",
  secret: "block",
};

// Per-shape exceptions to the table above, where the shape changes what a
// class means: truncating a file with `>` is how a report gets written, so a
// home-directory target is a judgment rather than an interruption.
export const SHAPE_CLASS_OVERRIDE = {
  // Truncating a file with a redirect is how output gets written, not a
  // destructive act: `> ~/notes.md` names its target and the TUI shows it. Same
  // conclusion the file tools reached, for the same reason. Deleting from home
  // still asks, and secrets or system paths still refuse.
  overwrite: { home: "allow" },
};

export const SHAPE_DEFAULT = {
  delete: "judge",
  overwrite: "allow", // a redirect into the workspace is how work gets written
  history: "judge", // local history rewriting: recoverable from reflog/remote
  authorization: "confirm", // external effects need human scope, even if reversible
  remote: "confirm", // irreversible on a remote: force push, drop table, repo delete
  privilege: "confirm", // sudo, chmod -R, process kills: disruptive, not silent
  wipe: "block", // mkfs, fdisk, diskutil erase: no judgment makes this fine
  move: "allow", // mv sources: a rename in the workspace is work; out of home asks by class
};

export const READ_HEADS = new Set([
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

export const NETWORK_HEADS = new Set([
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

export const UPLOAD_FLAGS = new Set([
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

export const INTERPRETER_HEADS = new Set([
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

export function nonFlagArgs(args) {
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

function authorizationShape(head, args) {
  // RTK preserves the underlying action; it is not an authorization boundary.
  if (head === "rtk") return authorizationShape(args[0], args.slice(1));
  const text = args.join(" ");
  const consequential =
    (head === "git" && /\bpush\b/.test(text)) ||
    (head === "gh" &&
      (/\b(pr\s+(merge|create|close|reopen|edit)|release\s+(create|upload|delete)|repo\s+(create|delete|edit|rename|transfer))\b/.test(
        text,
      ) ||
        (/\bapi\b/.test(text) &&
          /(^|\s)(-X|--method|-f|-F|--field|--raw-field|--input)(=|\s)/.test(text)))) ||
    (["terraform", "tofu"].includes(head) && /\b(apply|destroy|import)\b/.test(text)) ||
    (["npm", "pnpm", "yarn", "bun"].includes(head) &&
      /^(?:(?:run|npm)\s+)?(?:publish|deploy|release)\b/.test(text)) ||
    (["wrangler", "vercel", "netlify", "fly", "flyctl"].includes(head) &&
      /\b(deploy|publish|delete|destroy|promote)\b/.test(text)) ||
    (head === "kubectl" && /\b(apply|create|delete|replace|patch|scale|rollout)\b/.test(text)) ||
    (head === "helm" && /\b(install|upgrade|uninstall|rollback)\b/.test(text)) ||
    (head === "docker" && /\bpush\b/.test(text));
  return consequential
    ? {
        id: "authorization",
        detail: head + " external effect",
        targets: [],
        scope: head + " " + text,
      }
    : null;
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

// What mv takes away from its sources. The destination is an overwrite.
function moveShape(head, args) {
  if (head !== "mv") return null;
  const sources = nonFlagArgs(args).slice(0, -1);
  return sources.length ? { id: "move", detail: "mv (source)", targets: sources } : null;
}

function overwriteShape(head, args, segment) {
  const writes = [];
  const redirects = redirectTargets(segment).filter((r) => r.target);
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
  if (["cp", "mv", "install"].includes(head)) {
    const paths = nonFlagArgs(args);
    return { id: "overwrite", detail: head, targets: paths.slice(-1) };
  }
  if (head === "tee") {
    return { id: "overwrite", detail: "tee (truncates)", targets: nonFlagArgs(args) };
  }
  if (writes.length)
    return { id: "overwrite", detail: "output redirect truncates", targets: writes };
  return null;
}

/** One segment's shapes: a segment can both overwrite and delete. */
export function detectShapes(segment) {
  const tokens = tokenize(segment);
  if (!tokens.length) return [];
  const { head, args } = findHead(tokens);
  if (!head) return [];
  const whole = ` ${segment} `;
  const found = [
    gitShape(head, args),
    deleteShape(head, args, whole),
    overwriteShape(head, args, segment),
    moveShape(head, args),
    privilegeShape(head, args, whole),
    remoteShape(head, whole),
    authorizationShape(head, args),
  ].filter(Boolean);
  return found;
}

// ---------------------------------------------------------------------------
// Indirection: interpreters, inline code and script files
