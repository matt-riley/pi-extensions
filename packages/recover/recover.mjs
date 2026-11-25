// recover.mjs — journal tool calls and, on resume, write one crash-recovery
// note. index.ts owns the pi wiring; this module owns the journal and the note.

export const JOURNAL_TYPE = "recover-journal";
export const NOTE_TYPE = "recover-note";
const CHECK = "check the current state before repeating.";

export function journalEntry(phase, event, at) {
  const toolCallId = event?.toolCallId;
  const toolName = event?.toolName;
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  if (typeof toolName !== "string" || !toolName) return null;
  if (phase !== "started" && phase !== "finished") return null;
  return { version: 1, toolCallId, toolName, phase, at };
}

function isCustom(entry, type) {
  return entry?.type === "custom" && entry.customType === type;
}

function validRecord(data) {
  return (
    data?.version === 1 &&
    typeof data.toolCallId === "string" &&
    data.toolCallId &&
    typeof data.toolName === "string" &&
    data.toolName &&
    (data.phase === "started" || data.phase === "finished")
  );
}

function lastIndex(entries, match) {
  for (let i = entries.length - 1; i >= 0; i--) if (match(entries[i])) return i;
  return -1;
}

function lastAssistant(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i]?.message ?? entries[i];
    if (message?.role === "assistant") return { message, index: i };
  }
  return { message: null, index: -1 };
}

function readJournal(entries) {
  const records = [];
  let found = false;
  for (const entry of entries) {
    if (!isCustom(entry, JOURNAL_TYPE)) continue;
    found = true;
    if (!validRecord(entry.data)) return { ok: false, reason: "unreadable" };
    records.push(entry.data);
  }
  if (!found) return { ok: false, reason: "missing" };
  return { ok: true, records };
}

function foldRecords(records) {
  const byId = new Map();
  for (const record of records) {
    const current = byId.get(record.toolCallId) ?? {
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      finished: false,
    };
    current.toolName = record.toolName;
    if (record.phase === "finished") current.finished = true;
    byId.set(record.toolCallId, current);
  }
  const finished = [];
  const partial = [];
  for (const record of byId.values()) {
    const item = { toolCallId: record.toolCallId, toolName: record.toolName };
    if (record.finished) finished.push(item);
    else partial.push(item);
  }
  return { finished, partial };
}

function alreadyNoted(entries, after) {
  return lastIndex(entries, (entry) => isCustom(entry, NOTE_TYPE)) > after;
}

export function summarizeRecovery(entries) {
  if (!Array.isArray(entries)) return { kind: "closed", reason: "unreadable" };
  if (entries.length === 0) return { kind: "none" };

  const journal = readJournal(entries);
  if (!journal.ok && journal.reason === "unreadable") {
    if (alreadyNoted(entries, -1)) return { kind: "none" };
    return { kind: "closed", reason: "unreadable" };
  }

  const assistant = lastAssistant(entries);
  const aborted = assistant.message?.stopReason === "aborted";
  const lastJournal = lastIndex(entries, (entry) => isCustom(entry, JOURNAL_TYPE));
  const after = Math.max(lastJournal, aborted ? assistant.index : -1);

  if (journal.ok) {
    const { finished, partial } = foldRecords(journal.records);
    if (partial.length === 0 && !aborted) return { kind: "none" };
    if (alreadyNoted(entries, after)) return { kind: "none" };
    return { kind: "cutoff", finished, partial };
  }

  if (aborted) {
    if (alreadyNoted(entries, after)) return { kind: "none" };
    return { kind: "closed", reason: "missing" };
  }
  return { kind: "none" };
}

function nameTool(record) {
  return `${record.toolName} (${record.toolCallId})`;
}

export function recoveryNote(summary) {
  if (!summary || summary.kind === "none") return null;
  if (summary.kind === "closed") {
    const why = summary.reason === "missing" ? "missing" : "unreadable";
    return (
      `This session may have been cut off mid-turn. The recovery journal is ${why}, ` +
      `so what finished and what may have partly run cannot be listed. ${CHECK}`
    );
  }
  const finished = summary.finished.length ? summary.finished.map(nameTool).join(", ") : "none";
  const partial = summary.partial.length ? summary.partial.map(nameTool).join(", ") : "none";
  return (
    `This session was cut off mid-turn. Finished: ${finished}. ` +
    `May have partly run: ${partial}. ${CHECK}`
  );
}
