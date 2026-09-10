/* CareTracer scores - direct measurements.
 *
 * The "regular scores" pillar: trended values read straight from the record,
 * with the reference band the lab itself would print. No formula, no model,
 * no interpretation beyond where the value sits against its range.
 */

import { buildPlot, buildDualPlot } from "./plot.js";
import {
  STATUS, TRACK_COLOR, result, seriesOf, latestPlausible,
  trendOf, daysSince, cannotSeeFor, stalenessNote,
} from "./common.js";

/* Which six tiles the demo shows, and how each is banded. Bands are in value
 * space; buildPlot clips them to whatever domain the data occupies. */
const TILES = [
  {
    id: "hba1c", measure: "hba1c", label: "Blood sugar (HbA1c)", short: "HbA1c",
    track: "glycemic", decimals: 1, clampMin: 0,
    bands: [
      { to: 5.7, color: "#6FA88D", label: "normal" },
      { from: 5.7, to: 6.5, color: "#D49A4E", label: "prediabetes" },
      { from: 6.5, color: "#C56B72", label: "diabetes range" },
    ],
    status: (v) => v < 5.7 ? ["Below the usual range", "caution"]
      : v < 7.0 ? ["At target", "good"]
      : v < 8.0 ? ["Above target", "caution"] : ["Well above target", "alert"],
    // Range checks alone cannot catch this: 4.0% is inside the physiological
    // envelope, but it contradicts an active diabetes diagnosis on treatment.
    // Only a score, which can see the problem list, has the context to notice.
    crossCheck: (v, tables) => {
      if (v >= 5.0) return null;
      const dm = (tables.problems || []).some((p) => p.clinical && p.active
        && /diabetes mellitus type (2|ii)|type (2|ii) diabetes/i.test(p.display || ""));
      const treated = (tables.med_episodes || []).some((m) => m.active
        && /insulin|metformin|glipizide|glimepiride|semaglutide|sitagliptin|empagliflozin/i.test(m.display || ""));
      if (!dm) return null;
      return {
        severity: "caution",
        statusText: "Unexpectedly low for treated diabetes",
        note: "This result (" + v.toFixed(1) + "%) is lower than expected for "
          + "someone with a diabetes diagnosis"
          + (treated ? " who is on glucose-lowering medication" : "")
          + ". It may reflect a laboratory or transcription problem rather than "
          + "your actual blood sugar, and is worth confirming with your care team.",
      };
    },
  },
  {
    id: "egfr", measure: "egfr", label: "Kidney function (eGFR)", short: "eGFR",
    track: "kidney", decimals: 0, clampMin: 0,
    bands: [
      { from: 90, color: "#6FA88D", label: "normal" },
      { from: 60, to: 90, color: "#D49A4E", label: "mildly reduced" },
      { to: 60, color: "#C56B72", label: "moderately reduced" },
    ],
    status: (v) => v >= 90 ? ["Normal filtration", "good"]
      : v >= 60 ? ["Mildly reduced", "caution"]
      : v >= 30 ? ["Moderately reduced", "alert"] : ["Severely reduced", "alert"],
  },
  {
    id: "uacr", measure: "uacr", label: "Protein in urine (UACR)", short: "UACR",
    track: "kidney", decimals: 0, clampMin: 0,
    bands: [
      { to: 30, color: "#6FA88D", label: "normal" },
      { from: 30, to: 300, color: "#D49A4E", label: "moderately raised" },
      { from: 300, color: "#C56B72", label: "severely raised" },
    ],
    status: (v) => v < 30 ? ["Normal", "good"]
      : v < 300 ? ["Moderately raised", "caution"] : ["Severely raised", "alert"],
  },
  {
    id: "blood_pressure", measure: "systolic_bp", secondMeasure: "diastolic_bp",
    label: "Blood pressure", short: "BP", track: "cardiovascular", decimals: 0,
    bands: [
      { to: 130, color: "#6FA88D", label: "at goal" },
      { from: 130, to: 140, color: "#D49A4E", label: "elevated" },
      { from: 140, color: "#C56B72", label: "high" },
    ],
    status: (v) => v < 90 ? ["Lower than expected", "caution"]
      : v < 130 ? ["At goal", "good"]
      : v < 140 ? ["Elevated", "caution"] : ["High", "alert"],
  },
  {
    id: "ldl", measure: "ldl", label: "LDL cholesterol", short: "LDL",
    track: "cardiovascular", decimals: 0, clampMin: 0,
    bands: [
      { to: 70, color: "#6FA88D", label: "goal for high risk" },
      { from: 70, to: 100, color: "#D49A4E", label: "above high-risk goal" },
      { from: 100, color: "#C56B72", label: "high" },
    ],
    status: (v) => v < 70 ? ["At the high-risk goal", "good"]
      : v < 100 ? ["Above the high-risk goal", "caution"] : ["High", "alert"],
  },
  {
    id: "bmi", measure: "bmi", label: "Body mass index", short: "BMI",
    track: "general", decimals: 1, clampMin: 0,
    bands: [
      { from: 18.5, to: 25, color: "#6FA88D", label: "healthy range" },
      { from: 25, to: 30, color: "#D49A4E", label: "overweight" },
      { from: 30, color: "#C56B72", label: "obesity" },
    ],
    status: (v) => v < 18.5 ? ["Below the healthy range", "caution"]
      : v < 25 ? ["Healthy range", "good"]
      : v < 30 ? ["Overweight range", "caution"] : ["Obesity range", "alert"],
  },
];

function buildTile(tables, spec, today) {
  const series = seriesOf(tables, spec.measure);
  if (!series) {
    return result({
      id: spec.id, label: spec.label, short: spec.short, category: "direct",
      track: spec.track, status: STATUS.INSUFFICIENT,
      cannotSee: ["This measurement does not appear anywhere in your record."],
    });
  }

  const point = latestPlausible(series);
  if (!point) {
    return result({
      id: spec.id, label: spec.label, short: spec.short, category: "direct",
      track: spec.track, status: STATUS.INSUFFICIENT,
      cannotSee: cannotSeeFor(tables, [spec.measure],
        ["Every recorded result failed a plausibility check, so no value is shown."]),
    });
  }

  const color = TRACK_COLOR[spec.track] || TRACK_COLOR.general;
  const second = spec.secondMeasure ? seriesOf(tables, spec.secondMeasure) : null;
  const secondPoint = latestPlausible(second);

  const plotOpts = {
    bands: spec.bands, color: color, axisLabel: series.unit,
    decimals: spec.decimals, clampMin: spec.clampMin,
    tickDecimals: spec.decimals === 1 ? 1 : 0,
  };
  const plot = second
    ? buildDualPlot(series, second, Object.assign({ colorB: "#7C9BAA" }, plotOpts))
    : buildPlot(series.points, plotOpts);

  let [statusText, severity] = spec.status(point.value);
  const trend = trendOf(series, { windowYears: 3, today: today });
  const crossNotes = spec.crossCheck ? spec.crossCheck(point.value, tables) : null;
  if (crossNotes && crossNotes.severity) {
    statusText = crossNotes.statusText || statusText;
    severity = crossNotes.severity;
  }

  const display = second && secondPoint
    ? Math.round(point.value) + " / " + Math.round(secondPoint.value)
    : Number(point.value).toFixed(spec.decimals);

  const inputs = [{
    label: series.label, value: Number(point.value.toFixed(spec.decimals)),
    unit: series.unit, date: point.date, ref: point.ref,
  }];
  if (secondPoint) {
    inputs.push({
      label: second.label, value: Number(secondPoint.value.toFixed(0)),
      unit: second.unit, date: secondPoint.date, ref: secondPoint.ref,
    });
  }

  const measures = [spec.measure].concat(spec.secondMeasure ? [spec.secondMeasure] : []);
  const notes = cannotSeeFor(tables, measures, [
    crossNotes ? crossNotes.note : null,
    trend && trend.note ? trend.note : null,
    stalenessNote(series.short || series.label, point.date, 550, today),
    series.nImplausible
      ? series.nImplausible + " of " + series.n + " recorded results were set "
        + "aside as outside the possible range, so the line here is drawn from "
        + series.nPlausible + " readings."
      : null,
  ]);

  return result({
    id: spec.id, label: spec.label, short: spec.short,
    category: "direct", track: spec.track,
    status: STATUS.OK,
    value: point.value, unit: series.unit, display: display,
    stageLabel: statusText, severity: severity,
    trend: trend,
    asOf: point.date, staleDays: daysSince(point.date, today),
    inputs: inputs,
    cannotSee: notes,
    plot: plot,
    extra: {
      n: series.n, nPlausible: series.nPlausible,
      firstDate: series.firstDate, firstValue: series.firstValue,
      betterDirection: series.betterDirection,
      sources: Array.from(new Set(series.points.map((p) => p.source))),
    },
  });
}

/** All six direct-measurement tiles, in display order. */
export function directMeasures(tables, options) {
  const today = (options || {}).today;
  return TILES.map((spec) => buildTile(tables, spec, today));
}

export function directMeasure(tables, id, options) {
  const spec = TILES.find((t) => t.id === id);
  return spec ? buildTile(tables, spec, (options || {}).today) : null;
}

export { TILES as DIRECT_TILES };
