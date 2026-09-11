/* Manage Accounts panel for X Intelligence.

   The panel is scoped to the theme on screen. X Intelligence filters its feed
   by template membership, so a panel that only knew about the global tracked
   list could not answer the question people actually open it with: which
   accounts is *this* filter showing, and how do I change them. Adding from the
   Conspiracy theme used to write the account into Crypto & Stocks — the
   handle was tracked, and never appeared in the feed that was on screen.

   So there are two scopes here, and the panel opens on the first:

     - In this theme: the accounts the selected filter resolves to, in
       the order the template lists them.
     - All tracked: every account the dashboard fetches, whichever themes use
       it, so an existing handle can be pulled into this theme.

   and correspondingly two kinds of removal, which are not the same act:
   "Remove from <Theme>" drops one membership; "Delete" untracks the account
   everywhere and discards its cached feed data.

   Add and delete are server-persisted through /api/x/accounts/config and
   /api/x/templates/<id>/accounts, not stored as a browser preference — a
   localStorage-only list would quietly restore deleted accounts on the next
   redeploy, and only on the one device that made the change.

   Mutations go through AdminKey.fetch, which is the existing pattern for
   admin-gated actions: it prompts for the key with an in-page modal, stores
   it, and retries once on a 401.

   The validation and scoping helpers are exported for tests; the panel itself
   is DOM. */
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

  var THEME_SCOPE = "theme";
  var ALL_SCOPE = "all";

  function normalizeHandle(value) {
    return String(value == null ? "" : value).trim().replace(/^@+/, "").trim();
  }

  function canonicalHandle(value) {
    return normalizeHandle(value).toLowerCase();
  }

  function validateHandle(value) {
    var handle = normalizeHandle(value);
    if (!handle) return { ok: false, reason: "Enter an X handle." };
    if (!HANDLE_PATTERN.test(handle)) {
      return { ok: false, reason: "Handles are 1-15 letters, numbers or underscores." };
    }
    return { ok: true, handle: handle };
  }

  /* Returns the tracked account that already holds this handle, or null.
     Case-insensitive, because X handles are: @Barchart and @barchart are one
     account. The server enforces the same rule — this is the fast, friendly
     half, and it names the existing entry so the reason is obvious. */
  function findDuplicate(accounts, handle) {
    var wanted = canonicalHandle(handle);
    if (!wanted) return null;
    var match = (accounts || []).filter(function (account) {
      return canonicalHandle(account && account.handle) === wanted;
    });
    return match.length ? match[0] : null;
  }

  function isDuplicate(accounts, handle) {
    return Boolean(findDuplicate(accounts, handle));
  }

  /* Whether this template lists the handle. Kept separate from findDuplicate
     because "tracked" and "in this theme" are different questions, and
     conflating them is what made an already-tracked handle un-addable to the
     theme being viewed. */
  function isMember(template, handle) {
    var wanted = canonicalHandle(handle);
    if (!wanted) return false;
    return ((template && template.handles) || []).some(function (entry) {
      return canonicalHandle(entry) === wanted;
    });
  }

  /* The accounts this theme actually resolves to, in the order the template
     lists them — which is the order the page's sidebar renders.

     A handle naming an account that is no longer tracked is dropped, matching
     resolveAccounts on the server. Showing it would offer a row whose feed can
     never fill. */
  function accountsInTemplate(accounts, template) {
    var byHandle = {};
    (accounts || []).forEach(function (account) {
      byHandle[canonicalHandle(account && account.handle)] = account;
    });
    return ((template && template.handles) || []).reduce(function (rows, handle) {
      var account = byHandle[canonicalHandle(handle)];
      if (account) rows.push(account);
      return rows;
    }, []);
  }

  function themeName(template) {
    return (template && template.name) || "this theme";
  }

  function duplicateMessage(account) {
    return (
      "@" + account.handle + " is already tracked" +
      (account.category ? " under " + account.category : "") + "."
    );
  }

  /* The case the old panel turned into a dead end. The handle is tracked, so
     the add is refused — but it is not in the theme on screen, which is the
     thing the person was trying to fix. Say both, and the panel offers the
     one-click membership add alongside it. */
  function trackedElsewhereMessage(account, template) {
    return (
      "@" + account.handle + " is already tracked but is not in " +
      themeName(template) + ". Add it to this theme instead."
    );
  }

  function alreadyInThemeMessage(account, template) {
    return "@" + account.handle + " is already in " + themeName(template) + ".";
  }

  function confirmationMessage(handle) {
    return (
      "Remove @" + handle + " from X Intelligence? " +
      "Existing cached feed data for this account will also be removed."
    );
  }

  /* Deliberately not the wording of confirmationMessage above. The two
     removals differ in blast radius, and a person clicking the narrower one
     needs to be told it is the narrower one — that the account stays tracked
     and its other themes are untouched. */
  function removeFromThemeMessage(handle, template) {
    return (
      "Remove @" + handle + " from " + themeName(template) + "? " +
      "The account stays tracked and its other themes keep it."
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

    var overlay = el(doc, "div", "manage-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Manage X Intelligence accounts");

    var box = el(doc, "div", "manage-box");
    var head = el(doc, "div", "manage-head");
    var headText = el(doc, "div", "manage-head-text");
    headText.appendChild(el(doc, "h2", "manage-title", "Manage Accounts"));
    // Names the filter being edited. Without it the panel looks global, which
    // is exactly the confusion that let an add land in the wrong theme.
    var headSubtitle = el(doc, "p", "manage-subtitle", "");
    headText.appendChild(headSubtitle);
    head.appendChild(headText);
    var close = el(doc, "button", "manage-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    head.appendChild(close);
    box.appendChild(head);

    var scopeBar = el(doc, "div", "manage-scope");
    scopeBar.setAttribute("role", "tablist");
    var scopeTheme = el(doc, "button", "manage-scope-tab", "");
    scopeTheme.type = "button";
    scopeTheme.setAttribute("role", "tab");
    var scopeAll = el(doc, "button", "manage-scope-tab", "");
    scopeAll.type = "button";
    scopeAll.setAttribute("role", "tab");
    scopeBar.appendChild(scopeTheme);
    scopeBar.appendChild(scopeAll);
    box.appendChild(scopeBar);

    var status = el(doc, "div", "manage-status");
    status.setAttribute("role", "status");

    var form = el(doc, "form", "manage-form");
    var handleInput = el(doc, "input", "manage-input");
    handleInput.type = "text";
    handleInput.placeholder = "@handle";
    handleInput.setAttribute("aria-label", "X handle");
    handleInput.autocomplete = "off";

    var labelInput = el(doc, "input", "manage-input");
    labelInput.type = "text";
    labelInput.placeholder = "Display label (optional)";
    labelInput.setAttribute("aria-label", "Display label");
    labelInput.autocomplete = "off";

    var categoryInput = el(doc, "input", "manage-input");
    categoryInput.type = "text";
    categoryInput.placeholder = "Category";
    categoryInput.setAttribute("aria-label", "Category");
    categoryInput.setAttribute("list", "xManageCategories");
    categoryInput.autocomplete = "off";

    var categoryList = el(doc, "datalist");
    categoryList.id = "xManageCategories";

    // Says "already tracked" while the handle is still being typed, so a
    // duplicate is refused before anyone clicks Add rather than after.
    var dupHint = el(doc, "div", "manage-hint");
    dupHint.setAttribute("role", "status");
    dupHint.hidden = true;

    // The escape hatch for a handle that is tracked but missing from this
    // theme: one click puts it in, rather than leaving the add refused with
    // nothing to do about it.
    var adoptButton = el(doc, "button", "manage-adopt", "");
    adoptButton.type = "button";
    adoptButton.hidden = true;

    var submit = el(doc, "button", "manage-add", "Add Account");
    submit.type = "submit";

    form.appendChild(handleInput);
    form.appendChild(dupHint);
    form.appendChild(adoptButton);
    form.appendChild(labelInput);
    form.appendChild(categoryInput);
    form.appendChild(categoryList);
    form.appendChild(submit);

    var listRoot = el(doc, "div", "manage-list");

    box.appendChild(form);
    box.appendChild(status);
    box.appendChild(listRoot);
    overlay.appendChild(box);
    doc.body.appendChild(overlay);

    var accounts = [];
    var categories = [];
    var template = opts.template ? JSON.parse(JSON.stringify(opts.template)) : null;
    var scope = THEME_SCOPE;
    var changed = false;

    function say(message, tone) {
      status.textContent = message || "";
      status.className = "manage-status" + (tone ? " is-" + tone : "");
    }

    function cleanup() {
      doc.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (changed) onChange(accounts, { template: template });
    }

    function onKey(e) {
      if (e.key === "Escape") cleanup();
    }

    /* Re-adopts the template from a mutation response, so membership state on
       screen is the server's rather than an optimistic guess. */
    function adoptTemplates(body) {
      if (!template || !body || !body.templates) return;
      var next = body.templates.filter(function (entry) { return entry.id === template.id; });
      if (next.length) template = next[0];
    }

    function syncHead() {
      if (!template) {
        headSubtitle.textContent = "Accounts the dashboard tracks and fetches.";
        scopeBar.hidden = true;
        return;
      }
      scopeBar.hidden = false;
      headSubtitle.textContent =
        "Editing " + template.name + " — the theme selected on the page.";
      var inTheme = accountsInTemplate(accounts, template).length;
      scopeTheme.textContent = "In " + template.name + " (" + inTheme + ")";
      scopeAll.textContent = "All tracked (" + accounts.length + ")";
      scopeTheme.className = "manage-scope-tab" + (scope === THEME_SCOPE ? " active" : "");
      scopeAll.className = "manage-scope-tab" + (scope === ALL_SCOPE ? " active" : "");
      scopeTheme.setAttribute("aria-selected", scope === THEME_SCOPE ? "true" : "false");
      scopeAll.setAttribute("aria-selected", scope === ALL_SCOPE ? "true" : "false");
      submit.textContent = "Add to " + template.name;
    }

    /* The account's own category — descriptive metadata the registry requires,
       not a second filter. Templates have no sections to file it under. */
    function syncCategoryOptions() {
      categoryList.innerHTML = "";
      (categories || []).forEach(function (name) {
        var option = doc.createElement("option");
        option.value = name;
        categoryList.appendChild(option);
      });
      if (!categoryInput.value && categories.length) categoryInput.value = categories[0];
    }

    /* Keeps the duplicate warning, the adopt button and the Add button in step
       with what is typed and with the list the server last confirmed. */
    function refreshDuplicateHint() {
      var existing = findDuplicate(accounts, handleInput.value);
      if (!existing) {
        dupHint.hidden = true;
        dupHint.textContent = "";
        adoptButton.hidden = true;
        handleInput.setAttribute("aria-invalid", "false");
        submit.disabled = false;
        return;
      }
      handleInput.setAttribute("aria-invalid", "true");
      submit.disabled = true;
      dupHint.hidden = false;
      if (!template || isMember(template, existing.handle)) {
        dupHint.textContent = template
          ? alreadyInThemeMessage(existing, template)
          : duplicateMessage(existing);
        adoptButton.hidden = true;
        return;
      }
      dupHint.textContent = trackedElsewhereMessage(existing, template);
      adoptButton.hidden = false;
      adoptButton.textContent = "Add @" + existing.handle + " to " + template.name;
      adoptButton.onclick = function () { addMember(existing.handle); };
    }

    /* Puts an already-tracked handle into this theme. Membership-only: the
       global account, its label and its cached feed data are untouched. */
    function addMember(handle) {
      if (!template) return;
      say("Adding @" + handle + " to " + template.name + "…");
      adoptButton.disabled = true;
      window.AdminKey.fetchOrSession(
        "/api/x/templates/" + encodeURIComponent(template.id) + "/accounts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ handle: handle }),
        }
      )
        .then(readJson)
        .then(function (result) {
          accounts = result.accounts || accounts;
          adoptTemplates(result);
          changed = true;
          if (canonicalHandle(handleInput.value) === canonicalHandle(handle)) handleInput.value = "";
          renderList();
          say("Added @" + handle + " to " + template.name + ".", "ok");
          onChange(accounts, { added: handle, template: template });
        })
        .catch(function (err) {
          say(err.message || "Could not add the account to this theme.", "error");
        })
        .then(function () {
          adoptButton.disabled = false;
          refreshDuplicateHint();
        });
    }

    /* Drops one membership. Deliberately distinct from removeAccount below:
       this leaves the account tracked, so the feed keeps working for every
       other theme that uses it. */
    function removeMember(handle, button) {
      if (!template) return;
      if (!window.confirm(removeFromThemeMessage(handle, template))) return;
      button.disabled = true;
      say("Removing @" + handle + " from " + template.name + "…");
      window.AdminKey.fetchOrSession(
        "/api/x/templates/" + encodeURIComponent(template.id) +
          "/accounts/" + encodeURIComponent(handle),
        { method: "DELETE" }
      )
        .then(readJson)
        .then(function (result) {
          accounts = result.accounts || accounts;
          adoptTemplates(result);
          changed = true;
          renderList();
          say("Removed @" + handle + " from " + template.name + ".", "ok");
          onChange(accounts, { removed: handle, template: template });
        })
        .catch(function (err) {
          button.disabled = false;
          say(err.message || "Could not remove the account from this theme.", "error");
        });
    }

    /* Untracks the account everywhere and discards its cached feed data. */
    function removeAccount(handle, button) {
      if (!window.confirm(confirmationMessage(handle))) return;
      button.disabled = true;
      say("Removing @" + handle + "…");
      window.AdminKey.fetchOrSession("/api/x/accounts/config/" + encodeURIComponent(handle), {
        method: "DELETE",
      })
        .then(readJson)
        .then(function (result) {
          accounts = result.accounts;
          adoptTemplates(result);
          changed = true;
          renderList();
          say("Removed @" + handle + ".", "ok");
          onChange(accounts, { removed: handle, template: template });
        })
        .catch(function (err) {
          button.disabled = false;
          say(err.message || "Could not remove the account.", "error");
        });
    }

    function emptyMessage() {
      if (scope === ALL_SCOPE || !template) return "No accounts are tracked yet.";
      return "No accounts in " + template.name + " yet — add one above.";
    }

    function renderRow(account) {
      var row = el(doc, "div", "manage-row");
      var text = el(doc, "div", "manage-row-text");
      text.appendChild(el(doc, "span", "manage-row-handle", "@" + account.handle));
      text.appendChild(
        el(doc, "span", "manage-row-meta", account.label + " · " + account.category)
      );
      row.appendChild(text);

      var actions = el(doc, "div", "manage-row-actions");
      if (template && scope === ALL_SCOPE && !isMember(template, account.handle)) {
        // The reason the "All tracked" scope exists: an account can be pulled
        // into the theme on screen from here, without retyping it.
        var add = el(doc, "button", "manage-row-add", "+ " + template.name);
        add.type = "button";
        add.setAttribute("aria-label", "Add @" + account.handle + " to " + template.name);
        add.addEventListener("click", function () { addMember(account.handle); });
        actions.appendChild(add);
      }
      if (template && isMember(template, account.handle)) {
        var drop = el(doc, "button", "manage-row-remove", "Remove from " + template.name);
        drop.type = "button";
        drop.addEventListener("click", function () { removeMember(account.handle, drop); });
        actions.appendChild(drop);
      }
      var remove = el(doc, "button", "manage-delete", "Delete");
      remove.type = "button";
      remove.title = "Untrack this account everywhere and discard its cached posts";
      remove.addEventListener("click", function () { removeAccount(account.handle, remove); });
      actions.appendChild(remove);
      row.appendChild(actions);
      return row;
    }

    function renderList() {
      listRoot.innerHTML = "";
      syncHead();
      syncCategoryOptions();
      refreshDuplicateHint();
      var rows = scope === THEME_SCOPE && template
        ? accountsInTemplate(accounts, template)
        : accounts;
      if (!rows.length) {
        listRoot.appendChild(el(doc, "div", "manage-empty", emptyMessage()));
        return;
      }
      rows.forEach(function (account) {
        listRoot.appendChild(renderRow(account));
      });
    }

    function setScope(next) {
      scope = next;
      renderList();
    }

    scopeTheme.addEventListener("click", function () { setScope(THEME_SCOPE); });
    scopeAll.addEventListener("click", function () { setScope(ALL_SCOPE); });

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
      var existing = findDuplicate(accounts, check.handle);
      if (existing) {
        // Tracked but absent from this theme is not a plain rejection: the
        // adopt button next to the hint is the thing to click.
        say(
          template && !isMember(template, existing.handle)
            ? trackedElsewhereMessage(existing, template)
            : duplicateMessage(existing),
          "error"
        );
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
          // Which theme the account joins. Omitted, the server falls back to
          // the default template — which is what used to happen always, and
          // is why an account added from another theme never showed up in it.
          template: template ? template.id : undefined,
        }),
      })
        .then(readJson)
        .then(function (result) {
          accounts = result.accounts;
          adoptTemplates(result);
          changed = true;
          handleInput.value = "";
          labelInput.value = "";
          renderList();
          say(
            "Added @" + check.handle + (template ? " to " + template.name : "") + ".",
            "ok"
          );
          onChange(accounts, { added: check.handle, template: template });
        })
        .catch(function (err) {
          say(err.message || "Could not add the account.", "error");
        })
        .then(function () {
          // Re-enables through the duplicate check rather than unconditionally:
          // a rejected add leaves the handle in the box, and it is still a
          // duplicate.
          refreshDuplicateHint();
        });
    });

    handleInput.addEventListener("input", refreshDuplicateHint);

    close.addEventListener("click", cleanup);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) cleanup();
    });
    doc.addEventListener("keydown", onKey, true);

    say("Loading tracked accounts…");
    // The template comes from the page so the panel can render its scope
    // immediately, but its memberships are re-read here: the page's copy is as
    // old as its last feed refresh, and stale memberships would mis-report
    // what is in the theme.
    Promise.all([
      fetch("/api/x/accounts/config", { headers: { Accept: "application/json" } }).then(readJson),
      template
        ? fetch("/api/x/templates", { headers: { Accept: "application/json" } })
            .then(readJson)
            .catch(function () { return null; })
        : Promise.resolve(null),
    ])
      .then(function (results) {
        var body = results[0];
        accounts = body.accounts || [];
        categories = body.categories || [];
        adoptTemplates(results[1]);
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
    findDuplicate: findDuplicate,
    isMember: isMember,
    accountsInTemplate: accountsInTemplate,
    duplicateMessage: duplicateMessage,
    trackedElsewhereMessage: trackedElsewhereMessage,
    alreadyInThemeMessage: alreadyInThemeMessage,
    confirmationMessage: confirmationMessage,
    removeFromThemeMessage: removeFromThemeMessage,
  };
});
