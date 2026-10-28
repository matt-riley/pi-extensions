// Supplied by the pi host, not installed here. Widget behavior is exercised
// through packages/workbench/*.mjs tests and .pi/verify against real pi;
// footer width behaviour through packages/footer/test with a stand-in.
declare module "@earendil-works/pi-tui" {
  export const Input: unknown;
  export const SelectList: unknown;
  export const ScrollView: unknown;
  export const matchesKey: unknown;
  export const truncateToWidth: unknown;
  export const visibleWidth: unknown;
}
