// blast.mjs — who else calls what a diff touches.
//
// A small-looking change to a shared helper breaks callers the diff never
// shows. This lists every definition the diff adds, removes or edits, then
// asks a grep for each name and splits the hits into files the diff already
// changes and callers outside it. A symbol no test file mentions is called
// out: nothing would notice if it broke. It finds callers; proving the change
// is safe for them is a run, not a grep.

// Exported only, at column 0: another file can call nothing else, and grepping the
// name of a local drowns the report in words like "head" and "failed".
const DEFINITION =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const MIN_NAME = 4;
const TEST_FILE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** The exported definition a line starts, if any: `function f`, `const f =`, `class F`. */
export function definitionNames(line) {
  const name = DEFINITION.exec(line)?.[1];
  return name && name.length >= MIN_NAME ? [name] : [];
}

/**
 * Per changed file, the definitions the diff touches. Needs
 * `--src-prefix=a/ --dst-prefix=b/`: a user's diff.mnemonicPrefix or
 * diff.noprefix changes the header this reads. Added and removed lines
 * count, and so does the hunk header's enclosing definition: editing a body
 * changes the function without ever showing its name.
 */
export function touchedSymbols(diff) {
  const files = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) {
      file = header[1];
      files.set(file, new Set());
      if (!CODE_FILE.test(file)) file = null;
      continue;
    }
    if (!file || line.startsWith("---")) continue;
    let text = null;
    if (line.startsWith("@@")) text = line.replace(/^@@[^@]*@@\s?/, "");
    else if (line.startsWith("+") || line.startsWith("-")) text = line.slice(1);
    if (text) for (const name of definitionNames(text)) files.get(file).add(name);
  }
  return files;
}

/** Split grep hits for one symbol into the diff's own files, outside callers and tests. */
export function classifyHits(allHits, changedFiles) {
  const hitFiles = allHits.filter((f) => CODE_FILE.test(f));
  const outside = hitFiles.filter((f) => !changedFiles.has(f));
  return {
    outside: outside.filter((f) => !TEST_FILE.test(f)),
    tests: hitFiles.filter((f) => TEST_FILE.test(f)),
  };
}

const MAX_SYMBOLS = 25;

/** `grep(name)` resolves to the tracked files that mention the name. */
export async function report(diff, grep) {
  const touched = touchedSymbols(diff);
  const changed = new Set(touched.keys());
  const lines = [];
  const seen = new Set();
  for (const [file, names] of touched) {
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (seen.size > MAX_SYMBOLS) continue;
      const { outside, tests } = classifyHits(await grep(name), changed);
      const untested = tests.length === 0 ? " — no test mentions it" : "";
      if (outside.length === 0 && !untested) continue;
      lines.push(`${name} (${file}): ${outside.length} caller file(s) outside the diff${untested}`);
      for (const f of outside.slice(0, 8)) lines.push(`  ${f}`);
      if (outside.length > 8) lines.push(`  … ${outside.length - 8} more`);
    }
  }
  if (seen.size === 0) return "No definitions touched.";
  if (seen.size > MAX_SYMBOLS)
    lines.push(`Checked the first ${MAX_SYMBOLS} of ${seen.size} definitions.`);
  return lines.length
    ? lines.join("\n")
    : `${seen.size} definition(s) touched; no outside callers.`;
}
