const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTurnOutput } = require("../lib/chat-output");

test("simple weather output removes forced headers and URL-only lines", () => {
  const prompt = "wie wird das wetter morgen in obersendling";
  const raw = ["Kurzfassung:", "Ick sach ma: Morgen in Obersendling 8-14C, leicht bewoelkt.", "https://example.com/wetter"].join(
    "\n"
  );
  const out = normalizeTurnOutput(raw, { prompt, maxLines: 4, maxChars: 220 });
  assert.equal(out, "Morgen in Obersendling 8-14C, leicht bewoelkt.");
});

test("simple factual output strips forced lead phrase", () => {
  const prompt = "wie viele ecken hat ein rechteck";
  const raw = "Ick sach ma: Ein Rechteck hat 4 Ecken.";
  const out = normalizeTurnOutput(raw, { prompt, maxLines: 4, maxChars: 220 });
  assert.equal(out, "Ein Rechteck hat 4 Ecken.");
});

test("complex prompts keep multi-line structure", () => {
  const prompt = "Gib mir einen P0-P2 Maßnahmenplan mit konkreten Schritten und Risiken.";
  const raw = ["Kurzfassung:", "P0: Output-Extraktion fixen", "P1: Prompt-Fallback haerten", "P2: Telemetrie erweitern"].join(
    "\n"
  );
  const out = normalizeTurnOutput(raw, { prompt, maxLines: 2, maxChars: 60 });
  assert.match(out, /P0:/);
  assert.match(out, /P2:/);
});

test("simple prompts are compacted by line/char limits", () => {
  const prompt = "was soll ich morgen anziehen";
  const raw = ["Ick sach ma: 1) Shirt", "2) Hemd", "3) Jacke", "4) Schirm", "5) Schuhe"].join("\n");
  const out = normalizeTurnOutput(raw, { prompt, maxLines: 3, maxChars: 120 });
  assert.equal(out, ["1) Shirt", "2) Hemd", "3) Jacke"].join("\n"));
});

test("nested forced prefixes are removed from first content line", () => {
  const prompt = "kurze antwort bitte";
  const raw = "Nu pass uff: Kurzfassung: Ick sach ma: passt, wird erledigt.";
  const out = normalizeTurnOutput(raw, { prompt, maxLines: 4, maxChars: 220 });
  assert.equal(out, "passt, wird erledigt.");
});

test("personality template leak lines are stripped completely", () => {
  const prompt = "muenchen";
  const raw = ["### B) Projektmanager", "Aufgabe:", "- Plant Projekte in Meilensteine."].join("\n");
  const out = normalizeTurnOutput(raw, { prompt, maxLines: 4, maxChars: 220 });
  assert.equal(out, "");
});

test("legitimate project manager sentence is preserved", () => {
  const prompt = "was macht ein projektmanager";
  const raw = "Ein Projektmanager plant Projekte, priorisiert Aufgaben und steuert Risiken.";
  const out = normalizeTurnOutput(raw, { prompt, maxLines: 4, maxChars: 220 });
  assert.equal(out, raw);
});

test("progress meta lines are removed from final chat output", () => {
  const prompt = "morgen in obersendling";
  const raw = [
    "Ich pruefe das Wetter fuer Obersendling fuer morgen und ziehe die konkreten Daten direkt rein.",
    "— Worked for 1m 11s",
    "______________________________________",
    "Morgen wird's in Obersendling kuehl: tagsueber um 8 C, nachts bis -2 C.",
  ].join("\n");
  const out = normalizeTurnOutput(raw, { prompt, maxLines: 4, maxChars: 220 });
  assert.equal(out, "Morgen wird's in Obersendling kuehl: tagsueber um 8 C, nachts bis -2 C.");
});
