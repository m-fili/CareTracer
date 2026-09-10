/* CareTracer pipeline - public API.
 *
 *   import { buildTables } from "./js/pipeline/index.js";
 *   const result = buildTables(resources, { measures, nonclinical });
 *
 * The dictionary is injected rather than loaded here, so the same code runs
 * unchanged in the browser (dictionary fetched) and under Node (dictionary
 * read from disk). That is what lets the verification harness exercise the
 * exact code path the app uses.
 *
 * Pure and deterministic: same resources in, same tables out.
 */

import { buildUuidMap, indexMeasures, refOf } from "./normalize.js";
import * as extract from "./extract.js";
import * as derive from "./derive.js";
import { runValidation, validateCadence } from "./validate.js";

export const PIPELINE_VERSION = "1.0.0";

function defaultDecoder() {
  if (typeof atob === "function") {
    return function (b64) {
      const bin = atob(b64);
      try {
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        return new TextDecoder("utf-8").decode(bytes);
      } catch (e) {
        return bin;
      }
    };
  }
  if (typeof Buffer !== "undefined") {
    return (b64) => Buffer.from(b64, "base64").toString("utf-8");
  }
  return null;
}

/**
 * @param {Array}  resources  FHIR resources (from IndexedDB or NDJSON)
 * @param {Object} dictionary { measures, nonclinical }
 * @param {Object} [options]  { decodeBase64, includeNoteText }
 */
export function buildTables(resources, dictionary, options) {
  const opts = options || {};
  const started = Date.now();

  const measures = dictionary.measures || dictionary;
  const nonclinical = dictionary.nonclinical || { snomed: {}, patterns: [] };
  const index = indexMeasures(measures);
  const uuidMap = buildUuidMap(resources);
  const knownRefs = new Set(resources.map(refOf).filter(Boolean));
  const decode = opts.decodeBase64 || defaultDecoder();

  const patient = resources.find((r) => r.resourceType === "Patient") || null;
  const demographics = extract.extractDemographics(patient);

  const obs = extract.extractObservations(resources, uuidMap, index);

  const tables = {
    demographics: demographics,
    encounters: extract.extractEncounters(resources, uuidMap),
    conditions: extract.extractConditions(resources, uuidMap),
    labs: obs.labs,
    vitals: obs.vitals,
    surveys: obs.surveys,
    social: obs.social,
    other: obs.other,
    medications: extract.extractMedications(resources, uuidMap),
    procedures: extract.extractProcedures(resources, uuidMap),
    immunizations: extract.extractImmunizations(resources, uuidMap),
    imaging: extract.extractImaging(resources, uuidMap),
    documents: extract.extractDocuments(resources, uuidMap,
      opts.includeNoteText === false ? null : decode),
    allergies: extract.extractAllergies(resources),
    careplans: extract.extractCareTeam(resources, uuidMap),
  };

  tables.problems = derive.deriveProblems(tables.conditions, nonclinical);
  tables.med_episodes = derive.deriveMedicationEpisodes(tables.medications);

  // Validation runs before series so implausible points are already marked
  // and can be excluded from "latest value" without being deleted.
  const issues = runValidation(tables, measures, knownRefs);

  tables.series = derive.deriveSeries(tables, measures);
  const cadenceIssues = validateCadence(tables.series, measures);

  tables.sources = derive.deriveSources(tables);
  tables.issues = issues.concat(cadenceIssues);

  const encounterStats = derive.deriveEncounterGaps(tables.encounters);

  return {
    version: PIPELINE_VERSION,
    builtAt: new Date().toISOString(),
    buildMs: Date.now() - started,
    tables: tables,
    summary: summarize(tables, encounterStats),
  };
}

function summarize(tables, encounterStats) {
  const activeProblems = (tables.problems || []).filter((p) => p.clinical && p.active);
  const bySeverity = { error: 0, warning: 0, info: 0 };
  (tables.issues || []).forEach((i) => { bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1; });

  const counts = {};
  Object.keys(tables).forEach(function (k) {
    if (Array.isArray(tables[k])) counts[k] = tables[k].length;
    else if (tables[k]) counts[k] = 1;
  });

  return {
    patient: tables.demographics ? tables.demographics.name : null,
    birthDate: tables.demographics ? tables.demographics.birthDate : null,
    rowCounts: counts,
    firstEncounter: encounterStats.firstDate,
    lastEncounter: encounterStats.lastDate,
    yearsCovered: encounterStats.firstDate && encounterStats.lastDate
      ? Number(encounterStats.lastDate.slice(0, 4)) - Number(encounterStats.firstDate.slice(0, 4))
      : null,
    systems: (tables.sources || []).length,
    activeProblems: activeProblems.length,
    totalProblems: (tables.problems || []).filter((p) => p.clinical).length,
    activeMedications: (tables.med_episodes || []).filter((m) => m.active).length,
    measuresTracked: (tables.series || []).length,
    issues: bySeverity,
  };
}

export { extract, derive };
