// mask.mjs — keep secrets out of tool results before the model, the log or a
// compaction ever sees them.
//
// A tool_result patch, applied through the shared redactor:
//   bash  — every credential shape: output is whatever a command printed, and
//           `env`, `cat .env` and a failing curl print secrets by accident.
//   read  — only definite key shapes (private key blocks, ghp_, sk-, AWS and
//           Slack tokens). Source files are full of `token`, `password=` and
//           example URLs; masking those would corrupt the code being edited.
// Everything else is left alone. The result says that it was masked, so a
// <REDACTED> marker is never a mystery.

import { redactSecrets } from "../../shared/redact.mjs";

const DEFINITE_KEY_SHAPES = ["pem", "aws", "github", "openai", "slack"];

function optionsFor(toolName) {
  // `homeDir: ""` keeps paths readable: this is about credentials, not privacy.
  if (toolName === "bash") return { homeDir: "" };
  if (toolName === "read") return { homeDir: "", only: DEFINITE_KEY_SHAPES };
  return undefined;
}

/** A tool_result patch with masked content and a visible note, or undefined when nothing was masked. */
export function maskToolResult(event) {
  const options = optionsFor(event?.toolName);
  if (!options || !Array.isArray(event.content)) return undefined;
  let masked = 0;
  const content = event.content.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const { value, count } = redactSecrets(block.text, options);
    masked += count;
    return count > 0 ? { ...block, text: value } : block;
  });
  if (masked === 0) return undefined;
  const note = `[guardrail masked ${masked} secret${masked === 1 ? "" : "s"} in this output]`;
  return { content: [...content, { type: "text", text: note }] };
}
