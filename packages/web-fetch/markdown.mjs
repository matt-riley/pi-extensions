// markdown.mjs — convert a cleaned HTML tree into Markdown (or plain text).
//
// The tree comes from html.mjs after boilerplate stripping and main-content
// selection. The converter is deliberately conservative: it favors readable
// output over exhaustive coverage, escapes only what would corrupt the
// rendering (backslashes, asterisks, backticks), and never throws on
// unexpected shapes.

// --- helpers ----------------------------------------------------------------

function nodeText(node) {
  if (node.tag === null) return node.text;
  let out = "";
  for (const c of node.children) out += nodeText(c);
  return out;
}

function escapeInlineText(text) {
  // Escape only the characters that would turn prose into markdown syntax.
  return text.replace(/([\\*`])/g, "\\$1");
}

function cleanHref(href) {
  return href.replace(/\s+/g, "");
}

// --- inline ----------------------------------------------------------------

function renderInline(node, ctx) {
  if (node.tag === null) return escapeInlineText(node.text).replace(/\s+/g, " ");
  const attrs = node.attrs;
  switch (node.tag) {
    case "a": {
      const href = cleanHref(attrs.href ?? "");
      const label = childrenInline(node, ctx).trim();
      if (!href || /^javascript:/i.test(href)) return label;
      if (href === label) return label;
      const title = attrs.title ? ` "${attrs.title.replace(/"/g, '\\"')}"` : "";
      return `[${label || href}](${href}${title})`;
    }
    case "img":
      return renderImage(node, ctx);
    case "br":
      return "\n";
    case "strong":
    case "b":
      return `**${childrenInline(node, ctx)}**`;
    case "em":
    case "i":
      return `*${childrenInline(node, ctx)}*`;
    case "code": {
      const content = nodeText(node);
      const fence = content.includes("`") ? "``" : "`";
      return `${fence}${content}${fence}`;
    }
    case "del":
    case "s":
      return `~~${childrenInline(node, ctx)}~~`;
    case "sub":
    case "sup":
    case "small":
    case "mark":
    case "u":
    case "ins":
    case "span":
    case "abbr":
    case "time":
    case "q":
    case "cite":
    case "kbd":
    case "samp":
    case "var":
    case "wbr":
    case "bdi":
    case "bdo":
    case "ruby":
    case "rt":
    case "rp":
    case "label":
    default:
      return childrenInline(node, ctx);
  }
}

function childrenInline(node, ctx) {
  let out = "";
  for (const c of node.children) {
    if (c.tag === null) {
      out += escapeInlineText(c.text).replace(/\s+/g, " ");
    } else if (c.tag === "br") {
      out += "\n";
    } else if (c.tag === "img") {
      out += renderImage(c, ctx);
    } else {
      out += renderInline(c, ctx);
    }
  }
  return out;
}

function renderImage(node, ctx) {
  if (!ctx.includeImages) return "";
  const src = cleanHref(node.attrs.src ?? "");
  if (!src || /^data:/i.test(src)) return "";
  const alt = (node.attrs.alt ?? "").trim();
  const title = node.attrs.title ? ` "${node.attrs.title.replace(/"/g, '\\"')}"` : "";
  return `![${alt || src}](${src}${title})`;
}

// --- block ----------------------------------------------------------------

function renderBlocks(node, ctx) {
  if (node.tag === null) {
    // The virtual tree root is a tag-less container; text leaves have no children.
    if (node.children.length > 0) return childrenBlocks(node, ctx);
    const t = node.text.trim();
    return t ? t.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  }
  const attrs = node.attrs;
  switch (node.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const level = Number(node.tag[1]);
      const text = childrenInline(node, ctx).trim();
      return text ? [`${"#".repeat(level)} ${text}`] : [];
    }
    case "p": {
      const text = childrenInline(node, ctx).trim();
      return text ? [text] : [];
    }
    case "pre":
      return codeBlock(node);
    case "blockquote": {
      const inner = childrenBlocks(node, ctx);
      return inner.map((l) => (l ? `> ${l}` : ">"));
    }
    case "ul":
    case "ol":
      return listBlocks(node, ctx);
    case "table":
      return tableBlocks(node);
    case "hr":
      return ["---"];
    case "figure":
      return childrenBlocks(node, ctx);
    case "figcaption": {
      const t = childrenInline(node, ctx).trim();
      return t ? [`*${t}*`] : [];
    }
    case "summary": {
      const t = childrenInline(node, ctx).trim();
      return t ? [`**${t}**`] : [];
    }
    case "dt": {
      const t = childrenInline(node, ctx).trim();
      return t ? [t] : [];
    }
    case "dd":
      return childrenBlocks(node, ctx).map((l) => `  ${l}`);
    case "address":
      return childrenBlocks(node, ctx);
    default: {
      // Containers (div/section/article/main/header/…) and anything unknown:
      // emit children blocks with blank-line separation.
      return childrenBlocks(node, ctx);
    }
  }
}

// Render all children as blocks, joined by blank lines; drops empty groups.
function childrenBlocks(node, ctx) {
  const groups = [];
  for (const c of node.children) {
    if (c.tag === null) {
      const t = c.text.trim();
      if (t) groups.push([t]);
      continue;
    }
    const lines = renderBlocks(c, ctx);
    if (lines.length) groups.push(lines);
  }
  const out = [];
  for (const g of groups) {
    if (out.length) out.push("");
    out.push(...g);
  }
  return out;
}

function codeBlock(node) {
  let text = nodeText(node);
  text = text.replace(/^\n+/, "").replace(/\s+$/, "");
  if (!text) return [];
  let lang = "";
  const codeChild = node.children.find((c) => c.tag === "code");
  const cls = codeChild?.attrs.class ?? node.attrs.class ?? "";
  const m = cls.match(/(?:^|\s)(?:language-|lang-)([a-zA-Z0-9_+-]+)/);
  if (m) lang = m[1];
  const fence = text.includes("```") ? "~~~~" : "```";
  return [fence + lang, ...text.split("\n"), fence];
}

function listBlocks(node, ctx) {
  const ordered = node.tag === "ol";
  let index = 0;
  const lines = [];
  const baseIndent = "  ".repeat(ctx.listDepth);

  for (const li of node.children) {
    if (li.tag !== "li") {
      lines.push(...renderBlocks(li, ctx));
      continue;
    }
    const marker = ordered ? `${++index}. ` : "- ";
    const content = [];
    const nested = [];
    for (const c of li.children) {
      if (c.tag === "ul" || c.tag === "ol") nested.push(c);
      else content.push(c);
    }

    const itemLines = content.flatMap((c) => renderBlocks(c, ctx));
    if (itemLines.length === 0) {
      lines.push(`${baseIndent}${marker.trimEnd()}`);
    } else {
      lines.push(`${baseIndent}${marker}${itemLines[0]}`);
      const contIndent = " ".repeat(marker.length);
      for (let i = 1; i < itemLines.length; i++) {
        lines.push(`${baseIndent}${contIndent}${itemLines[i]}`);
      }
    }
    for (const n of nested) {
      lines.push(...listBlocks(n, { ...ctx, listDepth: ctx.listDepth + 1 }));
    }
  }
  return lines;
}

function tableBlocks(node) {
  const rows = [];
  const walkRows = (n) => {
    for (const c of n.children) {
      if (c.tag === "tr") rows.push(c);
      else walkRows(c);
    }
  };
  walkRows(node);
  if (rows.length === 0) return [];

  const cellLines = (tr) =>
    tr.children
      .filter((c) => c.tag === "td" || c.tag === "th")
      .map((c) => childrenInline(c, { includeImages: false }).trim().replace(/\|/g, "\\|").replace(/\n/g, " "));

  const header = cellLines(rows[0]);
  const body = rows.slice(1).map(cellLines);
  const cols = Math.max(header.length, ...body.map((r) => r.length));
  const pad = (cells) => {
    const c = [...cells];
    while (c.length < cols) c.push("");
    return c.map((x) => ` ${x} `);
  };

  const lines = [];
  lines.push(`|${pad(header).join("|")}|`);
  lines.push(`|${Array(cols).fill(" --- ").join("|")}|`);
  for (const r of body) lines.push(`|${pad(r).join("|")}|`);
  return lines;
}

// --- public API -------------------------------------------------------------

export function treeToMarkdown(root, { includeImages = false } = {}) {
  if (!root) return "";
  const ctx = { includeImages, listDepth: 0 };
  const lines = renderBlocks(root, ctx);
  return postProcess(lines);
}

export function treeToText(root) {
  if (!root) return "";
  const out = [];
  const push = (t) => {
    const s = t.trim();
    if (s) out.push(s);
  };

  const inline = (node) => {
    if (node.tag === null) return node.text;
    if (node.tag === "img") return "";
    if (node.tag === "br") return " ";
    return node.children.map(inline).join("");
  };

  const block = (node) => {
    if (node.tag === null) {
      if (node.children.length > 0) {
        for (const c of node.children) block(c);
        return;
      }
      push(node.text);
      return;
    }
    switch (node.tag) {
      case "pre":
        push(nodeText(node));
        return;
      case "p":
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
      case "dt":
      case "summary":
      case "figcaption":
      case "address":
      case "li":
        push(inline(node));
        return;
      case "table": {
        const rows = [];
        const walk = (n) => {
          for (const c of n.children) {
            if (c.tag === "tr") rows.push(c);
            else walk(c);
          }
        };
        walk(node);
        for (const tr of rows) {
          const cells = tr.children
            .filter((c) => c.tag === "td" || c.tag === "th")
            .map((c) => inline(c).trim());
          push(cells.join(" | "));
        }
        return;
      }
      default:
        for (const c of node.children) block(c);
    }
  };

  block(root);
  return out
    .join("\n\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function postProcess(lines) {
  return lines
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
