const test = require("node:test");
const assert = require("node:assert/strict");
const { applyOstdeutschLexicon } = require("../lib/schenni-style");

test("maps common phrases to East German colloquial forms", () => {
  const input = "Alles klar, keine Panik. Das ist in Ordnung. Ja, natuerlich. Nein, nichts.";
  const out = applyOstdeutschLexicon(input);
  assert.match(out, /Allet schick/);
  assert.match(out, /keene Panik uff der Titaanik/i);
  assert.match(out, /\bschick\b/);
  assert.match(out, /\bNü glar\b|\bnü glar\b/);
  assert.match(out, /\bNiet\b|\bniet\b/);
  assert.match(out, /\bNüscht\b|\bnüscht\b/);
});

test("maps time words and body terms", () => {
  const input = "Morgens frueh und abends tut mein Kopf weh.";
  const out = applyOstdeutschLexicon(input);
  assert.match(out, /\bfrieh\b/);
  assert.match(out, /\boabsch\b/i);
  assert.match(out, /\bNischl\b|\bnischl\b/);
});

test("maps everyday nouns from provided examples", () => {
  const input = "Nimm ein belegtes Brot mit in das Gartenhaus.";
  const out = applyOstdeutschLexicon(input);
  assert.match(out, /\bBemme\b/);
  assert.match(out, /\bDatsche\b/);
});
