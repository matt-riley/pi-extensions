// Supplied by the pi host, not installed here. Widget behavior is exercised
// through packages/workbench/*.mjs tests and .pi/verify against real pi.
declare module "@earendil-works/pi-tui" {
  export const Input: unknown;
  export const SelectList: unknown;
  export const ScrollView: unknown;
  export const matchesKey: unknown;
  export const truncateToWidth: unknown;
}
