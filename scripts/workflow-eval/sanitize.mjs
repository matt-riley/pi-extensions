// Blinding for prompt and skill evals: the model under evaluation must not see
// that it is being measured. A word like "test" or "rubric" in a directory name
// or a prompt changes how a model behaves, so any path or prompt it can see is
// checked here before a run starts.

/** Words that give the measurement away. */
export const BANNED_WORDS = ["eval", "test", "judge", "rubric", "score", "candidate", "benchmark"];
// A token starting with a word's stem is banned, so inflections count too:
// "scoring", "judged", "candidates", "evaluation". "latest" is one token, so passes.
const stem = (word) => word.replace(/e$/, "");

/** Split text into lower-case word tokens, breaking camelCase and digits. */
function tokens(text) {
  return String(text ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** The banned words found in `text`, in BANNED_WORDS order, without repeats. */
export function bannedWords(text) {
  const found = new Set();
  for (const token of tokens(text))
    for (const word of BANNED_WORDS) if (token.startsWith(stem(word))) found.add(word);
  return BANNED_WORDS.filter((word) => found.has(word));
}

/**
 * A project-shaped name for a fixture, case or workspace directory: lower
 * case, `a-z0-9` and single dashes. Throws when the name holds a banned word
 * or nothing usable, so a giveaway name stops the run instead of being renamed
 * behind the author's back.
 */
export function sanitize(name) {
  const banned = bannedWords(name);
  if (banned.length) throw new Error(`"${name}" names the measurement (${banned.join(", ")})`);
  const clean = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!clean) throw new Error(`"${name}" leaves no usable name`);
  return clean;
}

/**
 * Problems with a case prompt: banned words, or asking the model which skills
 * it used (self-report is not evidence; the transcript is). Empty when clean.
 */
export function promptProblems(prompt) {
  const problems = bannedWords(prompt).map((word) => `names "${word}"`);
  if (/\bwhich\s+(skills?|instructions?|prompts?)\b/i.test(prompt))
    problems.push("asks which skills were used");
  return problems;
}
