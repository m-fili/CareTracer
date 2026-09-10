/* CareTracer scores - kidney (KDIGO).
 *
 * KDIGO stages chronic kidney disease on two axes at once: G from filtration
 * rate, A from albuminuria. Neither alone gives the risk category — an eGFR of
 * 56 is "moderately reduced" whether albuminuria is normal or severe, but the
 * combined risk moves from moderate to very high across that range. So the
 * score is a cell in a grid, not a point on a line, and the tile renders the
 * grid with the patient's cell marked.
 */

import { buildPlot } from "./plot.js";
import {
  STATUS, TRACK_COLOR, result, seriesOf, latestPlausible,
  ratePerYear, trendOf, daysSince, cannotSeeFor, stalenessNote,
} from "./common.js";

const GUIDELINE = {
  name: "KDIGO CKD classification",
  citation: "KDIGO 2012 Clinical Practice Guideline for the Evaluation and "
    + "Management of Chronic Kidney Disease. Kidney Int Suppl. 2013;3(1):1-150.",
};

export const G_STAGES = [
  { code: "G1",  min: 90,  max: Infinity, label: "Normal or high" },
  { code: "G2",  min: 60,  max: 90,  label: "Mildly decreased" },
  { code: "G3a", min: 45,  max: 60,  label: "Mildly to moderately decreased" },
  { code: "G3b", min: 30,  max: 45,  label: "Moderately to severely decreased" },
  { code: "G4",  min: 15,  max: 30,  label: "Severely decreased" },
  { code: "G5",  min: -Infinity, max: 15, label: "Kidney failure" },
];

export const A_STAGES = [
  { code: "A1", min: -Infinity, max: 30,  label: "Normal to mildly increased" },
  { code: "A2", min: 30,  max: 300, label: "Moderately increased" },
  { code: "A3", min: 300, max: Infinity, label: "Severely increased" },
];

/* Risk grid, G rows x A columns, as published in the KDIGO heat map. */
export const RISK_GRID = {
  G1:  { A1: "low",       A2: "moderate",  A3: "high" },
  G2:  { A1: "low",       A2: "moderate",  A3: "high" },
  G3a: { A1: "moderate",  A2: "high",      A3: "very-high" },
  G3b: { A1: "high",      A2: "very-high", A3: "very-high" },
  G4:  { A1: "very-high", A2: "very-high", A3: "very-high" },
  G5:  { A1: "very-high", A2: "very-high", A3: "very-high" },
};

export const RISK_META = {
  "low":       { label: "Low risk", severity: "good",    color: "#6FA88D" },
  "moderate":  { label: "Moderately increased risk", severity: "caution", color: "#D49A4E" },
  "high":      { label: "High risk", severity: "alert",  color: "#DE8A5A" },
  "very-high": { label: "Very high risk", severity: "alert", color: "#C56B72" },
};

function stageOf(stages, value) {
  return stages.find((s) => value >= s.min && value < s.max) || stages[stages.length - 1];
}

export function kdigoStage(tables, options) {
  const today = (options || {}).today;
  const egfr = seriesOf(tables, "egfr");
  const uacr = seriesOf(tables, "uacr");
  const pEgfr = latestPlausible(egfr);
  const pUacr = latestPlausible(uacr);

  const base = {
    id: "kdigo", label: "Kidney health stage", short: "KDIGO",
    category: "validated", track: "kidney", guideline: GUIDELINE,
  };

  if (!pEgfr) {
    return result(Object.assign({}, base, {
      status: STATUS.INSUFFICIENT, display: "—",
      cannotSee: ["Staging needs a kidney filtration rate (eGFR), which is not "
        + "available in your record."],
    }));
  }

  const g = stageOf(G_STAGES, pEgfr.value);

  // Albuminuria may legitimately be absent. The G stage still stands; the risk
  // cell does not, and saying so is more useful than assuming A1.
  const a = pUacr ? stageOf(A_STAGES, pUacr.value) : null;
  const riskKey = a ? RISK_GRID[g.code][a.code] : null;
  const risk = riskKey ? RISK_META[riskKey] : null;

  const plot = buildPlot(egfr.points, {
    domain: [0, Math.max(105, pEgfr.value + 15)],
    bands: [
      { from: 90, color: "#6FA88D", label: "G1" },
      { from: 60, to: 90, color: "#D49A4E", label: "G2" },
      { from: 30, to: 60, color: "#DE8A5A", label: "G3" },
      { to: 30, color: "#C56B72", label: "G4-G5" },
    ],
    color: TRACK_COLOR.kidney,
    axisLabel: "eGFR (mL/min/1.73m²)", decimals: 0, clampMin: 0,
  });

  // Cross-check against what the clinician actually documented. Agreement is
  // worth showing; disagreement is worth flagging.
  const documented = (tables.problems || []).filter((p) => p.clinical && p.active
    && /chronic kidney disease stage/i.test(p.display || ""));
  const documentedLatest = documented.length ? documented[documented.length - 1] : null;

  const inputs = [{
    label: "eGFR", value: Number(pEgfr.value.toFixed(1)),
    unit: "mL/min/1.73m²", date: pEgfr.date, ref: pEgfr.ref,
  }];
  if (pUacr) {
    inputs.push({
      label: "Urine albumin/creatinine", value: Math.round(pUacr.value),
      unit: "mg/g", date: pUacr.date, ref: pUacr.ref,
    });
  }
  if (documentedLatest) {
    inputs.push({
      label: "Recorded diagnosis", value: documentedLatest.display, unit: null,
      date: documentedLatest.firstOnset, ref: documentedLatest.ref,
    });
  }

  const display = a ? g.code + " / " + a.code : g.code;

  return result(Object.assign({}, base, {
    status: STATUS.OK,
    value: pEgfr.value, unit: "mL/min/1.73m²",
    display: display,
    stage: display,
    stageLabel: risk ? risk.label : g.label,
    severity: risk ? risk.severity : "caution",
    trend: trendOf(egfr, { windowYears: 3, today: today }),
    asOf: pEgfr.date, staleDays: daysSince(pEgfr.date, today),
    inputs: inputs,
    cannotSee: cannotSeeFor(tables, ["egfr", "uacr"], [
      stalenessNote("eGFR", pEgfr.date, 400, today),
      !pUacr
        ? "No urine albumin result is on file, so only the filtration side of "
          + "the stage could be worked out."
        : null,
      "A single eGFR can move with hydration, illness or a recent meal. KDIGO "
        + "staging assumes the change has lasted at least three months.",
    ]),
    plot: plot,
    extra: {
      gStage: g.code, gLabel: g.label, gValue: Number(pEgfr.value.toFixed(1)),
      aStage: a ? a.code : null, aLabel: a ? a.label : null,
      aValue: pUacr ? Math.round(pUacr.value) : null,
      riskKey: riskKey, riskColor: risk ? risk.color : null,
      // Geometry for the heat-map card: rows G1..G5, columns A1..A3.
      grid: G_STAGES.map((row) => ({
        code: row.code, label: row.label,
        cells: A_STAGES.map((col) => ({
          a: col.code,
          risk: RISK_GRID[row.code][col.code],
          color: RISK_META[RISK_GRID[row.code][col.code]].color,
          current: a ? (row.code === g.code && col.code === a.code) : false,
        })),
      })),
      columns: A_STAGES.map((c) => ({ code: c.code, label: c.label })),
      documented: documentedLatest ? documentedLatest.display : null,
      agreesWithChart: documentedLatest
        ? new RegExp(g.code.replace(/[ab]$/, ""), "i").test(documentedLatest.display)
        : null,
    },
  }));
}
