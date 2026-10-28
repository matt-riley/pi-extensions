#!/usr/bin/env node
// memory-check.mjs — is this memory already in lore?
//
// /retro saves what the session learned. What it does not do is check whether
// the store already says it, so the same claim accumulates in slightly
// different words and recall spends its budget on near-duplicates. The
// deterministic half is a lexical search: the candidate memory goes to
// `lore search`, the closest hits are ranked by token overlap, and only the
// best few reach Jev.
//
// The judgment half is one Choice over the whole set — duplicate,
// contradiction, refinement, new — plus a Noul per candidate, so the report can
// name which existing memory the candidate collides with.
//
// Read-only: it searches and prints. Saving is still the caller's job.
//
//   node scripts/memory-check.mjs --memory "Cloudflare MCP tools stay deferred."
//   node scripts/memory-check.mjs --memory "…" --candidates /tmp/hits.json

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { askSystemOne } from "../shared/systemone.mjs";
import { usableNumber } from "../shared/systemone.mjs";

export const DEFAULT_BIN = process.env.LORE_BIN ?? "lore";
const MAX_CANDIDATES = 5;
const MAX_MEMORY_CHARS = 1200;
const MAX_CONTENT_CHARS = 900;
const MATCH = 0.6;

/** A backticked reference to a state path, the way these prompts name their input. */
const q = (name) => "`" + name + "`";

export const RELATIONS = {
  duplicate:
    "The candidate says what an existing memory already says; saving both would be two copies of one claim.",
  contradiction: "The candidate and an existing memory cannot both be true; one of them is wrong.",
  refinement:
    "The candidate narrows, sharpens or adds a condition to an existing memory rather than replacing it.",
  new: "No existing memory covers what the candidate claims.",
};

/**
 * Content words, lowercased. Stop words carry no overlap signal, and "the" must
 * not make two unrelated memories look related.
 */
const STOP = new Set(
  (
    "a an and are as at be been but by do does for from has have if in into is it its " +
    "not of on or so that the their them then there these they this to was were what " +
    "when where which who will with would you your"
  ).split(" "),
);

export function tokens(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .map((word) => word.replace(/^[._-]+|[._-]+$/g, ""))
      .filter((word) => word.length > 2 && !STOP.has(word)),
  );
}

/** Jaccard overlap of content words: cheap, deterministic, and explainable. */
export function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The lore search payload, as items. Accepts the CLI's JSON or the items. */
export function parseSearchOutput(raw) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  const items = parsed?.result?.items ?? parsed?.items ?? parsed;
  if (!Array.isArray(items)) return [];
  return items
    .filter((item) => item && typeof item.content === "string" && item.content.trim())
    .map((item) => ({
      id: String(item.id ?? "").trim() || null,
      content: item.content.trim().slice(0, MAX_CONTENT_CHARS),
      kind: item.kind ?? null,
      scope: item.scope ?? null,
      repository: item.repository ?? null,
    }));
}

/** Closest candidates first, so the cap keeps the ones worth asking about. */
export function rankCandidates(memory, items, { limit = MAX_CANDIDATES } = {}) {
  return (items ?? [])
    .map((item) => ({ ...item, similarity: similarity(memory, item.content) }))
    .sort(
      (left, right) =>
        right.similarity - left.similarity || (left.id ?? "").localeCompare(right.id ?? ""),
    )
    .slice(0, limit);
}

export function buildQuestions(count) {
  const questions = {
    relation: {
      type: "choice",
      instructions:
        "Read " +
        q("memory") +
        ", the candidate memory, and " +
        q("candidates") +
        ", the " +
        "existing memories lore returned for it. What is the candidate's relation to the best " +
        "matching existing memory? Judge the claims, not the wording: a paraphrase of one claim " +
        "is a duplicate. Answer 'new' only when nothing in the candidates makes the same point.",
      criteria: RELATIONS,
    },
  };
  for (let index = 0; index < count; index += 1) {
    questions["same_" + index] = {
      type: "noul",
      instructions:
        "Read " +
        q("memory") +
        " and " +
        q("candidates." + index + ".content") +
        ". Do these " +
        "make the same claim — restated, narrowed, or in conflict — such that saving the " +
        "candidate alongside it would be a duplicate, an amendment, or a contradiction? Sharing " +
        "a topic is not sharing a claim.",
      criteria: {
        true: "The candidate and this memory make the same claim, or disagree about it.",
        false: "They mention the same subject but assert different things.",
      },
    };
  }
  return questions;
}

/** The relation, the memories it matches, and what to do about it. */
export function routeCheck(answers, candidates) {
  const answer = answers?.relation;
  const relation =
    answer?.type === "choice" && Object.hasOwn(RELATIONS, answer.choice) ? answer.choice : null;
  const confidence = usableNumber(answer?.confidence);
  const matches = candidates
    .map((item, index) => ({
      ...item,
      probability: usableNumber(answers?.["same_" + index]?.noul),
    }))
    .filter((item) => item.probability !== null && item.probability >= MATCH)
    .sort((left, right) => right.probability - left.probability);
  const actionable =
    relation === "duplicate" || relation === "contradiction" || relation === "refinement";
  return {
    relation,
    confidence,
    probabilities: answer?.probabilities ?? {},
    matches: actionable ? matches : [],
  };
}

export function recommendation({ relation, matches } = {}) {
  const first = matches?.[0];
  const name = first ? (first.id ?? "(no id)") : null;
  switch (relation) {
    case "duplicate":
      return name
        ? "Update " + name + " instead of saving another memory."
        : "This restates an existing memory: find it with lore_search and update it instead.";
    case "contradiction":
      return name
        ? "Conflicts with " +
            name +
            ": decide which is true, correct or forget the other, then save once."
        : "This conflicts with an existing memory: decide which is true before saving.";
    case "refinement":
      return name
        ? "Amend " + name + " rather than adding a near-duplicate."
        : "This refines an existing memory: amend it rather than adding another.";
    case "new":
      return "No existing memory covers it: save as new.";
    default:
      return "No usable relation was returned.";
  }
}

export function formatCheck({ relation, confidence, probabilities, matches, judged, reason } = {}) {
  if (!judged) return "Not checked: " + (reason ?? "no judgment");
  const sure = typeof confidence === "number" ? " (confidence " + confidence.toFixed(2) + ")" : "";
  const distribution = Object.entries(probabilities ?? {})
    .filter(([, value]) => Number.isFinite(Number(value)))
    .map(([name, value]) => name + " " + Number(value).toFixed(2))
    .join(" · ");
  const lines = ["relation: " + relation + sure];
  if (distribution) lines.push("  " + distribution);
  for (const match of matches ?? []) {
    lines.push(
      "  " +
        (match.id ?? "(no id)") +
        (match.kind ? " · " + match.kind : "") +
        " · " +
        match.probability.toFixed(2) +
        " — " +
        match.content.slice(0, 160),
    );
  }
  lines.push("→ " + recommendation({ relation, matches }));
  return lines.join("\n");
}

/**
 * The query the lexical search gets.
 *
 * The whole memory is the wrong query: lore's search is lexical, and a full
 * sentence plus its qualifiers matches nothing — which then reads as "no
 * duplicate" and saves the duplicate this check exists to prevent (measured on
 * a real memory: the sentence returned 0 hits, its distinctive words returned
 * the memory). Longest words first, because they carry the meaning; a single
 * word as the fallback, because a store with no exact phrase may still hold the
 * claim.
 */
export function searchQueries(text, { limit = 6 } = {}) {
  const words = [...tokens(text)].sort(
    (left, right) => right.length - left.length || left.localeCompare(right),
  );
  const primary = words.slice(0, limit).join(" ");
  return [...new Set([primary, words[0]].filter((query) => query && query.length > 0))];
}

/** Run the lexical half. Injected in tests; the CLI is the only side effect. */
export function searchLore({ query, repository, bin = DEFAULT_BIN, exec = execFileSync } = {}) {
  const args = [
    "search",
    String(query ?? "").slice(0, 600),
    "--output",
    "json",
    "--all-repositories",
  ];
  if (repository) args.push("--repository", repository);
  const raw = exec(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return parseSearchOutput(raw);
}

/**
 * Check one candidate memory against the store.
 *
 * A dead daemon or a missing key is reported, never guessed: the caller decides
 * whether to save unverified, and /retro says so rather than claiming novelty.
 */
export async function checkMemory({
  memory,
  candidates,
  repository,
  bin = DEFAULT_BIN,
  exec,
  model,
  env,
  ask = askSystemOne,
} = {}) {
  const text = String(memory ?? "")
    .trim()
    .slice(0, MAX_MEMORY_CHARS);
  if (!text) return { judged: false, reason: "the memory is empty" };
  let items = candidates;
  if (!items) {
    try {
      items = [];
      for (const query of searchQueries(text)) {
        items = searchLore({ query, repository, bin, ...(exec ? { exec } : {}) });
        if (items.length > 0) break;
      }
    } catch (error) {
      return {
        judged: false,
        reason: "lore search failed: " + (error instanceof Error ? error.message : String(error)),
      };
    }
  }
  const ranked = rankCandidates(text, items);
  if (ranked.length === 0) {
    // Not "nothing like this exists": a lexical search that found nothing is
    // not a proof of novelty, and the caller must not read it as one.
    return {
      judged: false,
      reason: "the search found no memories to compare against",
      candidates: 0,
    };
  }
  try {
    const result = await ask({
      state: {
        memory: text,
        candidates: ranked.map((item) => ({ id: item.id, content: item.content, kind: item.kind })),
      },
      questions: buildQuestions(ranked.length),
      model,
      env,
    });
    const routed = routeCheck(result?.answers, ranked);
    return {
      ...routed,
      judged: routed.relation !== null,
      reason: routed.relation === null ? "the model returned no usable relation" : undefined,
      candidates: ranked.length,
      model: result?.model,
      usage: result?.usage ?? null,
    };
  } catch (error) {
    return {
      judged: false,
      reason: error instanceof Error ? error.message : String(error),
      candidates: ranked.length,
    };
  }
}

function parseArgs(argv) {
  const flags = { memory: null, candidates: null, repository: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--memory") flags.memory = argv[++index];
    else if (arg === "--candidates") flags.candidates = argv[++index];
    else if (arg === "--repository") flags.repository = argv[++index];
    else if (arg === "--file") flags.memory = "@" + argv[++index];
    else if (arg.startsWith("--")) {
      console.error("memory-check: unknown flag " + arg);
      process.exit(2);
    }
  }
  return flags;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = parseArgs(process.argv.slice(2));
  const memory =
    flags.memory === "-"
      ? fs.readFileSync(0, "utf8")
      : flags.memory?.startsWith("@")
        ? fs.readFileSync(flags.memory.slice(1), "utf8")
        : flags.memory;
  if (!memory || !String(memory).trim()) {
    console.error('memory-check: pass --memory "text", --memory - (stdin) or --file path');
    process.exitCode = 2;
  } else {
    const candidates = flags.candidates
      ? parseSearchOutput(fs.readFileSync(flags.candidates, "utf8"))
      : undefined;
    const result = await checkMemory({ memory, candidates, repository: flags.repository });
    if (!result.judged) {
      console.error("memory-check: " + result.reason);
      process.exitCode = 2;
    } else {
      console.log(formatCheck({ memory, ...result }));
    }
  }
}
