/* Manage Accounts panel for X Intelligence.

   Add and delete are server-persisted through /api/x/accounts/config, not
   stored as a browser preference — a localStorage-only list would quietly
   restore deleted accounts on the next redeploy, and only on the one device
   that made the change.

   Mutations go through AdminKey.fetch, which is the existing pattern for
   admin-gated actions: it prompts for the key with an in-page modal, stores
   it, and retries once on a 401.

   The validation helpers are exported for tests; the panel itself is DOM. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XAccountsAdmin = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // Mirrors the server rule in src/services/x-account-registry.js. Duplicated
  // deliberately: the client check is for a fast, friendly message, and the
  // server's is the one that actually guards the store.
  var HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

  function normalizeHandle(value) {
    return String(value == null ? "" : value).trim().replace(/^@+/, "").trim();
  }

  function validateHandle(value) {
    var handle = normalizeHandle(value);
    if (!handle) return { ok: false, reason: "Enter an X handle." };
    if (!HANDLE_PATTERN.test(handle)) {
      return { ok: false, reason: "Handles are 1-15 letters, numbers or underscores." };
    }
    return { ok: true, handle: handle };
  }

  function isDuplicate(accounts, handle) {
    var wanted = normalizeHandle(handle).toLowerCase();
    return (accounts || []).some(function (account) {
      return String(account.handle).toLowerCase() === wanted;
    });
  }

  function confirmationMessage(handle) {
    return (
      "Remove @" + handle + " from X Intelligence? " +
      "Existing cached feed data for this account will also be removed."
    );
  }

  function el(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function open(options) {
    var opts = options || {};
    var doc = document;
    var onChange = opts.onChange || function () {};

    var overlay = el(doc, "div", "x-manage-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Manage X Intelligence accounts");

    var box = el(doc, "div", "x-manage-box");
    var head = el(doc, "div", "x-manage-head");
    head.appendChild(el(doc, "h2", "x-manage-title", "Manage Accounts"));
    var close = el(doc, "button", "x-manage-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    head.appendChild(close);
    box.appendChild(head);

    var status = el(doc, "div", "x-manage-status");
    status.setAttribute("role", "status");

    var form = el(doc, "form", "x-manage-form");
    var handleInput = el(doc, "input", "x-manage-input");
    handleInput.type = "text";
    handleInput.placeholder = "@handle";
    handleInput.setAttribute("aria-label", "X handle");
    handleInput.autocomplete = "off";

    var labelInput = el(doc, "input", "x-manage-input");
    labelInput.type = "text";
    labelInput.placeholder = "Display label (optional)";
    labelInput.setAttribute("aria-label", "Display label");
    labelInput.autocomplete = "off";

    var categoryInput = el(doc, "input", "x-manage-input");
    categoryInput.type = "text";
    categoryInput.placeholder = "Category";
    categoryInput.setAttribute("aria-label", "Category");
    categoryInput.setAttribute("list", "xManageCategories");
    categoryInput.autocomplete = "off";

    var categoryList = el(doc, "datalist");
    categoryList.id = "xManageCategories";

    var submit = el(doc, "button", "x-manage-add", "Add Account");
    submit.type = "submit";

    form.appendChild(handleInput);
    form.appendChild(labelInput);
    form.appendChild(categoryInput);
    form.appendChild(categoryList);
    form.appendChild(submit);

    var listRoot = el(doc, "div", "x-manage-list");

    box.appendChild(form);
    box.appendChild(status);
    box.appendChild(listRoot);
    overlay.appendChild(box);
    doc.body.appendChild(overlay);

    var accounts = [];
    var changed = false;

    function say(message, tone) {
      status.textContent = message || "";
      status.className = "x-manage-status" + (tone ? " is-" + tone : "");
    }

    function cleanup() {
      doc.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (changed) onChange(accounts);
    }

    function onKey(e) {
      if (e.key === "Escape") cleanup();
    }

    function renderList() {
      listRoot.innerHTML = "";
      if (!accounts.length) {
        listRoot.appendChild(el(doc, "div", "x-manage-empty", "No accounts are tracked yet."));
        return;
      }
      accounts.forEach(function (account) {
        var row = el(doc, "div", "x-manage-row");
        var text = el(doc, "div", "x-manage-row-text");
        text.appendChild(el(doc, "span", "x-manage-row-handle", "@" + account.handle));
        text.appendChild(
          el(doc, "span", "x-manage-row-meta", account.label + " · " + account.category)
        );
        var remove = el(doc, "button", "x-manage-delete", "Delete");
        remove.type = "button";
        remove.addEventListener("click", function () {
          if (!window.confirm(confirmationMessage(account.handle))) return;
          remove.disabled = true;
          say("Removing @" + account.handle + "…");
          window.AdminKey.fetchOrSession("/api/x/accounts/config/" + encodeURIComponent(account.handle), {
            method: "DELETE",
          })
            .then(readJson)
            .then(function (result) {
              accounts = result.accounts;
              changed = true;
              renderList();
              say("Removed @" + account.handle + ".", "ok");
              onChange(accounts, { removed: account.handle });
            })
            .catch(function (err) {
              remove.disabled = false;
              say(err.message || "Could not remove the account.", "error");
            });
        });
        row.appendChild(text);
        row.appendChild(remove);
        listRoot.appendChild(row);
      });
    }

    function readJson(res) {
      return res.json().then(
        function (body) {
          if (!res.ok) throw new Error(body && body.error ? body.error : "Request failed: " + res.status);
          return body;
        },
        function () {
          throw new Error("Request failed: " + res.status);
        }
      );
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var check = validateHandle(handleInput.value);
      if (!check.ok) {
        say(check.reason, "error");
        return;
      }
      if (isDuplicate(accounts, check.handle)) {
        say("@" + check.handle + " is already tracked.", "error");
        return;
      }
      var category = categoryInput.value.trim();
      if (!category) {
        say("Choose or type a category.", "error");
        return;
      }

      submit.disabled = true;
      say("Adding @" + check.handle + "…");
      window.AdminKey.fetchOrSession("/api/x/accounts/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: check.handle,
          label: labelInput.value.trim(),
          category: category,
        }),
      })
        .then(readJson)
        .then(function (result) {
          accounts = result.accounts;
          changed = true;
          handleInput.value = "";
          labelInput.value = "";
          renderList();
          say("Added @" + check.handle + ".", "ok");
          onChange(accounts, { added: check.handle });
        })
        .catch(function (err) {
          say(err.message || "Could not add the account.", "error");
        })
        .then(function () {
          submit.disabled = false;
        });
    });

    close.addEventListener("click", cleanup);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) cleanup();
    });
    doc.addEventListener("keydown", onKey, true);

    say("Loading tracked accounts…");
    fetch("/api/x/accounts/config", { headers: { Accept: "application/json" } })
      .then(readJson)
      .then(function (body) {
        accounts = body.accounts || [];
        (body.categories || []).forEach(function (name) {
          var option = doc.createElement("option");
          option.value = name;
          categoryList.appendChild(option);
        });
        if (!categoryInput.value && body.categories && body.categories.length) {
          categoryInput.value = body.categories[0];
        }
        renderList();
        // A registry the server could not read is worth saying out loud —
        // the list on screen would be the seed, not what was saved.
        if (body.registry && body.registry.loadState === "corrupt") {
          say("The saved account list could not be read; showing defaults.", "error");
        } else {
          say("");
        }
      })
      .catch(function () {
        say("Could not load the tracked accounts.", "error");
      });

    setTimeout(function () {
      try { handleInput.focus(); } catch (e) { /* ignore */ }
    }, 30);
  }

  return {
    open: open,
    normalizeHandle: normalizeHandle,
    validateHandle: validateHandle,
    isDuplicate: isDuplicate,
    confirmationMessage: confirmationMessage,
  };
});
