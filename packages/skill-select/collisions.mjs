#!/usr/bin/env node
// collisions.mjs — which skill descriptions would the ranker confuse?
//
// Each skill's description is used as a query against the whole library, and
// every other skill is scored relative to the skill itself (its own best
// possible match). Two skills collide when, in both directions, the other comes
// within `margin` of that self score: a task worded like one can be routed to
// the other. Lexical and offline, so it can run in
// CI; it flags merge candidates for a human, it does not decide.
//
// Usage: node packages/skill-select/collisions.mjs [--margin 0.6] [--top 20] [--json]

import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { discoverSkills, rankSkills, resolveRoots } from "./library.mjs";

/**
 * @param {Array<{ name: string, description: string }>} skills
 * @param {{ margin?: number }} options
 * @returns {Array<{ a: string, b: string, strength: number, mutualTop: boolean }>}
 *   strongest first; strength is the weaker direction's score / self score.
 */
export function findCollisions(skills, { margin = 0.6 } = {}) {
  const relative = new Map();
  const top = new Map();
  for (const skill of skills) {
    if (!skill.description) continue;
    const ranked = rankSkills(skills, skill.description, { limit: skills.length });
    const self = ranked.find((match) => match.name === skill.name)?.score ?? 0;
    if (self <= 0) continue;
    top.set(skill.name, ranked.find((match) => match.name !== skill.name)?.name);
    for (const match of ranked) relative.set(`${skill.name}\0${match.name}`, match.score / self);
  }
  const pairs = [];
  const names = skills.map((skill) => skill.name).sort();
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const [a, b] = [names[i], names[j]];
      const strength = Math.min(relative.get(`${a}\0${b}`) ?? 0, relative.get(`${b}\0${a}`) ?? 0);
      if (strength >= 1 - margin)
        pairs.push({ a, b, strength, mutualTop: top.get(a) === b && top.get(b) === a });
    }
  }
  return pairs.sort((x, y) => y.strength - x.strength || x.a.localeCompare(y.a));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  const flag = (name, fallback) =>
    argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback;
  const skills = await discoverSkills({
    roots: resolveRoots({ cwd: process.cwd(), home: homedir(), env: process.env }),
  });
  const pairs = findCollisions(skills, { margin: flag("--margin", 0.6) }).slice(
    0,
    flag("--top", 20),
  );
  const where = new Map(skills.map((skill) => [skill.name, skill.path]));
  if (argv.includes("--json")) {
    console.log(
      JSON.stringify(pairs.map((p) => ({ ...p, paths: [where.get(p.a), where.get(p.b)] }))),
    );
  } else {
    console.log(
      `${pairs.length} colliding pair(s) across ${skills.length} skills (merge candidates, not verdicts):`,
    );
    for (const { a, b, strength, mutualTop } of pairs)
      console.log(`  ${strength.toFixed(2)}${mutualTop ? " mutual-top" : ""}  ${a} <-> ${b}`);
  }
}
