/* CareTracer - page hydration.
 *
 * Reads the connected record out of IndexedDB and replaces the placeholder
 * copy baked into the wireframes with values derived from the actual data.
 *
 * Elements opt in with data attributes, so a page that has not been wired yet
 * simply keeps its static text:
 *
 *   data-ct="lastUpdated"     -> "Last updated August 7, 2026"
 *   data-ct="lastSynced"      -> "August 7, 2026"
 *   data-ct="recordSummary"   -> "Your record covers 77 years across ..."
 *   data-ct="patientName"     -> "John Doe"
 *   data-ct="patientFirst"    -> "John"
 *   data-ct="providerName"    -> "Mass General Brigham"
 *   data-ct="resourceCount"   -> "8,608"
 *
 * Depends on store.js.
 */
(function () {
  "use strict";

  /* Synthea records social determinants and administrative flags as Conditions
   * alongside real diagnoses. A patient's problem list should not show "Has a
   * criminal record" or "Full-time employment", so these are filtered out of
   * the clinical count. Matched case-insensitively against the display text. */
  var NON_CLINICAL = [
    "employment", "criminal record", "social contact", "social isolation",
    "educated to", "higher education", "medication review", "labor force",
    "victim of", "reports of violence", "unemployed", "housing",
    "food insecurity", "transportation", "stress (finding)",
    "received higher", "part-time", "full-time"
  ];

  function isClinical(display) {
    var d = (display || "").toLowerCase();
    if (!d) return false;
    for (var i = 0; i < NON_CLINICAL.length; i++) {
      if (d.indexOf(NON_CLINICAL[i]) >= 0) return false;
    }
    return true;
  }

  function displayOf(concept) {
    if (!concept) return "";
    var codings = concept.coding || [];
    for (var i = 0; i < codings.length; i++) {
      if (codings[i].display) return codings[i].display;
    }
    return concept.text || "";
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-US",
      { year: "numeric", month: "long", day: "numeric" });
  }

  function plural(n, one, many) { return n === 1 ? one : (many || one + "s"); }

  /* Derive the active problem list the way the pipeline will have to:
   * Synthea emits only encounter diagnoses, so collapse by code, keep the
   * earliest onset, and treat a condition as resolved only when every
   * recorded instance carries an abatement date. */
  function activeConditions(conditions) {
    var merged = {};
    conditions.forEach(function (c) {
      var name = displayOf(c.code);
      if (!name || !isClinical(name)) return;
      var rec = merged[name] || (merged[name] = { resolved: true });
      if (!c.abatementDateTime) rec.resolved = false;
    });
    var active = 0;
    Object.keys(merged).forEach(function (k) {
      if (!merged[k].resolved) active++;
    });
    return { active: active, total: Object.keys(merged).length };
  }

  function summarize() {
    return window.CareTracerStore.getConnection().then(function (conn) {
      if (!conn) return null;
      return window.CareTracerStore.getByType("Condition").then(function (conds) {
        var counts = activeConditions(conds);
        var s = conn.summary || {};
        var first = s.firstEncounter ? parseInt(s.firstEncounter.slice(0, 4), 10) : null;
        var last = s.lastEncounter ? parseInt(s.lastEncounter.slice(0, 4), 10) : null;
        var years = (first && last) ? Math.max(1, last - first) : null;
        var name = (conn.patient && conn.patient.name) || "";
        return {
          connection: conn,
          patientName: name,
          patientFirst: name.split(/\s+/)[0] || "",
          providerName: conn.provider ? conn.provider.name : "",
          systems: 1,
          years: years,
          firstYear: first,
          lastYear: last,
          activeConditions: counts.active,
          totalConditions: counts.total,
          resourceCount: conn.resourceCount || 0,
          connectedAt: conn.connectedAt
        };
      });
    });
  }

  function recordSummarySentence(v) {
    var parts = [];
    if (v.years) parts.push(v.years + " " + plural(v.years, "year"));
    var sentence = "Your record covers " + (parts[0] || "your history") +
      " across " + v.systems + " " + plural(v.systems, "health system") +
      " and " + v.activeConditions + " active " +
      plural(v.activeConditions, "condition") + ".";
    return sentence;
  }

  var FILLERS = {
    lastUpdated: function (v) { return "Last updated " + fmtDate(v.connectedAt); },
    lastSynced: function (v) { return fmtDate(v.connectedAt); },
    recordSummary: recordSummarySentence,
    patientName: function (v) { return v.patientName; },
    patientFirst: function (v) { return v.patientFirst; },
    providerName: function (v) { return v.providerName; },
    resourceCount: function (v) { return (v.resourceCount || 0).toLocaleString(); },
    yearsCovered: function (v) { return String(v.years || ""); },
    activeConditions: function (v) { return String(v.activeConditions); }
  };

  function apply(v) {
    document.querySelectorAll("[data-ct]").forEach(function (node) {
      var key = node.getAttribute("data-ct");
      var fn = FILLERS[key];
      if (fn) {
        var text = fn(v);
        if (text) node.textContent = text;
      }
    });
    document.querySelectorAll("[data-ct-show]").forEach(function (node) {
      node.hidden = false;
    });
  }

  function hydrate() {
    if (!window.CareTracerStore) return Promise.resolve(null);
    return summarize().then(function (v) {
      if (v) apply(v);
      return v;
    }).catch(function (err) {
      // A hydration failure must never blank the page; the static copy stands.
      if (window.console) console.warn("hydrate failed:", err);
      return null;
    });
  }

  window.CareTracerHydrate = {
    hydrate: hydrate,
    summarize: summarize,
    fmtDate: fmtDate,
    isClinical: isClinical
  };

  document.addEventListener("DOMContentLoaded", hydrate);
})();
