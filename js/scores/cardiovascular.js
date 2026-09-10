/* CareTracer scores - cardiovascular.
 *
 * Two scores, and the interesting one is the score that refuses.
 *
 * The Pooled Cohort Equations estimate the 10-year risk of a FIRST
 * atherosclerotic event. They are validated for primary prevention in adults
 * aged 40-79 without clinical ASCVD. Running them on someone who has already
 * had a myocardial infarction produces a number that looks authoritative and
 * means nothing. So the applicability check runs first, and when it fails the
 * score reports why instead of computing anyway.
 *
 * For a patient with established disease the guideline-relevant question is
 * different: is LDL cholesterol at the secondary-prevention goal. That is what
 * ldlGoal() answers.
 */

import { buildPlot } from "./plot.js";
import {
  STATUS, TRACK_COLOR, result, seriesOf, latestPlausible,
  trendOf, daysSince, cannotSeeFor, stalenessNote,
  ambulatoryPoints, settingNote,
} from "./common.js";

/* Pooled Cohort Equations coefficients, Goff DC Jr et al., Circulation 2013.
 * TRANSCRIBED FROM THE PUBLISHED TABLES AND NOT INDEPENDENTLY VERIFIED against
 * an authoritative implementation. Verify before any clinical display. */
const PCE = {
  white_male: {
    lnAge: 12.344, lnTC: 11.853, lnAge_lnTC: -2.664, lnHDL: -7.990,
    lnAge_lnHDL: 1.769, lnTreatedSBP: 1.797, lnUntreatedSBP: 1.764,
    smoker: 7.837, lnAge_smoker: -1.795, diabetes: 0.658,
    mean: 61.18, s0: 0.9144,
  },
  black_male: {
    lnAge: 2.469, lnTC: 0.302, lnHDL: -0.307, lnTreatedSBP: 1.916,
    lnUntreatedSBP: 1.809, smoker: 0.549, diabetes: 0.645,
    mean: 19.54, s0: 0.8954,
  },
  white_female: {
    lnAge: -29.799, lnAgeSq: 4.884, lnTC: 13.540, lnAge_lnTC: -3.114,
    lnHDL: -13.578, lnAge_lnHDL: 3.149, lnTreatedSBP: 2.019,
    lnUntreatedSBP: 1.957, smoker: 7.574, lnAge_smoker: -1.665,
    diabetes: 0.661, mean: -29.18, s0: 0.9665,
  },
  black_female: {
    lnAge: 17.114, lnTC: 0.940, lnHDL: -18.920, lnAge_lnHDL: 4.475,
    lnTreatedSBP: 29.291, lnAge_lnTreatedSBP: -6.432,
    lnUntreatedSBP: 27.820, lnAge_lnUntreatedSBP: -6.087,
    smoker: 0.691, diabetes: 0.874, mean: 86.61, s0: 0.9533,
  },
};

const ASCVD_GUIDELINE = {
  name: "ACC/AHA Pooled Cohort Equations",
  citation: "Goff DC Jr et al. 2013 ACC/AHA Guideline on the Assessment of "
    + "Cardiovascular Risk. Circulation. 2014;129(25 Suppl 2):S49-73.",
};

const LDL_GUIDELINE = {
  name: "2018 AHA/ACC Cholesterol Guideline",
  citation: "Grundy SM et al. 2018 AHA/ACC Multisociety Guideline on the "
    + "Management of Blood Cholesterol. Circulation. 2019;139(25):e1082-143.",
};

/* Conditions that establish clinical ASCVD, which rules out primary-prevention
 * risk estimation. Matched on SNOMED where possible, text as fallback. */
const ASCVD_SNOMED = new Set([
  "22298006",   // Myocardial infarction
  "401303003",  // Acute STEMI
  "401314000",  // Acute NSTEMI
  "399211009",  // History of myocardial infarction
  "414545008",  // Ischemic heart disease
  "399261000",  // History of CABG
  "230690007",  // Stroke
  "195111005",  // Peripheral arterial disease
  "53741008",   // Coronary arteriosclerosis
]);
const ASCVD_TEXT = /myocardial infarction|ischemic heart|coronary (artery )?(bypass|arterioscler)|angina|stroke|cerebral infarction|peripheral arterial|atherosclerotic/i;

function establishedAscvd(tables) {
  return (tables.problems || [])
    .filter((p) => p.clinical)
    .filter((p) => (p.snomed && ASCVD_SNOMED.has(p.snomed)) || ASCVD_TEXT.test(p.display || ""));
}

function hasDiabetes(tables) {
  return (tables.problems || []).some((p) => p.clinical && p.active
    && /diabetes mellitus type (2|ii)|type (2|ii) diabetes|due to (type (2|ii) )?diabetes/i.test(p.display || ""));
}

function onAntihypertensive(tables) {
  return (tables.med_episodes || []).some((m) => m.active
    && /lisinopril|losartan|valsartan|enalapril|amlodipine|hydrochlorothiazide|metoprolol|atenolol|chlorthalidone|carvedilol/i.test(m.display || ""));
}

function smokingStatus(tables) {
  const rows = (tables.social || []).filter((r) => r.measure === "smoking_status");
  const last = rows[rows.length - 1];
  if (!last) return { current: null, text: null, ref: null, date: null };
  const text = last.valueCode || "";
  return {
    current: /current|every day|some day|smoker(?! *\()/i.test(text) && !/never|former|ex-/i.test(text),
    text: text, ref: last.ref, date: last.date,
  };
}

export function computePce(inputs) {
  const key = (inputs.race === "black" ? "black" : "white") + "_"
    + (inputs.sex === "female" ? "female" : "male");
  const c = PCE[key];
  if (!c) return null;

  const lnAge = Math.log(inputs.age);
  const lnTC = Math.log(inputs.totalCholesterol);
  const lnHDL = Math.log(inputs.hdl);
  const lnSBP = Math.log(inputs.systolic);

  let sum = 0;
  sum += (c.lnAge || 0) * lnAge;
  sum += (c.lnAgeSq || 0) * lnAge * lnAge;
  sum += (c.lnTC || 0) * lnTC;
  sum += (c.lnAge_lnTC || 0) * lnAge * lnTC;
  sum += (c.lnHDL || 0) * lnHDL;
  sum += (c.lnAge_lnHDL || 0) * lnAge * lnHDL;
  if (inputs.treatedBp) {
    sum += (c.lnTreatedSBP || 0) * lnSBP;
    sum += (c.lnAge_lnTreatedSBP || 0) * lnAge * lnSBP;
  } else {
    sum += (c.lnUntreatedSBP || 0) * lnSBP;
    sum += (c.lnAge_lnUntreatedSBP || 0) * lnAge * lnSBP;
  }
  if (inputs.smoker) {
    sum += (c.smoker || 0);
    sum += (c.lnAge_smoker || 0) * lnAge;
  }
  if (inputs.diabetes) sum += (c.diabetes || 0);

  const risk = 1 - Math.pow(c.s0, Math.exp(sum - c.mean));
  return Math.max(0, Math.min(1, risk)) * 100;
}

/** 10-year ASCVD risk, with the applicability guard that must run first. */
export function ascvdRisk(tables, options) {
  const opts = options || {};
  const today = opts.today;
  const demo = tables.demographics || {};

  const base = {
    id: "ascvd", label: "10-year heart risk", short: "ASCVD",
    category: "validated", track: "cardiovascular",
    guideline: ASCVD_GUIDELINE,
  };

  const established = establishedAscvd(tables);
  const age = demo.birthDate
    ? Math.floor((new Date(today || Date.now()) - new Date(demo.birthDate)) / (365.25 * 86400000))
    : null;

  // ---- applicability, before any arithmetic
  const blockers = [];
  if (established.length) {
    blockers.push({
      reason: "established-ascvd",
      text: "This estimate is for people who have not yet had a heart attack, "
        + "stroke or related event. Your record already shows established "
        + "cardiovascular disease, so a first-event risk figure would not apply "
        + "to you.",
      evidence: established.map((p) => ({
        label: p.display, date: p.firstOnset, ref: p.ref,
      })),
    });
  }
  if (age !== null && (age < 40 || age > 79)) {
    blockers.push({
      reason: "age-out-of-range",
      text: "The equations were developed and validated for ages 40 to 79. "
        + "You are " + age + ".",
      evidence: [],
    });
  }

  if (blockers.length) {
    return result(Object.assign({}, base, {
      status: STATUS.NOT_APPLICABLE,
      stageLabel: "Not applicable",
      severity: "neutral",
      display: "—",
      cannotSee: blockers.map((b) => b.text),
      extra: {
        blockers: blockers,
        establishedAscvd: established.map((p) => ({
          display: p.display, onset: p.firstOnset, ref: p.ref,
        })),
        alternative: "ldl_goal",
      },
    }));
  }

  // ---- inputs
  const tc = seriesOf(tables, "cholesterol_total");
  const hdl = seriesOf(tables, "hdl");
  const sbp = seriesOf(tables, "systolic_bp");
  const pTc = latestPlausible(tc ? ambulatoryPoints(tc) : []);
  const pHdl = latestPlausible(hdl ? ambulatoryPoints(hdl) : []);
  const pSbp = latestPlausible(sbp ? ambulatoryPoints(sbp) : []);
  const smoke = smokingStatus(tables);
  const dm = hasDiabetes(tables);
  const treated = onAntihypertensive(tables);

  const missing = [];
  if (age === null) missing.push("date of birth");
  if (!pTc) missing.push("total cholesterol");
  if (!pHdl) missing.push("HDL cholesterol");
  if (!pSbp) missing.push("systolic blood pressure");

  if (missing.length) {
    return result(Object.assign({}, base, {
      status: STATUS.INSUFFICIENT,
      display: "—",
      cannotSee: ["This estimate needs " + missing.join(", ")
        + ", which " + (missing.length > 1 ? "are" : "is") + " not in your record."],
    }));
  }

  const risk = computePce({
    age: age, sex: demo.gender === "female" ? "female" : "male",
    race: /black|african/i.test(demo.race || "") ? "black" : "white",
    totalCholesterol: pTc.value, hdl: pHdl.value, systolic: pSbp.value,
    treatedBp: treated, smoker: !!smoke.current, diabetes: dm,
  });

  const severity = risk < 5 ? "good" : risk < 7.5 ? "caution" : "alert";
  const stage = risk < 5 ? "Low risk" : risk < 7.5 ? "Borderline risk"
    : risk < 20 ? "Intermediate risk" : "High risk";

  return result(Object.assign({}, base, {
    status: STATUS.OK,
    value: risk, unit: "%", display: risk.toFixed(1) + "%",
    stage: stage, stageLabel: stage, severity: severity,
    asOf: pSbp.date, staleDays: daysSince(pSbp.date, today),
    inputs: [
      { label: "Age", value: age, unit: "years", date: null, ref: demo.ref },
      { label: "Total cholesterol", value: Math.round(pTc.value), unit: "mg/dL", date: pTc.date, ref: pTc.ref },
      { label: "HDL cholesterol", value: Math.round(pHdl.value), unit: "mg/dL", date: pHdl.date, ref: pHdl.ref },
      { label: "Systolic blood pressure", value: Math.round(pSbp.value), unit: "mmHg", date: pSbp.date, ref: pSbp.ref },
      { label: "Treated for blood pressure", value: treated ? "Yes" : "No", unit: null, date: null, ref: null },
      { label: "Diabetes", value: dm ? "Yes" : "No", unit: null, date: null, ref: null },
      { label: "Smoking", value: smoke.text || "Not recorded", unit: null, date: smoke.date, ref: smoke.ref },
    ],
    cannotSee: cannotSeeFor(tables, ["cholesterol_total", "hdl", "systolic_bp"], [
      "The equations were derived in populations that did not represent every "
        + "group equally, and they can over- or under-estimate risk outside those groups.",
      !smoke.text ? "Smoking status is not recorded, and was treated as non-smoking." : null,
    ]),
    extra: { treated: treated, diabetes: dm, smoker: !!smoke.current },
  }));
}

/** LDL against the secondary-prevention goal. Correct where ASCVD is not. */
export function ldlGoal(tables, options) {
  const today = (options || {}).today;
  const series = seriesOf(tables, "ldl");
  const ldlPoints = series ? ambulatoryPoints(series) : [];
  const point = latestPlausible(ldlPoints);
  const established = establishedAscvd(tables);
  const veryHighRisk = established.length > 0;
  const goal = veryHighRisk ? 70 : 100;

  const base = {
    id: "ldl_goal", label: "Cholesterol goal", short: "LDL goal",
    category: "validated", track: "cardiovascular", guideline: LDL_GUIDELINE,
  };

  if (!point) {
    return result(Object.assign({}, base, {
      status: STATUS.INSUFFICIENT, display: "—",
      cannotSee: ["No LDL cholesterol result is available in your record."],
    }));
  }

  const gap = point.value - goal;
  const atGoal = gap <= 0;
  const severity = atGoal ? "good" : (gap <= 30 ? "caution" : "alert");
  const onStatin = (tables.med_episodes || []).filter((m) => m.active
    && /statin|atorvastatin|simvastatin|rosuvastatin|pravastatin|lovastatin/i.test(m.display || ""));

  const plot = buildPlot(ldlPoints, {
    bands: [
      { to: goal, color: "#6FA88D", label: "at goal" },
      { from: goal, to: goal + 30, color: "#D49A4E", label: "above goal" },
      { from: goal + 30, color: "#C56B72", label: "well above goal" },
    ],
    color: TRACK_COLOR.cardiovascular,
    axisLabel: "LDL (mg/dL)", decimals: 0, clampMin: 0,
  });

  return result(Object.assign({}, base, {
    status: STATUS.OK,
    value: point.value, unit: "mg/dL",
    display: Math.round(point.value) + " mg/dL",
    stage: atGoal ? "At goal" : "Above goal",
    stageLabel: atGoal
      ? "At the under-" + goal + " goal"
      : Math.round(gap) + " mg/dL above the under-" + goal + " goal",
    severity: severity,
    trend: trendOf(series, { points: ldlPoints, windowYears: 3, today: today }),
    asOf: point.date, staleDays: daysSince(point.date, today),
    inputs: [
      { label: "LDL cholesterol", value: Math.round(point.value), unit: "mg/dL", date: point.date, ref: point.ref },
    ].concat(established.slice(0, 3).map((p) => ({
      label: "Risk category evidence", value: p.display, unit: null,
      date: p.firstOnset, ref: p.ref,
    }))).concat(onStatin.map((m) => ({
      label: "Cholesterol medication", value: m.display, unit: null,
      date: m.firstDate, ref: m.ref,
    }))),
    cannotSee: cannotSeeFor(tables, ["ldl"], [
      stalenessNote("LDL cholesterol", point.date, 550, today),
      settingNote(series, "LDL"),
      onStatin.length > 1
        ? onStatin.length + " cholesterol medications are listed as active at "
          + "the same time, which is worth reviewing with your care team."
        : null,
      "Goals are set by overall risk, not by the number alone. Your care team "
        + "may set a different target for you.",
    ]),
    plot: plot,
    extra: {
      goal: goal, gap: Number(gap.toFixed(1)), veryHighRisk: veryHighRisk,
      onStatin: onStatin.map((m) => m.display),
      establishedAscvd: established.map((p) => p.display),
    },
  }));
}
