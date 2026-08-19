// The extensions import their own sibling ".mjs" helper modules (plain JS,
// covered by node --test per AGENTS.md, not by tsc). Type-checking treats
// every such import as `any` rather than attempting JS-inference of their
// shapes — see the tsconfig-decisions note in the root package's PR/report
// for why (allowJs's inferred signatures were narrower than real call sites
// and produced false positives across files this repo does not own).
declare module "*.mjs";
