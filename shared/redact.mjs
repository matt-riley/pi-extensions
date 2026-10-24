// redact.mjs — credential and privacy masking before TypeSafe requests.
//
// These judgments are asked about real work: commands, tool outputs, whole
// session transcripts. Any of that can carry a token, and every request goes
// to a remote API, so the shapes below are replaced before the body is built.
//
// The patterns are the ones that let a wrong answer still be useful: a caller
// loses the secret, not the sentence around it, so a question about *why* a
// command touches a credential can still be asked.

import { homedir } from "node:os";

/** Exact values, replaced first: a matched shape cannot see a key it is part of. */
const MIN_LITERAL = 8;
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s?#<>]*@/gi;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

const PATTERNS = [
  ["pem", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g],
  ["aws", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["github", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["openai", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g],
];

// NAME=value, "name": "value", password: ... — with the name kept so the
// sentence still reads. A redacted marker is not a secret; short values are
// left alone, because a 6-character value is a variable, not a credential.
const ASSIGNMENT =
  /([A-Za-z0-9_.-]*(?:key|token|secret|password|credential)[A-Za-z0-9_.-]*\s*[:=]\s*["']?)(?!<REDACTED)([^\s"',;]{16,})/gi;

const marker = (kind) => `<REDACTED:${kind}>`;

function isPlainObject(value) {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function redactString(text, { literals, homeDir, maskEmails }, add, addPrivacy) {
  let out = text;
  for (const literal of literals) {
    if (typeof literal !== "string" || literal.length < MIN_LITERAL) continue;
    const parts = out.split(literal);
    if (parts.length === 1) continue;
    add(parts.length - 1);
    out = parts.join(marker("key"));
  }
  out = out.replace(URL_USERINFO, (_match, scheme) => {
    add(1);
    return `${scheme}${marker("url")}@`;
  });
  for (const [kind, pattern] of PATTERNS) {
    out = out.replace(pattern, () => {
      add(1);
      return marker(kind);
    });
  }
  out = out.replace(ASSIGNMENT, (_match, prefix) => {
    add(1);
    return `${prefix}${marker("assignment")}`;
  });
  if (homeDir) {
    out = out.replaceAll(homeDir, (match, offset, source) => {
      const suffix = source.slice(offset + match.length);
      if (suffix && !/^(?:[\\/\s"'(){}[\],;:!?<>`]|\.(?:\s|$))/.test(suffix)) return match;
      addPrivacy(1);
      return marker("home");
    });
  }
  if (maskEmails) {
    out = out.replace(EMAIL, () => {
      addPrivacy(1);
      return marker("email");
    });
  }
  return out;
}

/**
 * Replace credentials in every string of `value`, keeping its shape.
 *
 * @param {unknown} value state of any shape
 * @param {{ literals?: string[], homeDir?: string, maskEmails?: boolean }} [opts] privacy options
 * @returns {{ value: unknown, count: number, privacyCount?: number }} credential and privacy counts; input untouched
 */
export function redactSecrets(
  value,
  { literals = [], homeDir = homedir(), maskEmails = false } = {},
) {
  // Do not interpret a root or an empty home as a prefix of every absolute path.
  homeDir = homeDir.replace(/[\\/]+$/, "");
  let count = 0;
  let privacyCount = 0;
  const add = (n) => {
    count += n;
  };
  const addPrivacy = (n) => {
    privacyCount += n;
  };
  const walk = (node) => {
    if (typeof node === "string")
      return redactString(node, { literals, homeDir, maskEmails }, add, addPrivacy);
    if (Array.isArray(node)) return node.map(walk);
    if (isPlainObject(node)) {
      const out = {};
      for (const [key, inner] of Object.entries(node)) out[key] = walk(inner);
      return out;
    }
    return node;
  };
  return { value: walk(value), count, ...(privacyCount > 0 ? { privacyCount } : {}) };
}
