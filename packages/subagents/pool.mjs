// pool.mjs — cap-4 running, queue the rest, incrementing type ids. Children that
// can write run one at a time (no worktrees): a writer's before/after diff is
// then its own, while read-only children stay parallel.

const MAX_CONCURRENT = 4;

export function createPool({ maxConcurrent = MAX_CONCURRENT, onChange } = {}) {
  const entries = new Map();
  const typeCounts = new Map();

  function notify() {
    onChange?.();
  }

  function nextId(type) {
    const key = String(type || "agent").toLowerCase();
    const n = (typeCounts.get(key) ?? 0) + 1;
    typeCounts.set(key, n);
    return n === 1 ? key : `${key}-${n}`;
  }

  function runningCount() {
    let n = 0;
    for (const entry of entries.values()) if (entry.status === "running") n += 1;
    return n;
  }

  function queuedCount() {
    let n = 0;
    for (const entry of entries.values()) if (entry.status === "queued") n += 1;
    return n;
  }

  function writerRunning() {
    for (const entry of entries.values())
      if (entry.write && entry.status === "running") return true;
    return false;
  }

  // A free slot, and for a writer, no other writer already running.
  function canStart(entry) {
    return runningCount() < maxConcurrent && !(entry.write && writerRunning());
  }

  function promote(entry) {
    entry.status = "running";
    entry.startedAt = Date.now();
    const queued = entry._queued;
    entry._queued = null;
    queued?.resolve(entry);
  }

  // Oldest first. A queued writer blocked by the writer lane does not hold back
  // the readers behind it, so keep going until nothing queued can start.
  function startNext() {
    for (const entry of entries.values()) {
      if (entry.status === "queued" && entry._queued && canStart(entry)) {
        promote(entry);
        notify();
      }
    }
  }

  function acquire(type, meta = {}) {
    const id = nextId(type);
    const entry = {
      id,
      type: String(type || "agent"),
      status: "queued",
      description: meta.description || "",
      task: meta.task || "",
      maxTurns: meta.maxTurns,
      write: meta.write === true,
      startedAt: undefined,
      turns: 0,
      toolUses: 0,
      tokens: 0,
      lastTool: "",
      abort: null,
      stopRequested: false,
      _queued: null,
    };
    entries.set(id, entry);

    let ready;
    if (canStart(entry)) {
      promote(entry);
      ready = Promise.resolve(entry);
    } else {
      ready = new Promise((resolve, reject) => {
        entry._queued = { resolve, reject };
      });
    }
    notify();
    return { entry, ready };
  }

  function release(id) {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    notify();
    startNext();
  }

  function stop(id) {
    const entry = entries.get(id);
    if (!entry) return false;
    if (entry.status === "queued" && entry._queued) {
      const queued = entry._queued;
      entry._queued = null;
      entries.delete(id);
      queued.resolve({ ...entry, status: "stopped", stoppedBeforeStart: true });
      notify();
      return true;
    }
    if (entry.status === "running") {
      // abort is only wired once the child session exists (spawn's bind()). A
      // stop landing during session creation sets a pending flag instead;
      // update() fires it the moment abort lands, so the stop never no-ops.
      if (typeof entry.abort === "function") entry.abort();
      else entry.stopRequested = true;
      return true;
    }
    return false;
  }

  function update(id, patch) {
    const entry = entries.get(id);
    if (!entry || !patch || typeof patch !== "object") return;
    Object.assign(entry, patch);
    // A stop requested before abort was wired fires as soon as abort exists.
    if (entry.stopRequested && typeof entry.abort === "function") {
      entry.stopRequested = false;
      entry.abort();
    }
    notify();
  }

  function get(id) {
    return entries.get(id);
  }

  function list() {
    return [...entries.values()];
  }

  function abortAll() {
    for (const entry of entries.values()) {
      if (entry.status === "queued" && entry._queued) {
        const queued = entry._queued;
        entry._queued = null;
        queued.resolve({ ...entry, status: "stopped", stoppedBeforeStart: true });
      }
      try {
        entry.abort?.();
      } catch {
        // ignore
      }
    }
    entries.clear();
    notify();
  }

  return {
    acquire,
    release,
    stop,
    update,
    get,
    list,
    abortAll,
    runningCount,
    queuedCount,
  };
}
