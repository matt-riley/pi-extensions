#!/usr/bin/env node
// Pre-flight for .pi/verify/SKILL.md: says what this machine can actually drive.
// Exit 0 when the offline gates and the terminal harness can run, 1 otherwise.
// Starts nothing, so it is also the check to repeat after anything surprising.
import { execFileSync } from "node:child_process";

const run = (binary, args) => {
  try {
    return execFileSync(binary, args, {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
};

const binaries = [
  {
    name: "pi",
    args: ["--version"],
    min: [1, 4],
    why: "npm run smoke refuses hosts older than 1.4.0",
  },
  { name: "tmux", args: ["-V"], why: "node .pi/verify/workbench.mjs drives a real terminal" },
  { name: "nvim", args: ["--version"], why: "the workbench editor handoff opens a real Neovim" },
  { name: "git", args: ["--version"], why: "fixtures and the target revision" },
];

let failed = false;
for (const { name, args, min, why } of binaries) {
  const output = run(name, args);
  const version = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(output ?? "");
  const patch = Number(version?.[3] ?? 0);
  const tooOld =
    min && version && (Number(version[1]) < min[0] || (Number(version[1]) === min[0] && Number(version[2]) < min[1]));
  if (!output) {
    failed = true;
    console.log(`MISSING ${name}: not on PATH — ${why}`);
  } else if (tooOld) {
    failed = true;
    console.log(`MISSING ${name}: ${version[1]}.${version[2]}.${patch} — ${why}`);
  } else {
    console.log(`ok      ${name.padEnd(5)} ${version ? `${version[1]}.${version[2]}${version[3] ? "." + version[3] : ""}` : output.split("\n")[0]}`);
  }
}

const head = run("git", ["rev-parse", "--short", "HEAD"]) ?? "no HEAD";
const dirty = (run("git", ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length;
console.log(`target  ${head}, ${dirty} changed path(s) in the working tree`);
console.log(
  process.env.TYPESAFE_API_KEY
    ? "ok      TYPESAFE_API_KEY set — live judgment and web_answer drives are available"
    : "info    TYPESAFE_API_KEY unset — typesafe_ask, read_relevant, find_code, web_answer, review, router and prompt-coach drives report the offline fallback",
);
console.log(
  failed
    ? "doctor: fix the MISSING lines before launching"
    : "doctor: ready for npm run check, npm run verify, npm run smoke and the workbench drive",
);
process.exit(failed ? 1 : 0);
