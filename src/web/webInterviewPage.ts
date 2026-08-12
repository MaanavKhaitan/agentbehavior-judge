/**
 * The single-file page served by the web interview server (the `generate`
 * default, with or without `--update`).
 *
 * All interview state arrives over SSE (`GET /events`) and answers go back as
 * JSON (`POST /answer`, `POST /back`); the page holds no knowledge of
 * interview order — it renders whatever step the server pushes. Dynamic text
 * is inserted through DOM APIs (never innerHTML), so spec quotes and
 * trajectory content cannot inject markup.
 *
 * Editing is local-first: "Save description" re-renders the card with the new
 * text, and only the card's primary button submits the answer (as an
 * edit-kind answer when a local edit is pending).
 *
 * The embedded script deliberately avoids backticks and "${" so this file can
 * hold it in one template literal without escape noise.
 */
export const INTERVIEW_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>behavior-judge — interview</title>
<style>
  :root {
    --bg: #faf8ef;
    --card: #ffffff;
    --line: #e9e6d7;
    --line-soft: #f0eee1;
    --ink: #22221c;
    --muted: #71706a;
    --faint: #9b9a92;
    --green-bg: #ddf3d4;
    --green-line: #b6e0a6;
    --green-ink: #285c1e;
    --slate-bg: #eceff3;
    --slate-line: #d5dbe3;
    --slate-ink: #3d4653;
    --red-bg: #fbe5e0;
    --red-line: #f0bfb4;
    --red-ink: #93321f;
    --violet-bg: #ece7fb;
    --violet-line: #d4c9f2;
    --violet-ink: #4b3396;
    --amber-bg: #faf1d3;
    --amber-line: #e9d795;
    --amber-ink: #7a5c10;
    --code-bg: #22261f;
    --code-ink: #e9e7dc;
    --code-dim: #8f9b87;
    --code-str: #d8c184;
    --code-key: #93b7c9;
    --spring: cubic-bezier(0.3, 1.35, 0.4, 1);
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }

  .shell {
    max-width: 760px;
    margin: 0 auto;
    padding: 40px 20px 72px;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .masthead { text-align: center; margin-bottom: 30px; }
  .kicker {
    font-size: 12px;
    font-weight: 500;
    color: var(--faint);
  }
  .masthead-title {
    margin-top: 6px;
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .progress {
    margin: 18px auto 0;
    width: min(420px, 80%);
    height: 4px;
    border-radius: 99px;
    background: var(--line);
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    width: 3%;
    border-radius: 99px;
    background: var(--ink);
    transition: width 0.6s var(--spring);
  }

  .stage { position: relative; flex: 1; }

  .card-host { display: grid; }
  .card-host > * { grid-area: 1 / 1; }

  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 22px;
    padding: 32px 36px 30px;
    box-shadow: 0 1px 2px rgba(35, 35, 28, 0.04), 0 18px 44px -18px rgba(35, 35, 28, 0.16);
    max-width: 640px;
    margin: 0 auto;
    width: 100%;
  }

  @keyframes cardIn {
    from { opacity: 0; transform: translateY(30px) scale(0.975); }
    to { opacity: 1; transform: none; }
  }
  @keyframes cardInBack {
    from { opacity: 0; transform: translateY(-24px) scale(0.975); }
    to { opacity: 1; transform: none; }
  }
  .card-enter { animation: cardIn 0.5s var(--spring) both; }
  .card-enter-back { animation: cardInBack 0.5s var(--spring) both; }
  .card.no-anim, .card.no-anim * { animation: none !important; }
  .card-exit {
    opacity: 0;
    transform: translateY(-14px) scale(0.985);
    transition: opacity 0.16s ease, transform 0.16s ease;
    pointer-events: none;
  }

  .step-kicker {
    font-size: 12.5px;
    font-weight: 550;
    color: var(--faint);
  }
  .card h2 {
    margin: 10px 0 4px;
    font-size: 22px;
    line-height: 1.32;
    font-weight: 700;
    letter-spacing: -0.015em;
  }
  .card h2.h2-quote {
    font-style: italic;
    font-weight: 600;
    font-size: 19px;
  }
  .badges { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 99px;
    border: 1px solid var(--slate-line);
    background: var(--slate-bg);
    color: var(--slate-ink);
  }
  .badge::before { content: ""; width: 6px; height: 6px; border-radius: 99px; background: currentColor; opacity: 0.7; }
  .badge-red { background: var(--red-bg); border-color: var(--red-line); color: var(--red-ink); }
  .badge-violet { background: var(--violet-bg); border-color: var(--violet-line); color: var(--violet-ink); }
  .badge-green { background: var(--green-bg); border-color: var(--green-line); color: var(--green-ink); }

  .lead { font-size: 16.5px; line-height: 1.55; margin: 14px 0 0; }
  .lead.editable-view { white-space: pre-wrap; }

  .hint-line { margin: 10px 0 0; font-size: 13px; line-height: 1.5; color: var(--muted); }

  .rail { display: flex; align-items: center; gap: 8px; margin: 20px 0 0; }
  .rail-node {
    font-size: 12px;
    font-weight: 650;
    padding: 3.5px 12px;
    border-radius: 99px;
    border: 1px solid var(--line);
    color: var(--faint);
    background: transparent;
  }
  .rail-node.rail-active-green { background: var(--green-bg); border-color: var(--green-line); color: var(--green-ink); }
  .rail-node.rail-active-dark { background: var(--ink); border-color: var(--ink); color: #ffffff; }
  .rail-node.rail-done { border-color: var(--green-line); color: var(--green-ink); }
  .rail-arrow { color: var(--faint); font-size: 13px; }

  .zone {
    margin-top: 20px;
    border-radius: 16px;
    border: 1px solid var(--line);
    padding: 18px 18px 24px;
  }
  .zone-trigger { background: #f1f8ec; border-color: #d7eac9; }
  .zone-check { background: #f7f5ec; }
  .zone-semantic { background: #f4f0fb; border-color: #ddd2f3; }
  .zone .lead { margin-top: 0; }
  .zone .badges { margin-top: 0; }
  .zone .section-label { margin: 18px 0 10px; }
  .zone .diagram { margin-top: 18px; }
  .zone .evidence { margin-top: 26px; }
  .zone .quote { margin-top: 0; background: transparent; border-radius: 0; }
  .zone .badges + .quote { margin-top: 12px; }
  .zone .edit-area { margin-top: 0; }
  .zone .section-label:first-child { margin-top: 0; }
  .zone + .zone { margin-top: 14px; }

  .quote {
    margin: 18px 0 0;
    padding: 12px 18px;
    border-left: 3px solid var(--ink);
    background: var(--line-soft);
    border-radius: 0 12px 12px 0;
  }
  .quote-label {
    font-size: 11.5px;
    font-weight: 550;
    color: var(--faint);
  }
  .quote-text { font-style: italic; font-size: 15.5px; margin-top: 3px; }

  .section-label {
    margin: 22px 0 10px;
    font-size: 12px;
    font-weight: 550;
    color: var(--faint);
  }
  .section-label.label-tight { margin: 16px 0 0; }

  .chip-group { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .chip {
    border-radius: 12px;
    padding: 8px 14px;
    border: 1px solid var(--green-line);
    background: var(--green-bg);
    color: var(--green-ink);
  }
  .chip-plain { border-color: var(--slate-line); background: var(--slate-bg); color: var(--slate-ink); }
  .chip-red { border-color: var(--red-line); background: var(--red-bg); color: var(--red-ink); }
  .chip-title { font-weight: 650; font-size: 14.5px; letter-spacing: -0.005em; }
  .chip-sub { font-size: 12px; opacity: 0.85; margin-top: 1px; }
  .chip-or {
    font-size: 11.5px;
    font-weight: 550;
    color: var(--faint);
  }
  @keyframes chipIn {
    from { opacity: 0; transform: translateY(8px) scale(0.94); }
    to { opacity: 1; transform: none; }
  }
  .chip, .chip-or { animation: chipIn 0.45s var(--spring) both; }

  .diagram {
    margin-top: 14px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .diagram-row { display: flex; align-items: center; gap: 10px; }
  .diagram-tag {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--faint);
    min-width: 44px;
  }
  .connector {
    display: flex;
    flex-direction: column;
    align-items: center;
    margin: 4px 0 4px 26px;
  }
  .connector-line { width: 2px; height: 12px; background: var(--line); border-radius: 2px; }
  .connector-label {
    margin: 4px 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    background: var(--line-soft);
    border: 1px solid var(--line);
    padding: 2px 10px;
    border-radius: 99px;
    white-space: nowrap;
  }
  .connector-arrow {
    width: 0; height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-top: 6px solid var(--line);
    margin-top: -1px;
  }
  .diagram-caption { margin-top: 10px; font-size: 13.5px; color: var(--muted); font-weight: 550; }
  .diagram-caption.red { color: var(--red-ink); }
  .after-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 12px;
    padding: 8px 12px;
    border: 1px dashed var(--line);
    border-radius: 12px;
  }

  .evidence {
    margin-top: 18px;
    background: var(--code-bg);
    border-radius: 14px;
    padding: 14px 18px 15px;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--code-ink);
    overflow-x: auto;
  }
  .evidence-head {
    font-family: var(--sans);
    font-size: 11.5px;
    font-weight: 550;
    color: var(--code-dim);
    margin-bottom: 8px;
  }
  .ev-row { display: flex; gap: 12px; align-items: baseline; padding: 3px 0; }
  .ev-row + .ev-row { border-top: 1px solid rgba(255, 255, 255, 0.07); margin-top: 6px; padding-top: 9px; }
  .ev-role {
    flex: none;
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 550;
    color: var(--code-dim);
    min-width: 68px;
  }
  .ev-body { min-width: 0; }
  .ev-actor { color: var(--code-dim); }
  .ev-action { color: var(--code-ink); font-weight: 600; }
  .ev-sep { color: var(--code-dim); padding: 0 6px; }
  .ev-content { color: var(--code-str); word-break: break-word; }
  .ev-meta { color: var(--code-key); }
  .ev-meta b { color: var(--code-ink); font-weight: 600; }
  .ev-none { color: var(--code-dim); font-style: italic; }
  .ev-none.ok { color: #9fd28f; font-style: normal; }

  .warn {
    margin-top: 16px;
    background: var(--amber-bg);
    border: 1px solid var(--amber-line);
    border-radius: 14px;
    padding: 12px 16px;
    color: var(--amber-ink);
    font-size: 13.5px;
    line-height: 1.5;
  }
  .warn b { font-weight: 700; }
  .warn code, .warn-body code {
    font-family: var(--mono);
    font-size: 12px;
    background: rgba(122, 92, 16, 0.12);
    padding: 1px 5px;
    border-radius: 5px;
  }

  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 30px; }
  .btn {
    appearance: none;
    font: inherit;
    font-size: 14.5px;
    font-weight: 600;
    padding: 11px 20px;
    border-radius: 13px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink);
    cursor: pointer;
    transition: transform 0.16s var(--spring), box-shadow 0.16s ease, background 0.16s ease,
      border-color 0.16s ease, color 0.16s ease;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 16px -8px rgba(35, 35, 28, 0.3); }
  .btn:active { transform: scale(0.97); }
  .btn-primary { background: var(--ink); border-color: var(--ink); color: #ffffff; }
  .btn-primary:hover { background: #3a3a30; }
  .btn-danger:hover { border-color: var(--red-line); background: var(--red-bg); color: var(--red-ink); }
  body.busy .btn { opacity: 0.55; pointer-events: none; }

  .edit-area {
    margin-top: 14px;
    width: 100%;
    font: inherit;
    font-size: 16px;
    line-height: 1.5;
    padding: 12px 14px;
    border-radius: 13px;
    border: 1.5px solid var(--ink);
    background: var(--card);
    color: var(--ink);
    resize: vertical;
    min-height: 76px;
    outline: none;
    box-shadow: 0 0 0 4px rgba(34, 34, 28, 0.06);
  }
  input.edit-area { min-height: 0; }
  .edit-hint { margin-top: 8px; font-size: 12px; color: var(--faint); }

  .back {
    position: absolute;
    top: 26px;
    left: calc(50% - 320px - 70px);
    width: 46px;
    height: 46px;
    border-radius: 99px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 1px 2px rgba(35, 35, 28, 0.05), 0 8px 20px -10px rgba(35, 35, 28, 0.2);
    transition: transform 0.16s var(--spring), box-shadow 0.16s ease, color 0.16s ease;
    z-index: 2;
  }
  .back:hover { transform: translateX(-2px); color: var(--ink); }
  .back:active { transform: scale(0.94); }
  .back svg { display: block; }
  .back[hidden] { display: none; }
  @media (max-width: 820px) {
    .back { position: static; margin: 0 auto 14px; }
    .stage { display: flex; flex-direction: column; }
  }

  .summary-list { margin-top: 18px; display: flex; flex-direction: column; gap: 10px; }
  details.summary-row {
    border: 1px solid var(--line);
    border-radius: 14px;
    overflow: hidden;
  }
  details.summary-row > summary {
    list-style: none;
    cursor: pointer;
    padding: 13px 44px 13px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    position: relative;
    user-select: none;
  }
  details.summary-row > summary::-webkit-details-marker { display: none; }
  details.summary-row > summary::after {
    content: "\\203A";
    position: absolute;
    right: 20px;
    top: 12px;
    font-size: 18px;
    color: var(--faint);
    transform: rotate(90deg);
    transition: transform 0.2s var(--spring);
  }
  details.summary-row[open] > summary::after { transform: rotate(-90deg); }
  details.summary-row > summary:hover { background: var(--line-soft); }
  .summary-name { font-weight: 650; font-size: 14.5px; }
  .summary-sub { font-size: 13px; color: var(--muted); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .summary-pill {
    font-size: 11.5px;
    font-weight: 650;
    border-radius: 99px;
    padding: 1.5px 9px;
    background: var(--green-bg);
    border: 1px solid var(--green-line);
    color: var(--green-ink);
  }
  .summary-pill.violet { background: var(--violet-bg); border-color: var(--violet-line); color: var(--violet-ink); }
  .summary-pill.amber { background: var(--amber-bg); border-color: var(--amber-line); color: var(--amber-ink); }
  .summary-pill.slate { background: var(--slate-bg); border-color: var(--slate-line); color: var(--slate-ink); }
  .all-clear {
    margin-top: 16px;
    background: var(--green-bg);
    border: 1px solid var(--green-line);
    border-radius: 14px;
    padding: 12px 16px;
    color: var(--green-ink);
    font-size: 13.5px;
    line-height: 1.5;
  }
  .all-clear b { font-weight: 700; }
  .removed-line { margin: 14px 0 0; font-size: 13px; color: var(--red-ink); }
  .rule-detail {
    border-top: 1px solid var(--line-soft);
    padding: 11px 16px 13px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .rule-line { display: flex; gap: 8px; font-size: 13px; align-items: baseline; }
  .mini-tag {
    flex: none;
    font-size: 10.5px;
    font-weight: 650;
    padding: 1px 8px;
    border-radius: 99px;
    background: var(--slate-bg);
    border: 1px solid var(--slate-line);
    color: var(--slate-ink);
  }
  .mini-tag.green { background: var(--green-bg); border-color: var(--green-line); color: var(--green-ink); }
  .mini-tag.violet { background: var(--violet-bg); border-color: var(--violet-line); color: var(--violet-ink); }
  .rule-line-text { color: var(--muted); line-height: 1.45; }
  .carried-list {
    margin-top: 18px;
    border: 1px solid var(--line);
    border-top: 1px solid var(--line);
    border-radius: 14px;
  }

  details.yaml { margin-top: 18px; }
  details.yaml summary {
    cursor: pointer;
    font-size: 13.5px;
    font-weight: 600;
    color: var(--muted);
    user-select: none;
  }
  details.yaml summary:hover { color: var(--ink); }
  details.yaml pre {
    margin: 10px 0 0;
    background: var(--code-bg);
    color: var(--code-ink);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    border-radius: 14px;
    padding: 16px 18px;
    overflow-x: auto;
    max-height: 340px;
    overflow-y: auto;
  }
  .save-target { margin-top: 16px; font-size: 13px; color: var(--muted); }
  .save-target code {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--line-soft);
    border: 1px solid var(--line);
    padding: 2px 7px;
    border-radius: 7px;
    color: var(--ink);
  }

  .center-card { text-align: center; padding-top: 44px; padding-bottom: 44px; }
  .center-card h2 { margin-top: 18px; }
  .center-sub { color: var(--muted); font-size: 14.5px; max-width: 400px; margin: 8px auto 0; }

  .dots { display: inline-flex; gap: 7px; }
  .dots span {
    width: 9px; height: 9px; border-radius: 99px; background: var(--ink); opacity: 0.25;
    animation: dotPulse 1.2s infinite ease-in-out;
  }
  .dots span:nth-child(2) { animation-delay: 0.15s; }
  .dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes dotPulse {
    0%, 100% { opacity: 0.2; transform: translateY(0); }
    40% { opacity: 0.9; transform: translateY(-5px); }
  }

  .done-mark {
    width: 64px; height: 64px; margin: 0 auto;
    border-radius: 99px;
    background: var(--green-bg);
    border: 1.5px solid var(--green-line);
    color: var(--green-ink);
    display: flex; align-items: center; justify-content: center;
    animation: markIn 0.6s var(--spring) both;
  }
  .done-mark.red { background: var(--red-bg); border-color: var(--red-line); color: var(--red-ink); }
  @keyframes markIn {
    from { opacity: 0; transform: scale(0.4); }
    to { opacity: 1; transform: scale(1); }
  }

  .error-detail {
    margin-top: 14px;
    font-family: var(--mono);
    font-size: 12.5px;
    color: var(--red-ink);
    background: var(--red-bg);
    border: 1px solid var(--red-line);
    border-radius: 12px;
    padding: 10px 14px;
    text-align: left;
    word-break: break-word;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <div class="kicker">behavior-judge</div>
    <div class="masthead-title" id="behaviorName">&nbsp;</div>
    <div class="progress" aria-hidden="true"><div class="progress-fill" id="progressFill"></div></div>
  </header>
  <main class="stage">
    <button class="back" id="backBtn" type="button" aria-label="Go back to the previous step" hidden>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"></path></svg>
    </button>
    <div class="card-host" id="cardHost"></div>
  </main>
</div>
<script>
'use strict';

var TOKEN = new URLSearchParams(location.search).get('token') || '';
var current = null;
var lastRevision = -1;
var busy = false;
// Text saved via "Save description"/"Save question"/"Save name" but not yet
// submitted: shown in place of the server value until the primary button
// sends it as an edit-kind answer. Reset on every server snapshot.
var pendingEdit = null;

// ---------- tiny DOM helpers ----------

function el(tag, cls, children) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (children != null) {
    (Array.isArray(children) ? children : [children]).forEach(function (child) {
      if (child == null) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
  }
  return node;
}

// Renders text where segments wrapped in backticks become <code>.
function inline(text) {
  var span = el('span');
  text.split('\\u0060').forEach(function (part, index) {
    span.appendChild(index % 2 === 1 ? el('code', null, part) : document.createTextNode(part));
  });
  return span;
}

// ---------- natural-language rendering of matchers ----------

var ACRONYMS = { url: 1, api: 1, id: 1, http: 1, https: 1, html: 1, json: 1, ai: 1, llm: 1, sql: 1, ui: 1, io: 1 };

function humanizeSlug(slug) {
  var words = slug.split(/[_\\-.]+/).filter(Boolean).map(function (word) {
    var lower = word.toLowerCase();
    return ACRONYMS[lower] ? lower.toUpperCase() : lower;
  });
  if (words.length === 0) return slug;
  if (words[0] === words[0].toLowerCase()) {
    words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  }
  return words.join(' ');
}

var ACTOR_PHRASE = { agent: 'the agent', tool: 'a tool', user: 'the user' };

function matcherChip(matcher, tone) {
  var chip = el('div', 'chip' + (tone === 'plain' ? ' chip-plain' : tone === 'red' ? ' chip-red' : ''));
  var title = matcher.action
    ? humanizeSlug(matcher.action)
    : matcher.contentIncludes
      ? 'Any event'
      : matcher.actor
        ? 'Any event by ' + (ACTOR_PHRASE[matcher.actor] || matcher.actor)
        : 'Any event';
  chip.appendChild(el('div', 'chip-title', title));
  var subs = [];
  if (matcher.action && matcher.actor) subs.push('by ' + (ACTOR_PHRASE[matcher.actor] || matcher.actor));
  if (matcher.contentIncludes) subs.push('mentioning \\u201C' + matcher.contentIncludes + '\\u201D');
  if (matcher.metadata) {
    Object.keys(matcher.metadata).forEach(function (key) {
      subs.push(key + ' = ' + matcher.metadata[key]);
    });
  }
  if (subs.length > 0) chip.appendChild(el('div', 'chip-sub', subs.join(' \\u00B7 ')));
  return chip;
}

function patternGroup(pattern, tone) {
  var list = Array.isArray(pattern) ? pattern : [pattern];
  var group = el('div', 'chip-group');
  var delay = 0;
  list.forEach(function (matcher, index) {
    if (index > 0) {
      var or = el('span', 'chip-or', 'or');
      or.style.animationDelay = delay + 'ms';
      group.appendChild(or);
    }
    var chip = matcherChip(matcher, tone);
    chip.style.animationDelay = delay + 'ms';
    delay += 60;
    group.appendChild(chip);
  });
  return group;
}

// ---------- check visuals ----------

function connector(label) {
  return el('div', 'connector', [
    el('div', 'connector-line'),
    el('div', 'connector-label', label),
    el('div', 'connector-line'),
    el('div', 'connector-arrow'),
  ]);
}

function taggedRow(tag, pattern, tone) {
  return el('div', 'diagram-row', [tag ? el('div', 'diagram-tag', tag) : null, patternGroup(pattern, tone)]);
}

function countCaption(check) {
  var bounds;
  if (check.min != null && check.max != null) {
    bounds = check.min === check.max ? 'exactly ' + check.min : 'between ' + check.min + ' and ' + check.max;
  } else if (check.min != null) {
    bounds = 'at least ' + check.min;
  } else {
    bounds = 'at most ' + check.max;
  }
  var times = (check.min != null && check.max == null ? check.min : check.max) === 1 ? 'time' : 'times';
  var caption = 'must happen ' + bounds + ' ' + times;
  if (check.distinctBy === 'content') {
    caption += ', counting distinct contents';
  } else if (check.distinctBy) {
    caption += ', counting distinct \\u201C' + check.distinctBy.slice('metadata.'.length) + '\\u201D values';
  }
  return caption;
}

function checkDiagram(check) {
  var wrap = el('div', 'diagram');
  if (check.type === 'ordering') {
    wrap.appendChild(taggedRow('First', check.first, 'green'));
    wrap.appendChild(connector('must come before'));
    wrap.appendChild(taggedRow('Then', check.before, 'plain'));
    return wrap;
  }
  if (check.type === 'pairing') {
    wrap.appendChild(taggedRow('Each', check.each, 'green'));
    wrap.appendChild(connector('must be followed by'));
    wrap.appendChild(taggedRow('', check.followedBy, 'plain'));
    return wrap;
  }
  if (check.after) {
    wrap.appendChild(el('div', 'after-strip', ['Only applies after the first:', patternGroup(check.after, 'plain')]));
  }
  wrap.appendChild(patternGroup(check.match, check.type === 'forbidden' ? 'red' : 'green'));
  var caption =
    check.type === 'required' ? 'must appear at least once'
    : check.type === 'forbidden' ? 'must never appear'
    : countCaption(check);
  wrap.appendChild(el('div', 'diagram-caption' + (check.type === 'forbidden' ? ' red' : ''), caption));
  return wrap;
}

var CHECK_BADGE = {
  ordering: { label: 'Order matters', cls: '' },
  pairing: { label: 'Must be paired', cls: '' },
  required: { label: 'Must happen', cls: '' },
  forbidden: { label: 'Never allowed', cls: ' badge-red' },
  count: { label: 'Count limit', cls: '' },
};

// ---------- evidence ----------

var ROLE_LABEL = { first: 'First', before: 'Then', each: 'Each', followedBy: 'Then', match: 'Event', after: 'After' };

function evidencePanel(entries) {
  var panel = el('div', 'evidence');
  panel.appendChild(el('div', 'evidence-head', 'Example \\u2014 a matching event from one of your sample runs'));
  var showRoles = entries.length > 1;
  entries.forEach(function (entry) {
    var row = el('div', 'ev-row');
    if (showRoles) row.appendChild(el('div', 'ev-role', ROLE_LABEL[entry.role] || entry.role));
    var body = el('div', 'ev-body');
    if (entry.sample) {
      body.appendChild(el('div', 'ev-line1', [
        el('span', 'ev-actor', entry.sample.actor),
        el('span', 'ev-sep', '\\u00B7'),
        el('span', 'ev-action', entry.sample.action),
      ]));
      if (entry.sample.content) {
        body.appendChild(el('div', 'ev-content', '\\u201C' + entry.sample.content + '\\u201D'));
      }
      Object.keys(entry.sample.metadata || {}).forEach(function (key) {
        var meta = el('div', 'ev-meta');
        meta.appendChild(document.createTextNode(key + ': '));
        meta.appendChild(el('b', null, entry.sample.metadata[key]));
        body.appendChild(meta);
      });
    } else if (entry.noMatchIsExpected) {
      body.appendChild(el('div', 'ev-none ok', '\\u2713 never appears in your samples \\u2014 exactly what this check wants'));
    } else {
      body.appendChild(el('div', 'ev-none', 'no matching event in your samples'));
    }
    row.appendChild(body);
    panel.appendChild(row);
  });
  return panel;
}

function warningBox(unobserved) {
  if (!unobserved || unobserved.length === 0) return null;
  var box = el('div', 'warn');
  var title = el('div', 'warn-title');
  title.appendChild(el('b', null, 'Not seen in your samples. '));
  box.appendChild(title);
  var body = el('span', 'warn-body');
  body.appendChild(document.createTextNode('This references '));
  unobserved.forEach(function (item, index) {
    if (index > 0) body.appendChild(document.createTextNode(index === unobserved.length - 1 ? ' and ' : ', '));
    body.appendChild(inline(item));
  });
  body.appendChild(document.createTextNode(
    ' that never appears in your sample runs. Keep it only if your agent\\u2019s instrumentation records that event.'
  ));
  title.appendChild(body);
  return box;
}

// ---------- shared card scaffolding ----------

function kickerText(step) {
  if (step.kind === 'name') return 'Name your rules \\u00B7 ' + (step.index + 1) + ' of ' + step.count;
  if (step.kind === 'confirm') {
    return step.update && !step.update.hasChanges
      ? 'Final step \\u00B7 Nothing changed'
      : 'Final step \\u00B7 Review and save';
  }
  var p = step.position;
  var where = 'Rule ' + (p.metaIndex + 1) + ' of ' + p.metaCount;
  if (step.kind === 'trigger') return where;
  if (step.kind === 'changedTrigger') return where + ' \\u00B7 Trigger changed';
  if (step.kind === 'carriedBatch') return where + ' \\u00B7 Carried clauses';
  if (step.kind === 'check') return where + ' \\u00B7 Check ' + (p.itemIndex + 1) + ' of ' + p.itemCount;
  return where + ' \\u00B7 Semantic check ' + (p.itemIndex + 1) + ' of ' + p.itemCount;
}

// Amber callout on a card the update flow re-asks after a spec edit.
function reAskBox(reason) {
  if (!reason) return null;
  var box = el('div', 'warn');
  var title = el('div', 'warn-title');
  title.appendChild(el('b', null, 'This clause needs re-review after your spec edit. '));
  title.appendChild(document.createTextNode(reason));
  box.appendChild(title);
  return box;
}

function actionButton(label, kind, onClick) {
  var btn = el('button', 'btn' + (kind === 'primary' ? ' btn-primary' : kind === 'danger' ? ' btn-danger' : ''), label);
  btn.type = 'button';
  if (kind === 'primary') btn.dataset.primary = '1';
  btn.addEventListener('click', onClick);
  return btn;
}

function quoteBlock(quote) {
  return el('div', 'quote', [
    el('div', 'quote-label', 'From your spec'),
    el('div', 'quote-text', '\\u201C' + quote + '\\u201D'),
  ]);
}

// Where this card sits inside the rule: the trigger gates the checks.
function ruleRail(stage) {
  var rail = el('div', 'rail');
  rail.title = 'The trigger gates the rule: runs that never match it skip the checks entirely.';
  rail.appendChild(el('span', 'rail-node' + (stage === 'trigger' ? ' rail-active-green' : ' rail-done'),
    stage === 'trigger' ? 'Trigger' : '\\u2713 Trigger'));
  rail.appendChild(el('span', 'rail-arrow', '\\u2192'));
  rail.appendChild(el('span', 'rail-node' + (stage === 'checks' ? ' rail-active-dark' : ''), 'Checks'));
  return rail;
}

// Swaps one text element for an edit field. Saving stores the text locally
// and instantly re-renders the card (no entrance animation); the primary
// button submits it with the answer.
function enterEdit(card, options) {
  var area = el(options.multiline === false ? 'input' : 'textarea', 'edit-area');
  area.value = options.value;
  var save = actionButton(options.saveLabel, 'primary', function () {
    pendingEdit = area.value;
    render(current, 'none');
  });
  var cancel = actionButton('Cancel', '', function () {
    render(current, 'none');
  });
  var actions = el('div', 'actions', [save, cancel]);
  options.slot.replaceWith(area);
  card.querySelector('.actions').replaceWith(actions);
  actions.appendChild(el('div', 'edit-hint', 'Press Esc to cancel'));
  area.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && (options.multiline === false || event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      pendingEdit = area.value;
      render(current, 'none');
    }
    if (event.key === 'Escape') render(current, 'none');
  });
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}

// ---------- card builders ----------

function loadingCard() {
  var card = el('article', 'card center-card', [
    el('div', 'dots', [el('span'), el('span'), el('span')]),
    el('h2', null, 'Drafting your judge\\u2026'),
    el('p', 'center-sub', 'Reading your behavior spec and matching every rule against your sample runs. This usually takes under a minute.'),
  ]);
  return card;
}

function nameCard(state) {
  var step = state.step;
  var name = pendingEdit != null ? pendingEdit : step.name;
  var card = el('article', 'card');
  card.appendChild(el('div', 'step-kicker', kickerText(step)));
  var title = el('h2', null, name);
  card.appendChild(title);
  card.appendChild(el('p', 'lead', 'Your spec has no section headings, so this rule name was proposed from its text. You can keep it, rename it, or drop the rule entirely.'));
  card.appendChild(el('div', 'actions', [
    actionButton('Keep this name', 'primary', function () {
      send(pendingEdit != null ? { kind: 'rename', name: pendingEdit } : { kind: 'keep' });
    }),
    actionButton('Rename', '', function () {
      enterEdit(card, { slot: title, value: name, multiline: false, saveLabel: 'Save name' });
    }),
    actionButton('Drop this rule', 'danger', function () { send({ kind: 'drop' }); }),
  ]));
  return card;
}

function triggerCard(state) {
  var step = state.step;
  var description = pendingEdit != null ? pendingEdit : step.description;
  var card = el('article', 'card');
  card.appendChild(el('div', 'step-kicker', kickerText(step)));
  card.appendChild(el('h2', null, step.metaName));
  card.appendChild(ruleRail('trigger'));
  var reAsk = reAskBox(step.reAskReason);
  if (reAsk) card.appendChild(reAsk);

  var zone = el('div', 'zone zone-trigger');
  var lead = el('p', 'lead editable-view', description);
  zone.appendChild(lead);
  if (step.semantic) {
    zone.appendChild(el('p', 'hint-line', 'No event pattern can detect this reliably, so the judge model reads each run and decides whether the rule applies.'));
  } else {
    zone.appendChild(el('div', 'section-label', 'Fires on'));
    zone.appendChild(patternGroup(step.match, 'green'));
    if (step.evidence) zone.appendChild(evidencePanel([step.evidence]));
  }
  card.appendChild(zone);

  var warn = warningBox(step.unobserved);
  if (warn) card.appendChild(warn);

  var buttons = [
    actionButton('Keep this trigger', 'primary', function () {
      send(pendingEdit != null ? { kind: 'edit', description: pendingEdit } : { kind: 'accept' });
    }),
  ];
  if (!step.semantic) {
    buttons.push(actionButton('Move to semantic trigger', '', function () { send({ kind: 'forceSemantic' }); }));
  }
  buttons.push(actionButton('Edit description', '', function () {
    enterEdit(card, { slot: lead, value: description, saveLabel: 'Save description' });
  }));
  card.appendChild(el('div', 'actions', buttons));
  return card;
}

function checkCard(state) {
  var step = state.step;
  var check = step.check;
  var card = el('article', 'card');
  card.appendChild(el('div', 'step-kicker', kickerText(step)));
  card.appendChild(el('div', 'section-label label-tight', 'From your spec'));
  card.appendChild(el('h2', 'h2-quote', '\\u201C' + check.quote + '\\u201D'));
  card.appendChild(ruleRail('checks'));
  var reAsk = reAskBox(step.reAskReason);
  if (reAsk) card.appendChild(reAsk);

  var zone = el('div', 'zone zone-check');
  var badge = CHECK_BADGE[check.type] || { label: check.type, cls: '' };
  var badges = el('div', 'badges');
  badges.appendChild(el('span', 'badge' + badge.cls, badge.label));
  badges.appendChild(el('span', 'badge badge-green', 'Checked deterministically'));
  zone.appendChild(badges);
  zone.appendChild(checkDiagram(check));
  zone.appendChild(evidencePanel(step.evidence));
  card.appendChild(zone);

  var warn = warningBox(step.unobserved);
  if (warn) card.appendChild(warn);
  card.appendChild(el('div', 'actions', [
    actionButton('Keep this check', 'primary', function () { send({ kind: 'accept' }); }),
    actionButton('Move to semantic check', '', function () { send({ kind: 'demote' }); }),
    actionButton('Skip it', 'danger', function () { send({ kind: 'drop' }); }),
  ]));
  return card;
}

function semanticCard(state) {
  var step = state.step;
  var question = pendingEdit != null ? pendingEdit : step.question;
  var card = el('article', 'card');
  card.appendChild(el('div', 'step-kicker', kickerText(step)));
  card.appendChild(el('div', 'section-label label-tight', 'The judge model will be asked'));
  var title = el('h2', null, question);
  card.appendChild(title);
  card.appendChild(ruleRail('checks'));
  var reAsk = reAskBox(step.reAskReason);
  if (reAsk) card.appendChild(reAsk);

  var zone = el('div', 'zone zone-semantic');
  if (step.demoted) {
    var badges = el('div', 'badges');
    badges.appendChild(el('span', 'badge', 'Converted from a deterministic check'));
    zone.appendChild(badges);
  }
  zone.appendChild(quoteBlock(step.quote));
  card.appendChild(zone);

  card.appendChild(el('div', 'actions', [
    actionButton('Keep this check', 'primary', function () {
      send(pendingEdit != null ? { kind: 'edit', question: pendingEdit } : { kind: 'accept' });
    }),
    actionButton('Edit the question', '', function () {
      enterEdit(card, { slot: title, value: question, saveLabel: 'Save question' });
    }),
    actionButton('Skip it', 'danger', function () { send({ kind: 'drop' }); }),
  ]));
  return card;
}

// Update flow: the spec edit changed the trigger; previous vs proposed.
function changedTriggerCard(state) {
  var step = state.step;
  var description = pendingEdit != null ? pendingEdit : step.proposed.description;
  var card = el('article', 'card');
  card.appendChild(el('div', 'step-kicker', kickerText(step)));
  card.appendChild(el('h2', null, step.metaName));
  card.appendChild(el('p', 'lead', 'Your spec edit changed when this rule applies. Keep the proposed trigger, or stay with the one you approved before?'));

  var prevZone = el('div', 'zone');
  prevZone.appendChild(el('div', 'section-label', 'Previous trigger'));
  prevZone.appendChild(el('p', 'lead', step.previous.description));
  if (step.previous.semantic) {
    prevZone.appendChild(el('p', 'hint-line', 'Semantic: the judge model decides whether the rule applies.'));
  } else {
    prevZone.appendChild(el('div', 'section-label', 'Fires on'));
    prevZone.appendChild(patternGroup(step.previous.match, 'plain'));
  }
  card.appendChild(prevZone);

  var zone = el('div', 'zone zone-trigger');
  zone.appendChild(el('div', 'section-label', 'Proposed trigger'));
  var lead = el('p', 'lead editable-view', description);
  zone.appendChild(lead);
  if (step.proposed.semantic) {
    zone.appendChild(el('p', 'hint-line', 'No event pattern can detect this reliably, so the judge model reads each run and decides whether the rule applies.'));
  } else {
    zone.appendChild(el('div', 'section-label', 'Fires on'));
    zone.appendChild(patternGroup(step.proposed.match, 'green'));
    if (step.evidence) zone.appendChild(evidencePanel([step.evidence]));
  }
  card.appendChild(zone);

  var warn = warningBox(step.unobserved);
  if (warn) card.appendChild(warn);

  var buttons = [
    actionButton('Keep proposed trigger', 'primary', function () {
      send(pendingEdit != null ? { kind: 'edit', description: pendingEdit } : { kind: 'accept' });
    }),
    actionButton('Keep previous trigger', '', function () { send({ kind: 'keepPrevious' }); }),
  ];
  if (!step.proposed.semantic) {
    buttons.push(actionButton('Move to semantic trigger', '', function () { send({ kind: 'forceSemantic' }); }));
  }
  buttons.push(actionButton('Edit description', '', function () {
    enterEdit(card, { slot: lead, value: description, saveLabel: 'Save description' });
  }));
  card.appendChild(el('div', 'actions', buttons));
  return card;
}

// Update flow: clauses whose spec sentences survived the edit unchanged.
function carriedBatchCard(state) {
  var step = state.step;
  var card = el('article', 'card');
  card.appendChild(el('div', 'step-kicker', kickerText(step)));
  card.appendChild(el('h2', null, step.metaName));
  card.appendChild(el('p', 'lead', step.items.length === 1
    ? 'Your spec edit didn\\u2019t change this clause. It can stay exactly as you approved it.'
    : 'Your spec edit didn\\u2019t change these clauses. They can stay exactly as you approved them.'));

  var list = el('div', 'rule-detail carried-list');
  step.items.forEach(function (item) {
    if (item.kind === 'trigger') {
      list.appendChild(el('div', 'rule-line', [
        el('span', 'mini-tag green', item.trigger.semantic ? 'semantic trigger' : 'trigger'),
        el('span', 'rule-line-text', item.trigger.description),
      ]));
    } else if (item.kind === 'check') {
      list.appendChild(el('div', 'rule-line', [
        el('span', 'mini-tag', item.type),
        el('span', 'rule-line-text', '\\u201C' + item.quote + '\\u201D'),
      ]));
    } else {
      list.appendChild(el('div', 'rule-line', [
        el('span', 'mini-tag violet', 'semantic'),
        el('span', 'rule-line-text', item.question),
      ]));
    }
  });
  card.appendChild(list);

  card.appendChild(el('div', 'actions', [
    actionButton(step.items.length === 1 ? 'Keep this clause' : 'Keep all ' + step.items.length, 'primary', function () { send({ kind: 'keep' }); }),
    actionButton('Review individually', '', function () { send({ kind: 'review' }); }),
  ]));
  return card;
}

var STATUS_PILL = {
  unchanged: { label: 'unchanged', cls: ' slate' },
  changed: { label: 'updated', cls: ' amber' },
  added: { label: 'new', cls: '' },
};

function updateLead(update) {
  var parts = [];
  if (update.changed > 0) parts.push(update.changed + ' updated');
  if (update.added > 0) parts.push(update.added + ' new');
  if (update.removed.length > 0) parts.push(update.removed.length + ' removed');
  parts.push(update.unchanged + ' unchanged');
  return 'What your spec edit did to your rules: ' + parts.join(' \\u00B7 ') + '. Expand a rule to see exactly what it checks.';
}

function confirmCard(state) {
  var step = state.step;
  var update = step.update;
  var noChanges = update && !update.hasChanges;
  var card = el('article', 'card');
  card.appendChild(el('div', 'step-kicker', kickerText(step)));
  card.appendChild(el('h2', null, noChanges ? 'Your judge is already up to date' : 'Review and save your judge'));

  if (noChanges) {
    var clear = el('div', 'all-clear');
    clear.appendChild(el('b', null, 'Nothing to re-review. '));
    clear.appendChild(document.createTextNode(
      'All ' + update.unchanged + ' spec sections still match the judge you already approved, so there were no questions to ask. Saving keeps the rules exactly as they are.'
    ));
    card.appendChild(clear);
  } else if (update) {
    card.appendChild(el('p', 'lead', updateLead(update)));
  } else {
    card.appendChild(el('p', 'lead', 'Every rule below is bound to the event vocabulary from your sample runs. Expand a rule to see exactly what it checks.'));
  }

  var list = el('div', 'summary-list');
  step.summary.forEach(function (meta, index) {
    var row = el('details', 'summary-row');
    if (index === 0) row.open = true;
    var head = el('summary', null);
    head.appendChild(el('div', 'summary-name', meta.name));
    var sub = el('div', 'summary-sub');
    if (meta.status && STATUS_PILL[meta.status]) {
      var status = STATUS_PILL[meta.status];
      sub.appendChild(el('span', 'summary-pill' + status.cls, status.label));
    }
    if (meta.checkCount > 0) {
      sub.appendChild(el('span', 'summary-pill', meta.checkCount + ' deterministic'));
    }
    if (meta.semanticCheckCount > 0) {
      sub.appendChild(el('span', 'summary-pill violet', meta.semanticCheckCount + ' semantic'));
    }
    head.appendChild(sub);
    row.appendChild(head);

    var detail = el('div', 'rule-detail');
    detail.appendChild(el('div', 'rule-line', [
      el('span', 'mini-tag green', meta.semanticTrigger ? 'semantic trigger' : 'trigger'),
      el('span', 'rule-line-text', meta.triggerDescription),
    ]));
    (meta.checks || []).forEach(function (check) {
      detail.appendChild(el('div', 'rule-line', [
        el('span', 'mini-tag', check.type),
        el('span', 'rule-line-text', '\\u201C' + check.quote + '\\u201D'),
      ]));
    });
    (meta.semanticChecks || []).forEach(function (check) {
      detail.appendChild(el('div', 'rule-line', [
        el('span', 'mini-tag violet', 'semantic'),
        el('span', 'rule-line-text', check.question),
      ]));
    });
    row.appendChild(detail);
    list.appendChild(row);
  });
  card.appendChild(list);

  if (update && update.removed.length > 0) {
    var removedLine = el('p', 'removed-line');
    removedLine.appendChild(el('b', null, 'Removed: '));
    removedLine.appendChild(document.createTextNode(
      update.removed.join(', ') + ' \\u2014 their sections no longer appear in the spec.'
    ));
    card.appendChild(removedLine);
  }

  var details = el('details', 'yaml');
  details.appendChild(el('summary', null, 'View the raw judge.yaml'));
  details.appendChild(el('pre', null, step.yaml));
  card.appendChild(details);

  var target = el('div', 'save-target');
  target.appendChild(document.createTextNode('Will be written to '));
  target.appendChild(el('code', null, step.outPath));
  card.appendChild(target);

  card.appendChild(el('div', 'actions', [
    actionButton('Save judge.yaml', 'primary', function () { send({ kind: 'save' }); }),
    actionButton('Cancel without saving', 'danger', function () { send({ kind: 'cancel' }); }),
  ]));
  return card;
}

function doneCard(state) {
  var card = el('article', 'card center-card');
  if (state.written) {
    card.appendChild(el('div', 'done-mark', el('span', null, '\\u2713')));
    card.appendChild(el('h2', null, 'Your judge is saved'));
    var target = el('div', 'save-target');
    target.appendChild(el('code', null, state.written));
    card.appendChild(target);
    card.appendChild(el('p', 'center-sub', 'You can close this tab and return to your terminal. Check the file into your repo next to BEHAVIOR.md.'));
  } else {
    card.appendChild(el('div', 'done-mark red', el('span', null, '\\u00D7')));
    card.appendChild(el('h2', null, 'Nothing was written'));
    card.appendChild(el('p', 'center-sub', 'You cancelled the final confirmation. Re-run behavior-judge generate to start over.'));
  }
  return card;
}

function errorCard(state) {
  var card = el('article', 'card center-card');
  card.appendChild(el('div', 'done-mark red', el('span', null, '!')));
  card.appendChild(el('h2', null, 'Something went wrong'));
  card.appendChild(el('div', 'error-detail', state.message));
  card.appendChild(el('p', 'center-sub', 'Details are in your terminal. Fix the problem and re-run behavior-judge generate.'));
  return card;
}

// ---------- state plumbing ----------

function buildCard(state) {
  if (state.type === 'loading') return loadingCard();
  if (state.type === 'done') return doneCard(state);
  if (state.type === 'error') return errorCard(state);
  var kind = state.step.kind;
  if (kind === 'name') return nameCard(state);
  if (kind === 'trigger') return triggerCard(state);
  if (kind === 'changedTrigger') return changedTriggerCard(state);
  if (kind === 'carriedBatch') return carriedBatchCard(state);
  if (kind === 'check') return checkCard(state);
  if (kind === 'semanticCheck') return semanticCard(state);
  return confirmCard(state);
}

function progressFraction(state) {
  if (state.type === 'loading') return 0.03;
  if (state.type !== 'step') return 1;
  var step = state.step;
  if (step.kind === 'name') return 0.04 + 0.06 * (step.index / Math.max(1, step.count));
  if (step.kind === 'confirm') return 0.96;
  var p = step.position;
  var within = 0.12;
  if (step.kind === 'check') within = 0.2 + 0.5 * (p.itemIndex / Math.max(1, p.itemCount));
  if (step.kind === 'semanticCheck') within = 0.7 + 0.28 * (p.itemIndex / Math.max(1, p.itemCount));
  return 0.1 + 0.86 * ((p.metaIndex + within) / Math.max(1, p.metaCount));
}

// direction: 'forward' | 'back' pick the entrance animation; 'none' swaps the
// card in place with no motion (used when an in-card edit is saved/cancelled).
function render(state, direction) {
  var host = document.getElementById('cardHost');
  var old = host.firstElementChild;
  if (direction === 'none') {
    if (old) old.remove();
  } else if (old) {
    old.classList.add('card-exit');
    setTimeout(function () { old.remove(); }, 180);
  }
  var card = buildCard(state);
  card.classList.add(direction === 'none' ? 'no-anim' : direction === 'back' ? 'card-enter-back' : 'card-enter');
  host.appendChild(card);

  var backBtn = document.getElementById('backBtn');
  backBtn.hidden = !(state.type === 'step' && state.canGoBack);
  document.getElementById('progressFill').style.width = (progressFraction(state) * 100).toFixed(1) + '%';
}

function handle(snapshot) {
  if (snapshot.revision === lastRevision) return;
  lastRevision = snapshot.revision;
  document.getElementById('behaviorName').textContent = humanizeSlug(snapshot.behavior);
  document.title = 'behavior-judge \\u2014 ' + snapshot.behavior;
  var direction = 'forward';
  if (snapshot.state.type === 'step' && current && current.type === 'step' &&
      snapshot.state.stepId <= current.stepId) {
    direction = 'back';
  }
  busy = false;
  document.body.classList.remove('busy');
  pendingEdit = null;
  current = snapshot.state;
  render(current, direction);
}

function post(pathname, body) {
  if (busy) return;
  busy = true;
  document.body.classList.add('busy');
  fetch(pathname + '?token=' + encodeURIComponent(TOKEN), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).catch(function () {}).then(function () {
    // The SSE snapshot re-enables the page; this is a fallback for rejected posts.
    setTimeout(function () { busy = false; document.body.classList.remove('busy'); }, 400);
  });
}

function send(answer) {
  if (!current || current.type !== 'step') return;
  post('answer', { stepId: current.stepId, answer: answer });
}

document.getElementById('backBtn').addEventListener('click', function () {
  if (current && current.type === 'step' && current.canGoBack) post('back');
});

document.addEventListener('keydown', function (event) {
  if (event.key !== 'Enter') return;
  var tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON') return;
  var primary = document.querySelector('#cardHost .btn[data-primary]');
  if (primary) primary.click();
});

render({ type: 'loading' }, 'forward');

var source = new EventSource('events?token=' + encodeURIComponent(TOKEN));
source.onmessage = function (message) {
  try {
    handle(JSON.parse(message.data));
  } catch (error) {
    // Ignore malformed frames; the next snapshot re-syncs the page.
  }
};
</script>
</body>
</html>
`;
