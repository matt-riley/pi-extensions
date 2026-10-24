// Native built-ins dispatch before the input hook; this list supplies suggestions
// too. Extension, prompt and skill names always come from the current registry.
const BUILTINS =
  "login logout model thinking scoped-models settings llama resume new name session tree fork clone compact import copy export share bug trust reload hotkeys changelog quit".split(
    " ",
  );

function near(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return (
    a.slice(i + 1) === b.slice(i + 1) ||
    a.slice(i) === b.slice(i + 1) ||
    a.slice(i + 1) === b.slice(i) ||
    (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
  );
}

/** Only close, command-shaped misspellings: paths and slash prose stay ordinary input. */
export function commandTypos(text, commands) {
  const name = /^\/([a-zA-Z][\w:-]{0,63})(?:[ \t].*)?$/.exec(text)?.[1];
  if (!name) return [];
  const names = [...new Set([...BUILTINS, ...commands.map((command) => command.name)])];
  if (names.includes(name)) return [];
  return names.filter((candidate) => near(name.toLowerCase(), candidate.toLowerCase())).slice(0, 3);
}
