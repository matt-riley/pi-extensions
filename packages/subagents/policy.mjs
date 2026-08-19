// policy.mjs — pure helpers for tool-activation and child-model resolution.

// Keep the active tool set in sync with the enabled flag: add the tool when
// enabled, remove it when disabled, leave an unchanged set untouched.
export function reconcileActiveTools(active, enabled, toolName) {
  const list = Array.isArray(active) ? active : [];
  const has = list.includes(toolName);
  if (enabled && !has) return [...new Set([...list, toolName])];
  if (!enabled && has) return list.filter((tool) => tool !== toolName);
  return list;
}

// Resolve a child's model: inherit the parent's active model unless the agent
// frontmatter pins a provider/id that the registry can resolve. Unresolvable
// specs inherit the parent and carry a note.
export function resolveChildModel(modelRegistry, parentModel, spec) {
  if (!spec) return { model: parentModel, note: undefined };
  const slash = spec.indexOf("/");
  if (slash <= 0) {
    return { model: parentModel, note: `unresolved model "${spec}"; inherited parent` };
  }
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  try {
    const found = modelRegistry?.getModel?.(provider, id);
    if (found) return { model: found, note: undefined };
  } catch {
    // inherit
  }
  return { model: parentModel, note: `unresolved model "${spec}"; inherited parent` };
}
