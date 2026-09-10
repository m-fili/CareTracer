/* CareTracer pipeline - derived tables.
 *
 * Everything here is computed from extracted rows rather than read from FHIR,
 * because the source does not provide it. The problem list is the clearest
 * case: Synthea emits only encounter diagnoses and never a problem-list-item,
 * so the list a patient would recognise as "my conditions" has to be derived.
 */

import { daysBetween } from "./normalize.js";

/** True when a condition is a clinical problem rather than an SDOH or
 *  administrative finding. Coded exclusions win; text is the fallback. */
export function isClinicalCondition(row, nonclinical) {
  if (row.snomed && nonclinical.snomed && nonclinical.snomed[row.snomed]) return false;
  const text = (row.display || "").toLowerCase();
  if (!text) return false;
  return !(nonclinical.patterns || []).some((p) => text.indexOf(p) >= 0);
}

/**
 * Collapse repeated encounter diagnoses into one row per distinct condition.
 *
 * A condition counts as resolved only when every recorded instance carries an
 * abatement date; one open instance means it is still active.
 */
export function deriveProblems(conditions, nonclinical) {
  const byCode = new Map();

  conditions.forEach(function (c) {
    const key = c.snomed || c.icd10 || c.display;
    if (!key) return;
    let p = byCode.get(key);
    if (!p) {
      p = {
        key: key, snomed: c.snomed, icd10: c.icd10, display: c.display,
        firstOnset: c.onset, lastRecorded: c.recorded || c.onset,
        occurrences: 0, abatement: null, allAbated: true,
        sources: new Set(), refs: [],
        clinical: isClinicalCondition(c, nonclinical),
      };
      byCode.set(key, p);
    }
    p.occurrences += 1;
    p.sources.add(c.source);
    p.refs.push(c.ref);
    if (c.onset && (!p.firstOnset || c.onset < p.firstOnset)) p.firstOnset = c.onset;
    const seen = c.recorded || c.onset;
    if (seen && (!p.lastRecorded || seen > p.lastRecorded)) p.lastRecorded = seen;
    if (c.abatement) {
      if (!p.abatement || c.abatement > p.abatement) p.abatement = c.abatement;
    } else {
      p.allAbated = false;
    }
  });

  return Array.from(byCode.values()).map(function (p) {
    return {
      key: p.key, snomed: p.snomed, icd10: p.icd10, display: p.display,
      firstOnset: p.firstOnset, lastRecorded: p.lastRecorded,
      occurrences: p.occurrences,
      active: !p.allAbated,
      resolvedOn: p.allAbated ? p.abatement : null,
      clinical: p.clinical,
      sources: Array.from(p.sources),
      ref: p.refs[0],
      refs: p.refs,
    };
  }).sort(function (a, b) {
    return (a.firstOnset || "9999").localeCompare(b.firstOnset || "9999");
  });
}

/** One row per drug: first prescribed, last touched, currently active. */
export function deriveMedicationEpisodes(medications) {
  const byDrug = new Map();
  medications.forEach(function (m) {
    const key = m.rxnorm || m.display;
    if (!key) return;
    let e = byDrug.get(key);
    if (!e) {
      e = { key: key, rxnorm: m.rxnorm, display: m.display,
            firstDate: m.date, lastDate: m.date, orders: 0,
            active: false, dosageText: m.dosageText, ref: m.ref,
            sources: new Set() };
      byDrug.set(key, e);
    }
    e.orders += 1;
    e.sources.add(m.source);
    if (m.date && (!e.firstDate || m.date < e.firstDate)) e.firstDate = m.date;
    if (m.date && (!e.lastDate || m.date > e.lastDate)) e.lastDate = m.date;
    if (m.isActive) e.active = true;
    if (m.dosageText && !e.dosageText) e.dosageText = m.dosageText;
  });
  return Array.from(byDrug.values()).map(function (e) {
    return Object.assign({}, e, { sources: Array.from(e.sources) });
  }).sort(function (a, b) {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (b.lastDate || "").localeCompare(a.lastDate || "");
  });
}

/**
 * Per-measure time series with first/last, direction of travel, and whether
 * the change is an improvement given the measure's betterDirection.
 * This is what a trajectory chart or a score tile reads.
 */
export function deriveSeries(observationTables, dictionary) {
  const defs = dictionary.measures || {};
  const byMeasure = new Map();

  ["labs", "vitals", "surveys", "social"].forEach(function (table) {
    (observationTables[table] || []).forEach(function (row) {
      if (!row.measure || row.value === null || row.value === undefined) return;
      if (!byMeasure.has(row.measure)) byMeasure.set(row.measure, []);
      byMeasure.get(row.measure).push({
        date: row.date, value: row.value, unit: row.unit,
        ref: row.ref, source: row.source, plausible: row.plausible !== false,
      });
    });
  });

  const series = [];
  byMeasure.forEach(function (points, measureId) {
    points.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const def = defs[measureId] || {};
    const usable = points.filter((p) => p.plausible);
    const first = points[0];
    const last = points[points.length - 1];
    const prev = points.length > 1 ? points[points.length - 2] : null;

    let direction = "flat";
    if (prev) {
      if (last.value > prev.value) direction = "up";
      else if (last.value < prev.value) direction = "down";
    }
    let improving = null;
    if (direction !== "flat" && def.betterDirection && def.betterDirection !== "neutral") {
      improving = direction === def.betterDirection;
    }

    series.push({
      measure: measureId,
      label: def.label || measureId,
      short: def.short || measureId,
      unit: def.unit || (last ? last.unit : null),
      track: def.track || null,
      table: def.table || null,
      betterDirection: def.betterDirection || "neutral",
      n: points.length,
      nPlausible: usable.length,
      nImplausible: points.length - usable.length,
      firstDate: first ? first.date : null,
      firstValue: first ? first.value : null,
      lastDate: last ? last.date : null,
      lastValue: last ? last.value : null,
      latestPlausibleValue: usable.length ? usable[usable.length - 1].value : null,
      latestPlausibleDate: usable.length ? usable[usable.length - 1].date : null,
      direction: direction,
      improving: improving,
      referenceRange: def.referenceRange || null,
      scale: def.scale || null,
      points: points,
      ref: last ? last.ref : null,
    });
  });

  return series.sort((a, b) => a.label.localeCompare(b.label));
}

/** One row per contributing health system. Backs the multi-EHR claim.
 *  `rows` counts table rows, which exceeds resource count because component
 *  observations (blood pressure) expand to one row per component. */
export function deriveSources(tables) {
  const bySource = new Map();
  const add = function (row) {
    if (!row || !row.source) return;
    let s = bySource.get(row.source);
    if (!s) { s = { source: row.source, rows: 0, firstDate: null, lastDate: null }; bySource.set(row.source, s); }
    s.rows += 1;
    const d = row.date || row.start || row.onset || row.firstOnset || null;
    if (d) {
      if (!s.firstDate || d < s.firstDate) s.firstDate = d;
      if (!s.lastDate || d > s.lastDate) s.lastDate = d;
    }
  };
  Object.keys(tables).forEach(function (name) {
    const t = tables[name];
    if (Array.isArray(t)) t.forEach(add);
    else if (t && t.source) add(t);
  });
  return Array.from(bySource.values()).sort((a, b) => b.rows - a.rows);
}

/** Encounter cadence, useful for spotting a record that has gone quiet. */
export function deriveEncounterGaps(encounters) {
  const dated = encounters.filter((e) => e.start).slice().sort(
    (a, b) => a.start.localeCompare(b.start));
  const gaps = [];
  for (let i = 1; i < dated.length; i++) {
    gaps.push(daysBetween(dated[i - 1].start, dated[i].start));
  }
  return {
    total: dated.length,
    firstDate: dated.length ? dated[0].start : null,
    lastDate: dated.length ? dated[dated.length - 1].start : null,
    medianGapDays: gaps.length
      ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null,
    maxGapDays: gaps.length ? Math.max.apply(null, gaps) : null,
  };
}
