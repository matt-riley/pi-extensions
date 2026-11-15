// rules.mjs — read and validate the human-written rules file.
//
// The file is JSON that a person authors and owns; this module never writes it.
// Anything it does not understand is an error rather than a rule that quietly
// does nothing: unknown keys, a missing name, a rule with no `forbid`, a `$n`
// that the `from` pattern cannot supply.
//
//   {
//     "version": 1,
//     "ignore": ["**/test/**"],          // importing files these match are not checked
//     "cycles": "report",                // or "off"
//     "rules": [{
//       "name": "packages-are-islands",
//       "from": "packages/*/**",         // files the rule applies to; * is captured as $1
//       "forbid": ["packages/**"],       // they must not import any of these ...
//       "except": ["packages/$1/**"],    // ... apart from these
//       "reason": "share code through shared/"
//     }]
//   }

import { captureCount } from "./glob.mjs";

const TOP_KEYS = new Set(["version", "ignore", "cycles", "rules"]);
const RULE_KEYS = new Set(["name", "from", "forbid", "except", "reason"]);

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
const asList = (value) => (typeof value === "string" ? [value] : value);

function checkRule(rule, at, seen) {
  const errors = [];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
    return { errors: [`${at}: must be an object`] };
  }
  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.has(key)) errors.push(`${at}: unknown key "${key}"`);
  }
  if (typeof rule.name !== "string" || !rule.name) errors.push(`${at}: needs a "name"`);
  else if (seen.has(rule.name)) errors.push(`${at}: duplicate rule name "${rule.name}"`);
  if (typeof rule.from !== "string" || !rule.from) errors.push(`${at}: needs a "from" pattern`);
  const forbid = asList(rule.forbid);
  if (!isStringArray(forbid) || forbid.length === 0) {
    errors.push(`${at}: "forbid" must be a pattern or a non-empty list of patterns`);
  }
  const except = rule.except === undefined ? [] : asList(rule.except);
  if (!isStringArray(except))
    errors.push(`${at}: "except" must be a pattern or a list of patterns`);
  if (rule.reason !== undefined && typeof rule.reason !== "string") {
    errors.push(`${at}: "reason" must be text`);
  }
  if (errors.length === 0) {
    const offered = captureCount(rule.from);
    for (const pattern of [...forbid, ...except]) {
      for (const [, digits] of pattern.matchAll(/\$(\d+)/g)) {
        if (Number(digits) < 1 || Number(digits) > offered) {
          errors.push(`${at}: $${digits} in "${pattern}" but "from" captures ${offered}`);
        }
      }
    }
  }
  if (errors.length > 0) return { errors };
  return {
    errors,
    rule: {
      name: rule.name,
      from: rule.from,
      forbid,
      ...(except.length > 0 && { except }),
      ...(rule.reason && { reason: rule.reason }),
    },
  };
}

/**
 * Parse the text of a rules file. Never throws.
 *
 * @param {string} text
 * @returns {{ rules: object[], ignore: string[], cycles: "report" | "off", errors: string[] }}
 */
export function parseRules(text) {
  const result = { rules: [], ignore: [], cycles: "report", errors: [] };
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    result.errors.push(`rules file is not valid JSON: ${error.message}`);
    return result;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    result.errors.push("rules file must be a JSON object");
    return result;
  }
  for (const key of Object.keys(json)) {
    if (!TOP_KEYS.has(key)) result.errors.push(`unknown key "${key}"`);
  }
  if (json.cycles !== undefined) {
    if (json.cycles === "report" || json.cycles === "off") result.cycles = json.cycles;
    else result.errors.push('"cycles" must be "report" or "off"');
  }
  if (json.ignore !== undefined) {
    if (isStringArray(json.ignore)) result.ignore = json.ignore;
    else result.errors.push('"ignore" must be a list of patterns');
  }
  if (!Array.isArray(json.rules)) {
    result.errors.push('"rules" must be an array');
    return result;
  }
  const seen = new Set();
  json.rules.forEach((candidate, index) => {
    const { errors, rule } = checkRule(candidate, `rules[${index}]`, seen);
    result.errors.push(...errors);
    if (rule) {
      seen.add(rule.name);
      result.rules.push(rule);
    } else if (typeof candidate?.name === "string") seen.add(candidate.name);
  });
  return result;
}
