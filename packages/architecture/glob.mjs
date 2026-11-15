// glob.mjs — the small path-pattern language the rules file uses.
//
// `*` is any run inside one path segment and is captured, `**` crosses
// directories, `?` is one character, and `$1`, `$2` stand for the text the 1st,
// 2nd `*` of the rule's `from` pattern captured, inserted as plain text. Nothing
// else is special, so a path with regex characters in it matches itself.

const ESCAPE = /[.+*?^${}()|[\]\\]/g;
const literal = (text) => text.replace(ESCAPE, "\\$&");

function toRegExp(pattern, captures) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      // `**/` may match no directory at all; a bare `**` matches anything.
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (char === "*") out += "([^/]*)";
    else if (char === "?") out += "[^/]";
    else if (char === "$" && /\d/.test(pattern[i + 1] ?? "")) {
      const digits = /^\d+/.exec(pattern.slice(i + 1))[0];
      const value = captures[Number(digits) - 1];
      // An unfilled $n can never match, rather than matching everything.
      out += value === undefined ? "(?!)" : literal(value);
      i += digits.length;
    } else out += literal(char);
  }
  return new RegExp(`^${out}$`);
}

/**
 * Match `path` against `pattern`. Returns the text each `*` captured (an empty
 * array when there is none), or null when it does not match. `captures` fills
 * `$n` references in the pattern.
 *
 * @param {string} pattern
 * @param {string} path
 * @param {string[]} [captures]
 * @returns {string[] | null}
 */
export function matchGlob(pattern, path, captures = []) {
  const match = toRegExp(pattern, captures).exec(path);
  return match ? match.slice(1) : null;
}

/** How many `$n` captures a pattern offers: the number of single `*` in it. */
export function captureCount(pattern) {
  return (pattern.replace(/\*\*/g, "").match(/\*/g) ?? []).length;
}
