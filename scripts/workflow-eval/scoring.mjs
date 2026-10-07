import { splitSegments, tokenize } from "../../shared/shell-parse.mjs";

// Conservative recognizer for this frozen CLI pilot, not a shell interpreter.
// Support direct commands, pipelines and cd-to-fixture && command. Other forms
// remain unscored; never count a quoted command in echo/printf as execution.
export function acceptanceExecuted(events, argv, cwd) {
  return events.some((start) => {
    if (start.type !== "tool_execution_start" || start.toolName !== "bash") return false;
    const command = String(start.args?.command ?? "");
    if (command.includes("||")) return false;
    const segments = splitSegments(command);
    const control = new Set([
      "exit",
      "return",
      "if",
      "then",
      "else",
      "fi",
      "for",
      "while",
      "until",
      "case",
      "eval",
      "exec",
    ]);
    if (segments.some((segment) => control.has(tokenize(segment.trim())[0]))) return false;
    if (command.includes("&&")) {
      const first = tokenize(command.split("&&")[0].trim());
      if (
        first.length !== 2 ||
        first[0] !== "cd" ||
        first[1] !== cwd ||
        command.split("&&").length !== 2
      )
        return false;
    }
    const invoked = segments.some((segment) => {
      const tokens = tokenize(segment.trim());
      return tokens.length === argv.length && tokens.every((token, index) => token === argv[index]);
    });
    if (!invoked) return false;
    return events.some(
      (end) =>
        end.type === "tool_execution_end" &&
        end.toolCallId === start.toolCallId &&
        end.isError === false &&
        end.result?.content?.some((part) => part.type === "text" && part.text.trim()),
    );
  });
}
