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

/* Encounter class (HL7 v3 ActCode) -> the setting a result was taken in.
 * An outpatient value and an inpatient value answer different clinical
 * questions, so the setting has to travel with the row. */
const SETTING_BY_CLASS = {
  AMB: "ambulatory", VR: "ambulatory", HH: "ambulatory", FLD: "ambulatory",
  IMP: "inpatient", ACUTE: "inpatient", NONAC: "inpatient",
  SS: "inpatient", OBSENC: "inpatient",
  EMER: "emergency",
};

/** Stamp each observation row with the setting its encounter took place in. */
export function tagSettings(observationTables, encounters) {
  const byRef = new Map((encounters || []).map((e) => [e.ref, e]));
  ["labs", "vitals", "surveys", "social", "other"].forEach(function (table) {
    (observationTables[table] || []).forEach(function (row) {
      const enc = typeof row.encounterRef === "string" ? byRef.get(row.encounterRef) : null;
      row.encounterClass = enc ? enc.classCode : null;
      row.encounterType = enc ? enc.type : null;
      row.setting = enc ? (SETTING_BY_CLASS[enc.classCode] || "unknown") : "unknown";
    });
  });
}

/**
 * Collapse duplicate results for the same measure at the same encounter.
 *
 * Synthea orders overlapping panels at one visit and draws each value
 * independently, so a single encounter can report an eGFR of 54 and 18 from
 * what should be one specimen. Real labs do not do this, and plotting both
 * makes a chronic trend unreadable.
 *
 * The duplicates are marked, never deleted, and the row kept is the ACTUAL
 * observation nearest the group median rather than a synthesised average, so
 * every plotted point still cites a real resource.
 */
export function collapseSameEncounter(observationTables, dictionary) {
  const defs = (dictionary && dictionary.measures) || {};
  const tally = {};

  ["labs", "vitals", "surveys", "social"].forEach(function (table) {
    const groups = new Map();
    (observationTables[table] || []).forEach(function (r) {
      if (!r.measure || r.value === null || r.value === undefined) return;
      // Same specimen means same encounter AND same day. An inpatient
      // admission is one Encounter spanning several days, so keying on the
      // encounter alone would collapse a week of daily labs into one point.
      const scope = (typeof r.encounterRef === "string" && r.encounterRef)
        ? r.encounterRef : "no-encounter";
      const key = r.measure + "|" + scope + "|" + (r.date || "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    });

    groups.forEach(function (group) {
      if (group.length < 2) return;
      const sorted = group.map((g) => g.value).slice().sort((a, b) => a - b);
      const mid = sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

      let keep = group[0];
      let best = Infinity;
      group.forEach(function (g) {
        const d = Math.abs(g.value - mid);
        if (d < best) { best = d; keep = g; }
      });

      const spread = sorted[sorted.length - 1] - sorted[0];
      group.forEach(function (g) {
        if (g === keep) {
          g.representative = true;
          g.collapsedFrom = group.length;
          g.collapsedSpread = Number(spread.toFixed(3));
        } else {
          g.superseded = true;
          g.supersededBy = keep.ref;
        }
      });

      const t = tally[keep.measure] || (tally[keep.measure] = {
        encounters: 0, dropped: 0, maxSpread: 0, unit: keep.unit, ref: keep.ref,
      });
      t.encounters += 1;
      t.dropped += group.length - 1;
      if (spread > t.maxSpread) t.maxSpread = spread;
    });
  });

  return Object.keys(tally).map(function (measure) {
    const t = tally[measure];
    const label = (defs[measure] && defs[measure].label) || measure;
    return {
      severity: "warning", rule: "duplicate-at-encounter", measure: measure,
      table: (defs[measure] && defs[measure].table) || null, ref: t.ref, date: null,
      message: t.encounters + " visit" + (t.encounters === 1 ? "" : "s")
        + " reported more than one " + label + " result from what should be a "
        + "single specimen; " + t.dropped + " duplicate"
        + (t.dropped === 1 ? " was" : "s were") + " set aside and the value "
        + "closest to the median kept (largest disagreement "
        + t.maxSpread.toFixed(1) + (t.unit ? " " + t.unit : "") + ").",
      encounters: t.encounters, dropped: t.dropped,
      maxSpread: Number(t.maxSpread.toFixed(2)),
    };
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
      if (row.superseded) return;   // duplicate specimen, kept in the table
      if (!byMeasure.has(row.measure)) byMeasure.set(row.measure, []);
      byMeasure.get(row.measure).push({
        date: row.date, value: row.value, unit: row.unit,
        ref: row.ref, source: row.source, plausible: row.plausible !== false,
        setting: row.setting || "unknown",
        encounterClass: row.encounterClass || null,
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
      bySetting: points.reduce(function (acc, p) {
        acc[p.setting] = (acc[p.setting] || 0) + 1; return acc;
      }, {}),
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
