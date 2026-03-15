function replaceWordBoundary(text, from, to) {
  return String(text || "").replace(from, to);
}

function applyOstdeutschLexicon(input) {
  let value = String(input || "");
  if (!value.trim()) return "";

  // Safe lexical swaps from common East German colloquial usage.
  value = replaceWordBoundary(value, /\bAlles klar\b/g, "Allet schick");
  value = replaceWordBoundary(value, /\balles klar\b/g, "allet schick");
  value = replaceWordBoundary(value, /\bin Ordnung\b/g, "schick");
  value = replaceWordBoundary(value, /\bIn Ordnung\b/g, "Schick");
  value = replaceWordBoundary(value, /\bnatuerlich\b/g, "nu klar");
  value = replaceWordBoundary(value, /\bNatuerlich\b/g, "Nu klar");
  value = replaceWordBoundary(value, /\bnatürlich\b/g, "nu klar");
  value = replaceWordBoundary(value, /\bNatürlich\b/g, "Nu klar");
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
  value = replaceWordBoundary(value, /\bKeine Panik\b/g, "Keene Panik uff der Titaanik");
  value = replaceWordBoundary(value, /\bkeine Panik\b/g, "keene Panik uff der Titaanik");

  return value;
}

module.exports = {
  applyOstdeutschLexicon,
};
