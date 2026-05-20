/* CareTracer — demo authentication shim.
 *
 * Notes:
 * - Credentials are intentionally hard-coded in the client for a wireframe demo.
 *   This is NOT real authentication and should never ship as such.
 * - Session is stored in sessionStorage so it ends when the tab closes, and
 *   so opening any wireframe URL in a fresh tab bounces to the landing page.
 */
(function () {
  var DEMO_USER = "demo";
  var DEMO_PASS = "caretracer2026!";
  var STORAGE_KEY = "caretracer_auth";

  function getSession() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function setSession(role) {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ role: role, ts: Date.now() })
      );
    } catch (e) {}
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  function login(username, password, role) {
    if (typeof username !== "string" || typeof password !== "string") return false;
    if (username.trim() !== DEMO_USER || password !== DEMO_PASS) return false;
    setSession(role === "provider" ? "provider" : "patient");
    return true;
  }

  /**
   * Gate a protected page. If the user is not signed in (or signed in under
   * the wrong role), the page is hidden and the browser is redirected to the
   * landing page.
   *
   * Call this in the document <head>, immediately after loading auth.js, so
   * the redirect fires before any content paints.
   */
  function require(role) {
    var s = getSession();
    var ok = !!s && (!role || s.role === role);
    if (!ok) {
      try {
        document.documentElement.style.visibility = "hidden";
      } catch (e) {}
      location.replace("index.html");
    }
  }

  window.CareTracerAuth = {
    login: login,
    logout: clearSession,
    require: require,
    getSession: getSession,
  };
})();
