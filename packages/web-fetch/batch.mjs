// batch.mjs — pure budget-allocation helpers for batch_web_fetch's shared
// character budget (totalMaxChars). Kept separate from index.ts so the
// allocation math is unit-testable without a live fetch.
//
// The bug this fixes: reserving `min(item.maxChars, remainingBudget)` from
// remainingBudget *before* fetching starves later items even when earlier
// items returned far less content than their reservation — with defaults
// (maxChars 60000, totalMaxChars 300000) items 6..25 of a 25-item batch got
// a 0 budget and came back empty no matter how small the earlier pages were.
//
// The fix: charge the shared budget by content ACTUALLY consumed, after each
// fetch completes, instead of by upfront reservation. The worker loop is
// async but single-threaded, so a read-modify-write of remainingBudget
// between awaits (allocate at pickup, charge on completion) is race-free.

// Compute the per-item fetch cap when a worker picks up an item, given the
// budget remaining across the whole batch and that item's own requested
// maxChars. When the shared budget is already exhausted, the caller should
// skip the fetch entirely (not fetch with cap 0) — signaled by `exhausted`.
export function allocateItemBudget(remainingBudget, requestMaxChars) {
  if (remainingBudget <= 0) {
    return { exhausted: true, cap: 0 };
  }
  const cap = Math.min(requestMaxChars, remainingBudget);
  return { exhausted: false, cap };
}

// Deduct the content actually emitted for a completed item from the shared
// budget. Never goes negative; non-finite/negative input is treated as 0
// consumed so a bad measurement can't corrupt the running total.
export function chargeBudget(remainingBudget, contentCharsUsed) {
  const used = Number.isFinite(contentCharsUsed) ? Math.max(0, contentCharsUsed) : 0;
  return Math.max(0, remainingBudget - used);
}
