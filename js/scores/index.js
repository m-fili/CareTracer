/* CareTracer scores - public API.
 *
 *   import { buildTables } from "../pipeline/index.js";
 *   import { computeScores } from "./index.js";
 *
 *   const { tables } = buildTables(resources, dictionary);
 *   const scores = computeScores(tables);
 *
 * Each score is a pure function of the pipeline's tables. None of them touch
 * FHIR, and none of them are AI: these are published formulas and published
 * cut-points, computed deterministically. The generated layer sits above this,
 * turning a result into plain language, and can be removed without changing a
 * single number.
 */

import { directMeasures, directMeasure, DIRECT_TILES } from "./direct.js";
import { cognitiveTrajectory } from "./cognitive.js";
import { ascvdRisk, ldlGoal } from "./cardiovascular.js";
import { kdigoStage } from "./renal.js";
import { STATUS } from "./common.js";

export const SCORES_VERSION = "1.0.0";

/* The validated-score registry. Adding a clinical area means adding a row
 * here and a function beside it: the Map, the tiles and the detail views all
 * read this list rather than naming scores individually. */
export const VALIDATED = [
  { id: "cognitive_trajectory", track: "cognitive",       fn: cognitiveTrajectory },
  { id: "ascvd",               track: "cardiovascular",   fn: ascvdRisk },
  { id: "ldl_goal",            track: "cardiovascular",   fn: ldlGoal },
  { id: "kdigo",               track: "kidney",           fn: kdigoStage },
];

export function computeScores(tables, options) {
  const opts = options || {};
  const direct = directMeasures(tables, opts);

  const validated = VALIDATED.map(function (entry) {
    try {
      return entry.fn(tables, opts);
    } catch (err) {
      // A failing score must not take the page down with it.
      return {
        id: entry.id, label: entry.id, category: "validated", track: entry.track,
        status: STATUS.INSUFFICIENT, display: "—",
        cannotSee: ["This score could not be calculated from your record."],
        error: String(err && err.message || err),
        inputs: [], plot: null,
      };
    }
  });

  return {
    version: SCORES_VERSION,
    computedAt: new Date().toISOString(),
    direct: direct,
    validated: validated,
    byId: direct.concat(validated).reduce(function (acc, s) {
      acc[s.id] = s; return acc;
    }, {}),
    summary: {
      direct: direct.length,
      validated: validated.length,
      ok: direct.concat(validated).filter((s) => s.status === STATUS.OK).length,
      notApplicable: validated.filter((s) => s.status === STATUS.NOT_APPLICABLE).length,
      insufficient: direct.concat(validated)
        .filter((s) => s.status === STATUS.INSUFFICIENT).length,
      limitations: direct.concat(validated)
        .reduce((n, s) => n + (s.cannotSee || []).length, 0),
    },
  };
}

export {
  directMeasures, directMeasure, DIRECT_TILES,
  cognitiveTrajectory, ascvdRisk, ldlGoal, kdigoStage,
  STATUS,
};
export { buildPlot, buildDualPlot, CHART, monthYear } from "./plot.js";
export { TRACK_COLOR, SEVERITY_COLOR } from "./common.js";
