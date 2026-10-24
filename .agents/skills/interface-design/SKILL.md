---
name: interface-design
description: Design or refactor module boundaries and public interfaces to hide complexity behind small APIs. Use when an interface is hard to use, callers duplicate orchestration, or a refactor needs a simpler boundary without changing behavior.
---

# Interface design

Start with the caller's problem. A good module removes more complexity from its callers than its interface introduces. A function or existing platform feature may be the whole solution.

1. Trace representative callers and a concrete success and failure scenario. Identify the complexity leaking out: call ordering, repeated validation, shared mutable state, configuration, resource lifetime or error translation.
2. Check whether an existing helper, standard library, native platform feature or installed dependency already owns that responsibility. Reuse it before adding another layer.
3. Propose the smallest coherent boundary. Keep related policy and state together; hide internal steps the caller should not coordinate. Prefer one meaningful operation over a wrapper that exposes every implementation detail.
4. Show one caller before and after. State which concepts disappear from the caller, what inputs and errors remain, and who owns cleanup. If the wrapper removes no decisions or duplicated work, delete it instead of polishing it.
5. Check compatibility across every affected caller, including malformed input, failure, cancellation and partial completion where relevant. Preserve public behavior unless the user authorized a compatibility change. Do not invent extension points for hypothetical future users.
6. Give the verification: a test at the interface that demonstrates the behavior independently of its implementation. For an authorized refactor, run baseline tests first, make a small change, and rerun focused and repository checks.

For a design-only request, report the proposal and trade-offs without editing code. Ask only about genuine product choices that code and documentation cannot settle. Use competing designs only when a consequential trade-off warrants them; do not summon an architecture process for a small helper.

## Deliverable

Give the current pain, proposed interface, a concrete caller example, compatibility risks, and the check that would prove the change works. Include the no-new-abstraction option. Stop if the existing boundary already earns its place.

Do not add a framework, dependency, glossary or architecture document by default. Record a decision only when it is hard to reverse, surprising without context, and based on a real trade-off.
