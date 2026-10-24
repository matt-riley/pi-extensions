// index.ts — pi extension: where a pull request stands.
//
// Registers:
//   watch_pr — one read of a PR's checks on its head commit, merge state and
//              unresolved review threads, with a verdict; optionally polls
//              while the only thing outstanding is a pending check
//
// Read-only: it never pushes, rebases, resolves a thread or merges.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { OPEN_READ } from "../../shared/tool-annotations.mjs";

import { assess, fetchSnapshot } from "./pr.mjs";

const GH_TIMEOUT_MS = 20_000;
const POLL_MS = 20_000;
const MAX_WAIT_S = 600;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}

export default function piWatchPrExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "watch_pr",
    label: "watch_pr",
    exposure: "deferred",
    annotations: OPEN_READ,
    description:
      "Where a pull request stands right now: checks on its head commit, merge conflicts or being behind base, " +
      "requested changes, unresolved review threads. Returns a verdict — needs-action, pending, ready or closed — " +
      "and the head SHA it applies to. With wait_seconds it polls while only pending checks remain. Read-only; " +
      "'ready' is not authority to merge.",
    promptSnippet:
      "watch_pr(pr?, wait_seconds?): checks, merge state and unresolved threads for a PR's head commit, with a verdict",
    promptGuidelines: [
      "When taking a PR to merge, call watch_pr after every push, fix what it lists, rebase if it says behind, and stop when it says ready or closed.",
    ],
    parameters: Type.Object({
      pr: Type.Optional(
        Type.String({
          description: "PR number, URL or branch. Defaults to the current branch's PR.",
        }),
      ),
      wait_seconds: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: MAX_WAIT_S,
          description: "Poll up to this long while the verdict is pending (default 0: one read).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      const exec = async (args: string[]) => {
        // exec takes no cwd, and gh has no -C: cd in a shell, as git -C does elsewhere.
        const r = await pi.exec("sh", ["-c", 'cd "$0" && exec gh "$@"', cwd, ...args], {
          timeout: GH_TIMEOUT_MS,
        });
        return r.code === 0 ? r.stdout : null;
      };
      const deadline = Date.now() + (params?.wait_seconds ?? 0) * 1000;
      for (;;) {
        const snap = await fetchSnapshot(exec, params?.pr);
        if ("error" in snap) {
          return { content: [{ type: "text", text: snap.error }], isError: true };
        }
        const { verdict, lines } = assess(snap);
        if (snap.note) lines.push(snap.note);
        if (verdict !== "pending" || Date.now() + POLL_MS > deadline || signal?.aborted) {
          return { content: [{ type: "text", text: `${verdict}\n${lines.join("\n")}` }] };
        }
        await sleep(POLL_MS, signal);
      }
    },
  });
}
