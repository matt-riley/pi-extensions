// recover.mjs — journal tool calls and, on resume, write one crash-recovery
// note. index.ts owns the pi wiring; this module owns the journal and the note.

export const JOURNAL_TYPE = "recover-journal";
export const NOTE_TYPE = "recover-note";
export const LIST_CAP = 20;
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

function messageOf(entry) {
  return entry?.message ?? entry;
}

function isUser(entry) {
  return messageOf(entry)?.role === "user";
}

function isCompletedAssistant(entry) {
  const message = messageOf(entry);
  return (
    message?.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted" &&
    message.stopReason !== "toolUse"
  );
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
  for (let i = entries.length - 1; i >= 0; i--) if (match(entries[i], i)) return i;
  return -1;
}

function lastAssistant(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = messageOf(entries[i]);
    if (message?.role === "assistant") return { message, index: i };
  }
  return { message: null, index: -1 };
}

function incidentStart(entries) {
  return Math.max(
    lastIndex(entries, (entry) => isCustom(entry, NOTE_TYPE)),
    lastIndex(entries, isCompletedAssistant),
  );
}

function readJournal(entries, start = -1) {
  const records = [];
  let found = false;
  for (let i = start + 1; i < entries.length; i++) {
    const entry = entries[i];
    if (!isCustom(entry, JOURNAL_TYPE)) continue;
    found = true;
    if (!validRecord(entry.data)) return { ok: false, reason: "unreadable" };
    records.push({ data: entry.data, index: i });
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

export function summarizeRecovery(entries) {
  if (!Array.isArray(entries)) return { kind: "closed", reason: "unreadable" };
  if (entries.length === 0) return { kind: "none" };

  const start = incidentStart(entries);
  const journal = readJournal(entries, start);
  if (!journal.ok && journal.reason === "unreadable") {
    return { kind: "closed", reason: "unreadable" };
  }

  const assistant = lastAssistant(entries);
  const aborted = assistant.message?.stopReason === "aborted" && assistant.index > start;

  if (journal.ok) {
    const lastUser = lastIndex(entries, (entry, i) => i > start && isUser(entry));
    const turnStart = Math.max(start, lastUser);
    const { finished, partial } = foldRecords(
      journal.records.filter((record) => record.index > turnStart).map((record) => record.data),
    );
    if (partial.length === 0 && !aborted) return { kind: "none" };
    return { kind: "cutoff", finished, partial };
  }

  if (aborted) {
    const anyJournal = entries.some((entry) => isCustom(entry, JOURNAL_TYPE));
    if (!anyJournal) return { kind: "closed", reason: "missing" };
    return { kind: "cutoff", finished: [], partial: [] };
  }
  return { kind: "none" };
}

function nameTool(record) {
  return `${record.toolName} (${record.toolCallId})`;
}

function formatList(records) {
  if (!records.length) return "none";
  const hidden = Math.max(0, records.length - LIST_CAP);
  const shown = records.slice(-LIST_CAP).map(nameTool).join(", ");
  return hidden > 0 ? `${shown} +${hidden} more` : shown;
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
  return (
    `This session was cut off mid-turn. Finished: ${formatList(summary.finished)}. ` +
    `May have partly run: ${formatList(summary.partial)}. ${CHECK}`
  );
}
