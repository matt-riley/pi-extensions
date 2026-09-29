// index.ts — pi extension: TypeSafe System One judgments as an agent tool.
//
// Registers typesafe_ask: send `state` plus a map of typed questions
// (choice | noul | score) and receive calibrated, structured answers — one
// batched request, probabilities instead of prose. Configuration is
// environment-only (TYPESAFE_API_KEY, optional TYPESAFE_BASE_URL /
// TYPESAFE_MODEL / TYPESAFE_TIMEOUT_MS) to keep the tool trivial to install
// and maintain. Zero runtime dependencies: node: built-ins + pi's typebox.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { askSystemOne, formatAnswers } from "../../shared/systemone.mjs";
import {
  askFiles,
  formatFileResults,
  gateCommand,
  resolveReadable,
  resolveTargets,
  runCommand,
} from "./files.mjs";
import { formatRanges, selectRelevantRanges } from "./relevant.mjs";
import { TYPESAFE_TOOLS } from "./tools.mjs";

const [ASK_TOOL, READ_RELEVANT_TOOL] = TYPESAFE_TOOLS;

const errorResult = (prefix: string, error: unknown) => ({
  content: [
    {
      type: "text",
      text: `${prefix} failed: ${error instanceof Error ? error.message : String(error)}`,
    },
  ],
  isError: true,
});

const STATE_SCHEMA = Type.Union(
  [Type.String(), Type.Object({}, { additionalProperties: true }), Type.Array(Type.Any())],
  {
    description:
      "What the model evaluates. A string for plain text, or structured JSON (object/array) such as records, " +
      "messages, or candidates. Questions can reference it by path, e.g. `ticket.messages[0].text`.",
  },
);

const QUESTION_SCHEMA = Type.Object(
  {
    type: Type.Union([Type.Literal("choice"), Type.Literal("noul"), Type.Literal("score")], {
      description:
        "Primitive: choice (one of a defined set), noul (probability the answer is yes), " +
        "score (graded position on ordered levels).",
    }),
    instructions: Type.Union(
      [Type.String(), Type.Object({}, { additionalProperties: true }), Type.Array(Type.Any())],
      {
        description:
          "The single judgment to make. Include complete meaning here — question ids are for code and are " +
          "not sent to the model. Reference state with backticked paths.",
      },
    ),
    criteria: Type.Optional(
      Type.Any({
        description:
          "choice: object mapping option -> description or null (at least two options). " +
          "noul: optional { true, false } descriptions. score: ordered array of at least two level descriptions.",
      }),
    ),
  },
  { additionalProperties: true },
);

export default function piTypesafeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: ASK_TOOL,
    label: "typesafe_ask",
    description:
      "Ask TypeSafe's System One model (Jev) for calibrated, typed judgments about state. Independent questions " +
      "are batched into one request and return probabilities and confidence rather than prose: noul = probability " +
      "of yes; choice = the intended option plus its distribution; score = graded rating on your ordered levels. " +
      "Use it when a decision needs programmable common sense — routing, ranking, verifying a claim, judging " +
      "which candidate fits — and keep thresholds and follow-up actions in code. To judge files or command output " +
      "WITHOUT loading them into your context, pass `paths` (files, directories, globs; one call per file, in " +
      "parallel) and/or `command` (read-only shell); questions then reference `file.content`, `file.path` and " +
      "`command_output.output`. Prefer that over reading files and pasting them. Requires TYPESAFE_API_KEY.",
    promptSnippet:
      "typesafe_ask(state, questions, model?): batched typed judgments (choice/noul/score) with probabilities; needs TYPESAFE_API_KEY",
    promptGuidelines: [
      "Use typesafe_ask when a decision needs calibrated judgment rather than prose: send all independent questions in one call, then apply thresholds and routing in code.",
      "To judge a file or many files, give typesafe_ask `paths` instead of reading and pasting them; use `rank_by` to order files by a noul or score question.",
    ],
    parameters: Type.Object({
      state: Type.Optional(STATE_SCHEMA),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Files, directories or globs (e.g. src/**/*.ts), at most 255 files. Each file is read locally and judged by its own request; " +
            "the content never enters your context. Repo files only; secrets are refused.",
        }),
      ),
      command: Type.Optional(
        Type.String({
          description:
            "Read-only shell command whose output becomes state (`command_output.output`). Refused unless read-only.",
        }),
      ),
      recursive: Type.Optional(
        Type.Boolean({
          description: "Include subdirectories for directory paths (default false).",
        }),
      ),
      rank_by: Type.Optional(
        Type.String({
          description:
            "With paths: id of a noul or score question; files are listed highest first.",
        }),
      ),
      questions: Type.Record(Type.String(), QUESTION_SCHEMA, {
        description:
          "Map of question id -> question. Ids are for your own reference and are echoed back with the answers; " +
          "they are never sent to the model, so each question must carry its full meaning.",
      }),
      model: Type.Optional(
        Type.String({
          description: "Override the model for this call (default: TYPESAFE_MODEL or jev-latest).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const {
          state,
          paths,
          command,
          recursive,
          rank_by: rankBy,
          questions,
          model,
        } = params ?? {};
        const hasPaths = Array.isArray(paths) && paths.length > 0;
        if (state === undefined && !hasPaths && !command) {
          throw new Error("Provide state, paths, or command.");
        }
        if (!hasPaths && !command) {
          const result = await askSystemOne({ state, questions, model, signal });
          return { content: [{ type: "text", text: formatAnswers(result) }] };
        }

        const cwd = ctx.cwd ?? process.cwd();
        const exec = (cmd: string, args: string[], opts?: { timeout?: number }) =>
          pi.exec(cmd, args, opts);
        if (rankBy && !["noul", "score"].includes(questions?.[rankBy]?.type)) {
          throw new Error("rank_by must name a noul or score question.");
        }
        const shared: Record<string, unknown> = {};
        if (state !== undefined) shared.state = state;
        if (command) {
          const refusal = gateCommand(command, cwd);
          if (refusal) throw new Error(refusal);
          shared.command_output = await runCommand({ command, cwd, exec });
        }
        if (!hasPaths) {
          const result = await askSystemOne({ state: shared, questions, model, signal });
          return { content: [{ type: "text", text: formatAnswers(result) }] };
        }

        const { root, files, skipped } = await resolveTargets({
          patterns: paths,
          cwd,
          exec,
          recursive,
        });
        if (files.length === 0) throw new Error(formatFileResults({ results: [], skipped }));
        const results = await askFiles({ root, files, questions, shared, signal });
        return {
          content: [{ type: "text", text: formatFileResults({ results, skipped, rankBy }) }],
        };
      } catch (error) {
        return errorResult("typesafe_ask", error);
      }
    },
  });

  pi.registerTool({
    name: READ_RELEVANT_TOOL,
    label: "read_relevant",
    description:
      "Read only the lines of a file that matter to a goal. Big files are scanned in windows by TypeSafe's Jev " +
      "model and you get back a few tight, line-numbered ranges (exact file text) instead of the whole file. " +
      "Short files come back in full. Use plain `read` when you need the entire file to edit it. Requires TYPESAFE_API_KEY.",
    promptSnippet:
      "read_relevant(path, goal, max_ranges?): just the lines of a large file relevant to a goal",
    promptGuidelines: [
      "For a large file where you only need the part about one thing, use read_relevant with a specific goal instead of read.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "File to read, relative to the working directory." }),
      goal: Type.String({
        description:
          "What you are looking for or working on; be specific (e.g. 'where retries back off').",
      }),
      max_ranges: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 8, description: "Most ranges to return (default 3)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const cwd = ctx.cwd ?? process.cwd();
        const { rel, text } = await resolveReadable({
          path: params.path,
          cwd,
          exec: (cmd: string, args: string[], opts?: { timeout?: number }) =>
            pi.exec(cmd, args, opts),
        });
        const selected = await selectRelevantRanges({
          text,
          path: rel,
          goal: params.goal,
          maxRanges: params.max_ranges,
          signal,
        });
        return { content: [{ type: "text", text: formatRanges({ path: rel, ...selected }) }] };
      } catch (error) {
        return errorResult("read_relevant", error);
      }
    },
  });
}
