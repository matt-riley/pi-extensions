// plan-file.mjs — durable, non-clobbering plan file handling for plan mode.
//
// resolvePlanFile is a pure, unit-testable decision function; index.ts does
// the fs I/O around it. Atomic writes (tmp + rename) keep the plan file from
// being corrupted if pi is interrupted mid-write.

import { rename, unlink, writeFile } from "node:fs/promises";

// Choose the file to write a plan revision to:
//   - existing === null          -> base path (first write)
//   - existing === lastWritten   -> base path (we own it, user hasn't edited)
//   - existing === plan          -> base path (idempotent rewrite; also makes
//                                   a same-plan rewrite after a restart land
//                                   in place instead of a spurious .2)
//   - otherwise                  -> first free base.2, base.3, ... via the
//                                   injected altTaken(n) existence check
// The conservative branch keeps user edits from ever being clobbered, even
// when lastWritten is unknown (e.g. after a pi restart).
export function resolvePlanFile({ base, plan, existing, lastWritten, altTaken }) {
  if (existing === null || existing === lastWritten || existing === plan) {
    return base;
  }
  let n = 2;
  while (altTaken(n)) n++;
  return `${base}.${n}`;
}

// Atomically replace `target` with `content`: write a temp file in the same
// directory, then rename it over the target. On failure the temp file is
// removed (best effort) and the error rethrown.
export async function atomicWriteFile(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
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
