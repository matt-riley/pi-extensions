// hit-context.mjs — the lines around each code_search hit.
//
// An edit needs the exact text of the lines it replaces. With `context` set, a
// page of hits carries those lines, so the agent can edit from the result alone
// instead of spending a turn on a read. Only the hits on the page are read, each
// file once, and a page has a line budget so a broad search cannot flood the
// conversation.

export const MAX_CONTEXT = 10;
const LINE_BUDGET = 400;
const LINE_CAP = 200;

/** A whole number from 0 to MAX_CONTEXT; anything else is 0. */
export function clampContext(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_CONTEXT, Math.max(0, n)) : 0;
}

const cut = (text) => (text.length > LINE_CAP ? `${text.slice(0, LINE_CAP)}…` : text);

/**
 * Add `around` (numbered lines, the match marked) to each hit that fits the
 * budget, in page order. Returns the hits and how many were left plain.
 *
 * @param {{ hits: Array, context: number, readFile: (rel: string) => Promise<string | null>, budget?: number }} opts
 */
export async function attachContext({ hits, context, readFile, budget = LINE_BUDGET }) {
  const size = clampContext(context);
  if (size === 0 || hits.length === 0) return { hits, omitted: 0 };

  const sources = new Map();
  const linesOf = (rel) => {
    if (!sources.has(rel)) {
      sources.set(
        rel,
        readFile(rel).then((source) => (source == null ? null : source.split(/\r?\n/))),
      );
    }
    return sources.get(rel);
  };

  let left = budget;
  let omitted = 0;
  const out = [];
  for (const hit of hits) {
    const lines = await linesOf(hit.rel);
    const from = Math.max(1, hit.lineNo - size);
    const to = lines ? Math.min(lines.length, hit.lineNo + size) : 0;
    const count = to - from + 1;
    if (!lines || count > left) {
      omitted++;
      out.push(hit);
      continue;
    }
    left -= count;
    const around = [];
    for (let n = from; n <= to; n++) {
      around.push({ n, text: cut(lines[n - 1]), match: n === hit.lineNo });
    }
    out.push({ ...hit, around });
  }
  return { hits: out, omitted };
}
