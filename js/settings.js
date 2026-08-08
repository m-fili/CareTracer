/* CareTracer - Settings behaviour.
 *
 * Renders the "Connected health systems" card from what is actually on the
 * device, and implements disconnect: clearing the local record and dropping
 * the connection. That operation is real, not a mock. It empties IndexedDB.
 *
 * Depends on store.js, connect.js.
 */
(function () {
  "use strict";

  var EXTRA_CSS = [
    '.btn-danger{background:transparent;color:#C0574F;border:1px solid #E0BDBA;',
    'font-size:14px;font-weight:600;padding:8px 16px;border-radius:8px;',
    'cursor:pointer;font-family:inherit;flex:none}',
    '.btn-danger:hover{background:rgba(197,107,114,.10);border-color:#C0574F}',
    '.source-actions{display:flex;gap:8px;flex:none;align-items:center}',
    '.ct-confirm{margin-top:14px;border:1px solid #E0BDBA;background:rgba(197,107,114,.06);',
    'border-radius:10px;padding:16px 18px}',
    '.ct-confirm h4{margin:0 0 6px;font-size:15px;font-weight:600;color:#1B2330}',
    '.ct-confirm p{margin:0 0 14px;font-size:13.5px;line-height:1.55;color:#6B7785}',
    '.ct-confirm .row{display:flex;gap:10px}'
  ].join("");

  function injectCss() {
    if (document.getElementById("ct-settings-css")) return;
    var s = document.createElement("style");
    s.id = "ct-settings-css";
    s.textContent = EXTRA_CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function providerMeta(id) {
    var list = (window.CareTracerConnect && window.CareTracerConnect.providers) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function render() {
    var host = document.getElementById("ct-sources");
    if (!host) return;

    window.CareTracerHydrate.summarize().then(function (v) {
      if (!v) return;                       // nothing connected: keep empty state
      host.innerHTML = "";

      var conn = v.connection;
      var p = conn.provider || {};
      var meta = providerMeta(p.id) || p;

      var row = el("div", "source-row");

      var logo = el("div", "source-logo");
      logo.setAttribute("aria-hidden", "true");
      if (meta.tint) {
        logo.style.background = meta.tint + "1F";
        logo.style.color = meta.tint;
      }
      logo.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ' +
        'style="width:22px;height:22px"><path d="M3 21h18M5 21V7l7-4 7 4v14"/>' +
        '<path d="M12 9v6M9 12h6"/></svg>';
      row.appendChild(logo);

      var mid = el("div", "source-mid");
      mid.appendChild(el("span", "source-name", p.name || "Connected system"));
      mid.appendChild(el("span", "source-vendor",
        (meta.loc ? meta.loc + " · " : "") +
        v.resourceCount.toLocaleString() + " records" +
        (v.firstYear ? " · " + v.firstYear + "–" + v.lastYear : "")));
      mid.appendChild(el("span", "source-status",
        '<span class="status-dot" aria-hidden="true"></span>Connected · Last synced ' +
        window.CareTracerHydrate.fmtDate(conn.connectedAt)));
      row.appendChild(mid);

      var actions = el("div", "source-actions");
      var refresh = el("button", "btn-refresh", "Refresh");
      refresh.type = "button";
      refresh.setAttribute("aria-label", "Refresh " + (p.name || "") + " connection");
      var disc = el("button", "btn-danger", "Disconnect");
      disc.type = "button";
      disc.setAttribute("aria-label", "Disconnect " + (p.name || "") + " and delete records");
      actions.appendChild(refresh);
      actions.appendChild(disc);
      row.appendChild(actions);

      host.appendChild(row);

      refresh.addEventListener("click", function () {
        window.CareTracerConnect.refresh(p, conn.consented);
      });
      disc.addEventListener("click", function () {
        showConfirm(host, p.name || "this health system", v.resourceCount);
      });
    });
  }

  function showConfirm(host, providerName, count) {
    if (document.getElementById("ct-confirm")) return;

    var box = el("div", "ct-confirm");
    box.id = "ct-confirm";
    box.appendChild(el("h4", null, "Disconnect " + providerName + "?"));
    box.appendChild(el("p", null,
      "This deletes all " + count.toLocaleString() + " records from this device and " +
      "ends the connection. Your Health Map, scores, and Companion history will be " +
      "cleared. Nothing is deleted at " + providerName + ", and you can reconnect " +
      "at any time."));

    var row = el("div", "row");
    var cancel = el("button", "btn-refresh", "Keep my records");
    cancel.type = "button";
    var go = el("button", "btn-danger", "Disconnect and delete");
    go.type = "button";
    row.appendChild(go);
    row.appendChild(cancel);
    box.appendChild(row);
    host.parentNode.insertBefore(box, host.nextSibling);

    cancel.addEventListener("click", function () { box.remove(); });
    go.addEventListener("click", function () {
      go.disabled = true;
      go.textContent = "Deleting…";
      window.CareTracerConnect.disconnect().then(function () {
        location.reload();
      });
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    injectCss();
    render();
    var add = document.getElementById("ct-connect-another");
    if (add) {
      add.addEventListener("click", function () {
        window.CareTracerConnect.openPicker();
      });
    }
  });
})();
