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

import { askSystemOne, formatAnswers } from "./systemone.mjs";
import { TYPESAFE_TOOLS } from "./tools.mjs";

const ASK_TOOL = TYPESAFE_TOOLS[0];

const STATE_SCHEMA = Type.Union(
  [
    Type.String(),
    Type.Object({}, { additionalProperties: true }),
    Type.Array(Type.Any()),
  ],
  {
    description:
      "What the model evaluates. A string for plain text, or structured JSON (object/array) such as records, "
      + "messages, or candidates. Questions can reference it by path, e.g. `ticket.messages[0].text`.",
  },
);

const QUESTION_SCHEMA = Type.Object(
  {
    type: Type.Union([Type.Literal("choice"), Type.Literal("noul"), Type.Literal("score")], {
      description:
        "Primitive: choice (one of a defined set), noul (probability the answer is yes), "
        + "score (graded position on ordered levels).",
    }),
    instructions: Type.Union(
      [Type.String(), Type.Object({}, { additionalProperties: true }), Type.Array(Type.Any())],
      {
        description:
          "The single judgment to make. Include complete meaning here — question ids are for code and are "
          + "not sent to the model. Reference state with backticked paths.",
      },
    ),
    criteria: Type.Optional(Type.Any({
      description:
        "choice: object mapping option -> description or null (at least two options). "
        + "noul: optional { true, false } descriptions. score: ordered array of at least two level descriptions.",
    })),
  },
  { additionalProperties: true },
);

export default function piTypesafeExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: ASK_TOOL,
    label: "typesafe_ask",
    description:
      "Ask TypeSafe's System One model (Jev) for calibrated, typed judgments about state. Independent questions "
      + "are batched into one request and return probabilities and confidence rather than prose: noul = probability "
      + "of yes; choice = the intended option plus its distribution; score = graded rating on your ordered levels. "
      + "Use it when a decision needs programmable common sense — routing, ranking, verifying a claim, judging "
      + "which candidate fits — and keep thresholds and follow-up actions in code. Requires TYPESAFE_API_KEY.",
    promptSnippet:
      "typesafe_ask(state, questions, model?): batched typed judgments (choice/noul/score) with probabilities; needs TYPESAFE_API_KEY",
    promptGuidelines: [
      "Use typesafe_ask when a decision needs calibrated judgment rather than prose: send all independent questions in one call, then apply thresholds and routing in code.",
    ],
    parameters: Type.Object({
      state: STATE_SCHEMA,
      questions: Type.Record(Type.String(), QUESTION_SCHEMA, {
        description:
          "Map of question id -> question. Ids are for your own reference and are echoed back with the answers; "
          + "they are never sent to the model, so each question must carry its full meaning.",
      }),
      model: Type.Optional(Type.String({
        description: "Override the model for this call (default: TYPESAFE_MODEL or jev-latest).",
      })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      try {
        const result = await askSystemOne({
          state: params?.state,
          questions: params?.questions,
          model: params?.model,
          signal,
        });
        return { content: [{ type: "text", text: formatAnswers(result) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `typesafe_ask failed: ${message}` }],
          isError: true,
        };
      }
    },
  });
}
