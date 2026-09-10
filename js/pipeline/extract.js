/* CareTracer pipeline - extraction.
 *
 * Raw FHIR resources in, typed rows out. One function per resource type.
 * No clinical judgement happens here beyond routing observations to the right
 * table; interpretation lives in derive.js and validate.js.
 */

import {
  SYSTEM, refOf, sourceOf, codings, codeIn, displayOf,
  normalizeRef, dateOf, quantityOf, matchMeasure, ageAt,
} from "./normalize.js";

const base = (r) => ({ ref: refOf(r), id: r.id, source: sourceOf(r) });

/* ------------------------------------------------------------ demographics */

export function extractDemographics(patient) {
  if (!patient) return null;
  const name = (patient.name || [])[0] || {};
  const addr = (patient.address || []).find((a) => a.use !== "old")
    || (patient.address || [])[0] || {};

  const ext = {};
  (patient.extension || []).forEach(function (e) {
    if (!e.url) return;
    const key = e.url.split("/").pop();
    if (e.valueCode) { ext[key] = e.valueCode; return; }
    const omb = (e.extension || []).find((x) => x.url === "ombCategory");
    const text = (e.extension || []).find((x) => x.url === "text");
    if (omb && omb.valueCoding) ext[key] = omb.valueCoding.display;
    else if (text) ext[key] = text.valueString;
  });

  return Object.assign(base(patient), {
    name: name.text || [(name.given || []).join(" "), name.family].filter(Boolean).join(" "),
    given: (name.given || [])[0] || null,
    family: name.family || null,
    birthDate: patient.birthDate || null,
    age: ageAt(patient.birthDate, new Date().toISOString().slice(0, 10)),
    gender: patient.gender || null,
    deceased: !!patient.deceasedDateTime || patient.deceasedBoolean === true,
    maritalStatus: displayOf(patient.maritalStatus) || null,
    race: ext["us-core-race"] || null,
    ethnicity: ext["us-core-ethnicity"] || null,
    birthSex: ext["us-core-birthsex"] || null,
    city: addr.city || null,
    state: addr.state || null,
    postalCode: addr.postalCode || null,
    language: displayOf(((patient.communication || [])[0] || {}).language) || null,
    identifiers: (patient.identifier || []).map(function (i) {
      return { type: displayOf(i.type) || i.system || "id", value: i.value };
    }),
  });
}

/* -------------------------------------------------------------- encounters */

export function extractEncounters(resources, uuidMap) {
  return resources.filter((r) => r.resourceType === "Encounter").map(function (r) {
    const period = r.period || {};
    const participant = (r.participant || [])[0] || {};
    return Object.assign(base(r), {
      start: period.start ? period.start.slice(0, 10) : dateOf(r),
      end: period.end ? period.end.slice(0, 10) : null,
      status: r.status || null,
      classCode: (r.class && r.class.code) || null,
      classDisplay: (r.class && r.class.display) || null,
      type: displayOf((r.type || [])[0]) || null,
      typeCode: codeIn((r.type || [])[0], SYSTEM.SNOMED),
      reason: displayOf((r.reasonCode || [])[0]) || null,
      practitionerRef: normalizeRef(participant.individual, uuidMap),
      organizationRef: normalizeRef(r.serviceProvider, uuidMap),
    });
  });
}

/* -------------------------------------------------------------- conditions */

export function extractConditions(resources, uuidMap) {
  return resources.filter((r) => r.resourceType === "Condition").map(function (r) {
    return Object.assign(base(r), {
      code: codeIn(r.code, SYSTEM.SNOMED) || codeIn(r.code, SYSTEM.ICD10)
        || (codings(r.code)[0] || {}).code || null,
      codeSystem: (codings(r.code)[0] || {}).system || null,
      snomed: codeIn(r.code, SYSTEM.SNOMED),
      icd10: codeIn(r.code, SYSTEM.ICD10),
      display: displayOf(r.code),
      category: displayOf((r.category || [])[0])
        || ((codings((r.category || [])[0])[0] || {}).code) || null,
      clinicalStatus: displayOf(r.clinicalStatus) || null,
      verificationStatus: displayOf(r.verificationStatus) || null,
      onset: r.onsetDateTime ? r.onsetDateTime.slice(0, 10) : null,
      abatement: r.abatementDateTime ? r.abatementDateTime.slice(0, 10) : null,
      recorded: r.recordedDate ? r.recordedDate.slice(0, 10) : null,
      encounterRef: normalizeRef(r.encounter, uuidMap),
    });
  });
}

/* ------------------------------------------------- observations -> 3 tables */

/**
 * Observations split by category into labs / vitals / surveys / social / other.
 *
 * Component-bearing observations (blood pressure above all) are exploded into
 * one row per component. Reading `valueQuantity` on a BP panel yields nothing,
 * which is how blood pressure silently disappears from a naive extractor.
 */
export function extractObservations(resources, uuidMap, index) {
  const out = { labs: [], vitals: [], surveys: [], social: [], other: [] };

  resources.filter((r) => r.resourceType === "Observation").forEach(function (r) {
    const category = ((codings((r.category || [])[0])[0] || {}).code) || "other";
    const when = dateOf(r);
    const common = Object.assign(base(r), {
      date: when,
      status: r.status || null,
      encounterRef: normalizeRef(r.encounter, uuidMap),
      category: category,
    });

    const rows = [];

    if (Array.isArray(r.component) && r.component.length) {
      r.component.forEach(function (comp) {
        const q = quantityOf(comp.valueQuantity);
        rows.push(Object.assign({}, common, {
          panelLoinc: (codings(r.code).find((c) => c.system === SYSTEM.LOINC) || {}).code || null,
          panelDisplay: displayOf(r.code),
          concept: comp.code,
          display: displayOf(comp.code),
          value: q ? q.value : null,
          unit: q ? q.unit : null,
          ucum: q ? q.ucum : null,
          valueCode: comp.valueCodeableConcept ? displayOf(comp.valueCodeableConcept) : null,
          isComponent: true,
        }));
      });
    } else {
      const q = quantityOf(r.valueQuantity);
      rows.push(Object.assign({}, common, {
        panelLoinc: null,
        panelDisplay: null,
        concept: r.code,
        display: displayOf(r.code),
        value: q ? q.value : null,
        unit: q ? q.unit : null,
        ucum: q ? q.ucum : null,
        valueCode: r.valueCodeableConcept ? displayOf(r.valueCodeableConcept) : null,
        isComponent: false,
      }));
    }

    rows.forEach(function (row) {
      const match = matchMeasure(row.concept, index);
      row.loinc = (row.concept ? (codings(row.concept)
        .find((c) => c.system === SYSTEM.LOINC) || {}).code : null) || null;
      row.measure = match ? match.id : null;
      row.measureLabel = match ? match.def.label : null;
      row.track = match ? (match.def.track || null) : null;
      row.expectedUnit = match ? (match.def.unit || null) : null;
      delete row.concept;

      const table = match && match.def.table
        ? match.def.table
        : ({ laboratory: "labs", "vital-signs": "vitals", survey: "surveys",
             "social-history": "social" }[row.category] || "other");
      (out[table] || out.other).push(row);
    });
  });

  Object.keys(out).forEach(function (k) {
    out[k].sort(function (a, b) { return (a.date || "").localeCompare(b.date || ""); });
  });
  return out;
}

/* ------------------------------------------------------------- medications */

export function extractMedications(resources, uuidMap) {
  const rows = [];
  resources.forEach(function (r) {
    if (r.resourceType !== "MedicationRequest"
      && r.resourceType !== "MedicationAdministration") return;
    const concept = r.medicationCodeableConcept || null;
    const dosage = (r.dosageInstruction || [])[0] || {};
    rows.push(Object.assign(base(r), {
      kind: r.resourceType,
      rxnorm: codeIn(concept, SYSTEM.RXNORM),
      display: displayOf(concept) || normalizeRef(r.medicationReference, uuidMap),
      status: r.status || null,
      intent: r.intent || null,
      isActive: r.status === "active",
      date: dateOf(r, ["authoredOn", "effectiveDateTime", "occurrenceDateTime"]),
      dosageText: dosage.text || null,
      encounterRef: normalizeRef(r.encounter || r.context, uuidMap),
      reasonRef: normalizeRef((r.reasonReference || [])[0], uuidMap),
    }));
  });
  rows.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  return rows;
}

/* -------------------------------------------------- procedures / the rest */

export function extractProcedures(resources, uuidMap) {
  return resources.filter((r) => r.resourceType === "Procedure").map(function (r) {
    const period = r.performedPeriod || {};
    return Object.assign(base(r), {
      code: codeIn(r.code, SYSTEM.CPT) || codeIn(r.code, SYSTEM.SNOMED)
        || (codings(r.code)[0] || {}).code || null,
      display: displayOf(r.code),
      status: r.status || null,
      start: r.performedDateTime ? r.performedDateTime.slice(0, 10)
        : (period.start ? period.start.slice(0, 10) : null),
      end: period.end ? period.end.slice(0, 10) : null,
      encounterRef: normalizeRef(r.encounter, uuidMap),
      note: ((r.note || [])[0] || {}).text || null,
    });
  }).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
}

export function extractImmunizations(resources, uuidMap) {
  return resources.filter((r) => r.resourceType === "Immunization").map((r) =>
    Object.assign(base(r), {
      cvx: codeIn(r.vaccineCode, SYSTEM.CVX),
      display: displayOf(r.vaccineCode),
      status: r.status || null,
      date: dateOf(r, ["occurrenceDateTime", "date"]),
      encounterRef: normalizeRef(r.encounter, uuidMap),
    })
  ).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

export function extractImaging(resources, uuidMap) {
  return resources.filter((r) => r.resourceType === "ImagingStudy").map((r) =>
    Object.assign(base(r), {
      // Synthea puts modality on series[] and names the study via
      // procedureCode; the top-level `modality`/`description` used by other
      // exporters are frequently absent, so fall back rather than emit nulls.
      modality: ((r.modality || [])[0] || {}).code
        || (((r.series || [])[0] || {}).modality || {}).code || null,
      bodySite: (((r.series || [])[0] || {}).bodySite || {}).display || null,
      description: r.description
        || displayOf((r.procedureCode || [])[0])
        || ((r.series || [])[0] || {}).description || null,
      date: r.started ? r.started.slice(0, 10) : dateOf(r),
      series: r.numberOfSeries || 0,
      instances: r.numberOfInstances || 0,
      encounterRef: normalizeRef(r.encounter, uuidMap),
      note: ((r.note || [])[0] || {}).text || null,
    })
  ).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

export function extractDocuments(resources, uuidMap, decodeBase64) {
  return resources.filter((r) => r.resourceType === "DocumentReference").map(function (r) {
    const att = ((r.content || [])[0] || {}).attachment || {};
    let text = null;
    if (att.data && decodeBase64) {
      try { text = decodeBase64(att.data); } catch (e) { text = null; }
    }
    const ctx = r.context || {};
    return Object.assign(base(r), {
      type: displayOf(r.type) || null,
      category: displayOf((r.category || [])[0]) || null,
      status: r.status || null,
      date: r.date ? r.date.slice(0, 10) : dateOf(r),
      contentType: att.contentType || null,
      authorRef: normalizeRef((r.author || [])[0], uuidMap),
      encounterRef: normalizeRef((ctx.encounter || [])[0], uuidMap),
      chars: text ? text.length : 0,
      text: text,
    });
  }).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
}

export function extractAllergies(resources) {
  return resources.filter((r) => r.resourceType === "AllergyIntolerance").map((r) =>
    Object.assign(base(r), {
      code: codeIn(r.code, SYSTEM.SNOMED) || (codings(r.code)[0] || {}).code || null,
      display: displayOf(r.code),
      clinicalStatus: displayOf(r.clinicalStatus) || null,
      criticality: r.criticality || null,
      date: dateOf(r, ["recordedDate", "onsetDateTime"]),
    })
  );
}

export function extractCareTeam(resources, uuidMap) {
  const plans = resources.filter((r) => r.resourceType === "CarePlan").map((r) =>
    Object.assign(base(r), {
      kind: "CarePlan",
      status: r.status || null,
      intent: r.intent || null,
      display: displayOf((r.category || [])[0]) || null,
      start: (r.period || {}).start ? r.period.start.slice(0, 10) : null,
      end: (r.period || {}).end ? r.period.end.slice(0, 10) : null,
      encounterRef: normalizeRef(r.encounter, uuidMap),
    })
  );
  const teams = resources.filter((r) => r.resourceType === "CareTeam").map((r) =>
    Object.assign(base(r), {
      kind: "CareTeam",
      status: r.status || null,
      display: displayOf((r.category || [])[0]) || r.name || null,
      start: (r.period || {}).start ? r.period.start.slice(0, 10) : null,
      end: (r.period || {}).end ? r.period.end.slice(0, 10) : null,
      encounterRef: normalizeRef(r.encounter, uuidMap),
    })
  );
  return plans.concat(teams).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
}
