/* CareTracer - Connect health records.
 *
 * Simulates a SMART on FHIR patient-portal connection: pick a health system,
 * authorize the data classes being shared, then import a Bulk FHIR export.
 *
 * The import is real work, not a timer. It reads a Bulk Data Access manifest,
 * then streams each NDJSON file with a ReadableStream reader, parsing lines as
 * bytes arrive and reporting true byte-level progress. Swapping the local
 * directory for a live $export endpoint would not change this code path.
 *
 * Depends on store.js.
 */
(function () {
  "use strict";

  var DATA_ROOT = "data/riley817";

  /* Health systems shown in the picker. Text only, no marks or logos.
   * Every entry currently resolves to the same synthetic export. */
  var PROVIDERS = [
    { id: "mgb",  name: "Mass General Brigham",            vendor: "Epic",          loc: "Boston, MA" },
    { id: "nh",   name: "Granite State Community Hospital", vendor: "Oracle Health", loc: "Nashua, NH" },
    { id: "bilh", name: "Beth Israel Lahey Health",         vendor: "Epic",          loc: "Cambridge, MA" },
    { id: "bmc",  name: "Boston Medical Center",            vendor: "Epic",          loc: "Boston, MA" },
    { id: "dfci", name: "Dana-Farber Cancer Institute",     vendor: "Epic",          loc: "Boston, MA" },
    { id: "umm",  name: "UMass Memorial Health",            vendor: "Epic",          loc: "Worcester, MA" },
    { id: "tufts",name: "Tufts Medicine",                   vendor: "Epic",          loc: "Boston, MA" },
    { id: "cha",  name: "Cambridge Health Alliance",        vendor: "Epic",          loc: "Cambridge, MA" },
    { id: "dh",   name: "Dartmouth Health",                 vendor: "Epic",          loc: "Lebanon, NH" },
    { id: "cmc",  name: "Catholic Medical Center",          vendor: "Meditech",      loc: "Manchester, NH" }
  ];

  /* USCDI-shaped data classes, mapped to the FHIR resource types they cover. */
  var DATA_CLASSES = [
    { id: "problems",  label: "Conditions and problem list", types: ["Condition"] },
    { id: "meds",      label: "Medications",                 types: ["MedicationRequest", "Medication", "MedicationAdministration"] },
    { id: "labs",      label: "Laboratory results",          types: ["Observation"] },
    { id: "vitals",    label: "Vital signs",                 types: [] },
    { id: "encounters",label: "Visits and encounters",       types: ["Encounter", "CarePlan", "CareTeam"] },
    { id: "immun",     label: "Immunizations",               types: ["Immunization"] },
    { id: "procs",     label: "Procedures and devices",      types: ["Procedure", "Device"] },
    { id: "notes",     label: "Clinical notes",              types: ["DocumentReference"] },
    { id: "imaging",   label: "Imaging studies",             types: ["ImagingStudy"] }
  ];

  var STYLE = [
    '.ct-ov{position:fixed;inset:0;z-index:9000;background:rgba(27,35,48,.42);',
    'backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;padding:24px}',
    '.ct-modal{background:#fff;border:1px solid #E5EAEE;border-radius:14px;width:100%;max-width:560px;',
    'box-shadow:0 8px 40px rgba(27,35,48,.18);font:400 15px/1.5 Inter,-apple-system,"Segoe UI",Roboto,sans-serif;',
    'color:#1B2330;max-height:86vh;display:flex;flex-direction:column;overflow:hidden}',
    '.ct-hd{padding:22px 26px 14px;border-bottom:1px solid #E5EAEE;flex:none}',
    '.ct-hd h2{margin:0 0 5px;font-size:19px;font-weight:600;letter-spacing:-.01em}',
    '.ct-hd p{margin:0;font-size:13.5px;color:#6B7785}',
    '.ct-bd{padding:18px 26px;overflow-y:auto;flex:1 1 auto}',
    '.ct-ft{padding:14px 26px 20px;border-top:1px solid #E5EAEE;display:flex;gap:10px;',
    'justify-content:flex-end;align-items:center;flex:none}',
    '.ct-btn{height:40px;padding:0 18px;border-radius:8px;border:1px solid #E5EAEE;background:#fff;',
    'color:#1B2330;font:600 14px Inter,sans-serif;cursor:pointer}',
    '.ct-btn:hover{background:#F4F6F8}',
    '.ct-btn.pri{background:#0E5C6F;border-color:#0E5C6F;color:#fff}',
    '.ct-btn.pri:hover{background:#0a4c5c}',
    '.ct-btn:disabled{opacity:.5;cursor:not-allowed}',
    '.ct-search{width:100%;height:42px;border:1px solid #E5EAEE;border-radius:8px;padding:0 14px;',
    'font:400 15px Inter,sans-serif;background:#F4F6F8;margin-bottom:12px;color:#1B2330}',
    '.ct-search:focus{outline:none;background:#fff;border-color:#0E5C6F;box-shadow:0 0 0 3px rgba(14,92,111,.12)}',
    '.ct-list{display:flex;flex-direction:column;gap:6px}',
    '.ct-prov{display:flex;align-items:center;gap:13px;padding:11px 13px;border:1px solid #E5EAEE;',
    'border-radius:10px;cursor:pointer;background:#fff;text-align:left;width:100%;font:inherit;color:inherit}',
    '.ct-prov:hover{border-color:#0E5C6F;background:#FBFAF7}',
    '.ct-av{width:38px;height:38px;border-radius:9px;background:rgba(179,217,223,.42);color:#0E5C6F;',
    'display:grid;place-items:center;font:600 13px Inter,sans-serif;flex:none}',
    '.ct-pn{font-weight:600;font-size:14.5px}',
    '.ct-pm{font-size:12.5px;color:#6B7785}',
    '.ct-cls{display:flex;flex-direction:column;gap:2px;margin:14px 0 0}',
    '.ct-cls label{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:8px;cursor:pointer;font-size:14px}',
    '.ct-cls label:hover{background:#F4F6F8}',
    '.ct-cls input{width:17px;height:17px;accent-color:#0E5C6F;flex:none}',
    '.ct-note{background:#FBFAF7;border:1px solid #E5EAEE;border-radius:9px;padding:13px 15px;',
    'font-size:13px;color:#6B7785;line-height:1.55}',
    '.ct-bar{height:8px;background:#F4F6F8;border-radius:99px;overflow:hidden;margin:20px 0 10px}',
    '.ct-fill{height:100%;background:#0E5C6F;border-radius:99px;width:0;transition:width .18s ease}',
    '.ct-stat{display:flex;justify-content:space-between;font-size:13px;color:#6B7785;font-variant-numeric:tabular-nums}',
    '.ct-log{margin-top:16px;max-height:150px;overflow-y:auto;font:12.5px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace;color:#6B7785}',
    '.ct-log .ok{color:#0E5C6F}',
    '.ct-sum{display:grid;grid-template-columns:1fr 1fr;gap:11px;margin:6px 0 16px}',
    '.ct-tile{border:1px solid #E5EAEE;border-radius:10px;padding:13px 15px;background:#FBFAF7}',
    '.ct-tile .n{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
    '.ct-tile .l{font-size:12px;color:#6B7785;margin-top:2px}',
    '.ct-badge{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;',
    'color:#6B7785;background:#F4F6F8;border:1px solid #E5EAEE;border-radius:5px;padding:3px 8px;margin-top:12px}'
  ].join("");

  function injectStyle() {
    if (document.getElementById("ct-connect-style")) return;
    var s = document.createElement("style");
    s.id = "ct-connect-style";
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (w) { return w[0]; }).join("").toUpperCase();
  }

  function fmt(n) { return n.toLocaleString(); }

  /* ---------------------------------------------------------------- modal */

  function Modal() {
    injectStyle();
    this.ov = el("div", "ct-ov");
    this.modal = el("div", "ct-modal");
    this.modal.setAttribute("role", "dialog");
    this.modal.setAttribute("aria-modal", "true");
    this.hd = el("div", "ct-hd");
    this.bd = el("div", "ct-bd");
    this.ft = el("div", "ct-ft");
    this.modal.appendChild(this.hd);
    this.modal.appendChild(this.bd);
    this.modal.appendChild(this.ft);
    this.ov.appendChild(this.modal);
    document.body.appendChild(this.ov);
  }
  Modal.prototype.head = function (title, sub) {
    this.hd.innerHTML = "";
    this.hd.appendChild(el("h2", null, title));
    if (sub) this.hd.appendChild(el("p", null, sub));
  };
  Modal.prototype.close = function () {
    if (this.ov.parentNode) this.ov.parentNode.removeChild(this.ov);
  };

  /* ------------------------------------------------------- step 1: picker */

  function stepPicker(m) {
    m.head("Connect your health records",
           "Choose the health system where you receive care. CareTracer will request a copy of your record.");
    m.bd.innerHTML = "";
    m.ft.innerHTML = "";

    var search = el("input", "ct-search");
    search.type = "text";
    search.placeholder = "Search health systems";
    search.setAttribute("aria-label", "Search health systems");

    var list = el("div", "ct-list");

    function render(filter) {
      list.innerHTML = "";
      var q = (filter || "").toLowerCase();
      PROVIDERS.filter(function (p) {
        return !q || p.name.toLowerCase().indexOf(q) >= 0 || p.loc.toLowerCase().indexOf(q) >= 0;
      }).forEach(function (p) {
        var btn = el("button", "ct-prov");
        btn.type = "button";
        btn.appendChild(el("span", "ct-av", initials(p.name)));
        var t = el("span");
        t.appendChild(el("span", "ct-pn", p.name));
        t.appendChild(el("span", "ct-pm", p.loc + " · " + p.vendor));
        t.style.display = "flex";
        t.style.flexDirection = "column";
        btn.appendChild(t);
        btn.addEventListener("click", function () { stepConsent(m, p); });
        list.appendChild(btn);
      });
      if (!list.children.length) {
        list.appendChild(el("p", "ct-pm", "No health systems match that search."));
      }
    }

    search.addEventListener("input", function () { render(search.value); });
    render("");

    m.bd.appendChild(search);
    m.bd.appendChild(list);
    m.bd.appendChild(el("div", "ct-badge", "Demonstration · synthetic data only"));

    var later = el("button", "ct-btn", "Not now");
    later.addEventListener("click", function () { m.close(); });
    m.ft.appendChild(later);
    setTimeout(function () { search.focus(); }, 30);
  }

  /* ------------------------------------------------------ step 2: consent */

  function stepConsent(m, provider) {
    m.head("Authorize " + provider.name,
           "You control what CareTracer receives. Uncheck anything you would rather not share.");
    m.bd.innerHTML = "";
    m.ft.innerHTML = "";

    var wrap = el("div", "ct-cls");
    DATA_CLASSES.forEach(function (c) {
      var lab = el("label");
      var cb = el("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.value = c.id;
      lab.appendChild(cb);
      lab.appendChild(el("span", null, c.label));
      wrap.appendChild(lab);
    });

    m.bd.appendChild(el("div", "ct-note",
      "Your record is downloaded directly to this device and stored locally. " +
      "It is not uploaded to CareTracer servers. You can disconnect and delete " +
      "it at any time from Settings."));
    m.bd.appendChild(wrap);

    var back = el("button", "ct-btn", "Back");
    back.addEventListener("click", function () { stepPicker(m); });
    var go = el("button", "ct-btn pri", "Allow and connect");
    go.addEventListener("click", function () {
      var chosen = {};
      wrap.querySelectorAll("input:checked").forEach(function (cb) { chosen[cb.value] = true; });
      stepImport(m, provider, chosen);
    });
    m.ft.appendChild(back);
    m.ft.appendChild(go);
  }

  /* ------------------------------------------------------- step 3: import */

  /* Stream one NDJSON file, parsing lines as bytes arrive. onBytes reports
   * real progress against the byte count declared in the manifest. */
  function streamNdjson(url, onBytes) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error(url + " -> HTTP " + res.status);
      if (!res.body) {                       // no streams: fall back to text
        return res.text().then(function (t) {
          return t.split("\n").filter(Boolean).map(JSON.parse);
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = "", out = [], seen = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            if (buf.trim()) out.push(JSON.parse(buf));
            return out;
          }
          seen += r.value.length;
          if (onBytes) onBytes(seen);
          buf += dec.decode(r.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\n")) >= 0) {
            var line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            if (line.trim()) out.push(JSON.parse(line));
          }
          return pump();
        });
      }
      return pump();
    });
  }

  function stepImport(m, provider, chosen) {
    m.head("Connecting to " + provider.name, "Requesting and importing your record.");
    m.bd.innerHTML = "";
    m.ft.innerHTML = "";

    var bar = el("div", "ct-bar");
    var fill = el("div", "ct-fill");
    bar.appendChild(fill);
    var stat = el("div", "ct-stat");
    var lbl = el("span", null, "Authorizing…");
    var pct = el("span", null, "0%");
    stat.appendChild(lbl);
    stat.appendChild(pct);
    var log = el("div", "ct-log");

    m.bd.appendChild(bar);
    m.bd.appendChild(stat);
    m.bd.appendChild(log);

    function setPct(p) {
      p = Math.max(0, Math.min(100, p));
      fill.style.width = p.toFixed(1) + "%";
      pct.textContent = p.toFixed(0) + "%";
    }
    function say(msg, ok) {
      var l = el("div", ok ? "ok" : null, msg);
      log.appendChild(l);
      log.scrollTop = log.scrollHeight;
    }
    function pause(ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    }

    var allowedTypes = {};
    DATA_CLASSES.forEach(function (c) {
      if (chosen[c.id]) c.types.forEach(function (t) { allowedTypes[t] = true; });
    });
    // Structural resources always come along; they are referenced by the rest.
    ["Patient", "Organization", "Practitioner"].forEach(function (t) { allowedTypes[t] = true; });

    var collected = [];
    var manifest = null;

    say("POST /oauth2/authorize → 302");
    pause(420)
      .then(function () {
        say("Access token granted (scope: patient/*.read)", true);
        lbl.textContent = "Requesting export…";
        setPct(3);
        return pause(380);
      })
      .then(function () {
        say("GET " + DATA_ROOT + "/manifest.json");
        return fetch(DATA_ROOT + "/manifest.json").then(function (r) {
          if (!r.ok) throw new Error("manifest -> HTTP " + r.status);
          return r.json();
        });
      })
      .then(function (mf) {
        manifest = mf;
        var files = mf.output.filter(function (f) { return allowedTypes[f.type]; });
        var skipped = mf.output.length - files.length;
        say("Export ready: " + files.length + " files, " +
            fmt(files.reduce(function (a, f) { return a + f.count; }, 0)) + " resources", true);
        if (skipped) say(skipped + " file(s) withheld by your consent choices");
        lbl.textContent = "Downloading…";

        var totalBytes = files.reduce(function (a, f) { return a + f.bytes; }, 0);
        var doneBytes = 0;

        function next(i) {
          if (i >= files.length) return Promise.resolve();
          var f = files[i];
          lbl.textContent = "Importing " + f.type + "…";
          return streamNdjson(DATA_ROOT + "/" + f.url, function (seen) {
            setPct(4 + 76 * (doneBytes + seen) / totalBytes);
          }).then(function (rs) {
            doneBytes += f.bytes;
            collected = collected.concat(rs);
            say("✓ " + f.type + "  " + fmt(rs.length) + " resources", true);
            setPct(4 + 76 * doneBytes / totalBytes);
            return pause(90).then(function () { return next(i + 1); });
          });
        }
        return next(0);
      })
      .then(function () {
        lbl.textContent = "Saving to this device…";
        say("Writing " + fmt(collected.length) + " resources to local storage");
        return window.CareTracerStore.putResources(collected, function (done, total) {
          setPct(80 + 18 * done / total);
        });
      })
      .then(function () {
        return window.CareTracerStore.setConnection({
          provider: provider,
          connectedAt: new Date().toISOString(),
          patient: manifest.patient,
          summary: manifest.summary,
          resourceCount: collected.length,
          consented: Object.keys(chosen)
        });
      })
      .then(function () {
        setPct(100);
        lbl.textContent = "Complete";
        return pause(360);
      })
      .then(function () { stepDone(m, provider, manifest, collected.length); })
      .catch(function (err) {
        lbl.textContent = "Connection failed";
        say("✗ " + err.message);
        var retry = el("button", "ct-btn pri", "Try again");
        retry.addEventListener("click", function () { stepPicker(m); });
        m.ft.appendChild(retry);
      });
  }

  /* --------------------------------------------------------- step 4: done */

  function stepDone(m, provider, manifest, count) {
    m.head("Connected to " + provider.name,
           "Your record is on this device and ready to explore.");
    m.bd.innerHTML = "";
    m.ft.innerHTML = "";

    var s = manifest.summary || {};
    var years = (s.firstEncounter && s.lastEncounter)
      ? s.firstEncounter.slice(0, 4) + " – " + s.lastEncounter.slice(0, 4)
      : "—";

    var grid = el("div", "ct-sum");
    [[fmt(count), "records imported"],
     [years, "years of history"],
     [manifest.patient.name || "—", "patient"],
     ["1", "connected system"]].forEach(function (t) {
      var tile = el("div", "ct-tile");
      tile.appendChild(el("div", "n", t[0]));
      tile.appendChild(el("div", "l", t[1]));
      grid.appendChild(tile);
    });

    m.bd.appendChild(grid);
    m.bd.appendChild(el("div", "ct-note",
      "This record is stored only in this browser on this device. " +
      "You can add another health system, or disconnect and delete this data, " +
      "from Settings."));

    var done = el("button", "ct-btn pri", "Continue");
    done.addEventListener("click", function () { m.close(); location.reload(); });
    m.ft.appendChild(done);
  }

  /* -------------------------------------------------------------- public */

  function open() { stepPicker(new Modal()); }

  function autoOpen() {
    if (!window.CareTracerStore) return;
    window.CareTracerStore.getConnection().then(function (conn) {
      if (!conn) open();
    });
  }

  window.CareTracerConnect = { open: open, autoOpen: autoOpen, providers: PROVIDERS };
})();
