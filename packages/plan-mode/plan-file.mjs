// plan-file.mjs — durable, non-clobbering plan file handling for plan mode.
//
// resolvePlanFile is a pure, unit-testable decision function; index.ts does
// the fs I/O around it. Atomic writes (tmp + rename) keep the plan file from
// being corrupted if pi is interrupted mid-write.

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Choose the file to write a plan revision to. `owned` is the file the
// caller currently believes it owns (state.planPath): null on the first
// write, otherwise the base path or a previously allocated alternate
// (base.N) that a prior revision landed on. `existing` is the CURRENT
// content read from that same owned path (or from `base` when nothing is
// owned yet) — the caller is responsible for reading the right file before
// calling this.
//
//   - existing === null          -> owned ?? base (first write, or the
//                                   owned file was removed — recreate it)
//   - existing === lastWritten   -> owned ?? base (we own it, user hasn't
//                                   edited it since our last write)
//   - existing === plan          -> owned ?? base (idempotent rewrite; also
//                                   makes a same-plan rewrite after a
//                                   restart land in place instead of a
//                                   spurious .2)
//   - otherwise                  -> first free base.2, base.3, ... via the
//                                   injected altTaken(n) existence check.
//                                   This is reached both for a hand-edited
//                                   base (first divergence) and a
//                                   hand-edited owned alternate (e.g. .2 ->
//                                   .3): altTaken(n) reports the owned
//                                   alternate's own number as taken, so the
//                                   loop naturally skips past it.
// The conservative branch keeps user edits from ever being clobbered, even
// when lastWritten is unknown (e.g. after a pi restart).
export function resolvePlanFile({ base, plan, existing, lastWritten, owned, altTaken }) {
  if (existing === null || existing === lastWritten || existing === plan) {
    return owned ?? base;
  }
  let n = 2;
  while (altTaken(n)) n++;
  return `${base}.${n}`;
}

// Atomically replace `target` with `content`: ensure its directory exists,
// write a temp file in the same directory, then rename it over the target.
// On failure the temp file is removed (best effort) and the error rethrown.
export async function atomicWriteFile(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  } catch (error) {
    try {
      await unlink(tmp);
    } catch {
      // Temp file may not exist (e.g. write itself failed) — ignore.
    }
    throw error;
  }
}
