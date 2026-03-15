const DIALECT_LEVELS = ["leicht", "mittel", "voll"];

function normalizeText(value) {
  return String(value || "").trim();
}

function replaceWordBoundary(text, from, to) {
  return String(text || "").replace(from, to);
}

function normalizeDialectLevel(level) {
  const value = String(level || "").trim().toLowerCase();
  if (DIALECT_LEVELS.includes(value)) return value;
  return "mittel";
}

function detectDialectLevel(promptText, outputText, options = {}) {
  const prompt = normalizeText(promptText).toLowerCase();
  const output = normalizeText(outputText).toLowerCase();
  const simpleMode = Boolean(options.simpleMode);

  const explicitNeutral = /\b(hochdeutsch|neutral|formell|ohne\s+dialekt)\b/i;
  if (explicitNeutral.test(prompt)) return "leicht";

  const explicitFull =
    /\b(ostdeutsch|dialekt|slang|schenni|berlinerisch|sächsisch|saechsisch|keck|frech|witzig|locker)\b/i;
  if (explicitFull.test(prompt)) return "voll";

  const highStakes =
    /\b(vertrag|gesetz|rechtlich|medizin|diagnose|medikament|steuer|finanzamt|kredit|investment|compliance)\b/i;
  if (highStakes.test(prompt)) return "leicht";

  const technical =
    /\b(code|coding|funktion|function|javascript|typescript|python|java|sql|regex|api|sdk|docker|kubernetes|k8s|tmux|terminal|shell|bash|zsh|git|branch|commit|ci|cd|debug|bug|error|stacktrace|exception|architektur|refactor|migration|pipeline)\b/i;
  if (technical.test(prompt) || /```/.test(output)) return "leicht";

  const complex =
    /\b(plan|analyse|analysiere|strategie|vergleich|konzept|schritt|maßnahmenplan|massnahmenplan|p0|p1|p2)\b/i;
  const questionCount = (prompt.match(/\?/g) || []).length;
  if (complex.test(prompt) || prompt.length > 220 || questionCount >= 2) return "leicht";

  const casualCreative = /\b(spruch|slogan|joke|witz|roast|smalltalk|meme)\b/i;
  if (casualCreative.test(prompt)) return "voll";

  if (simpleMode && prompt.length <= 120) return "mittel";
  return "mittel";
}

function applyOstdeutschLexicon(input, level = "mittel") {
  const normalizedLevel = normalizeDialectLevel(level);
  let value = normalizeText(input);
  if (!value) return "";
  if (normalizedLevel === "leicht") return value;

  // Medium baseline replacements.
  value = replaceWordBoundary(value, /\bAlles klar\b/g, "Allet schick");
  value = replaceWordBoundary(value, /\balles klar\b/g, "allet schick");
  value = replaceWordBoundary(value, /\bin Ordnung\b/g, "schick");
  value = replaceWordBoundary(value, /\bIn Ordnung\b/g, "Schick");
  value = replaceWordBoundary(value, /\bnatuerlich\b/g, "nü glar");
  value = replaceWordBoundary(value, /\bNatuerlich\b/g, "Nü glar");
  value = replaceWordBoundary(value, /\bnatürlich\b/g, "nü glar");
  value = replaceWordBoundary(value, /\bNatürlich\b/g, "Nü glar");
  value = replaceWordBoundary(value, /\bja\b/g, "nü glar");
  value = replaceWordBoundary(value, /\bJa\b/g, "Nü glar");
  value = replaceWordBoundary(value, /\bnein\b/g, "niet");
  value = replaceWordBoundary(value, /\bNein\b/g, "Niet");
  value = replaceWordBoundary(value, /\bnichts\b/g, "nüscht");
  value = replaceWordBoundary(value, /\bNichts\b/g, "Nüscht");
  value = replaceWordBoundary(value, /\bfrueh\b/g, "frieh");
  value = replaceWordBoundary(value, /\bFrueh\b/g, "Frieh");
  value = replaceWordBoundary(value, /\bfrüh\b/g, "frieh");
  value = replaceWordBoundary(value, /\bFrüh\b/g, "Frieh");
  value = replaceWordBoundary(value, /\babends\b/g, "oabsch");
  value = replaceWordBoundary(value, /\bAbends\b/g, "Oabsch");
  value = replaceWordBoundary(value, /\bKopf\b/g, "Nischl");
  value = replaceWordBoundary(value, /\bkopf\b/g, "nischl");
  value = replaceWordBoundary(value, /\bbelegtes Brot\b/g, "Bemme");
  value = replaceWordBoundary(value, /\bBelegtes Brot\b/g, "Bemme");
  value = replaceWordBoundary(value, /\bGartenhaus\b/g, "Datsche");
  value = replaceWordBoundary(value, /\bgartenhaus\b/g, "Datsche");

  if (normalizedLevel === "voll") {
    value = replaceWordBoundary(value, /\bKeine Panik\b/g, "Keene Panik uff der Titaanik");
    value = replaceWordBoundary(value, /\bkeine Panik\b/g, "keene Panik uff der Titaanik");
    value = replaceWordBoundary(value, /\bUnd\b/g, "Un");
    value = replaceWordBoundary(value, /\bund\b/g, "un");
    value = replaceWordBoundary(value, /\bNicht\b/g, "Nich");
    value = replaceWordBoundary(value, /\bnicht\b/g, "nich");
    value = replaceWordBoundary(value, /\bJetzt\b/g, "Nu");
    value = replaceWordBoundary(value, /\bjetzt\b/g, "nu");
    value = replaceWordBoundary(value, /\bVielleicht\b/g, "Vllt");
    value = replaceWordBoundary(value, /\bvielleicht\b/g, "vllt");
  }

  return value;
}

module.exports = {
  applyOstdeutschLexicon,
  detectDialectLevel,
  normalizeDialectLevel,
};
