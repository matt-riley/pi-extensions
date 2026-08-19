// html.mjs — zero-dependency HTML tokenizer, tree builder, boilerplate
// stripping, main-content selection, serialization, and metadata extraction.
//
// This is deliberately a *lenient* parser: real-world HTML is malformed, so
// every path degrades gracefully (bare "<", unclosed tags, stray close tags,
// attribute soup). We only need a tree good enough for content extraction,
// not a spec-perfect DOM.

export const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
  bull: "•", middot: "·", times: "×", divide: "÷", para: "¶",
  sect: "§", deg: "°", micro: "µ", ensp: "\u2002", emsp: "\u2003",
  thinsp: "\u2009", zwnj: "\u200c", zwj: "\u200d", shy: "\u00ad",
  euro: "€", pound: "£", yen: "¥", cent: "¢", frac12: "½", frac14: "¼",
  frac34: "¾", iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»",
  dagger: "†", permil: "‰", prime: "′", larr: "←", uarr: "↑",
  rarr: "→", darr: "↓", harr: "↔", plusmn: "±", sup2: "²", sup3: "³",
  acute: "´", cedil: "¸", macr: "¯", uml: "¨", ordf: "ª", ordm: "º",
  not: "¬", infin: "∞", ne: "≠", le: "≤", ge: "≥", sum: "∑",
  prod: "∏", radic: "√", int: "∫", sim: "∼", asymp: "≈", equiv: "≡",
};

export function decodeEntities(text) {
  return String(text).replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, entity) => {
      if (entity.startsWith("#")) {
        const hex = entity[1] === "x" || entity[1] === "X";
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        return match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

// --- Tokenizer --------------------------------------------------------------

// Returns tokens: { type: "text", text } | { type: "tag", name, attrs,
// selfClosing } | { type: "close", name }. Comments, doctype, and script/style
// raw bodies are dropped (their content is never display text).
export function tokenize(input) {
  const tokens = [];
  const src = String(input ?? "");
  const n = src.length;
  let i = 0;
  let textStart = 0;

  const flushText = (end) => {
    if (end > textStart) {
      tokens.push({ type: "text", text: decodeEntities(src.slice(textStart, end)) });
    }
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    const after = src[lt + 1];

    if (after === "!") {
      if (src.startsWith("<!--", lt)) {
        const end = src.indexOf("-->", lt + 4);
        const stop = end === -1 ? n : end + 3;
        flushText(lt);
        textStart = stop;
        i = stop;
        continue;
      }
      if (src.startsWith("<![CDATA[", lt)) {
        const end = src.indexOf("]]>", lt + 9);
        const stop = end === -1 ? n : end + 3;
        flushText(lt);
        tokens.push({ type: "text", text: src.slice(lt + 9, end === -1 ? n : end) });
        textStart = stop;
        i = stop;
        continue;
      }
      // <!DOCTYPE ...> or other declaration: skip to the next ">".
      const gt = src.indexOf(">", lt);
      if (gt === -1) break;
      flushText(lt);
      textStart = gt + 1;
      i = gt + 1;
      continue;
    }

    if (after === "/") {
      const m = /^<\s*\/\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(lt));
      const gt = src.indexOf(">", lt);
      if (m && gt !== -1) {
        flushText(lt);
        tokens.push({ type: "close", name: m[1].toLowerCase() });
        textStart = gt + 1;
        i = gt + 1;
        continue;
      }
      i = lt + 1; // malformed "</...": treat as text
      continue;
    }

    if (after && /[a-zA-Z]/.test(after)) {
      const parsed = parseStartTag(src, lt);
      if (parsed) {
        flushText(lt);
        const { name, attrs, selfClosing, end } = parsed;
        tokens.push({ type: "tag", name, attrs, selfClosing });
        textStart = end;
        i = end;
        if ((name === "script" || name === "style") && !selfClosing) {
          // Skip raw text until the matching close tag, but still emit the
          // close token so the tree builder pops the element.
          const closeAt = src.toLowerCase().indexOf(`</${name}`, i);
          if (closeAt === -1) {
            i = n;
            textStart = n;
          } else {
            const gt = src.indexOf(">", closeAt);
            i = gt === -1 ? n : gt + 1;
            textStart = i;
            tokens.push({ type: "close", name });
          }
        }
        continue;
      }
      i = lt + 1;
      continue;
    }

    i = lt + 1; // bare "<" (e.g. "1 < 2"): keep as text
  }

  if (n > textStart) {
    tokens.push({ type: "text", text: decodeEntities(src.slice(textStart, n)) });
  }
  return tokens;
}

function parseStartTag(src, lt) {
  const n = src.length;
  let i = lt + 1;
  const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(src.slice(i));
  if (!nameMatch) return null;
  const name = nameMatch[0].toLowerCase();
  i += nameMatch[0].length;

  const attrs = [];
  let selfClosing = false;

  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    const ch = src[i];
    if (ch === ">") {
      i++;
      break;
    }
    if (ch === "/" && src[i + 1] === ">") {
      selfClosing = true;
      i += 2;
      break;
    }
    const attrMatch = /^[^\s=/>]+/.exec(src.slice(i));
    if (!attrMatch) break;
    const attrName = attrMatch[0].toLowerCase();
    i += attrMatch[0].length;

    let value = "";
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] === "=") {
      i++;
      while (i < n && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, i + 1);
        if (close === -1) {
          value = src.slice(i + 1);
          i = n;
        } else {
          value = src.slice(i + 1, close);
          i = close + 1;
        }
      } else {
        const m = /^[^\s>]*/.exec(src.slice(i));
        value = m ? m[0] : "";
        i += value.length;
      }
    }
    attrs.push({ name: attrName, value: decodeEntities(value) });
  }

  return { name, attrs, selfClosing, end: i };
}

// --- Tree builder -----------------------------------------------------------

// Node shape: { tag: string|null, attrs: Record<string,string>, children: [],
// text: string }. Element nodes have tag != null and text ""; text nodes have
// tag === null and carry the decoded text.

// Elements that implicitly close an already-open same-kind element, but only
// when it is the current node (consecutive items like <li>a<li>b, <td>a<td>b).
// Nested lists must NOT trigger this, so the check is top-of-stack only.
const AUTO_CLOSE = {
  li: new Set(["li"]),
  dt: new Set(["dt", "dd"]),
  dd: new Set(["dt", "dd"]),
  td: new Set(["td", "th"]),
  th: new Set(["td", "th"]),
  tr: new Set(["td", "th", "tr"]),
  thead: new Set(["td", "th", "tr", "thead", "tbody", "tfoot"]),
  tbody: new Set(["td", "th", "tr", "thead", "tbody", "tfoot"]),
  tfoot: new Set(["td", "th", "tr", "thead", "tbody", "tfoot"]),
  p: new Set(["p"]),
  option: new Set(["option"]),
  optgroup: new Set(["option", "optgroup"]),
};

// Block elements that implicitly close an open <p>.
const P_ENDERS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "div", "section", "article", "aside",
  "header", "footer", "nav", "main", "ul", "ol", "table", "blockquote",
  "pre", "figure", "hr", "form", "address", "fieldset", "dl", "details",
]);

// Nested same-name elements are almost always broken markup (a div inside a
// div with no closer); browsers close the outer one. Mirror that to keep the
// tree from growing pathological chains.
const SAME_NAME_CLOSE = new Set([
  "div", "span", "p", "section", "article", "aside", "header", "footer",
  "nav", "main", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr",
  "td", "th", "blockquote", "figure", "a", "button", "h1", "h2", "h3", "h4",
  "h5", "h6", "strong", "em", "b", "i", "u", "s", "small", "sub", "sup",
  "code", "pre", "form", "label", "select", "textarea",
]);

const MAX_DEPTH = 200;

function attrsToMap(attrs) {
  const map = {};
  for (const { name, value } of attrs) map[name] = value;
  return map;
}

export function buildTree(tokens) {
  const root = { tag: null, attrs: {}, children: [], text: "" };
  const stack = [root];

  for (const tok of tokens) {
    if (tok.type === "text") {
      stack[stack.length - 1].children.push({
        tag: null, attrs: {}, children: [], text: tok.text,
      });
      continue;
    }
    if (tok.type === "close") {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tok.name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }

    const { name, attrs, selfClosing } = tok;
    if (VOID_TAGS.has(name)) {
      stack[stack.length - 1].children.push({
        tag: name, attrs: attrsToMap(attrs), children: [], text: "",
      });
      continue;
    }

    const ac = AUTO_CLOSE[name];
    if (ac && ac.has(stack[stack.length - 1].tag)) {
      stack.pop();
    }
    if (name === "p" || P_ENDERS.has(name)) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === "p") {
          stack.length = k;
          break;
        }
      }
    }
    if (SAME_NAME_CLOSE.has(name) && stack[stack.length - 1].tag === name) {
      stack.pop();
    }

    const el = { tag: name, attrs: attrsToMap(attrs), children: [], text: "" };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing && stack.length < MAX_DEPTH) {
      stack.push(el);
    }
  }
  return root;
}

// --- Tree helpers -----------------------------------------------------------

export function textLength(node) {
  if (node.tag === null) return node.text.length;
  let total = 0;
  for (const c of node.children) total += textLength(c);
  return total;
}

export function nodeText(node) {
  if (node.tag === null) return node.text;
  let out = "";
  for (const c of node.children) out += nodeText(c);
  return out;
}

// --- Serialization ----------------------------------------------------------

const BLOCK_TAGS = new Set([
  "html", "body", "head", "div", "section", "article", "aside", "header",
  "footer", "nav", "main", "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul",
  "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "dl",
  "dt", "dd", "blockquote", "pre", "figure", "figcaption", "hr", "form",
  "fieldset", "address", "details", "summary", "table", "caption", "colgroup",
]);

const BOOLEAN_ATTRS = new Set([
  "hidden", "disabled", "checked", "selected", "readonly", "required",
  "multiple", "autofocus", "defer", "async", "novalidate", "open",
]);

function escapeHtmlText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeAttrs(attrs) {
  let out = "";
  for (const [name, value] of Object.entries(attrs)) {
    if (BOOLEAN_ATTRS.has(name) && value === "") {
      out += ` ${name}`;
    } else {
      out += ` ${name}="${escapeHtmlText(value).replace(/"/g, "&quot;")}"`;
    }
  }
  return out;
}

function serializeRaw(node, out) {
  if (node.tag === null) {
    out.push(escapeHtmlText(node.text));
    return;
  }
  out.push(`<${node.tag}${serializeAttrs(node.attrs)}>`);
  for (const c of node.children) serializeRaw(c, out);
  out.push(`</${node.tag}>`);
}

// Pretty-printed serialization of a cleaned tree. Whitespace inside
// pre/textarea/code is preserved verbatim; close tags share the line with
// inline content and move to their own indented line only around block
// children.
export function serializeTree(root, { pretty = true } = {}) {
  const out = [];

  const emit = (node, d) => {
    if (node.tag === null) {
      if (node.children.length === 0) {
        out.push(node.text);
      } else {
        for (const c of node.children) emit(c, d);
      }
      return;
    }
    const tag = node.tag;
    const open = `<${tag}${serializeAttrs(node.attrs)}>`;
    if (VOID_TAGS.has(tag)) {
      out.push(open);
      return;
    }
    const raw = tag === "pre" || tag === "textarea" || tag === "code";
    const block = pretty && BLOCK_TAGS.has(tag);
    const indent = "  ".repeat(d);
    const hasBlockChild = node.children.some((c) => c.tag !== null && BLOCK_TAGS.has(c.tag));

    if (block) out.push(`\n${indent}${open}`);
    else out.push(open);

    if (raw) {
      for (const c of node.children) serializeRaw(c, out);
    } else {
      for (const c of node.children) emit(c, block && hasBlockChild ? d + 1 : d);
    }

    if (block && hasBlockChild) out.push(`\n${indent}</${tag}>`);
    else out.push(`</${tag}>`);
  };

  emit(root, 0);
  let html = out.join("");
  html = html
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return html;
}

// --- Boilerplate stripping --------------------------------------------------

// Tags whose content is never readable article content.
const STRIP_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "frame", "frameset",
  "object", "embed", "form", "button", "input", "select", "textarea",
  "option", "optgroup", "svg", "math", "canvas", "audio", "video", "source",
  "track", "dialog", "map", "area", "datalist", "slot", "portal",
]);

// class/id tokens that mark page chrome. Boundary-anchored so "nav" does not
// match "innovation" and "ad" does not match "badge".
const BOILERPLATE_RE =
  /(^|[\s_-])(comment|comments|sidebar|side-?bar|related|footer|foot|navbar|nav|menu|navigation|masthead|banner|advert|ad|ads|promo|social|share|sharing|newsletter|subscribe|signup|login|auth|cookie|consent|modal|popup|pop-?up|overlay|breadcrumb|breadcrumbs|pagination|widget|hidden|visually-?hidden|sr-?only|skip-?link|outbrain|taboola|recommend|recent|popular|tags?|legalese|legal|support)([\s_-]|$)/i;

// <header> is only chrome when its class/id says so — article headers carry
// the title and must survive.
const HEADER_BOILERPLATE_RE =
  /(^|[\s_-])(site-?header|site-?head|masthead|banner|navbar|navigation|menu|top-?bar|global-?nav|site-?nav)([\s_-]|$)/i;

function pruneEmpty(node) {
  if (node.tag === null) {
    // Virtual root container, or a text leaf.
    if (node.children.length === 0) return node;
    const kids = [];
    for (const c of node.children) {
      const kept = pruneEmpty(c);
      if (kept) kids.push(kept);
    }
    node.children = kids;
    return node;
  }
  if (VOID_TAGS.has(node.tag)) return node;
  const kids = [];
  for (const c of node.children) {
    const kept = pruneEmpty(c);
    if (kept) kids.push(kept);
  }
  node.children = kids;
  return kids.length === 0 ? null : node;
}

// Removes chrome (nav/footer/aside/form/scripts/ads/comments/etc.) from the
// tree in place and drops containers left empty. Returns the (possibly null)
// root.
export function stripBoilerplate(root) {
  const walk = (node) => {
    if (node.tag === null) {
      // Tag-less container (virtual root): process children, keep if any.
      const kids = [];
      for (const c of node.children) {
        const kept = walk(c);
        if (kept) kids.push(kept);
      }
      node.children = kids;
      return node;
    }
    const tag = node.tag;
    if (STRIP_TAGS.has(tag) || tag === "nav" || tag === "footer" || tag === "aside") {
      return null;
    }
    if ("hidden" in node.attrs) return null;
    const cls = `${node.attrs.class ?? ""} ${node.attrs.id ?? ""}`;
    if (BOILERPLATE_RE.test(cls)) return null;
    if (tag === "header" && HEADER_BOILERPLATE_RE.test(cls)) return null;
    const kids = [];
    for (const c of node.children) {
      const kept = walk(c);
      if (kept) kids.push(kept);
    }
    node.children = kids;
    return node;
  };
  const kept = walk(root);
  return kept ? pruneEmpty(kept) : null;
}

// --- Main-content selection -------------------------------------------------

export const MIN_MAIN_CHARS = 200;

// Picks the subtree most likely to hold the article: <article>, then
// <main>/[role=main], then the block-level child of the body with the most
// text. Falls back to the whole tree when nothing qualifies.
export function selectMain(root, { minChars = MIN_MAIN_CHARS } = {}) {
  // Breadth-first: prefer the shallowest article, then main/role=main.
  // Semantic elements win outright — they are the page's declared content.
  let semantic = null;
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (!node) continue;
    if (node.tag !== null) {
      if (node.tag === "article") {
        semantic = node;
        break;
      }
      if ((node.tag === "main" || node.attrs.role === "main") && !semantic) semantic = node;
    }
    for (const c of node.children) queue.push(c);
  }
  if (semantic) return semantic;

  // Score direct block children of the body (or the root when body is absent).
  const body =
    root.tag === "body" ? root : findChild(root, (n) => n.tag === "body") ?? root;
  let best = null;
  let bestLen = 0;
  for (const c of body.children) {
    if (c.tag === null) continue;
    if (c.tag === "div" || c.tag === "section" || c.tag === "main" || c.tag === "article") {
      const len = textLength(c);
      if (len > bestLen) {
        bestLen = len;
        best = c;
      }
    }
  }
  if (best && bestLen >= minChars) return best;

  return body.tag === "body" ? body : root;
}

function findChild(node, predicate) {
  for (const c of node.children) {
    if (predicate(c)) return c;
  }
  for (const c of node.children) {
    const found = findChild(c, predicate);
    if (found) return found;
  }
  return null;
}

// --- Metadata ---------------------------------------------------------------

const META_RE = /<meta\b[^>]*>/gi;

function metaAttr(tag, attr) {
  const re = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

function metaContent(html, key, value) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if ((metaAttr(tag, "name").toLowerCase() === value) ||
        (metaAttr(tag, "property").toLowerCase() === value) ||
        (metaAttr(tag, "itemprop").toLowerCase() === value)) {
      return metaAttr(tag, "content");
    }
  }
  return "";
}

function cleanMeta(value) {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

// Best-effort metadata from the raw HTML head. Regex-based is fine here: the
// <head> is small and well-formed in practice.
export function extractMetadata(html) {
  const src = String(html ?? "");

  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch
    ? cleanMeta(titleMatch[1].replace(/<[^>]*>/g, ""))
    : "";
  if (!title) title = cleanMeta(metaContent(src, "property", "og:title"));

  const description =
    cleanMeta(metaContent(src, "name", "description")) ||
    cleanMeta(metaContent(src, "property", "og:description")) ||
    cleanMeta(metaContent(src, "name", "twitter:description"));

  const author =
    cleanMeta(metaContent(src, "name", "author")) ||
    cleanMeta(metaContent(src, "property", "article:author"));

  const siteName =
    cleanMeta(metaContent(src, "property", "og:site_name")) ||
    cleanMeta(metaContent(src, "name", "application-name"));

  const published =
    cleanMeta(metaContent(src, "property", "article:published_time")) ||
    cleanMeta(metaContent(src, "itemprop", "datePublished")) ||
    cleanMeta(metaContent(src, "name", "date")) ||
    cleanMeta(metaContent(src, "name", "pubdate")) ||
    (() => {
      const t = src.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["'][^>]*>/i);
      return t ? cleanMeta(t[1]) : "";
    })();

  const langMatch = src.match(/<html\b[^>]*\blang\s*=\s*["']([^"']+)["']/i);
  const lang = langMatch ? langMatch[1].toLowerCase().trim() : "";

  let canonical = "";
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(src))) {
    const tag = m[0];
    const rel = metaAttr(tag, "rel").toLowerCase().split(/\s+/);
    if (rel.includes("canonical")) {
      canonical = metaAttr(tag, "href").trim();
      break;
    }
  }

  return { title, description, author, siteName, published, lang, canonical };
}
