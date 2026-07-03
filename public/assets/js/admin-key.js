/**
 * Admin key helper for action/mutation endpoints.
 *
 * The server guards credit-spending and broadcast routes behind an
 * `x-admin-key` header (see src/middleware/admin-auth.js). This helper stores
 * the key the owner enters in localStorage and attaches it to protected
 * requests. Anonymous visitors can still browse every read-only view.
 *
 *   AdminKey.fetch(url, opts)       -> prompts for the key if missing,
 *                                      re-prompts once on a 401. Use for
 *                                      user-initiated actions (button clicks).
 *   AdminKey.fetchSilent(url, opts) -> attaches the key only if already
 *                                      stored, never prompts. Use for
 *                                      background/auto calls.
 */
(function (global) {
  var STORAGE_KEY = "marketDashboardAdminKey";

  function get() {
    try {
      return global.localStorage.getItem(STORAGE_KEY) || "";
    } catch (e) {
      return "";
    }
  }

  function set(value) {
    try {
      if (value) {
        global.localStorage.setItem(STORAGE_KEY, value);
      } else {
        global.localStorage.removeItem(STORAGE_KEY);
      }
    } catch (e) {
      /* storage unavailable (private mode) — nothing to persist */
    }
  }

  function promptForKey(message) {
    var next = global.prompt(
      message || "Enter the admin key to perform this action:",
      get() || "",
    );
    if (next === null) {
      return null; // user cancelled
    }
    next = next.trim();
    set(next);
    return next;
  }

  function withKey(options, key) {
    var opts = Object.assign({}, options || {});
    opts.headers = Object.assign({}, (options && options.headers) || {});
    if (key) {
      opts.headers["x-admin-key"] = key;
    }
    return opts;
  }

  function adminFetch(url, options) {
    var key = get();
    if (!key) {
      key = promptForKey();
      if (!key) {
        return Promise.reject(new Error("Admin key required"));
      }
    }
    return global.fetch(url, withKey(options, key)).then(function (res) {
      if (res.status !== 401) {
        return res;
      }
      // Stored key was rejected — clear it and give the owner one retry.
      var retryKey = promptForKey("Admin key was rejected. Re-enter the admin key:");
      if (!retryKey) {
        return res;
      }
      return global.fetch(url, withKey(options, retryKey));
    });
  }

  function silentFetch(url, options) {
    return global.fetch(url, withKey(options, get()));
  }

  global.AdminKey = {
    get: get,
    set: set,
    prompt: promptForKey,
    fetch: adminFetch,
    fetchSilent: silentFetch,
  };
})(window);
