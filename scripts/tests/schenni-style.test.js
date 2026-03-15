const test = require("node:test");
const assert = require("node:assert/strict");
const { applyOstdeutschLexicon, detectDialectLevel } = require("../lib/schenni-style");

test("maps common phrases to East German colloquial forms", () => {
  const input = "Alles klar, keine Panik. Das ist in Ordnung. Ja, natuerlich. Nein, nichts.";
  const out = applyOstdeutschLexicon(input, "mittel");
  assert.match(out, /Allet schick/);
  assert.match(out, /\bschick\b/);
  assert.match(out, /\bNü glar\b|\bnü glar\b/);
  assert.match(out, /\bNiet\b|\bniet\b/);
  assert.match(out, /\bNüscht\b|\bnüscht\b/);
});

test("maps time words and body terms", () => {
  const input = "Morgens frueh und abends tut mein Kopf weh.";
  const out = applyOstdeutschLexicon(input, "mittel");
  assert.match(out, /\bfrieh\b/);
  assert.match(out, /\boabsch\b/i);
  assert.match(out, /\bNischl\b|\bnischl\b/);
});

test("maps everyday nouns from provided examples", () => {
  const input = "Nimm ein belegtes Brot mit in das Gartenhaus.";
  const out = applyOstdeutschLexicon(input, "mittel");
  assert.match(out, /\bBemme\b/);
  assert.match(out, /\bDatsche\b/);
});

test("keeps output neutral in level leicht", () => {
  const input = "Ja, nein, nichts. Alles klar.";
  const out = applyOstdeutschLexicon(input, "leicht");
  assert.equal(out, input);
});

test("adds stronger style only in level voll", () => {
  const input = "Keine Panik und nicht jetzt.";
  const out = applyOstdeutschLexicon(input, "voll");
  assert.match(out, /keene Panik uff der Titaanik/i);
  assert.match(out, /\bun\b/i);
  assert.match(out, /\bnich\b/i);
});

test("dialect level detection chooses leicht for technical prompts", () => {
  const level = detectDialectLevel("Erklaer den Unterschied zwischen Docker Image und Container", "", {
    simpleMode: true,
  });
  assert.equal(level, "leicht");
});

test("dialect level detection chooses voll when explicitly requested", () => {
  const level = detectDialectLevel("Antworte im ostdeutschen Dialekt, frech und keck", "", {
    simpleMode: true,
  });
  assert.equal(level, "voll");
});

test("dialect level detection defaults to mittel for everyday prompts", () => {
  const level = detectDialectLevel("Was soll ich morgen anziehen?", "", {
    simpleMode: true,
  });
  assert.equal(level, "mittel");
});
