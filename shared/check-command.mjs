import { hasCommandSubstitution, splitSegments } from "./shell-parse.mjs";

// Only standalone commands have an exit status attributable to the check.
// A compound shell can skip a check or hide its failure behind a later success.
export const CMD_START = String.raw`^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:rtk\s+)?`;
export const RUNNER = String.raw`(?:(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|uv\s+run|python3?\s+-m)\s+)?`;
const VERIFY_COMMANDS = [
  String.raw`(?:bash\s+|sh\s+|node\s+)?(?:\.\/)?\.pi\/verify\b`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|verify)\b`,
  // A smoke script is a check, but `smoke:publish` and the like are not named here.
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?smoke(?![:\w-])`,
  // A repo's own test, check, verify or smoke script.
  String.raw`(?:bash\s+|sh\s+)?(?:\.\/)?(?:scripts|bin)\/(?:test|check|verify|smoke|ci)[\w.-]*\.sh\b`,
  String.raw`node\s+--test\b`,
  String.raw`deno\s+(?:test|check|lint)\b`,
  String.raw`dotnet\s+test\b`,
  String.raw`mvn\s+(?:test|verify)\b`,
  String.raw`(?:\.\/)?gradlew?\s+(?:test|check)\b`,
  String.raw`(?:bundle\s+exec\s+)?rspec\b`,
  String.raw`${RUNNER}(?:phpunit|mocha|busted)\b`,
  String.raw`${RUNNER}playwright\s+test\b`,
  String.raw`go\s+(?:test|vet)\b`,
  String.raw`cargo\s+(?:test|check|clippy)\b`,
  String.raw`make\s+(?:test|check|lint|verify)\b`,
  String.raw`${RUNNER}(?:pytest|vitest|jest|tsc|mypy|ruff|oxlint|eslint|golangci-lint)\b`,
  // Without --check, stylua rewrites the file. That is not a verification run.
  String.raw`${RUNNER}stylua\s+--check\b`,
  String.raw`${RUNNER}selene\b`,
].map((body) => new RegExp(CMD_START + body));

/** True when a bash command runs the repo's checks (tests, typecheck, lint, .pi/verify). */
export function isVerifyCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  return (
    standalone(command) &&
    !/\s(?:--help|--version|--dry-run|--collect-only|--listTests|--list|-h)\b/.test(command) &&
    VERIFY_COMMANDS.some((pattern) => pattern.test(command.trim()))
  );
}

// Redirecting output does not change the exit status, so `npm run check 2>&1` is still one
// command. Only plain, unquoted redirects are taken out; a pipe or a chain still is not one.
const REDIRECTS = /\s(?:\d*>&\d+|&>>?\s*[^\s|;&<>'"]+|\d*>>?\s*[^\s|;&<>'"]+)(?=\s|$)/g;

export function standalone(command) {
  return (
    splitSegments(command.replace(REDIRECTS, "")).length === 1 && !hasCommandSubstitution(command)
  );
}
