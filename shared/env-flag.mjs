// env-flag.mjs — one reading of "the flag is off", so every package agrees.
//
// Only 0/false/off/no turn a feature off, and a prefix is not a word: "offline"
// is not "off". Unset means on, because these features are wanted by default
// and a typo in a shell must not silently disable one.

const OFF = new Set(["0", "false", "off", "no"]);

/** Whether an environment flag says off. Unset, blank or a word like "offline" is not off. */
export function flagOff(value) {
  return OFF.has(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

/** A positive finite number from a flag or env value, else `fallback`. Blank and junk fall back. */
export function positiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/** Like positiveNumber, but only a whole number counts. */
export function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}
