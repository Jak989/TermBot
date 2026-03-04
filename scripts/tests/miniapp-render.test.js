"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const render = require("../../public/telegram-miniapp/render.js");

test("renders headings, paragraphs and lists", () => {
  const input = [
    "## Antwort",
    "",
    "Das ist ein kurzer Text.",
    "",
    "- Punkt eins",
    "- Punkt zwei",
  ].join("\n");

  const html = render.renderAnswerHtml(input);
  assert.match(html, /<h2 class="answer-h">Antwort<\/h2>/);
  assert.match(html, /<p class="answer-p">Das ist ein kurzer Text\.<\/p>/);
  assert.match(html, /<ul class="answer-list">/);
  assert.match(html, /<li>Punkt eins<\/li>/);
});

test("renders fenced code blocks as escaped code", () => {
  const input = ["```js", "const a = \"<tag>\";", "```"].join("\n");
  const html = render.renderAnswerHtml(input);
  assert.match(html, /<pre class="answer-code" data-lang="js"><code>/);
  assert.match(html, /const a = &quot;&lt;tag&gt;&quot;;/);
});

test("escapes dangerous html", () => {
  const html = render.renderAnswerHtml("<script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("renders key value rows", () => {
  const input = ["state: done", "runtime: 1m 12s"].join("\n");
  const html = render.renderAnswerHtml(input);
  assert.match(html, /<dl class="answer-kv">/);
  assert.match(html, /<dt>state<\/dt><dd>done<\/dd>/);
});
