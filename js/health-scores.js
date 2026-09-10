/* CareTracer - Health Scores page.
 *
 * Reads the connected record out of IndexedDB, runs the preprocessing pipeline
 * and the score module, and renders both panels from the result. Nothing on
 * this page is a fixed demo value any more: every number, band, trend arrow and
 * limitation note is computed from the resources actually on the device.
 *
 * Depends on store.js (plain script, window.CareTracerStore).
 */

import { buildTables } from "./pipeline/index.js";
import { computeScores, STATUS } from "./scores/index.js";

const DICT_BASE = "js/pipeline/dictionary/";

/* Card help text. The clinical explanation belongs with the page, not with the
 * score function, which should stay free of patient-facing prose. */
const HELP = {
  hba1c: "Hemoglobin A1c reflects your average blood sugar over the past 2 to 3 months. The general target for adults with diabetes is below 7%. For older adults with a history of low blood-sugar episodes, a target of 7.0 to 7.5% is often more appropriate.",
  egfr: "Estimated glomerular filtration rate measures how well your kidneys filter waste. 90 or above is normal; 60 to 89 is mildly decreased; below 60 indicates more significant chronic kidney disease.",
  uacr: "The urine albumin-to-creatinine ratio measures protein leaking into your urine, which is an early sign of kidney damage. Below 30 mg/g is normal.",
  blood_pressure: "Blood pressure is written as systolic over diastolic. Current guidance puts the goal below 130 over 80 for most adults with diabetes or kidney disease.",
  ldl: "LDL is the cholesterol that builds up in artery walls. Goals depend on your overall risk; people who have already had a heart attack or stroke are usually aimed below 70 mg/dL.",
  bmi: "Body mass index compares weight to height. It is a rough screen, not a diagnosis, and does not distinguish muscle from fat.",
  cognitive_trajectory: "Brief cognitive tests such as the MMSE and MoCA are scored out of 30. What matters clinically is less the single number than the direction and pace of change across repeat tests.",
  ascvd: "The Pooled Cohort Equations estimate the chance of a first heart attack or stroke in the next 10 years. They apply to people who have not already had one.",
  ldl_goal: "For people who have already had a cardiovascular event, guidelines set a lower cholesterol target than for the general population.",
  kdigo: "KDIGO staging combines kidney filtration rate (the G category) with urine protein (the A category). The two together give a risk category that neither gives alone.",
};

const DETAIL_LINK = { cognitive_trajectory: "score-detail-moca.html" };

const SEVERITY_CLASS = {
  good: "trend-good", caution: "trend-caution",
  alert: "trend-alert", neutral: "trend-stable",
};

const EXTRA_CSS = `
  .trend-alert { color: var(--alert, #C56B72); }
  .score-status.sev-good    { color: var(--good, #6FA88D); }
  .score-status.sev-caution { color: var(--caution, #D49A4E); }
  .score-status.sev-alert   { color: var(--alert, #C56B72); }
  .score-status.sev-neutral { color: var(--text-2); }
  .score-rate { margin: 4px 0 0; font-size: 12.5px; color: var(--text-2); }
  .card.is-muted { background: var(--surface-alt, #F4F6F8); }
  .not-applicable { margin: 10px 0 0; font-size: 13.5px; line-height: 1.55; color: var(--text-2); }
  .na-evidence { margin: 10px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
  .na-evidence li { font-size: 12.5px; color: var(--text-2); display: flex; gap: 8px; }
  .na-evidence .yr { font-variant-numeric: tabular-nums; color: var(--text-2); flex: none; min-width: 34px; }
  .cannot-see { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 12px; }
  .cannot-see > summary { cursor: pointer; font-size: 12.5px; font-weight: 600;
    color: var(--teal, #0E5C6F); list-style: none; display: inline-flex; align-items: center; gap: 6px; }
  .cannot-see > summary::-webkit-details-marker { display: none; }
  .cannot-see > summary::before { content: "▸"; font-size: 10px; transition: transform .15s ease; }
  .cannot-see[open] > summary::before { transform: rotate(90deg); }
  .cannot-see ul { margin: 10px 0 0; padding-left: 16px; font-size: 12.5px;
    line-height: 1.55; color: var(--text-2); display: flex; flex-direction: column; gap: 7px; }
  /* The card is a flex column, so a bare <table> becomes a stretched flex item
     and lays out unpredictably. Wrapping it keeps normal block layout. */
  .kdigo-wrap { margin: 14px 0 0; overflow-x: auto; }
  .kdigo-grid { border-collapse: collapse; font-size: 10.5px; }
  .kdigo-grid th { color: var(--text-2); font-weight: 600; padding: 2px 5px; font-size: 10px; }
  .kdigo-grid th.rowhead { text-align: right; }
  .kdigo-grid td { width: 40px; height: 20px; border: 1px solid #FFFFFF; }
  .kdigo-grid td.is-current { outline: 2px solid var(--text, #1B2330); outline-offset: -2px; }
  .kdigo-grid td span { display: block; text-align: center; color: #fff; font-weight: 700; font-size: 10px; }
  .kdigo-caption { margin: 10px 0 0; font-size: 11.5px; color: var(--text-2); }
  .hs-state { padding: 40px 24px; text-align: center; color: var(--text-2); font-size: 14.5px; }
  .hs-state button { margin-top: 14px; height: 40px; padding: 0 18px; border-radius: 8px;
    border: 1px solid var(--teal, #0E5C6F); background: var(--teal, #0E5C6F); color: #fff;
    font: 600 14px inherit; cursor: pointer; }
`;

/* --------------------------------------------------------------- helpers */

const esc = (v) => String(v == null ? "" : v)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

function longDate(iso) {
  if (!iso) return "";
  return new Date(iso + "T12:00:00").toLocaleDateString("en-US",
    { year: "numeric", month: "long", day: "numeric" });
}

/* ----------------------------------------------------------------- chart */

function renderPlot(p, label) {
  if (!p) return "";
  const w = p.area.x1 - p.area.x0;

  const bands = p.bands.map((b) =>
    `<rect x="${p.area.x0}" y="${b.y}" width="${w}" height="${b.height}" `
    + `fill="${b.color}" fill-opacity="${b.opacity}"/>`).join("");

  const yTicks = p.yTicks.map((t) =>
    `<text x="${p.area.x0 - 5}" y="${t.y + 3}" font-size="10" fill="#6B7785" `
    + `text-anchor="end">${esc(t.label)}</text>`).join("");

  const xTicks = p.xTicks.map((t) =>
    `<text x="${t.x}" y="${p.area.y1 + 17}" font-size="10" fill="#6B7785" `
    + `text-anchor="${t.anchor}">${esc(t.label)}</text>`).join("");

  const dots = p.markEvery
    ? p.points.slice(0, -1).map((pt) =>
        `<circle cx="${pt.x}" cy="${pt.y}" r="3" fill="${p.color}"/>`).join("")
    : "";

  const second = p.second ? `
    <polyline points="${p.second.polyline}" fill="none" stroke="${p.second.color}"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 3"/>
    <circle cx="${p.second.last.x}" cy="${p.second.last.y}" r="4.5" fill="#FFFFFF"
      stroke="${p.second.color}" stroke-width="2"/>` : "";

  return `<svg class="chart-svg" viewBox="0 0 ${p.width} ${p.height}"
    xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}">
  ${bands}
  <line x1="${p.area.x0}" y1="${p.area.y0}" x2="${p.area.x0}" y2="${p.area.y1}" stroke="#E5EAEE"/>
  <line x1="${p.area.x0}" y1="${p.area.y1}" x2="${p.area.x1}" y2="${p.area.y1}" stroke="#E5EAEE"/>
  ${yTicks}
  ${p.axisLabel ? `<text x="12" y="70" transform="rotate(-90 12 70)" font-size="9.5"
    fill="#6B7785" text-anchor="middle">${esc(p.axisLabel)}</text>` : ""}
  ${xTicks}
  ${second}
  <polyline points="${p.polyline}" fill="none" stroke="${p.color}" stroke-width="2.4"
    stroke-linecap="round" stroke-linejoin="round"/>
  ${dots}
  <circle cx="${p.last.x}" cy="${p.last.y}" r="6" fill="#FFFFFF" stroke="${p.color}" stroke-width="2"/>
  <circle cx="${p.last.x}" cy="${p.last.y}" r="3.4" fill="${p.color}"/>
  <text x="${p.last.labelX}" y="${p.last.labelY}" text-anchor="end" font-size="10"
    font-weight="600" fill="#1B2330">${esc(p.last.label)}</text>
</svg>`;
}

function renderKdigo(score) {
  const e = score.extra;
  if (!e || !e.grid) return "";
  const head = `<tr><th></th>${e.columns
    .map((c) => `<th title="${esc(c.label)}">${c.code}</th>`).join("")}</tr>`;
  const rows = e.grid.map((r) =>
    `<tr><th class="rowhead" title="${esc(r.label)}">${r.code}</th>`
    + r.cells.map((c) =>
        `<td class="${c.current ? "is-current" : ""}" style="background:${c.color};`
        + `opacity:${c.current ? 1 : 0.32}"><span>${c.current ? "●" : ""}</span></td>`
      ).join("") + "</tr>").join("");
  const agree = e.agreesWithChart === true
    ? ` This matches the ${esc(e.documented || "diagnosis")} already recorded in your chart.`
    : "";
  return `<div class="kdigo-wrap"><table class="kdigo-grid" role="img"
    aria-label="KDIGO risk grid. Your stage is ${esc(e.gStage)} ${esc(e.aStage || "")}.">
    ${head}${rows}</table></div>
    <p class="kdigo-caption">eGFR ${esc(e.gValue)} places you in ${esc(e.gStage)}`
    + (e.aValue !== null && e.aValue !== undefined
        ? `, urine albumin ${esc(e.aValue)} mg/g in ${esc(e.aStage)}` : "")
    + `.${agree}</p>`;
}

/* ------------------------------------------------------------------ card */

function renderCard(score) {
  const help = HELP[score.id];
  const link = DETAIL_LINK[score.id] || "#";
  const muted = score.status !== STATUS.OK;

  const head = `<div class="score-top">
      <span class="score-label-row">
        ${esc(score.label)}
        ${help ? `<button class="help-hit" type="button"
          aria-label="What is ${esc(score.label)}?" title="${esc(help)}">
          <span class="score-help" aria-hidden="true">?</span></button>` : ""}
      </span>
      <a class="detail-link" href="${link}">View detail →</a>
    </div>`;

  const cannotSee = (score.cannotSee && score.cannotSee.length)
    ? `<details class="cannot-see">
        <summary>What this ${score.category === "direct" ? "measurement" : "score"} cannot see (${score.cannotSee.length})</summary>
        <ul>${score.cannotSee.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      </details>` : "";

  const footer = `<div class="card-footer">
      <span>${score.asOf ? "Updated " + longDate(score.asOf) : "No dated result"}</span>
      <span class="right">${score.guideline
        ? esc(score.guideline.name)
        : (score.inputs.length + " source" + (score.inputs.length === 1 ? "" : "s"))}</span>
    </div>`;

  // A score that declines to compute is a real result, not an error state.
  if (score.status === STATUS.NOT_APPLICABLE) {
    const ev = ((score.extra && score.extra.establishedAscvd) || [])
      .map((p) => `<li><span class="yr">${esc((p.onset || "").slice(0, 4))}</span>
        <span>${esc(p.display)}</span></li>`).join("");
    return `<article class="card is-muted">
      ${head}
      <div class="score-num-row"><span class="score-num">—</span></div>
      <p class="score-status sev-neutral">Not applicable to you</p>
      <p class="not-applicable">${esc(score.cannotSee[0] || "")}</p>
      ${ev ? `<ul class="na-evidence">${ev}</ul>` : ""}
      ${footer}
    </article>`;
  }

  if (score.status === STATUS.INSUFFICIENT) {
    return `<article class="card is-muted">
      ${head}
      <div class="score-num-row"><span class="score-num">—</span></div>
      <p class="score-status sev-neutral">Not enough information</p>
      <p class="not-applicable">${esc(score.cannotSee[0] || "")}</p>
      ${footer}
    </article>`;
  }

  const trendGlyph = score.trend
    ? `<span class="score-trend ${SEVERITY_CLASS[score.trend.severity] || "trend-stable"}"
        aria-label="${esc(score.trend.direction)}">${score.trend.glyph}</span>` : "";

  const rate = score.trend && (score.trend.rateText
    || (score.trend.ratePerYear !== null && score.trend.ratePerYear !== undefined
        ? (score.trend.ratePerYear > 0 ? "Rising " : "Falling ")
          + Math.abs(score.trend.ratePerYear).toFixed(1) + " "
          + (score.unit && score.unit !== "%" ? score.unit + " " : "") + "a year"
        : null));

  const unitLine = (score.unit && score.category === "direct"
    && !String(score.display).includes("/") && score.unit !== "%")
    ? `<p class="score-units-secondary">${esc(score.unit)}</p>` : "";

  const chartLabel = score.label + " over time, currently " + score.display
    + (score.stageLabel ? ", " + score.stageLabel : "");

  return `<article class="card">
    ${head}
    <div class="score-num-row">
      <span class="score-num">${esc(score.display)}</span>
      ${trendGlyph}
    </div>
    ${unitLine}
    <p class="score-status sev-${esc(score.severity)}">${esc(score.stageLabel || "")}</p>
    ${rate ? `<p class="score-rate">${esc(rate)}</p>` : ""}
    ${score.id === "kdigo" ? renderKdigo(score) : ""}
    ${score.plot ? `<div class="chart-wrap">${renderPlot(score.plot, chartLabel)}</div>` : ""}
    ${cannotSee}
    ${footer}
  </article>`;
}

/* ------------------------------------------------------------------ boot */

function setState(html) {
  const direct = document.getElementById("direct-grid");
  const validated = document.getElementById("validated-grid");
  if (direct) direct.innerHTML = html;
  if (validated) validated.innerHTML = "";
}

async function boot() {
  const style = document.createElement("style");
  style.textContent = EXTRA_CSS;
  document.head.appendChild(style);

  const directGrid = document.getElementById("direct-grid");
  const validatedGrid = document.getElementById("validated-grid");
  if (!directGrid || !validatedGrid) return;

  if (!window.CareTracerStore) {
    setState(`<p class="hs-state">Local record storage is unavailable in this browser.</p>`);
    return;
  }

  const connection = await window.CareTracerStore.getConnection();
  if (!connection) {
    setState(`<div class="hs-state">
      <p>Connect a health system to see your scores.</p>
      <button type="button" id="hs-connect">Connect your health records</button>
    </div>`);
    const btn = document.getElementById("hs-connect");
    if (btn) btn.addEventListener("click", () => {
      if (window.CareTracerConnect) window.CareTracerConnect.open();
    });
    return;
  }

  try {
    const [resources, measures, nonclinical] = await Promise.all([
      window.CareTracerStore.getAll(),
      fetch(DICT_BASE + "measures.json").then((r) => r.json()),
      fetch(DICT_BASE + "nonclinical.json").then((r) => r.json()),
    ]);

    const built = buildTables(resources, { measures, nonclinical });
    const scores = computeScores(built.tables);

    directGrid.innerHTML = scores.direct.map(renderCard).join("");
    validatedGrid.innerHTML = scores.validated.map(renderCard).join("");

    // Expose for the Companion and the detail views, and for debugging.
    window.CareTracerScores = { tables: built.tables, scores: scores };
    document.dispatchEvent(new CustomEvent("caretracer:scores", { detail: scores }));
  } catch (err) {
    if (window.console) console.error("health scores failed:", err);
    setState(`<p class="hs-state">Your scores could not be calculated from the
      record on this device.</p>`);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
