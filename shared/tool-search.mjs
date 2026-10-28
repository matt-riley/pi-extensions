// Mirrors pi 1.4.0 tool_search / codemode searchTools: BM25 over deferred and
// codemode tools, and the registration rule for which tools start declared.

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

function stem(term) {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

export function tokenize(text) {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaText(schema, parts) {
  if (!isObject(schema)) return;
  if (typeof schema.description === "string") parts.push(schema.description);
  if (isObject(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name);
      schemaText(property, parts);
    }
  }
  schemaText(schema.items, parts);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const variants = schema[key];
    if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
  }
}

export function createToolSearchDocument(tool, namespace) {
  const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
  schemaText(tool.parameters, parts);
  if (namespace) {
    parts.push(namespace.name, namespace.description ?? "", namespace.instructions ?? "");
  }
  return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

export class Bm25Ranker {
  constructor(options = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
  }

  rank(query, documents, limit) {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
    const termCounts = documents.map((document) => {
      const counts = new Map();
      for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
      return counts;
    });
    const lengths = termCounts.map((counts) =>
      [...counts.values()].reduce((sum, count) => sum + count, 0),
    );
    const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
    const idf = new Map(
      queryTerms.map((term) => {
        const frequency = termCounts.filter((counts) => counts.has(term)).length;
        return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
      }),
    );
    const matches = [];
    documents.forEach((document, index) => {
      let score = 0;
      for (const term of queryTerms) {
        const count = termCounts[index].get(term);
        if (!count) continue;
        const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / averageLength);
        score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
      }
      if (score > 0) matches.push({ name: document.name, score });
    });
    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function toolExposure(definition) {
  return definition?.exposure ?? "direct";
}

/** Whether pi activates a tool on registration so it appears in the initial prompt. */
export function isActivatedOnRegistration(definition) {
  const exposure = toolExposure(definition);
  const declarable = exposure === "direct" || exposure === "model-only";
  return declarable && definition?.defaultActive !== false;
}

export function isSearchableExposure(exposure) {
  return exposure === "codemode" || exposure === "deferred";
}

export function initialActiveToolNames(
  allTools,
  { baseActive = ["read", "bash", "edit", "write"] } = {},
) {
  const extensionActive = allTools
    .filter((tool) => isActivatedOnRegistration(tool))
    .map((tool) => tool.name);
  return [...new Set([...baseActive, ...extensionActive])];
}

export function createToolRegistry(allTools, options = {}) {
  const tools = allTools.map((tool) => ({
    ...tool,
    exposure: toolExposure(tool),
  }));
  let active = initialActiveToolNames(tools, options);
  return {
    getAllTools: () => tools,
    getActiveTools: () => [...active],
    setActiveTools: (names) => {
      active = [...names];
    },
  };
}

export function searchAndLoad(registry, query, limit = 8) {
  const active = registry.getActiveTools();
  const candidates = registry
    .getAllTools()
    .filter((tool) => isSearchableExposure(tool.exposure) && !active.includes(tool.name));
  const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
  const matches = new Bm25Ranker().rank(query, documents, limit);
  if (matches.length > 0) {
    registry.setActiveTools([...active, ...matches.map((match) => match.name)]);
  }
  return matches.map((match) => ({
    name: match.name,
    description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
  }));
}
