function normalizeWhitespace(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isUrlOnlyLine(line) {
  return /^https?:\/\/\S+$/i.test(String(line || "").trim());
}

function isPrefixOnlyLine(line) {
  const value = String(line || "").trim();
  if (!value) return false;
  return /^(kurzfassung|zusammenfassung)\s*:?\s*$/i.test(value) || /^(i(?:ck|ch)\s+sach\s+ma|nu\s+pass\s+uff)\s*:?\s*$/i.test(value);
}

function isPersonalityLeakLine(line) {
  const value = String(line || "").trim();
  if (!value) return false;
  return (
    /^#{1,6}\s*[a-d]\)\s*(pers[oö]nlicher assistent|projektmanager|developer|testing[- ]ingenieur)\b/i.test(value) ||
    /^(aufgabe|verhalten|output[- ]format|engineering[- ]regeln|test[- ]mindeststandard)\s*:?\s*$/i.test(value) ||
    /^(kritische systeme\/services kurz verifizieren|waehrend der arbeit|aenderungen in kleinen, nachvollziehbaren schritten|vor riskanten aenderungen:\s*backup\/checkpoint)\b/i.test(
      value
    ) ||
    /^(<!--\s*bot_profile_(start|end)\s*-->)$/i.test(value)
  );
}

function stripForcedLeadPrefix(text) {
  let value = String(text || "").trim();
  for (let i = 0; i < 6; i += 1) {
    const next = value
      .replace(/^(kurzfassung|zusammenfassung)\s*:\s*/i, "")
      .replace(/^(i(?:ck|ch)\s+sach\s+ma|nu\s+pass\s+uff)\s*:\s*/i, "")
      .trimStart();
    if (next === value) break;
    value = next;
  }
  return value.trim();
}

function collapseBlankLines(lines) {
  const out = [];
  for (const raw of lines) {
    const line = String(raw || "").replace(/\s+$/g, "");
    if (!line.trim()) {
      if (!out.length || !out[out.length - 1]) continue;
      out.push("");
      continue;
    }
    out.push(line);
  }
  while (out.length && !out[0]) out.shift();
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

function isLikelyComplexPrompt(prompt) {
  const text = String(prompt || "").trim().toLowerCase();
  if (!text) return false;
  if (text.length >= 180) return true;
  const complexHint =
    /\b(plan|analyse|analysiere|debug|ursache|warum|vergleich|strategie|architektur|implement|konzept|komplex|detaill|schritt|p0|p1|p2)\b/i;
  if (complexHint.test(text)) return true;
  const questionMarks = (text.match(/\?/g) || []).length;
  return questionMarks >= 2;
}

function compactSimpleOutput(lines, maxLines, maxChars) {
  const filtered = lines.filter((line) => String(line || "").trim());
  const lineLimited = filtered.slice(0, Math.max(1, Number(maxLines) || 1));
  let text = lineLimited.join("\n").trim();
  const cap = Math.max(80, Number(maxChars) || 0);
  if (text.length <= cap) return text;
  const hard = text.slice(0, Math.max(0, cap - 3));
  const cut = hard.lastIndexOf(" ");
  const clipped = cut > 60 ? hard.slice(0, cut) : hard;
  return `${clipped.trim()}...`;
}

function normalizeTurnOutput(rawOutput, options = {}) {
  const source = normalizeWhitespace(rawOutput);
  const prompt = String(options.prompt || "");
  const maxLines = options.maxLines;
  const maxChars = options.maxChars;
  if (!source.trim()) return "";

  const lines = source.split("\n").map((line) => String(line || "").replace(/\s+$/g, ""));
  const cleaned = [];
  let firstContentHandled = false;
  let droppingTemplateBlock = false;

  for (const rawLine of lines) {
    let line = String(rawLine || "");
    if (!line.trim()) {
      cleaned.push("");
      droppingTemplateBlock = false;
      continue;
    }

    if (isPersonalityLeakLine(line)) {
      droppingTemplateBlock = true;
      continue;
    }
    if (droppingTemplateBlock) {
      if (/^[-*]\s+/.test(line) || /^(aufgabe|verhalten|output[- ]format|engineering[- ]regeln|test[- ]mindeststandard)\s*:?\s*$/i.test(line.trim())) {
        continue;
      }
      droppingTemplateBlock = false;
    }
    if (isPrefixOnlyLine(line)) continue;
    if (!firstContentHandled) {
      line = stripForcedLeadPrefix(line);
      if (!line) continue;
      firstContentHandled = true;
    }
    cleaned.push(line);
  }

  const collapsed = collapseBlankLines(cleaned);
  if (!collapsed.length) return "";

  const hasTextLine = collapsed.some((line) => {
    const trimmed = String(line || "").trim();
    return trimmed && !isUrlOnlyLine(trimmed);
  });

  const withoutStandaloneUrls = hasTextLine ? collapsed.filter((line) => !isUrlOnlyLine(String(line || "").trim())) : collapsed.slice();
  const normalizedLines = collapseBlankLines(withoutStandaloneUrls);
  if (!normalizedLines.length) return "";

  if (isLikelyComplexPrompt(prompt)) {
    return normalizedLines.join("\n").trim();
  }
  return compactSimpleOutput(normalizedLines, maxLines, maxChars);
}

module.exports = {
  isLikelyComplexPrompt,
  normalizeTurnOutput,
};
