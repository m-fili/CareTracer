/* CareTracer - local record store.
 *
 * Connected FHIR resources are held in IndexedDB on the patient's device.
 * Nothing is sent anywhere. This is the technical substrate for the
 * "your record stays on your device" commitment, and it is what makes
 * "Disconnect and delete" a real operation rather than a label.
 *
 * sessionStorage is not usable here: it caps around 5 MB and stores strings
 * only, and a single connected patient is roughly 9 MB of FHIR.
 */
(function () {
  "use strict";

  var DB_NAME = "caretracer";
  var DB_VERSION = 1;
  var STORE_RESOURCES = "resources";
  var STORE_META = "meta";

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (ev) {
        var db = ev.target.result;
        if (!db.objectStoreNames.contains(STORE_RESOURCES)) {
          var os = db.createObjectStore(STORE_RESOURCES, { keyPath: "_key" });
          os.createIndex("byType", "resourceType", { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "id" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  /* Write resources in chunks so a large import does not block the UI thread
   * for the whole duration of one enormous transaction. */
  function putResources(resources, onProgress) {
    return openDb().then(function (db) {
      var CHUNK = 500;
      var written = 0;

      function writeChunk(start) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(STORE_RESOURCES, "readwrite");
          var os = tx.objectStore(STORE_RESOURCES);
          var end = Math.min(start + CHUNK, resources.length);
          for (var i = start; i < end; i++) {
            var r = resources[i];
            r._key = r.resourceType + "/" + r.id;
            os.put(r);
          }
          tx.oncomplete = function () {
            written = end;
            if (onProgress) onProgress(written, resources.length);
            resolve(end);
          };
          tx.onerror = function () { reject(tx.error); };
        });
      }

      function loop(start) {
        if (start >= resources.length) return Promise.resolve(written);
        return writeChunk(start).then(function (next) { return loop(next); });
      }

      return loop(0).then(function (n) { db.close(); return n; });
    });
  }

  function setConnection(meta) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_META, "readwrite");
        meta.id = "connection";
        tx.objectStore(STORE_META).put(meta);
        tx.oncomplete = function () { db.close(); resolve(meta); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getConnection() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_META, "readonly");
        var req = tx.objectStore(STORE_META).get("connection");
        req.onsuccess = function () { db.close(); resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    }).catch(function () { return null; });
  }

  function getByType(resourceType) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_RESOURCES, "readonly");
        var idx = tx.objectStore(STORE_RESOURCES).index("byType");
        var req = idx.getAll(resourceType);
        req.onsuccess = function () { db.close(); resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function get(reference) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_RESOURCES, "readonly");
        var req = tx.objectStore(STORE_RESOURCES).get(reference);
        req.onsuccess = function () { db.close(); resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function clear() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction([STORE_RESOURCES, STORE_META], "readwrite");
        tx.objectStore(STORE_RESOURCES).clear();
        tx.objectStore(STORE_META).clear();
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  window.CareTracerStore = {
    putResources: putResources,
    setConnection: setConnection,
    getConnection: getConnection,
    getByType: getByType,
    get: get,
    clear: clear,
  };
})();
