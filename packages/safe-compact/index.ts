// index.ts — pi extension: safe self-compaction with Jev making the judgment calls.
//
// Hybrid trigger: below --compact-soft-at nothing happens; between soft and
// hard, Jev decides whether this turn boundary is a clean place to compact;
// at --compact-at (or when the agent calls self_compact) it compacts at that
// boundary. The summary itself is assembled by plan.mjs from spans Jev
// selected and verified. Any failure returns nothing, so pi's native
// compaction runs, and the manual `/safe-compact` command still uses
// ctx.compact() for the idle case.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { judgeMoment } from "./judge.mjs";
import {
  buildBoundaryCompaction,
  composeHandoff,
  decideTrigger,
  fileListsFromDetails,
  mergeFileLists,
} from "./plan.mjs";
import { messageText } from "./segment.mjs";

const DEFAULT_SOFT = 50;
const DEFAULT_HARD = 70;
const MAX_HARD = 90;
const MOMENT_TIMEOUT_MS = 8000;
const RECENT_ENTRIES = 8;
const DEFAULT_KEEP_RECENT = 20000;

type Ask = (request: {
  state: unknown;
  questions: unknown;
  signal?: AbortSignal;
}) => Promise<unknown>;

const percentFlag = (raw: unknown, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export default function safeCompact(pi: ExtensionAPI, options: { ask?: Ask } = {}) {
  const ask = options.ask;

  pi.registerFlag("compact-soft-at", {
    description: `Context % where Jev starts looking for a clean moment to compact (default ${DEFAULT_SOFT})`,
    type: "string",
  });
  pi.registerFlag("compact-at", {
    description: `Context % where compaction happens regardless of moment (default ${DEFAULT_HARD}, max ${MAX_HARD})`,
    type: "string",
  });

  let pendingNote: string | undefined;
  let requested = false;
  let compacting = false;
  let noteConsumed = false;

  const thresholds = () => {
    const hard = Math.min(percentFlag(pi.getFlag("compact-at"), DEFAULT_HARD), MAX_HARD);
    const soft = Math.min(percentFlag(pi.getFlag("compact-soft-at"), DEFAULT_SOFT), hard - 1);
    return { soft, hard };
  };

  const branchMessages = (ctx: ExtensionContext) =>
    ((ctx.sessionManager?.getBranch?.() ?? []) as Array<{ type?: string; message?: unknown }>)
      .filter((entry) => entry?.type === "message")
      .map((entry) => entry.message);

  const snapshot = (ctx: ExtensionContext) => {
    try {
      const dir = join(ctx.cwd ?? process.cwd(), ".pi", "safe-compact");
      mkdirSync(dir, { recursive: true });
      const lines = ((ctx.sessionManager?.getBranch?.() ?? []) as unknown[]).map((entry) =>
        JSON.stringify(entry),
      );
      writeFileSync(join(dir, `${Date.now()}.jsonl`), `${lines.join("\n")}\n`);
    } catch {
      // A failed snapshot must not block compaction; pi's own history still exists.
    }
  };

  // pi resolves this per model; mirror the ordinary setting plus its override.
  const keepRecentFor = (ctx: ExtensionContext) => {
    try {
      const compaction = pi.getSettings?.()?.compaction;
      const key = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const override = key ? compaction?.modelOverrides?.[key]?.keepRecentTokens : undefined;
      const value = override ?? compaction?.keepRecentTokens ?? DEFAULT_KEEP_RECENT;
      return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : DEFAULT_KEEP_RECENT;
    } catch {
      return DEFAULT_KEEP_RECENT;
    }
  };

  const start = (ctx: ExtensionContext) => {
    if (compacting || !ctx.compact) return;
    compacting = true;
    requested = false;
    ctx.ui?.notify?.("safe-compact: compacting", "info");
    ctx.compact({
      onComplete: () => {
        compacting = false;
      },
      onError: (error: Error) => {
        compacting = false;
        ctx.ui?.notify?.(`safe-compact: compaction failed: ${error.message}`, "error");
      },
    });
  };

  pi.registerTool({
    name: "self_compact",
    label: "self_compact",
    description:
      "Compact your own context at the next turn boundary. The turn is not interrupted: the run continues " +
      "with the verified handoff. Pass a note to your future self: it is carried through compaction verbatim.",
    promptSnippet: "self_compact(note?): compact context now, carrying your note verbatim",
    promptGuidelines: [
      "Call self_compact at a natural boundary (a subtask finished) once view_context shows the window filling. Put in the note what you would otherwise forget: the next step and anything unrecorded.",
    ],
    parameters: Type.Object({
      note: Type.Optional(Type.String({ description: "Handoff note to your future self." })),
    }),
    async execute(_id, params) {
      pendingNote = params?.note?.trim() || undefined;
      requested = true;
      return {
        content: [
          {
            type: "text",
            text: "Context compaction will run at the next turn boundary; the turn is not interrupted.",
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "view_context",
    label: "view_context",
    description: "Show context window usage and the safe-compact thresholds.",
    promptSnippet: "view_context(): context usage and compaction thresholds",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const usage = ctx.getContextUsage?.();
      const info = { ...usage, ...thresholds(), compacting };
      return { content: [{ type: "text", text: JSON.stringify(info) }] };
    },
  });

  pi.on("turn_end", async (event, ctx) => {
    if (compacting) return;
    const { soft, hard } = thresholds();
    if (!requested) {
      const percent = ctx.getContextUsage?.()?.percent;
      if (percent === null || percent === undefined || percent < soft) return;

      if (percent < hard) {
        const messages = branchMessages(ctx);
        const lastUser = messages.findLastIndex((m: any) => m?.role === "user");
        const asText = (list: unknown[]) => list.map((m) => messageText(m)).join("\n\n");
        const recentText = asText(messages.slice(-RECENT_ENTRIES));
        const currentRequest = lastUser >= 0 ? messageText(messages[lastUser]) : "";
        const previousWork = asText(
          messages.slice(Math.max(0, lastUser - RECENT_ENTRIES), Math.max(0, lastUser)),
        );
        const signals = [AbortSignal.timeout(MOMENT_TIMEOUT_MS), ctx.signal].filter(
          (s): s is AbortSignal => Boolean(s),
        );
        let moment;
        try {
          moment = await judgeMoment({
            recentText,
            currentRequest,
            previousWork,
            signal: AbortSignal.any(signals),
          });
        } catch {
          return; // Jev unavailable: wait for the hard threshold
        }
        if (decideTrigger({ percent, soft, hard, moment }) !== "compact") return;
      }
    }
    requested = false;

    const entries = event?.context?.contextEntries;
    if (!Array.isArray(entries) || entries.length === 0) return;

    let draft;
    try {
      draft = await buildBoundaryCompaction({
        entries,
        keepRecentTokens: keepRecentFor(ctx),
        note: pendingNote,
        ask,
        signal: ctx.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify?.(`safe-compact: ${message}, keeping context`, "warning");
      return;
    }
    if (!draft) {
      ctx.ui?.notify?.(
        "safe-compact: could not verify a smaller handoff, keeping context",
        "warning",
      );
      return;
    }
    snapshot(ctx);
    pendingNote = undefined;
    ctx.ui?.notify?.("safe-compact: compacted at the turn boundary", "info");
    const drafts = event?.entries ?? [];
    return { entries: [...drafts, { type: "compaction", ...draft }] };
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, branchEntries, signal } = event;
    snapshot(ctx);

    const fileOps = preparation.fileOps;
    const previousDetails = (branchEntries as Array<{ type?: string; details?: unknown }>)
      .toReversed()
      .find((entry) => entry?.type === "compaction" && entry?.details)?.details;
    const fileLists = mergeFileLists(fileListsFromDetails(previousDetails), {
      readFiles: [...(fileOps?.read ?? [])].filter(
        (file: string) => !fileOps?.written?.has(file) && !fileOps?.edited?.has(file),
      ),
      modifiedFiles: [...new Set([...(fileOps?.edited ?? []), ...(fileOps?.written ?? [])])],
    });
    try {
      const result = await composeHandoff({
        messages: [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
        previousSummary: preparation.previousSummary,
        fileLists,
        note: pendingNote,
        tokensBefore: preparation.tokensBefore,
        ask,
        signal,
      });
      if (!result) {
        ctx.ui?.notify?.(
          "safe-compact: could not verify a handoff, using native compaction",
          "warning",
        );
        return;
      }
      noteConsumed = true;
      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: {
            ...result.details,
            readFiles: fileLists.readFiles,
            modifiedFiles: fileLists.modifiedFiles,
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui?.notify?.(`safe-compact: ${message}, using native compaction`, "warning");
    }
  });

  pi.on("session_compact", () => {
    // Native fallback ran: the note never reached a summary, so deliver it as
    // its own message rather than lose it.
    if (pendingNote && !noteConsumed) {
      pi.sendMessage(
        { customType: "safe-compact-note", content: `Note to self: ${pendingNote}`, display: true },
        { deliverAs: "nextTurn" },
      );
    }
    pendingNote = undefined;
    noteConsumed = false;
    compacting = false;
  });

  pi.registerCommand("safe-compact", {
    description:
      "Compact now with the verified handoff. Optional argument: a note carried verbatim.",
    handler: async (args, ctx) => {
      pendingNote = args.trim() || undefined;
      start(ctx);
    },
  });

  pi.registerCommand("safe-compact-plan", {
    description: "Dry run: show the handoff that would replace this session's history",
    handler: async (_args, ctx) => {
      const messages = branchMessages(ctx);
      try {
        const result = await composeHandoff({
          messages,
          tokensBefore: ctx.getContextUsage?.()?.tokens ?? Number.MAX_SAFE_INTEGER,
          ask,
          signal: ctx.signal,
        });
        if (!result) {
          ctx.ui?.notify?.(
            "safe-compact plan: no verified handoff, native compaction would run",
            "warning",
          );
          return;
        }
        await ctx.ui?.editor?.("safe-compact plan (dry run)", result.summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui?.notify?.(`safe-compact plan failed: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("safe-compact-info", {
    description: "Show safe-compact thresholds and current context usage",
    handler: async (_args, ctx) => {
      const { soft, hard } = thresholds();
      const percent = ctx.getContextUsage?.()?.percent;
      ctx.ui?.notify?.(
        `safe-compact: ${percent === null || percent === undefined ? "?" : Math.round(percent)}% used, soft ${soft}%, compact at ${hard}%`,
        "info",
      );
    },
  });
}
