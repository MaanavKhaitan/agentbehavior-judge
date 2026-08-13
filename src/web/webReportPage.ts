/**
 * The single-file page served by the web report server (the `judge` default).
 *
 * Shares the interview page's visual language (same palette, cards, tags,
 * evidence panels) but renders judge results instead of asking questions.
 * State arrives over SSE (`GET /events`); when the final report snapshot
 * lands, the page closes its stream and posts `/ack` so the CLI can exit.
 * Judgments are append-only across snapshots, so cards render incrementally
 * and never re-render — expanding a rule mid-judging is never undone.
 *
 * All dynamic text is inserted through DOM APIs (never innerHTML), so spec
 * quotes and trajectory content cannot inject markup. The embedded script
 * deliberately avoids backticks and "${" so this file can hold it in one
 * template literal without escape noise.
 */
export const REPORT_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>behavior-judge — report</title>
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
  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    font-size: 17px;
    font-weight: 650;
    letter-spacing: -0.01em;
    color: var(--slate-ink);
  }
  .brand svg { display: block; }
  .brand-tag {
    margin-left: 2px;
    font-size: 10.5px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    padding: 4px 10px;
    border-radius: 99px;
    background: var(--slate-bg);
    border: 1px solid var(--slate-line);
  }
  .masthead-title {
    margin-top: 10px;
    font-size: 14px;
    font-weight: 500;
    color: var(--muted);
  }
  .stats {
    margin-top: 12px;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    min-height: 26px;
  }
  .stat-total { font-size: 13px; color: var(--muted); }
  .progress {
    margin: 14px auto 0;
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

  .stage { flex: 1; display: flex; flex-direction: column; gap: 18px; }

  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 22px;
    padding: 26px 30px 26px;
    box-shadow: 0 1px 2px rgba(35, 35, 28, 0.04), 0 18px 44px -18px rgba(35, 35, 28, 0.16);
    max-width: 680px;
    margin: 0 auto;
    width: 100%;
  }

  @keyframes cardIn {
    from { opacity: 0; transform: translateY(30px) scale(0.975); }
    to { opacity: 1; transform: none; }
  }
  .card-enter { animation: cardIn 0.5s var(--spring) both; }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 700;
    padding: 4px 13px;
    border-radius: 99px;
    border: 1px solid var(--slate-line);
    background: var(--slate-bg);
    color: var(--slate-ink);
    white-space: nowrap;
  }
  .pill::before { content: ""; width: 7px; height: 7px; border-radius: 99px; background: currentColor; opacity: 0.75; }
  .pill-pass { background: var(--green-bg); border-color: var(--green-line); color: var(--green-ink); }
  .pill-fail { background: var(--red-bg); border-color: var(--red-line); color: var(--red-ink); }
  .pill-sm { font-size: 11px; padding: 2px 10px; }

  .run-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
  .run-id {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.3;
    word-break: break-word;
  }
  .run-desc { margin-top: 3px; font-size: 13.5px; color: var(--muted); }
  .run-head .pill { margin-top: 2px; }

  .warn {
    margin-top: 14px;
    background: var(--amber-bg);
    border: 1px solid var(--amber-line);
    border-radius: 14px;
    padding: 10px 16px;
    color: var(--amber-ink);
    font-size: 13px;
    line-height: 1.5;
  }
  .warn b { font-weight: 700; }

  .empty-note { margin: 14px 0 0; font-size: 13.5px; color: var(--muted); }

  .summary-list { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
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
    gap: 5px;
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
  .summary-name-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .summary-name { font-weight: 650; font-size: 14.5px; line-height: 1.35; }
  .summary-sub { font-size: 12.5px; color: var(--muted); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .summary-pill {
    font-size: 11.5px;
    font-weight: 650;
    border-radius: 99px;
    padding: 1.5px 9px;
    background: var(--green-bg);
    border: 1px solid var(--green-line);
    color: var(--green-ink);
  }
  .summary-pill.red { background: var(--red-bg); border-color: var(--red-line); color: var(--red-ink); }
  .summary-pill.slate { background: var(--slate-bg); border-color: var(--slate-line); color: var(--slate-ink); }

  .rule-detail {
    border-top: 1px solid var(--line-soft);
    padding: 14px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .trigger-line { display: flex; gap: 8px; font-size: 13px; align-items: baseline; }
  .mini-tag {
    flex: none;
    font-size: 10.5px;
    font-weight: 650;
    padding: 1px 8px;
    border-radius: 99px;
    background: var(--slate-bg);
    border: 1px solid var(--slate-line);
    color: var(--slate-ink);
    white-space: nowrap;
  }
  .mini-tag.green { background: var(--green-bg); border-color: var(--green-line); color: var(--green-ink); }
  .mini-tag.violet { background: var(--violet-bg); border-color: var(--violet-line); color: var(--violet-ink); }
  .mini-tag.red { background: var(--red-bg); border-color: var(--red-line); color: var(--red-ink); }
  .trigger-text { color: var(--muted); line-height: 1.45; }
  .trigger-note { font-size: 13px; color: var(--muted); line-height: 1.45; }

  .clause {
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 12px 14px 13px;
    background: #fdfcf7;
  }
  .clause.clause-fail { border-color: var(--red-line); background: #fdf6f4; }
  .clause-top { display: flex; gap: 10px; align-items: baseline; }
  .clause-mark { flex: none; font-size: 14px; font-weight: 700; width: 18px; text-align: center; }
  .clause-mark.pass { color: var(--green-ink); }
  .clause-mark.fail { color: var(--red-ink); }
  .clause-mark.na { color: var(--faint); }
  .clause-quote { font-style: italic; font-size: 14px; line-height: 1.5; }
  .clause-tags { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 0 28px; }
  .clause-note { margin: 8px 0 0 28px; font-size: 13px; line-height: 1.5; color: var(--muted); }
  .clause-note.amber { color: var(--amber-ink); }
  .clause-note.violet { color: var(--violet-ink); }
  .clause-reason { margin: 8px 0 0 28px; font-size: 13px; line-height: 1.5; color: var(--muted); }
  .clause-reason b { font-weight: 650; color: var(--ink); }
  .clause .evidence { margin: 10px 0 0 28px; }

  .evidence {
    background: var(--code-bg);
    border-radius: 14px;
    padding: 12px 16px 13px;
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
  .ev-id {
    flex: none;
    font-size: 11px;
    color: var(--code-dim);
    min-width: 64px;
    word-break: break-all;
  }
  .ev-body { min-width: 0; }
  .ev-actor { color: var(--code-dim); }
  .ev-action { color: var(--code-ink); font-weight: 600; }
  .ev-sep { color: var(--code-dim); padding: 0 6px; }
  .ev-content { color: var(--code-str); word-break: break-word; }
  .ev-meta { color: var(--code-key); }
  .ev-meta b { color: var(--code-ink); font-weight: 600; }
  .ev-desc { font-family: var(--sans); font-size: 12px; color: var(--code-dim); margin-top: 2px; }
  .ev-more { font-family: var(--sans); font-size: 12px; color: var(--code-dim); margin-top: 8px; font-style: italic; }

  .center-card { text-align: center; padding-top: 40px; padding-bottom: 40px; }
  .center-card h2 { margin: 18px 0 0; font-size: 20px; font-weight: 700; letter-spacing: -0.015em; }
  .center-sub { color: var(--muted); font-size: 14px; max-width: 420px; margin: 8px auto 0; }

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
    background: var(--red-bg);
    border: 1.5px solid var(--red-line);
    color: var(--red-ink);
    display: flex; align-items: center; justify-content: center;
    animation: markIn 0.6s var(--spring) both;
  }
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

  .foot-note {
    text-align: center;
    font-size: 12.5px;
    color: var(--faint);
    padding: 10px 0 0;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<div class="shell">
  <header class="masthead">
    <div class="brand">
      <svg width="30" height="30" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="4" cy="4" r="2" fill="#3a4551"></circle>
        <circle cx="20" cy="4" r="2" fill="#3a4551"></circle>
        <circle cx="4" cy="20" r="2" fill="#3a4551"></circle>
        <circle cx="20" cy="20" r="2" fill="#3a4551"></circle>
        <rect x="8.5" y="2.4" width="7" height="3.2" rx="1.6" fill="#85a377"></rect>
        <rect x="8.5" y="18.4" width="7" height="3.2" rx="1.6" fill="#85a377"></rect>
        <rect x="2.4" y="8.5" width="3.2" height="7" rx="1.6" fill="#a89a8c"></rect>
        <rect x="18.4" y="8.5" width="3.2" height="7" rx="1.6" fill="#a89a8c"></rect>
        <circle cx="12" cy="12" r="5.6" fill="#85a377"></circle>
        <path d="M9.3 12.2l1.9 1.9 3.7-4.2" fill="none" stroke="#ffffff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
      <span>behavior-judge</span>
      <span class="brand-tag">Report</span>
    </div>
    <div class="masthead-title" id="behaviorName">&nbsp;</div>
    <div class="stats" id="stats"></div>
    <div class="progress" aria-hidden="true"><div class="progress-fill" id="progressFill"></div></div>
  </header>
  <main class="stage">
    <div class="stage" id="runList"></div>
    <div class="stage" id="tail"></div>
  </main>
</div>
<script>
'use strict';

var TOKEN = new URLSearchParams(location.search).get('token') || '';
var lastRevision = -1;
var renderedRuns = 0;
var acked = false;
var source = null;

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

// ---------- verdict language ----------

function verdictPill(verdict, naReason, small) {
  var cls = 'pill' + (small ? ' pill-sm' : '');
  if (verdict === 'true') return el('span', cls + ' pill-pass', 'Pass');
  if (verdict === 'false') return el('span', cls + ' pill-fail', 'Fail');
  var label = naReason === 'not_applicable' ? 'Didn\\u2019t apply' : 'No verdict';
  return el('span', cls, label);
}

function naSentence(naReason, complete) {
  if (naReason === 'not_applicable') return 'No verdict \\u2014 this didn\\u2019t apply to the run.';
  if (complete === false) {
    return 'No verdict \\u2014 the run was cut off before this could be decided.';
  }
  return 'No verdict \\u2014 not enough evidence in the run.';
}

var CHECK_LABEL = {
  ordering: 'Order matters',
  pairing: 'Needs a follow-up',
  required: 'Must happen',
  forbidden: 'Never allowed',
  count: 'Count limit',
};

var VERIFICATION_NOTE = {
  confirmed: 'The judge model double-checked this failure and confirmed it.',
  overturned: 'The event pattern flagged this, but the judge model read the run and overturned it.',
  unverified: 'Flagged by the event pattern alone \\u2014 no model was available to double-check.',
};

// ---------- evidence ----------

var EVIDENCE_ROW_MAX = 4;

function evidencePanel(citations, head) {
  var panel = el('div', 'evidence');
  panel.appendChild(el('div', 'evidence-head', head));
  citations.slice(0, EVIDENCE_ROW_MAX).forEach(function (citation) {
    var row = el('div', 'ev-row');
    row.appendChild(el('div', 'ev-id', citation.eventId));
    var body = el('div', 'ev-body');
    if (citation.event) {
      body.appendChild(el('div', null, [
        el('span', 'ev-actor', citation.event.actor),
        el('span', 'ev-sep', '\\u00B7'),
        el('span', 'ev-action', citation.event.action),
      ]));
      if (citation.event.content) {
        body.appendChild(el('div', 'ev-content', '\\u201C' + citation.event.content + '\\u201D'));
      }
      Object.keys(citation.event.metadata || {}).forEach(function (key) {
        var meta = el('div', 'ev-meta');
        meta.appendChild(document.createTextNode(key + ': '));
        meta.appendChild(el('b', null, citation.event.metadata[key]));
        body.appendChild(meta);
      });
    }
    if (citation.description) {
      body.appendChild(el('div', 'ev-desc', citation.description));
    }
    row.appendChild(body);
    panel.appendChild(row);
  });
  if (citations.length > EVIDENCE_ROW_MAX) {
    panel.appendChild(el('div', 'ev-more', '+ ' + (citations.length - EVIDENCE_ROW_MAX) + ' more events'));
  }
  return panel;
}

// ---------- clause rendering ----------

function clauseBlock(clause, runComplete) {
  var block = el('div', 'clause' + (clause.verdict === 'false' ? ' clause-fail' : ''));

  var markCls = clause.verdict === 'true' ? 'pass' : clause.verdict === 'false' ? 'fail' : 'na';
  var markChar = clause.verdict === 'true' ? '\\u2713' : clause.verdict === 'false' ? '\\u2717' : '\\u2014';
  block.appendChild(el('div', 'clause-top', [
    el('span', 'clause-mark ' + markCls, markChar),
    el('div', 'clause-quote', '\\u201C' + clause.quote + '\\u201D'),
  ]));

  var tags = el('div', 'clause-tags');
  if (clause.checkType && CHECK_LABEL[clause.checkType]) {
    tags.appendChild(el('span', 'mini-tag' + (clause.checkType === 'forbidden' ? ' red' : ''), CHECK_LABEL[clause.checkType]));
  }
  if (clause.kind === 'predicate') {
    tags.appendChild(el('span', 'mini-tag green', 'checked deterministically'));
  } else {
    tags.appendChild(el('span', 'mini-tag violet', 'judged by the model'));
  }
  block.appendChild(tags);

  if (clause.verdict === 'na') {
    block.appendChild(el('div', 'clause-note', naSentence(clause.naReason, runComplete)));
  }
  if (clause.verification && VERIFICATION_NOTE[clause.verification]) {
    var noteCls = clause.verification === 'unverified' ? ' amber' : ' violet';
    block.appendChild(el('div', 'clause-note' + noteCls, VERIFICATION_NOTE[clause.verification]));
  }
  if (clause.reasoning) {
    var reason = el('div', 'clause-reason');
    reason.appendChild(el('b', null, 'Model\\u2019s reasoning: '));
    reason.appendChild(document.createTextNode(clause.reasoning));
    block.appendChild(reason);
  }
  if (clause.citations.length > 0) {
    var modelCited = clause.kind === 'semantic' || clause.verification === 'overturned';
    block.appendChild(evidencePanel(
      clause.citations,
      modelCited ? 'Events the model cited' : 'Events that decided this check'
    ));
  }
  return block;
}

// ---------- rule (meta-behavior) rendering ----------

function metaSummarySub(meta, runComplete) {
  var sub = el('div', 'summary-sub');
  if (!meta.triggered) {
    var text = meta.naReason === 'not_applicable'
      ? 'Didn\\u2019t apply \\u2014 the situation never came up in this run.'
      : runComplete === false
        ? 'No verdict \\u2014 the run was cut off before this rule came up.'
        : 'No verdict \\u2014 not enough evidence that this rule applied.';
    sub.appendChild(document.createTextNode(text));
    return sub;
  }
  var passed = 0, failed = 0, undecided = 0;
  meta.clauses.forEach(function (clause) {
    if (clause.verdict === 'true') passed += 1;
    else if (clause.verdict === 'false') failed += 1;
    else undecided += 1;
  });
  if (passed > 0) sub.appendChild(el('span', 'summary-pill', passed + ' passed'));
  if (failed > 0) sub.appendChild(el('span', 'summary-pill red', failed + ' failed'));
  if (undecided > 0) sub.appendChild(el('span', 'summary-pill slate', undecided + ' no verdict'));
  return sub;
}

function metaRow(meta, runComplete) {
  var row = el('details', 'summary-row');
  if (meta.verdict === 'false') row.open = true;

  var head = el('summary', null);
  head.appendChild(el('div', 'summary-name-row', [
    el('span', 'summary-name', meta.name),
    verdictPill(meta.verdict, meta.naReason, true),
  ]));
  head.appendChild(metaSummarySub(meta, runComplete));
  row.appendChild(head);

  var detail = el('div', 'rule-detail');
  if (meta.triggerDescription) {
    detail.appendChild(el('div', 'trigger-line', [
      el('span', 'mini-tag green', 'applies when'),
      el('span', 'trigger-text', meta.triggerDescription),
    ]));
  }

  if (!meta.triggered) {
    var note = meta.naReason === 'not_applicable'
      ? 'This never happened in the run, so the rule\\u2019s checks were skipped.'
      : 'The run ended (or lacked events) before this could be decided, so the rule\\u2019s checks were skipped.';
    detail.appendChild(el('div', 'trigger-note', note));
    // A semantic trigger leaves one explanatory clause behind: show the
    // model's reasoning and citations, but not a redundant quote block.
    meta.clauses.forEach(function (clause) {
      if (clause.reasoning) {
        var reason = el('div', 'clause-reason');
        reason.style.margin = '0';
        reason.appendChild(el('b', null, 'Model\\u2019s reasoning: '));
        reason.appendChild(document.createTextNode(clause.reasoning));
        detail.appendChild(reason);
      }
      if (clause.citations.length > 0) {
        detail.appendChild(evidencePanel(clause.citations, 'Events the model cited'));
      }
    });
  } else {
    meta.clauses.forEach(function (clause) {
      detail.appendChild(clauseBlock(clause, runComplete));
    });
  }

  row.appendChild(detail);
  return row;
}

// ---------- run cards ----------

function runCard(judgment) {
  var card = el('article', 'card');

  var title = el('div', null);
  title.appendChild(el('div', 'run-id', judgment.trajectoryId));
  if (judgment.description) {
    title.appendChild(el('div', 'run-desc', judgment.description));
  }
  card.appendChild(el('div', 'run-head', [title, verdictPill(judgment.verdict, null, false)]));

  if (judgment.eventCount === 0) {
    card.appendChild(el('p', 'empty-note', 'This run contains no events, so nothing could be judged.'));
  } else if (judgment.complete === false) {
    var warn = el('div', 'warn');
    warn.appendChild(el('b', null, 'Incomplete run. '));
    warn.appendChild(document.createTextNode(
      'It was cut off before finishing, so missing evidence reads as \\u201Cno verdict\\u201D rather than a failure.'
    ));
    card.appendChild(warn);
  }

  var list = el('div', 'summary-list');
  judgment.metaBehaviors.forEach(function (meta) {
    list.appendChild(metaRow(meta, judgment.complete));
  });
  card.appendChild(list);
  return card;
}

// ---------- header, tail, and state plumbing ----------

function updateStats(state) {
  var stats = document.getElementById('stats');
  stats.textContent = '';
  // An error snapshot carries no judgments; an empty stats line beats a
  // "0 runs judged" that contradicts the run cards still rendered above.
  if (state.type === 'error') return;
  var judgments = state.judgments || [];
  if (state.type === 'judging') {
    stats.appendChild(el('span', 'stat-total', 'Judging run ' + (state.done + 1) + ' of ' + state.total + '\\u2026'));
    return;
  }
  var passed = 0, failed = 0, undecided = 0;
  judgments.forEach(function (judgment) {
    if (judgment.verdict === 'true') passed += 1;
    else if (judgment.verdict === 'false') failed += 1;
    else undecided += 1;
  });
  stats.appendChild(el('span', 'stat-total', judgments.length + (judgments.length === 1 ? ' run judged' : ' runs judged')));
  if (passed > 0) stats.appendChild(el('span', 'pill pill-sm pill-pass', passed + ' passed'));
  if (failed > 0) stats.appendChild(el('span', 'pill pill-sm pill-fail', failed + ' failed'));
  if (undecided > 0) stats.appendChild(el('span', 'pill pill-sm', undecided + ' no verdict'));
}

function judgingCard(state) {
  var card = el('article', 'card center-card card-enter', [
    el('div', 'dots', [el('span'), el('span'), el('span')]),
    el('h2', null, 'Judging ' + state.judgingId + '\\u2026'),
    el('p', 'center-sub', 'Run ' + (state.done + 1) + ' of ' + state.total + '. Deterministic checks are instant; semantic checks ask the judge model.'),
  ]);
  return card;
}

function errorCard(message) {
  var card = el('article', 'card center-card card-enter');
  card.appendChild(el('div', 'done-mark', el('span', null, '!')));
  card.appendChild(el('h2', null, 'Something went wrong'));
  card.appendChild(el('div', 'error-detail', message));
  card.appendChild(el('p', 'center-sub', 'Details are in your terminal. Fix the problem and re-run behavior-judge judge.'));
  return card;
}

function loadingCard() {
  return el('article', 'card center-card card-enter', [
    el('div', 'dots', [el('span'), el('span'), el('span')]),
    el('h2', null, 'Loading the report\\u2026'),
  ]);
}

function updateTail(state) {
  var tail = document.getElementById('tail');
  tail.textContent = '';
  if (state.type === 'loading') {
    tail.appendChild(loadingCard());
    return;
  }
  if (state.type === 'judging') {
    tail.appendChild(judgingCard(state));
    return;
  }
  if (state.type === 'error') {
    tail.appendChild(errorCard(state.message));
    return;
  }
  if ((state.judgments || []).length === 0) {
    tail.appendChild(el('p', 'foot-note', 'No runs were judged.'));
    return;
  }
  tail.appendChild(el('p', 'foot-note', 'A plain-text copy of this report is in your terminal. You can close this tab.'));
}

function appendNewRuns(judgments) {
  var list = document.getElementById('runList');
  for (; renderedRuns < judgments.length; renderedRuns += 1) {
    var card = runCard(judgments[renderedRuns]);
    card.classList.add('card-enter');
    list.appendChild(card);
  }
}

function progressFraction(state) {
  if (state.type === 'judging') {
    return state.total === 0 ? 0.03 : Math.max(0.03, state.done / state.total);
  }
  return 1;
}

function ackReport() {
  if (acked) return;
  acked = true;
  // Close the stream first: the server shuts down right after the ack, and a
  // live EventSource would keep retrying against the dead port.
  if (source) source.close();
  fetch('ack?token=' + encodeURIComponent(TOKEN), { method: 'POST' }).catch(function () {});
}

function handle(snapshot) {
  if (snapshot.revision === lastRevision) return;
  lastRevision = snapshot.revision;
  document.getElementById('behaviorName').textContent = humanizeSlug(snapshot.behavior);
  document.title = 'behavior-judge \\u2014 ' + snapshot.behavior;
  var state = snapshot.state;
  if (state.type !== 'error') {
    appendNewRuns(state.judgments || []);
  }
  updateStats(state);
  updateTail(state);
  // The bar tracks judging; once the report (or an error) lands it would just
  // sit there as a full-width rule, so it leaves with the work it measured.
  document.querySelector('.progress').style.display = state.type === 'judging' ? '' : 'none';
  document.getElementById('progressFill').style.width = (progressFraction(state) * 100).toFixed(1) + '%';
  if (state.type === 'report') ackReport();
}

updateTail({ type: 'loading' });

source = new EventSource('events?token=' + encodeURIComponent(TOKEN));
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
