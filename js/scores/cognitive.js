/* CareTracer scores - cognitive trajectory (AD/MCI module).
 *
 * The clinical question in Alzheimer's care is longitudinal: is this person
 * progressing, and how fast. A single cognitive score answers neither, so the
 * score reported here is the trajectory — stage plus annualised rate of change
 * — rather than the latest number on its own.
 *
 * Instrument-agnostic by design: MMSE and MoCA are both 0-30 scales in wide
 * use, and a real record contains whichever one that clinic administers.
 * Bands differ per instrument and are declared, not assumed.
 */

import { buildPlot } from "./plot.js";
import {
  STATUS, TRACK_COLOR, result, seriesOf, latestPlausible,
  ratePerYear, daysSince, cannotSeeFor, stalenessNote,
  ambulatoryPoints, settingNote,
} from "./common.js";

const INSTRUMENTS = {
  mmse: {
    measure: "mmse", name: "MMSE", full: "Mini-Mental State Examination",
    max: 30,
    guideline: {
      name: "Folstein MMSE severity bands",
      citation: "Folstein MF, Folstein SE, McHugh PR. J Psychiatr Res. 1975;12(3):189-98.",
    },
    // Widely used severity cut-points for the 0-30 MMSE.
    stages: [
      { from: 24, to: 30, stage: "Normal to questionable", severity: "good" },
      { from: 18, to: 24, stage: "Mild impairment", severity: "caution" },
      { from: 10, to: 18, stage: "Moderate impairment", severity: "alert" },
      { from: 0, to: 10, stage: "Severe impairment", severity: "alert" },
    ],
  },
  moca: {
    measure: "moca", name: "MoCA", full: "Montreal Cognitive Assessment",
    max: 30,
    guideline: {
      name: "MoCA screening threshold",
      citation: "Nasreddine ZS et al. J Am Geriatr Soc. 2005;53(4):695-9.",
    },
    stages: [
      { from: 26, to: 30, stage: "Within normal limits", severity: "good" },
      { from: 18, to: 26, stage: "Mild cognitive impairment range", severity: "caution" },
      { from: 10, to: 18, stage: "Moderate impairment", severity: "alert" },
      { from: 0, to: 10, stage: "Severe impairment", severity: "alert" },
    ],
  },
};

function stageFor(instrument, value) {
  const hit = instrument.stages.find((s) => value >= s.from && value < s.to)
    || instrument.stages[instrument.stages.length - 1];
  return hit;
}

/**
 * Cognitive trajectory. Prefers whichever instrument the record actually
 * contains; if both are present MoCA wins, being the more sensitive screen
 * for the mild range this module is built around.
 */
export function cognitiveTrajectory(tables, options) {
  const today = (options || {}).today;

  const available = ["moca", "mmse"]
    .map((k) => ({ key: k, def: INSTRUMENTS[k], series: seriesOf(tables, k) }))
    .filter((c) => c.series && c.series.points.length);

  const base = {
    id: "cognitive_trajectory", label: "Memory and thinking", short: "Cognition",
    category: "validated", track: "cognitive",
  };

  if (!available.length) {
    return result(Object.assign({}, base, {
      status: STATUS.INSUFFICIENT,
      cannotSee: ["No cognitive assessment (MMSE or MoCA) appears in your record."],
    }));
  }

  const chosen = available[0];
  const inst = chosen.def;
  const series = chosen.series;
  // Cognitive testing during an admission reflects delirium as much as
  // baseline; the filter falls back to all points when too few remain.
  const points = ambulatoryPoints(series);
  const point = latestPlausible(points);

  if (!point) {
    return result(Object.assign({}, base, {
      status: STATUS.INSUFFICIENT,
      guideline: inst.guideline,
      cannotSee: cannotSeeFor(tables, [inst.measure],
        ["Recorded " + inst.name + " results did not pass validation."]),
    }));
  }

  // Instruments are scored in whole points; the validator already recorded the
  // raw value and the rounding as an issue.
  const shown = Math.round(point.value);
  const stage = stageFor(inst, shown);
  const rate = ratePerYear(points);
  const usable = points.filter((p) => p.plausible !== false);

  const bands = inst.stages.map((s) => ({
    from: s.from, to: s.to, label: s.stage,
    color: s.severity === "good" ? "#6FA88D"
      : s.severity === "caution" ? "#D49A4E" : "#C56B72",
    opacity: s.severity === "alert" ? 0.10 : 0.12,
  }));

  const plot = buildPlot(points, {
    domain: [0, inst.max],
    bands: bands,
    color: TRACK_COLOR.cognitive,
    axisLabel: inst.name + " (out of " + inst.max + ")",
    decimals: 0,
  });

  // Rate is the headline: a point-per-year figure is what tells a clinician
  // whether this is typical progression or something faster.
  let rateText = null;
  if (rate !== null && usable.length >= 2) {
    const perYear = Math.abs(rate).toFixed(1);
    rateText = rate < 0
      ? "Falling about " + perYear + " points a year"
      : "Rising about " + perYear + " points a year";
  }

  const notes = cannotSeeFor(tables, [inst.measure], [
    stalenessNote(inst.name, point.date, 400, today),
    settingNote(series, inst.name),
    usable.length <= 3
      ? "Only " + usable.length + " " + inst.name + " result"
        + (usable.length === 1 ? " is" : "s are") + " on file, which is too few "
        + "to describe a reliable trend."
      : null,
    "A cognitive score reflects one sitting. Sleep, mood, illness and "
      + "medication can all move it, and it cannot on its own distinguish "
      + "Alzheimer's disease from other causes of memory change.",
    available.length > 1
      ? "Your record also contains " + INSTRUMENTS[available[1].key].name
        + " results, which are scored differently and are not mixed into this line."
      : null,
  ]);

  return result(Object.assign({}, base, {
    status: STATUS.OK,
    guideline: inst.guideline,
    value: shown, unit: "of " + inst.max,
    display: shown + " / " + inst.max,
    stage: stage.stage, stageLabel: stage.stage, severity: stage.severity,
    trend: {
      direction: series.direction,
      improving: series.improving,
      glyph: series.direction === "up" ? "▲" : (series.direction === "down" ? "▼" : "―"),
      severity: series.improving === null ? "neutral" : (series.improving ? "good" : "caution"),
      ratePerYear: rate,
      rateText: rateText,
    },
    asOf: point.date, staleDays: daysSince(point.date, today),
    inputs: usable.map((p) => ({
      label: inst.name, value: Math.round(p.value), unit: "of " + inst.max,
      date: p.date, ref: p.ref,
    })),
    cannotSee: notes,
    plot: plot,
    extra: {
      instrument: inst.name, instrumentFull: inst.full, max: inst.max,
      rawValue: point.value,
      n: usable.length,
      firstDate: usable[0].date, firstValue: Math.round(usable[0].value),
      spanYears: usable.length > 1
        ? Number(((new Date(point.date) - new Date(usable[0].date))
            / (365.25 * 86400000)).toFixed(1))
        : null,
      stages: inst.stages,
    },
  }));
}

export { INSTRUMENTS as COGNITIVE_INSTRUMENTS };
