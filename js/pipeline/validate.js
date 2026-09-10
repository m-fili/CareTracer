/* CareTracer pipeline - validation.
 *
 * Validation writes rows into an `issues` table; it never drops data. A value
 * outside physiological range is still the patient's record and still has to
 * be traceable. Flagging rather than deleting is what lets a score say what it
 * could not see, instead of quietly rendering a wrong number.
 *
 * Severity:
 *   error   - the value cannot be true; do not display it as a result
 *   warning - suspicious, or the surrounding metadata is wrong
 *   info    - worth surfacing to the user, not a defect
 */

import { daysBetween, ageAt } from "./normalize.js";

function issue(severity, rule, message, row, extra) {
  return Object.assign({
    severity: severity,
    rule: rule,
    message: message,
    table: row && row.table || null,
    measure: row && row.measure || null,
    ref: row && row.ref || null,
    date: row && row.date || null,
    source: row && row.source || null,
  }, extra || {});
}

/**
 * Range, unit and scale checks on every measured observation.
 * Sets `row.plausible` in place so downstream series can exclude bad points
 * without losing them.
 */
export function validateObservations(tables, dictionary, demographics) {
  const defs = dictionary.measures || {};
  const issues = [];

  ["labs", "vitals", "surveys", "social"].forEach(function (tableName) {
    (tables[tableName] || []).forEach(function (row) {
      row.table = tableName;
      row.plausible = true;

      if (row.value === null || row.value === undefined) {
        // Coded results (smoking status, urine colour) are legitimate.
        if (!row.valueCode) {
          issues.push(issue("warning", "missing-value",
            "Observation has neither a numeric value nor a coded result", row));
        }
        return;
      }

      const def = row.measure ? defs[row.measure] : null;
      if (!def) return;   // unmapped observations are reported separately

      const p = def.plausible;
      if (p) {
        const lo = p.min !== undefined ? p.min : -Infinity;
        const hi = p.max !== undefined ? p.max : Infinity;
        if (row.value < lo || row.value > hi) {
          // A lifespan measure legitimately spans infant to adult values, so
          // only flag it when it is impossible at the patient's age.
          const isLifespan = def.lifespan === true;
          const ageThen = demographics
            ? ageAt(demographics.birthDate, row.date) : null;
          const excusable = isLifespan && ageThen !== null && ageThen < 20;
          if (!excusable) {
            row.plausible = false;
            issues.push(issue("error", "implausible-value",
              def.label + " of " + row.value + " " + (row.unit || "")
              + " is outside the physiologically plausible range "
              + (p.min !== undefined ? p.min : "-inf") + " to "
              + (p.max !== undefined ? p.max : "inf"), row,
              { value: row.value, expectedMin: p.min, expectedMax: p.max }));
          }
        }
      }

      if (def.scale) {
        if (def.scale.integer && Math.abs(row.value - Math.round(row.value)) > 1e-9) {
          row.roundedValue = Math.round(row.value);
          issues.push(issue("warning", "non-integer-score",
            def.label + " reported as " + row.value
            + "; this instrument is scored in whole points (rounded to "
            + row.roundedValue + " for display)", row, { value: row.value }));
        }
        if (def.scale.max !== undefined && row.value > def.scale.max) {
          row.plausible = false;
          issues.push(issue("error", "score-above-scale",
            def.label + " of " + row.value + " exceeds the instrument maximum of "
            + def.scale.max, row, { value: row.value }));
        }
      }

      if (def.ucum && row.ucum && row.ucum !== def.ucum) {
        issues.push(issue("warning", "unit-mismatch",
          def.label + " reported in '" + row.ucum + "' but the dictionary expects '"
          + def.ucum + "'; values may not be comparable", row));
      }
    });
  });

  return issues;
}

/** Measurement cadence that does not match what the test can actually show. */
export function validateCadence(series, dictionary) {
  const defs = dictionary.measures || {};
  const issues = [];
  series.forEach(function (s) {
    const def = defs[s.measure];
    if (!def || !def.minIntervalDays || s.points.length < 3) return;
    let tight = 0;
    let example = null;
    for (let i = 1; i < s.points.length; i++) {
      const gap = daysBetween(s.points[i - 1].date, s.points[i].date);
      if (gap >= 0 && gap < def.minIntervalDays) {
        tight += 1;
        if (!example) example = s.points[i].date;
      }
    }
    if (tight) {
      issues.push(issue("warning", "implausible-cadence",
        tight + " of " + (s.points.length - 1) + " " + def.label
        + " intervals are shorter than " + def.minIntervalDays
        + " days; this measure reflects a longer window, so repeated results "
        + "may be duplicates or back-filled", { table: def.table, measure: s.measure,
          ref: s.ref, date: example }, { intervals: tight }));
    }
  });
  return issues;
}

/** Referential integrity: every reference must resolve inside the record. */
export function validateReferences(tables, knownRefs) {
  const issues = [];
  const check = function (row, field, tableName) {
    const value = row[field];
    if (!value) return;
    // A conditional reference ("Practitioner?identifier=...") names a resource
    // by business identifier. It is valid FHIR and legitimately points outside
    // this record, so it is not an integrity failure.
    if (typeof value === "object" && value.external) return;
    if (!knownRefs.has(value)) {
      issues.push(issue("warning", "unresolved-reference",
        field + " points to " + value + ", which is not present in this record",
        Object.assign({}, row, { table: tableName })));
    }
  };
  ["labs", "vitals", "surveys", "social", "other"].forEach(function (t) {
    (tables[t] || []).forEach((r) => check(r, "encounterRef", t));
  });
  (tables.conditions || []).forEach((r) => check(r, "encounterRef", "conditions"));
  (tables.medications || []).forEach(function (r) {
    check(r, "encounterRef", "medications");
    check(r, "reasonRef", "medications");
  });
  (tables.procedures || []).forEach((r) => check(r, "encounterRef", "procedures"));
  (tables.encounters || []).forEach(function (r) {
    check(r, "practitionerRef", "encounters");
    check(r, "organizationRef", "encounters");
  });
  return issues;
}

/** Observations whose LOINC is not in the dictionary: coverage reporting. */
export function validateCoverage(tables) {
  const unmapped = new Map();
  ["labs", "vitals", "surveys", "social", "other"].forEach(function (t) {
    (tables[t] || []).forEach(function (row) {
      if (row.measure) return;
      const key = (row.loinc || "no-loinc") + "||" + (row.display || "?");
      const e = unmapped.get(key) || { loinc: row.loinc, display: row.display, count: 0, table: t, ref: row.ref };
      e.count += 1;
      unmapped.set(key, e);
    });
  });
  return Array.from(unmapped.values())
    .sort((a, b) => b.count - a.count)
    .map((u) => issue("info", "unmapped-observation",
      (u.count > 1 ? u.count + " observations" : "1 observation") + " of '"
      + (u.display || "unknown") + "' (LOINC " + (u.loinc || "none")
      + ") are not in the measure dictionary and will not appear as a score",
      { table: u.table, ref: u.ref }, { count: u.count, loinc: u.loinc }));
}

/** Problems whose index diagnosis is missing but whose complication is present. */
export function validateProblems(problems) {
  const issues = [];
  const active = problems.filter((p) => p.clinical && p.active);
  const text = active.map((p) => (p.display || "").toLowerCase());
  const hasDiabetes = text.some((t) => /diabetes mellitus type (2|ii)/.test(t));
  const hasDmComplication = text.some((t) => /due to (type (2|ii) )?diabetes/.test(t));
  if (hasDmComplication && !hasDiabetes) {
    issues.push(issue("warning", "missing-index-diagnosis",
      "The record contains complications attributed to diabetes but no diabetes "
      + "diagnosis; the index diagnosis may predate the exported history window",
      { table: "problems" }));
  }
  return issues;
}

export function runValidation(tables, dictionary, knownRefs) {
  return []
    .concat(validateObservations(tables, dictionary, tables.demographics))
    .concat(validateReferences(tables, knownRefs))
    .concat(validateCoverage(tables))
    .concat(validateProblems(tables.problems || []));
}
