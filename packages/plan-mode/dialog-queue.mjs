// dialog-queue.mjs — serialize interactive dialogs for plan mode.
//
// pi executes sibling tool calls from one assistant message concurrently, so
// a model grilling "the whole frontier in one round" fires several
// plan_mode_question calls in a single batch. The TUI dialog manager only
// owns one dialog at a time: concurrent ctx.ui.select calls stack or
// overwrite each other, the hidden dialogs never receive input, and the tool
// batch hangs. A FIFO queue guarantees one dialog is open at a time — each
// call runs only after the previous settles, and a rejected dialog never
// blocks the queue.

// Create a serializer for interactive-dialog promises.
//
// Returns enqueue(fn): schedules fn to run after every previously enqueued
// call has settled, and resolves/rejects with fn's result. Order is FIFO.
export function createDialogQueue() {
  let tail = Promise.resolve();
  return function enqueue(fn) {
    const run = tail.then(fn);
    // Keep the chain alive even when a dialog throws; the next caller still
    // gets its turn (its own rejection propagates to its caller).
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
