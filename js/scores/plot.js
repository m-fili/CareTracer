/* CareTracer scores - plot geometry.
 *
 * Turns a measure series into the exact chart geometry the prototype draws:
 * viewBox 0 0 340 160, plot area x 40..320, y 12..130, reference bands behind
 * the trajectory, and the final point emphasised with a labelled halo.
 *
 * This module computes coordinates only. It renders no markup, so the same
 * geometry can drive an inline SVG tile, a detail view, or a print sheet.
 */

export const CHART = {
  width: 340, height: 160,
  x0: 40, x1: 320,      // plot area, left/right
  y0: 12, y1: 130,      // plot area, top/bottom
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function monthYear(iso) {
  if (!iso) return "";
  const [y, m] = iso.split("-").map(Number);
  return MONTHS[(m || 1) - 1] + " " + y;
}

function niceTicks(min, max, count) {
  if (!(max > min)) return [min];
  const raw = (max - min) / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag)
    .find((s) => s >= raw) || mag * 10;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    ticks.push(Number(v.toFixed(6)));
  }
  return ticks;
}

/**
 * @param {Array}  points  [{date, value, ref, plausible}] ascending by date
 * @param {Object} opts
 *   domain      [min,max] forced y range; otherwise derived with padding
 *   bands       [{from,to,color,label}] reference bands in value space
 *   color       trajectory colour
 *   axisLabel   rotated y-axis caption
 *   decimals    label precision for the final value
 *   dropImplausible  exclude points flagged by the validator (default true)
 */
export function buildPlot(points, opts) {
  const o = opts || {};
  const drop = o.dropImplausible !== false;
  const used = (points || []).filter((p) =>
    p && typeof p.value === "number" && (!drop || p.plausible !== false));

  if (!used.length) return null;

  const values = used.map((p) => p.value);
  let lo, hi;
  if (o.domain) {
    lo = o.domain[0]; hi = o.domain[1];
  } else {
    lo = Math.min.apply(null, values);
    hi = Math.max.apply(null, values);
    const pad = (hi - lo) * 0.18 || Math.abs(hi) * 0.1 || 1;
    lo -= pad; hi += pad;
    if (o.clampMin !== undefined) lo = Math.max(lo, o.clampMin);
  }
  if (hi === lo) { hi = lo + 1; lo -= 1; }

  const t0 = new Date(used[0].date).getTime();
  const t1 = new Date(used[used.length - 1].date).getTime();
  const span = t1 - t0;

  const sx = (iso) => span > 0
    ? CHART.x0 + (CHART.x1 - CHART.x0) * ((new Date(iso).getTime() - t0) / span)
    : (CHART.x0 + CHART.x1) / 2;
  const sy = (v) =>
    CHART.y1 - (CHART.y1 - CHART.y0) * ((v - lo) / (hi - lo));

  const plotted = used.map((p) => ({
    x: Number(sx(p.date).toFixed(2)),
    y: Number(sy(p.value).toFixed(2)),
    value: p.value, date: p.date, ref: p.ref, source: p.source,
  }));

  // Reference bands clipped to the visible domain.
  const bands = (o.bands || []).map(function (b) {
    const top = Math.min(b.to === undefined ? hi : b.to, hi);
    const bottom = Math.max(b.from === undefined ? lo : b.from, lo);
    if (bottom >= top) return null;
    const yTop = sy(top);
    const yBottom = sy(bottom);
    return {
      y: Number(yTop.toFixed(2)),
      height: Number((yBottom - yTop).toFixed(2)),
      color: b.color, opacity: b.opacity || 0.12, label: b.label || null,
    };
  }).filter(Boolean);

  const yTicks = niceTicks(lo, hi, 5).map((v) => ({
    value: v, y: Number(sy(v).toFixed(2)),
    label: String(Number(v.toFixed(o.tickDecimals !== undefined ? o.tickDecimals : 0))),
  }));

  // Three x labels at most: first, midpoint, last.
  //
  // The midpoint is taken in TIME, not by index. Sampling is rarely even — this
  // record has weekly labs in its final months and yearly ones before that — so
  // the middle element of the array sits almost on top of the last one and the
  // two labels overlap. A label is then dropped outright if it would still land
  // within 46px of a neighbour, which is roughly the width of "Sep 1981".
  const first = plotted[0];
  const lastPt = plotted[plotted.length - 1];
  const candidates = [
    { x: first.x, date: first.date, anchor: "start" },
  ];
  if (plotted.length >= 3 && span > 0) {
    const midX = (CHART.x0 + CHART.x1) / 2;
    let nearest = plotted[0];
    let best = Infinity;
    plotted.forEach(function (p) {
      const d = Math.abs(p.x - midX);
      if (d < best) { best = d; nearest = p; }
    });
    candidates.push({ x: nearest.x, date: nearest.date, anchor: "middle" });
  }
  candidates.push({ x: lastPt.x, date: lastPt.date, anchor: "end" });

  const MIN_GAP = 46;
  const xTicks = [];
  candidates.forEach(function (c, i) {
    if (i === 0) { xTicks.push(c); return; }
    const isLast = i === candidates.length - 1;
    const prev = xTicks[xTicks.length - 1];
    if (Math.abs(c.x - prev.x) < MIN_GAP) {
      // Keep the endpoints; a crowded midpoint is the one that goes.
      if (isLast) xTicks.pop(); else return;
    }
    xTicks.push(c);
  });

  xTicks.forEach(function (t) { t.label = monthYear(t.date); });

  const last = plotted[plotted.length - 1];
  const dec = o.decimals !== undefined ? o.decimals : 0;

  return {
    width: CHART.width, height: CHART.height,
    area: { x0: CHART.x0, y0: CHART.y0, x1: CHART.x1, y1: CHART.y1 },
    domain: [lo, hi],
    color: o.color || "#0E5C6F",
    axisLabel: o.axisLabel || null,
    bands: bands,
    yTicks: yTicks,
    xTicks: xTicks,
    points: plotted,
    // Circles on every point reads as noise past a dozen; beyond that only
    // the endpoints are marked and the line carries the shape.
    markEvery: plotted.length <= 12,
    polyline: plotted.map((p) => p.x + "," + p.y).join(" "),
    last: {
      x: last.x, y: last.y, value: last.value,
      label: Number(last.value).toFixed(dec), date: last.date, ref: last.ref,
      // Halo is r=6; offset the label so it clears the marker.
      labelX: Number((last.x - 9).toFixed(2)),
      labelY: Number((last.y - 9).toFixed(2)),
    },
    excluded: (points || []).length - used.length,
  };
}

/** Two series on one chart (systolic over diastolic). */
export function buildDualPlot(seriesA, seriesB, opts) {
  const o = opts || {};
  const all = (seriesA.points || []).concat(seriesB.points || [])
    .filter((p) => p && typeof p.value === "number" && p.plausible !== false);
  if (!all.length) return null;

  const values = all.map((p) => p.value);
  const lo = o.domain ? o.domain[0] : Math.min.apply(null, values) - 12;
  const hi = o.domain ? o.domain[1] : Math.max.apply(null, values) + 12;

  const base = buildPlot(seriesA.points, Object.assign({}, o, { domain: [lo, hi] }));
  if (!base) return null;
  const second = buildPlot(seriesB.points, Object.assign({}, o, { domain: [lo, hi] }));

  base.second = second ? {
    polyline: second.polyline, points: second.points,
    last: second.last, color: o.colorB || "#7C9BAA",
    label: seriesB.short || seriesB.label,
  } : null;
  base.label = seriesA.short || seriesA.label;
  return base;
}
