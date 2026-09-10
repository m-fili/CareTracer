/* CareTracer scores - shared result shape and helpers.
 *
 * Every score function returns the same object, so one tile component can
 * render any of them and a score that declines to compute is a first-class
 * result rather than a special case the UI has to know about.
 */

export const STATUS = {
  OK: "ok",
  NOT_APPLICABLE: "not-applicable",   // outside the score's validated population
  INSUFFICIENT: "insufficient-data",  // required inputs missing
};

export const TRACK_COLOR = {
  cognitive: "#4F90B8",
  glycemic: "#E8985F",
  cardiovascular: "#D55D5D",
  kidney: "#8B7BB8",
  preventive: "#7C9BAA",
  general: "#0E5C6F",
};

export const SEVERITY_COLOR = {
  good: "#6FA88D",
  caution: "#D49A4E",
  alert: "#C56B72",
  neutral: "#6B7785",
};

export function result(base) {
  return Object.assign({
    id: null, label: null, short: null,
    category: "validated",       // "direct" | "validated"
    track: "general",
    guideline: null,
    status: STATUS.OK,
    value: null, unit: null, display: null,
    stage: null, stageLabel: null, severity: "neutral",
    trend: null,
    asOf: null, staleDays: null,
    inputs: [],                  // provenance: what the score actually read
    cannotSee: [],               // limitations, drawn from issues + inputs
    plot: null,
    extra: null,
  }, base);
}

export function seriesOf(tables, measureId) {
  return (tables.series || []).find((s) => s.measure === measureId) || null;
}

/** Latest point the validator did not reject. */
export function latestPlausible(series) {
  if (!series) return null;
  const ok = (series.points || []).filter((p) => p.plausible !== false);
  return ok.length ? ok[ok.length - 1] : null;
}

export function daysSince(iso, today) {
  if (!iso) return null;
  const now = today ? new Date(today) : new Date();
  return Math.round((now - new Date(iso)) / 86400000);
}

/** Annualised rate of change across the whole series, in units per year. */
export function ratePerYear(points) {
  const ok = (points || []).filter((p) => p.plausible !== false);
  if (ok.length < 2) return null;
  const first = ok[0];
  const last = ok[ok.length - 1];
  const years = (new Date(last.date) - new Date(first.date)) / (365.25 * 86400000);
  if (years <= 0) return null;
  return (last.value - first.value) / years;
}

/**
 * Least-squares slope in units per year over a recent window.
 *
 * The pipeline's own `direction` compares the last two points, which is fine
 * for a three-point instrument series and meaningless for 158 noisy lab
 * results: two adjacent readings can move opposite to a decade-long decline.
 * A regression over a window is what a clinician means by "the trend".
 */
export function rateOverWindow(points, years, today) {
  const ok = (points || []).filter((p) => p.plausible !== false && p.date);
  if (ok.length < 2) return null;

  const endMs = new Date(ok[ok.length - 1].date).getTime();
  const cutoff = endMs - (years || 3) * 365.25 * 86400000;
  const win = ok.filter((p) => new Date(p.date).getTime() >= cutoff);
  const use = win.length >= 2 ? win : ok;

  const t0 = new Date(use[0].date).getTime();
  const xs = use.map((p) => (new Date(p.date).getTime() - t0) / (365.25 * 86400000));
  const ys = use.map((p) => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) * (xs[i] - mx);
  }
  if (den === 0) return null;
  const slope = num / den;

  // R-squared. Real lab series are noisy, and a slope fitted through noise is
  // still a slope: without a goodness-of-fit gate the UI would confidently
  // report a rate the data does not support.
  const intercept = my - slope * mx;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = intercept + slope * xs[i];
    ssRes += (ys[i] - pred) * (ys[i] - pred);
    ssTot += (ys[i] - my) * (ys[i] - my);
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  return {
    slope: slope, n: n, mean: my, r2: r2,
    spanYears: xs[xs.length - 1] - xs[0],
    windowed: win.length >= 2,
  };
}

/* Two thresholds, because "which way is it going" and "how fast" are
 * different claims and the data supports them at different strengths.
 * Below DIRECTION the scatter dominates and even a direction is not asserted;
 * between DIRECTION and RATE the direction stands but no number is published. */
export const TREND_R2 = { DIRECTION: 0.25, RATE: 0.5 };

/**
 * Direction of travel and whether it is good news, derived from the regression
 * rather than the last two readings. A slope smaller than 1% of the measure's
 * own magnitude per year reads as flat, so noise does not present as a trend.
 */
export function trendOf(series, options) {
  if (!series) return null;
  const o = options || {};
  const fit = rateOverWindow(series.points, o.windowYears || 3, o.today);

  if (!fit) {
    return {
      direction: "flat", improving: null, glyph: "―", severity: "neutral",
      ratePerYear: null, n: (series.points || []).length, method: "insufficient",
    };
  }

  const reliable = fit.r2 >= (o.r2Floor === undefined ? TREND_R2.DIRECTION : o.r2Floor);
  const ratePublishable = fit.r2 >= (o.rateFloor === undefined ? TREND_R2.RATE : o.rateFloor);
  const threshold = Math.abs(fit.mean) * 0.01;

  let direction = fit.slope > threshold ? "up"
    : (fit.slope < -threshold ? "down" : "flat");
  if (!reliable) direction = "unclear";

  const better = series.betterDirection;
  const improving = (direction === "flat" || direction === "unclear"
    || !better || better === "neutral") ? null : (direction === better);

  const GLYPH = { up: "▲", down: "▼", flat: "―", unclear: "~" };

  return {
    direction: direction,
    improving: improving,
    glyph: GLYPH[direction],
    severity: improving === null ? "neutral" : (improving ? "good" : "caution"),
    // A rate is only published when the fit is strong enough to carry a number.
    ratePerYear: ratePublishable ? fit.slope : null,
    rawSlope: fit.slope,
    r2: Number(fit.r2.toFixed(3)),
    reliable: reliable,
    n: fit.n,
    windowYears: fit.windowed ? (o.windowYears || 3) : null,
    method: "least-squares",
    note: !reliable
      ? "Results vary too much between visits to describe a clear direction."
      : (!ratePublishable
          ? "Individual results vary enough that the direction is clearer than "
            + "the pace, so no rate per year is shown."
          : null),
  };
}

export function inputFrom(series, label, decimals) {
  const p = latestPlausible(series);
  if (!p) return null;
  return {
    label: label || (series && series.label),
    value: decimals === undefined ? p.value : Number(p.value.toFixed(decimals)),
    unit: series ? series.unit : null,
    date: p.date,
    ref: p.ref,
  };
}

/**
 * Limitations for this score, assembled from real data rather than prose.
 * Pulls the validator's own findings for the measures the score consumed.
 */
export function cannotSeeFor(tables, measureIds, extra) {
  const notes = [];
  const wanted = new Set(measureIds);
  const seen = new Set();

  (tables.issues || []).forEach(function (i) {
    if (!i.measure || !wanted.has(i.measure)) return;
    const key = i.rule + "|" + i.measure;
    if (seen.has(key)) return;
    seen.add(key);
    if (i.severity === "info") return;
    notes.push(i.message);
  });

  (extra || []).forEach((n) => { if (n) notes.push(n); });
  return notes;
}

/** Staleness note, phrased for a patient rather than an engineer. */
export function stalenessNote(label, iso, thresholdDays, today) {
  const days = daysSince(iso, today);
  if (days === null || days < (thresholdDays || 400)) return null;
  const years = days / 365.25;
  const age = years >= 1
    ? years.toFixed(1) + " years"
    : Math.round(days / 30) + " months";
  return label + " was last measured " + age + " ago, so this reflects that "
    + "visit rather than your health today.";
}
