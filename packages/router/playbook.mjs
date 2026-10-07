// playbook.mjs — task type → a short playbook for the run.
//
// The skill library only helps when the model thinks to search it. A playbook
// is the opposite: the router already judges every new task, so it also asks
// what kind of task it is and puts five to eight lines of "how we do this
// here" in the system prompt for that run. Five types only; anything else is
// `none`, which injects nothing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PLAYBOOK_TYPES = ["bug", "feature", "refactor", "investigation", "autonomous"];
export const NO_PLAYBOOK = "none";
/**
 * Below this probability on the chosen type, inject nothing. A wrong playbook
 * costs more than a missing one: it tells the model to do the wrong work. The
 * line is a dial, not a measurement.
 */
const MIN_CONFIDENCE = 0.5;

const PLAYBOOK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "playbooks");

export function buildTaskTypeQuestion() {
  return {
    type: "choice",
    instructions:
      "What kind of work does `prompt` ask for, given `conversation`? Judge the work, not the wording. " +
      "Choose none when it is a quick question, chit-chat, a trivial one-line edit, or a command like commit or push.",
    criteria: {
      bug: "Something is broken, failing, throwing, slow or behaving wrongly and needs to be found and fixed.",
      feature:
        "New or changed behaviour to build: add a command, support a case, implement a spec or ticket.",
      refactor:
        "Change the shape of existing code without changing behaviour: rename, extract, inline, dedupe, move, simplify.",
      investigation:
        "A read-only question to answer from the code or the web: how does X work, why is Y like this, should we do A or B.",
      autonomous:
        "Drive a long task to a finish line without stopping: keep going until CI is green, all PRs merged, every issue done.",
      [NO_PLAYBOOK]: "None of the above, or too small to need a playbook.",
    },
  };
}

/** The judged task type, or `none` when the answer is missing or unsure. */
export function taskTypeFromAnswer(answer, minConfidence = MIN_CONFIDENCE) {
  if (answer?.type !== "choice" || typeof answer.choice !== "string") return NO_PLAYBOOK;
  const choice = answer.choice.trim();
  if (!PLAYBOOK_TYPES.includes(choice)) return NO_PLAYBOOK;
  const p = Number(answer.probabilities?.[choice]);
  if (Number.isFinite(p) && p < minConfidence) return NO_PLAYBOOK;
  return choice;
}

const cache = new Map();

/** The playbook text for a type, or null for `none` or a missing file. */
export function loadPlaybook(type, dir = PLAYBOOK_DIR) {
  if (!PLAYBOOK_TYPES.includes(type)) return null;
  const file = path.join(dir, `${type}.md`);
  if (!cache.has(file)) {
    let text = null;
    try {
      text = fs.readFileSync(file, "utf8").trim() || null;
    } catch {
      text = null;
    }
    cache.set(file, text);
  }
  return cache.get(file);
}

export function withPlaybook(systemPrompt, text) {
  if (!text) return systemPrompt;
  return `${systemPrompt ?? ""}\n\n${text}`;
}
