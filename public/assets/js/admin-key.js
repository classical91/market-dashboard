/**
 * Admin key helper for action/mutation endpoints.
 *
 * The server guards credit-spending and broadcast routes behind an
 * `x-admin-key` header (see src/middleware/admin-auth.js). This helper stores
 * the key the owner enters in localStorage and attaches it to protected
 * requests. Anonymous visitors can still browse every read-only view.
 *
 * The key is collected with an in-page modal (NOT window.prompt), because many
 * mobile browsers silently suppress native prompt() dialogs.
 *
 *   AdminKey.fetch(url, opts)       -> asks for the key if missing (modal),
 *                                      re-asks once on a 401. Use for
 *                                      user-initiated actions (button clicks).
 *   AdminKey.fetchSilent(url, opts) -> attaches the key only if already
 *                                      stored, never asks. Use for
 *                                      background/auto calls.
 *   AdminKey.prompt(message)        -> returns a Promise<string|null>.
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

  // In-page modal that resolves with the entered string, or null if cancelled.
  // Falls back to window.prompt only if the DOM is somehow unavailable.
  function showModal(message, initial) {
    return new Promise(function (resolve) {
      var doc = global.document;
      if (!doc || !doc.body) {
        resolve(global.prompt ? global.prompt(message, initial || "") : null);
        return;
      }

      var overlay = doc.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;" +
        "justify-content:center;padding:20px;background:rgba(3,6,12,0.66);" +
        "-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);";

      var box = doc.createElement("div");
      box.style.cssText =
        "width:100%;max-width:380px;box-sizing:border-box;background:#0f1420;color:#e8ecf3;" +
        "border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:22px;" +
        "font-family:inherit;box-shadow:0 24px 70px rgba(0,0,0,0.55);";

      var label = doc.createElement("label");
      label.textContent = message || "Enter the admin key to perform this action:";
      label.style.cssText = "display:block;font-size:14px;line-height:1.45;margin-bottom:14px;";

      var input = doc.createElement("input");
      input.type = "password";
      input.value = initial || "";
      input.placeholder = "Admin key";
      input.autocomplete = "off";
      input.setAttribute("autocapitalize", "off");
      input.setAttribute("autocorrect", "off");
      input.spellcheck = false;
      input.style.cssText =
        "width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;" +
        "border:1px solid rgba(255,255,255,0.16);background:rgba(255,255,255,0.05);" +
        "color:inherit;font-size:15px;outline:none;";

      var showRow = doc.createElement("label");
      showRow.style.cssText =
        "display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;" +
        "color:rgba(232,236,243,0.75);cursor:pointer;";
      var showBox = doc.createElement("input");
      showBox.type = "checkbox";
      showBox.addEventListener("change", function () {
        input.type = showBox.checked ? "text" : "password";
      });
      var showText = doc.createElement("span");
      showText.textContent = "Show key";
      showRow.appendChild(showBox);
      showRow.appendChild(showText);

      var btnRow = doc.createElement("div");
      btnRow.style.cssText =
        "display:flex;gap:10px;margin-top:18px;justify-content:flex-end;";

      var cancel = doc.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      cancel.style.cssText =
        "padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.16);" +
        "background:transparent;color:inherit;font-size:14px;cursor:pointer;";

      var save = doc.createElement("button");
      save.type = "button";
      save.textContent = "Save";
      save.style.cssText =
        "padding:10px 18px;border-radius:10px;border:none;background:#4da3ff;" +
        "color:#04122b;font-weight:700;font-size:14px;cursor:pointer;";

      var settled = false;
      function cleanup(result) {
        if (settled) return;
        settled = true;
        doc.removeEventListener("keydown", onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === "Escape") {
          cleanup(null);
        } else if (e.key === "Enter") {
          e.preventDefault();
          cleanup(input.value);
        }
      }

      cancel.addEventListener("click", function () { cleanup(null); });
      save.addEventListener("click", function () { cleanup(input.value); });
      overlay.addEventListener("click", function (e) {
        if (e.target === overlay) cleanup(null);
      });
      doc.addEventListener("keydown", onKey, true);

      btnRow.appendChild(cancel);
      btnRow.appendChild(save);
      box.appendChild(label);
      box.appendChild(input);
      box.appendChild(showRow);
      box.appendChild(btnRow);
      overlay.appendChild(box);
      doc.body.appendChild(overlay);

      global.setTimeout(function () {
        try { input.focus(); input.select(); } catch (e) { /* ignore */ }
      }, 30);
    });
  }

  // Ask for the key, persist whatever is entered, resolve with it (or null).
  function promptForKey(message) {
    return showModal(
      message || "Enter the admin key to perform this action:",
      get(),
    ).then(function (next) {
      if (next === null || next === undefined) {
        return null;
      }
      next = String(next).trim();
      set(next);
      return next;
    });
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
    var stored = get();
    var keyPromise = stored ? Promise.resolve(stored) : promptForKey();

    return keyPromise.then(function (key) {
      if (!key) {
        return Promise.reject(new Error("Admin key required"));
      }
      return global.fetch(url, withKey(options, key)).then(function (res) {
        if (res.status !== 401) {
          return res;
        }
        // Stored key was rejected — give the owner one retry.
        return promptForKey("Admin key was rejected. Re-enter the admin key:").then(
          function (retryKey) {
            if (!retryKey) {
              return res;
            }
            return global.fetch(url, withKey(options, retryKey));
          },
        );
      });
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
