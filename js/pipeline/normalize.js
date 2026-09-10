/* CareTracer pipeline - normalization primitives.
 *
 * Every row the pipeline emits carries provenance (`ref`, `source`), so any
 * number rendered anywhere in the app can name the resource it came from.
 * These helpers are the only place that touches raw FHIR shape.
 */

export const SYSTEM = {
  LOINC: "http://loinc.org",
  SNOMED: "http://snomed.info/sct",
  RXNORM: "http://www.nlm.nih.gov/research/umls/rxnorm",
  ICD10: "http://hl7.org/fhir/sid/icd-10-cm",
  CPT: "http://www.ama-assn.org/go/cpt",
  CVX: "http://hl7.org/fhir/sid/cvx",
};

export function refOf(resource) {
  return resource && resource.resourceType && resource.id
    ? resource.resourceType + "/" + resource.id
    : null;
}

export function sourceOf(resource) {
  return (resource && resource.meta && resource.meta.source) || "unknown";
}

/** All codings on a CodeableConcept, flattened. */
export function codings(concept) {
  if (!concept) return [];
  return (concept.coding || []).map(function (c) {
    return { system: c.system || "", code: c.code || "", display: c.display || "" };
  });
}

/** First code from a given system, or null. */
export function codeIn(concept, system) {
  const hit = codings(concept).find(function (c) {
    return c.system === system;
  });
  return hit ? hit.code : null;
}

/** Human label: prefer a coding display, fall back to concept.text. */
export function displayOf(concept) {
  if (!concept) return "";
  const hit = codings(concept).find(function (c) { return c.display; });
  return hit ? hit.display : (concept.text || "");
}

/** Any LOINC code present on the concept (observations may carry several). */
export function loincCodes(concept) {
  return codings(concept)
    .filter(function (c) { return c.system === SYSTEM.LOINC; })
    .map(function (c) { return c.code; });
}

/**
 * Resolve a FHIR reference to `ResourceType/id`.
 *
 * Synthea transaction bundles use urn:uuid references that only resolve
 * against entry.fullUrl; exports and hand-authored bundles use relative
 * references. Both must normalize to the same citation key or provenance
 * breaks silently.
 */
export function normalizeRef(reference, uuidMap) {
  if (!reference) return null;
  const value = typeof reference === "string" ? reference : reference.reference;
  if (!value) {
    // Reference carrying only an identifier and display, no pointer.
    if (reference && reference.identifier) {
      const i = reference.identifier;
      return { external: true, system: i.system || null, value: i.value || null,
               display: reference.display || null };
    }
    return null;
  }
  if (uuidMap && uuidMap[value]) return uuidMap[value];
  if (value.indexOf("urn:uuid:") === 0) return null;   // genuinely unresolved

  // Conditional / logical reference: "Practitioner?identifier=system|value".
  // Valid FHIR, but it names a resource by business identifier rather than by
  // id, and that resource may legitimately sit outside this bundle. Preserve
  // it as an external pointer instead of mangling it into a fake Type/id.
  const q = value.indexOf("?");
  if (q > 0) {
    const type = value.slice(0, q);
    const params = value.slice(q + 1);
    const m = /identifier=([^&]+)/.exec(params);
    const token = m ? decodeURIComponent(m[1]) : null;
    const bar = token ? token.lastIndexOf("|") : -1;
    return {
      external: true,
      type: type,
      system: bar >= 0 ? token.slice(0, bar) : null,
      value: bar >= 0 ? token.slice(bar + 1) : token,
      display: (typeof reference === "object" && reference.display) || null,
    };
  }

  const parts = value.split("/");
  return parts.length >= 2 ? parts.slice(-2).join("/") : value;
}

/** Render a reference (internal string or external object) for display. */
export function refLabel(ref) {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  if (ref.external) {
    return ref.display || ((ref.type || "external") + " " + (ref.value || ""));
  }
  return String(ref);
}

/** True when the reference points outside this record by design. */
export function isExternalRef(ref) {
  return !!(ref && typeof ref === "object" && ref.external);
}

/** Build fullUrl/urn:uuid -> Type/id from a resource set that carries ids. */
export function buildUuidMap(resources) {
  const map = {};
  resources.forEach(function (r) {
    const ref = refOf(r);
    if (!ref) return;
    map["urn:uuid:" + r.id] = ref;
    map[ref] = ref;
  });
  return map;
}

/** ISO date (YYYY-MM-DD) from the several date fields FHIR resources use. */
export function dateOf(resource, fields) {
  const list = fields || [
    "effectiveDateTime", "effectiveInstant", "issued",
    "onsetDateTime", "recordedDate", "authoredOn",
    "performedDateTime", "occurrenceDateTime", "date", "start",
  ];
  for (let i = 0; i < list.length; i++) {
    const v = resource[list[i]];
    if (typeof v === "string" && v.length >= 10) return v.slice(0, 10);
  }
  if (resource.effectivePeriod && resource.effectivePeriod.start) {
    return resource.effectivePeriod.start.slice(0, 10);
  }
  if (resource.period && resource.period.start) {
    return resource.period.start.slice(0, 10);
  }
  if (resource.performedPeriod && resource.performedPeriod.start) {
    return resource.performedPeriod.start.slice(0, 10);
  }
  return null;
}

/** Quantity -> {value, unit, ucum} with unit text preferred over UCUM code. */
export function quantityOf(node) {
  if (!node || typeof node.value !== "number") return null;
  return {
    value: node.value,
    unit: node.unit || node.code || "",
    ucum: node.code || null,
  };
}

export function ageAt(birthDate, onDate) {
  if (!birthDate || !onDate) return null;
  const b = birthDate.split("-").map(Number);
  const d = onDate.split("-").map(Number);
  let age = d[0] - b[0];
  if (d[1] < b[1] || (d[1] === b[1] && d[2] < b[2])) age -= 1;
  return age;
}

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

/** Index measures.json by LOINC for O(1) lookup, honouring excludeLoinc. */
export function indexMeasures(dictionary) {
  const byLoinc = {};
  const excluded = {};
  const defs = dictionary.measures || {};
  Object.keys(defs).forEach(function (id) {
    const def = defs[id];
    (def.excludeLoinc || []).forEach(function (code) {
      excluded[code] = excluded[code] || [];
      excluded[code].push(id);
    });
    (def.loinc || []).forEach(function (code) {
      // First definition wins; a duplicate LOINC across measures is a
      // dictionary bug and is surfaced by the validator rather than silently
      // resolved here.
      if (!byLoinc[code]) byLoinc[code] = { id: id, def: def };
    });
  });
  return { byLoinc: byLoinc, excluded: excluded, defs: defs };
}

/** Match an Observation's codings to a measure definition, or null. */
export function matchMeasure(concept, index) {
  const codes = loincCodes(concept);
  for (let i = 0; i < codes.length; i++) {
    if (index.excluded[codes[i]]) return null;   // explicitly not this measure
    const hit = index.byLoinc[codes[i]];
    if (hit) return { id: hit.id, def: hit.def, loinc: codes[i] };
  }
  return null;
}
