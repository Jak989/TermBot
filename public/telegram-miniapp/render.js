(function initMiniAppRender(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.MiniAppRender = api;
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function formatInline(value) {
    let text = escapeHtml(value);
    text = text.replace(/`([^`]+?)`/g, "<code>$1</code>");
    text = text.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[\s(])\*([^*]+?)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
    return text;
  }

  function isBlank(line) {
    return !String(line || "").trim();
  }

  function parseBlocks(rawText) {
    const text = String(rawText || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = text.split("\n");
    const blocks = [];
    let i = 0;

    const isBlockStart = (line) => {
      if (isBlank(line)) return true;
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) return true;
      if (/^#{1,6}\s+/.test(trimmed)) return true;
      if (/^\[\s*[^\]]+\s*\]$/.test(trimmed)) return true;
      if (/^[-=]{3,}$/.test(trimmed)) return true;
      if (/^[-*•]\s+/.test(trimmed)) return true;
      if (/^\d+[.)]\s+/.test(trimmed)) return true;
      if (/^[A-Za-z][A-Za-z0-9 _/-]{1,24}\s*:\s+/.test(trimmed)) return true;
      return false;
    };

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (isBlank(trimmed)) {
        i += 1;
        continue;
      }

      const codeStart = /^```([a-zA-Z0-9_+-]+)?\s*$/.exec(trimmed);
      if (codeStart) {
        const lang = codeStart[1] || "";
        i += 1;
        const codeLines = [];
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        blocks.push({ type: "code", lang, text: codeLines.join("\n") });
        continue;
      }

      const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
      if (heading) {
        blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
        i += 1;
        continue;
      }

      if (/^[-=]{3,}$/.test(trimmed)) {
        i += 1;
        continue;
      }

      const bracketHeading = /^\[\s*([^\]]+)\s*\]$/.exec(trimmed);
      if (bracketHeading) {
        blocks.push({ type: "section", text: bracketHeading[1] });
        i += 1;
        continue;
      }

      if (/^[-*•]\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length) {
          const listLine = lines[i].trim();
          const match = /^[-*•]\s+(.+)$/.exec(listLine);
          if (!match) break;
          items.push(match[1]);
          i += 1;
        }
        blocks.push({ type: "ul", items });
        continue;
      }

      if (/^\d+[.)]\s+/.test(trimmed)) {
        const items = [];
        while (i < lines.length) {
          const listLine = lines[i].trim();
          const match = /^\d+[.)]\s+(.+)$/.exec(listLine);
          if (!match) break;
          items.push(match[1]);
          i += 1;
        }
        blocks.push({ type: "ol", items });
        continue;
      }

      if (/^[A-Za-z][A-Za-z0-9 _/-]{1,24}\s*:\s+/.test(trimmed)) {
        const rows = [];
        while (i < lines.length) {
          const kvLine = lines[i].trim();
          const match = /^([A-Za-z][A-Za-z0-9 _/-]{1,24})\s*:\s+(.+)$/.exec(kvLine);
          if (!match) break;
          rows.push({ key: match[1], value: match[2] });
          i += 1;
        }
        blocks.push({ type: "kv", rows });
        continue;
      }

      const paragraph = [];
      while (i < lines.length && !isBlockStart(lines[i])) {
        paragraph.push(lines[i].trim());
        i += 1;
      }
      if (paragraph.length === 0) {
        paragraph.push(trimmed);
        i += 1;
      }
      blocks.push({ type: "p", text: paragraph.join(" ") });
    }

    return blocks;
  }

  function renderBlock(block) {
    if (block.type === "heading") {
      const level = Math.min(Math.max(block.level, 2), 4);
      return `<h${level} class="answer-h">${formatInline(block.text)}</h${level}>`;
    }
    if (block.type === "section") {
      return `<h3 class="answer-section">${formatInline(block.text)}</h3>`;
    }
    if (block.type === "p") {
      return `<p class="answer-p">${formatInline(block.text)}</p>`;
    }
    if (block.type === "ul") {
      const items = block.items.map((item) => `<li>${formatInline(item)}</li>`).join("");
      return `<ul class="answer-list">${items}</ul>`;
    }
    if (block.type === "ol") {
      const items = block.items.map((item) => `<li>${formatInline(item)}</li>`).join("");
      return `<ol class="answer-list answer-list-ordered">${items}</ol>`;
    }
    if (block.type === "kv") {
      const rows = block.rows
        .map((row) => `<div><dt>${formatInline(row.key)}</dt><dd>${formatInline(row.value)}</dd></div>`)
        .join("");
      return `<dl class="answer-kv">${rows}</dl>`;
    }
    if (block.type === "code") {
      const language = block.lang ? ` data-lang="${escapeHtml(block.lang)}"` : "";
      return `<pre class="answer-code"${language}><code>${escapeHtml(block.text)}</code></pre>`;
    }
    return "";
  }

  function renderAnswerHtml(text) {
    const blocks = parseBlocks(text);
    if (!blocks.length) {
      return `<p class="answer-empty">${escapeHtml(text || "-")}</p>`;
    }
    return blocks.map((block) => renderBlock(block)).join("");
  }

  return {
    escapeHtml,
    parseBlocks,
    renderAnswerHtml,
  };
});
