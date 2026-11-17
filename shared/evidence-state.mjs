// evidence-state.mjs — when this process had code edits no check has covered.
//
// done-gate knows, run by run, whether the tree carries edits that no passing
// check has covered since. emphasis draws a reply's `[[Done]]` or `[[Passed]]`
// pill and wants to say when that claim was written over unchecked edits. The
// two never import each other (packages are islands); like mode-flags.mjs, this
// module is the shared copy both load by the same path.
//
// State is kept as spans of time rather than a flag, so a message rendered
// again later (a resize, a theme switch) is judged by when it was written, not
// by what is true now. Nothing persists: a new process starts with no spans,
// and until done-gate publishes once, every question answers "not known".

const MAX_SPANS = 64;

/** `{ from, to }` in epoch ms; `to` is null while the span is open. */
const spans = [];
let published = false;

/** done-gate's reading after each change: true while edits are unchecked. */
export function noteUncheckedEdits(unchecked, at = Date.now()) {
  published = true;
  const open = spans.at(-1)?.to === null ? spans.at(-1) : null;
  if (unchecked && !open) {
    spans.push({ from: at, to: null });
    if (spans.length > MAX_SPANS) spans.shift();
  } else if (!unchecked && open) {
    open.to = at;
  }
}

/**
 * Whether edits were unchecked at `at`: true or false once done-gate has
 * published, undefined when nothing has (done-gate absent or not yet run).
 */
export function uncheckedEditsAt(at = Date.now()) {
  if (!published) return undefined;
  return spans.some((span) => span.from <= at && (span.to === null || at < span.to));
}

/** Forget everything; for tests. */
export function resetEvidenceState() {
  spans.length = 0;
  published = false;
}
