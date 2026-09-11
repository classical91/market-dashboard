/* Persistent X Intelligence template manager. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XTemplatesAdmin = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  /* Every accent x-intelligence.css defines a [data-x-accent] rule for. The
     list was missing "conspiracy", so opening that theme showed "Market"
     selected and saving silently repainted it — the select is the only way to
     set an accent, so anything absent here is unreachable and lossy. */
  var ACCENTS = ["market", "world", "tech", "relic", "macro", "energy", "neutral", "conspiracy"];

  function slugify(value) {
    return String(value == null ? "" : value)
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /* One handle, one entry — X handles are case-insensitive, and a template
     holding an account twice would list it twice in the sidebar and double
     every one of its posts in the feed. Mirrors the server rule in
     src/services/x-template-registry.js. */
  function sameHandle(a, b) {
    return String(a == null ? "" : a).trim().replace(/^@+/, "").toLowerCase()
      === String(b == null ? "" : b).trim().replace(/^@+/, "").toLowerCase();
  }

  function isMember(draft, handle) {
    return ((draft && draft.handles) || []).some(function (entry) {
      return sameHandle(entry, handle);
    });
  }

  function el(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function readJson(res) {
    return res.json().then(function (body) {
      if (!res.ok) throw new Error(body && body.error ? body.error : "Request failed: " + res.status);
      return body;
    }, function () {
      throw new Error("Request failed: " + res.status);
    });
  }

  function adminFetch(url, options) {
    return window.AdminKey.fetchOrSession(url, options || {}).then(readJson);
  }

  /* A template is a name, a look and a flat list of handles. Sections are
     gone: the page's switcher is the only filter, and the account sidebar
     renders this list in order. */
  function normalizeDraft(draft) {
    var handles = [];
    ((draft && draft.handles) || []).forEach(function (entry) {
      var handle = String(entry == null ? "" : entry).trim().replace(/^@+/, "");
      if (!handle) return;
      if (handles.some(function (item) { return sameHandle(item, handle); })) return;
      handles.push(handle);
    });
    return {
      id: slugify(draft.id || draft.name),
      name: String(draft.name || "").trim().slice(0, 60),
      description: String(draft.description || "").trim().slice(0, 240),
      accent: slugify(draft.accent || "market") || "market",
      handles: handles,
    };
  }

  function open(options) {
    var opts = options || {};
    var doc = document;
    var overlay = el(doc, "div", "manage-overlay x-template-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Manage X Intelligence templates");
    var box = el(doc, "div", "manage-box x-template-manager");
    var head = el(doc, "div", "manage-head");
    head.appendChild(el(doc, "div", "x-template-heading-wrap"));
    head.firstChild.appendChild(el(doc, "h2", "manage-title", "Manage Templates"));
    head.firstChild.appendChild(el(doc, "p", "x-template-help", "Group global X accounts into reusable intelligence workspaces."));
    var close = el(doc, "button", "manage-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    head.appendChild(close);
    var status = el(doc, "div", "manage-status");
    status.setAttribute("role", "status");
    var layout = el(doc, "div", "x-template-manager-layout");
    var nav = el(doc, "aside", "x-template-nav");
    var editor = el(doc, "div", "x-template-editor");
    layout.appendChild(nav);
    layout.appendChild(editor);
    box.appendChild(head);
    box.appendChild(status);
    box.appendChild(layout);
    overlay.appendChild(box);
    doc.body.appendChild(overlay);

    var state = { templates: [], accounts: [], selectedId: opts.activeTemplateId || "markets", draft: null, creating: !!opts.createNew };

    function say(message, tone) {
      status.textContent = message || "";
      status.className = "manage-status" + (tone ? " is-" + tone : "");
    }

    function cleanup() {
      doc.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function onKey(event) {
      if (event.key === "Escape") cleanup();
    }

    function selected() {
      return state.templates.find(function (template) { return template.id === state.selectedId; }) || state.templates[0];
    }

    function resetDraft(template) {
      state.creating = !template;
      state.draft = template ? copy(template) : {
        id: "", name: "", description: "", accent: "world", handles: [],
      };
    }

    function notify(templateId) {
      if (typeof opts.onChange === "function") opts.onChange(copy(state.templates), templateId || state.selectedId);
    }

    function persistOrder() {
      return adminFetch("/api/x/templates/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: state.templates.map(function (template) { return template.id; }) }),
      }).then(function (body) {
        state.templates = body.templates || state.templates;
        notify();
      });
    }

    function moveTemplate(index, direction) {
      var target = index + direction;
      if (target < 0 || target >= state.templates.length) return;
      var moved = state.templates.splice(index, 1)[0];
      state.templates.splice(target, 0, moved);
      renderNav();
      say("Saving template order…");
      persistOrder().then(function () { say("Template order saved.", "ok"); }).catch(function (err) {
        say(err.message, "error");
        load();
      });
    }

    function renderNav() {
      nav.innerHTML = "";
      var newButton = el(doc, "button", "x-template-new", "+ New Template");
      newButton.type = "button";
      newButton.addEventListener("click", function () {
        resetDraft(null);
        renderNav();
        renderEditor();
      });
      nav.appendChild(newButton);
      state.templates.forEach(function (template, index) {
        var row = el(doc, "div", "x-template-nav-row" + (!state.creating && template.id === state.selectedId ? " active" : ""));
        var pick = el(doc, "button", "x-template-nav-pick", template.name);
        pick.type = "button";
        pick.addEventListener("click", function () {
          state.selectedId = template.id;
          resetDraft(template);
          renderNav();
          renderEditor();
        });
        var controls = el(doc, "span", "x-template-order-controls");
        [["↑", -1], ["↓", 1]].forEach(function (entry) {
          var button = el(doc, "button", "x-template-order", entry[0]);
          button.type = "button";
          button.disabled = entry[1] < 0 ? index === 0 : index === state.templates.length - 1;
          button.setAttribute("aria-label", (entry[1] < 0 ? "Move " : "Move ") + template.name + (entry[1] < 0 ? " up" : " down"));
          button.addEventListener("click", function () { moveTemplate(index, entry[1]); });
          controls.appendChild(button);
        });
        row.appendChild(pick);
        row.appendChild(controls);
        nav.appendChild(row);
      });
    }

    function field(label, input) {
      var wrapper = el(doc, "label", "x-template-field");
      wrapper.appendChild(el(doc, "span", "x-template-field-label", label));
      wrapper.appendChild(input);
      return wrapper;
    }

    function syncDraftFromFields(nameInput, descriptionInput, accentInput) {
      state.draft.name = nameInput.value;
      state.draft.description = descriptionInput.value;
      state.draft.accent = accentInput.value;
      if (state.creating) state.draft.id = slugify(nameInput.value);
    }

    function renderEditor() {
      editor.innerHTML = "";
      if (!state.draft) resetDraft(selected());
      var draft = state.draft;
      var title = el(doc, "div", "x-template-editor-title", state.creating ? "New template" : "Edit template");
      editor.appendChild(title);

      var basics = el(doc, "div", "x-template-basics");
      var nameInput = el(doc, "input", "manage-input");
      nameInput.value = draft.name;
      nameInput.placeholder = "Wars & Geopolitics";
      nameInput.addEventListener("input", function () {
        draft.name = nameInput.value;
        if (state.creating) draft.id = slugify(nameInput.value);
      });
      var descriptionInput = el(doc, "textarea", "manage-input x-template-description-input");
      descriptionInput.value = draft.description;
      descriptionInput.placeholder = "What this workspace monitors";
      descriptionInput.addEventListener("input", function () { draft.description = descriptionInput.value; });
      var accentInput = el(doc, "select", "manage-input");
      ACCENTS.forEach(function (accent) {
        var option = el(doc, "option", "", accent.charAt(0).toUpperCase() + accent.slice(1));
        option.value = accent;
        option.selected = accent === draft.accent;
        accentInput.appendChild(option);
      });
      accentInput.addEventListener("change", function () { draft.accent = accentInput.value; });
      basics.appendChild(field("Name", nameInput));
      basics.appendChild(field("Description", descriptionInput));
      basics.appendChild(field("Accent", accentInput));
      editor.appendChild(basics);

      var listHead = el(doc, "div", "x-template-section-head");
      listHead.appendChild(el(doc, "h3", "x-template-section-title", "Accounts"));
      listHead.appendChild(el(doc, "span", "x-template-help", "Shown in this order"));
      editor.appendChild(listHead);

      var accountsRoot = el(doc, "div", "x-template-accounts");
      if (!draft.handles.length) {
        accountsRoot.appendChild(
          el(doc, "div", "manage-empty", "No accounts yet — add a tracked account below.")
        );
      }
      draft.handles.forEach(function (handle, index) {
        var account = state.accounts.find(function (entry) { return sameHandle(entry.handle, handle); });
        var row = el(doc, "div", "x-template-member");
        row.appendChild(el(
          doc, "span", "x-template-member-name",
          "@" + handle + (account && account.label !== account.handle ? " · " + account.label : "")
        ));
        var controls = el(doc, "span", "x-template-order-controls");
        // Order is the only arrangement a template has now, and it is what the
        // account sidebar renders, so moving a row is a real edit rather than
        // cosmetic.
        [["↑", -1], ["↓", 1]].forEach(function (entry) {
          var move = el(doc, "button", "x-template-order", entry[0]);
          move.type = "button";
          move.disabled = entry[1] < 0 ? index === 0 : index === draft.handles.length - 1;
          move.setAttribute("aria-label", "Move @" + handle + (entry[1] < 0 ? " up" : " down"));
          move.addEventListener("click", function () {
            var moved = draft.handles.splice(index, 1)[0];
            draft.handles.splice(index + entry[1], 0, moved);
            renderEditor();
          });
          controls.appendChild(move);
        });
        row.appendChild(controls);
        var removeMember = el(doc, "button", "x-template-member-remove", "×");
        removeMember.type = "button";
        removeMember.setAttribute("aria-label", "Remove @" + handle + " from template");
        removeMember.addEventListener("click", function () {
          draft.handles = draft.handles.filter(function (entry) { return !sameHandle(entry, handle); });
          renderEditor();
        });
        row.appendChild(removeMember);
        accountsRoot.appendChild(row);
      });

      var available = state.accounts.filter(function (account) {
        return !isMember(draft, account.handle);
      });
      if (available.length) {
        var addRow = el(doc, "div", "x-template-add-account");
        var accountSelect = el(doc, "select", "manage-input");
        var placeholder = el(doc, "option", "", "Add tracked account…");
        placeholder.value = "";
        accountSelect.appendChild(placeholder);
        available.forEach(function (account) {
          var option = el(doc, "option", "", "@" + account.handle + " · " + account.label);
          option.value = account.handle;
          accountSelect.appendChild(option);
        });
        accountSelect.addEventListener("change", function () {
          if (!accountSelect.value) return;
          // The picker already hides accounts this template holds; this guards
          // the case where the draft moved on since it was rendered, so one
          // account can never be listed twice.
          if (isMember(draft, accountSelect.value)) {
            say("@" + accountSelect.value + " is already in this template.", "error");
            accountSelect.value = "";
            return;
          }
          draft.handles.push(accountSelect.value);
          renderEditor();
        });
        addRow.appendChild(accountSelect);
        accountsRoot.appendChild(addRow);
      }
      editor.appendChild(accountsRoot);

      var actions = el(doc, "div", "x-template-actions");
      var save = el(doc, "button", "manage-add", state.creating ? "Create Template" : "Save Changes");
      save.type = "button";
      save.addEventListener("click", function () {
        syncDraftFromFields(nameInput, descriptionInput, accentInput);
        var payload = normalizeDraft(draft);
        if (!payload.name || !payload.id) { say("Enter a template name.", "error"); return; }
        save.disabled = true;
        say(state.creating ? "Creating template…" : "Saving template…");
        adminFetch(state.creating ? "/api/x/templates" : "/api/x/templates/" + encodeURIComponent(state.selectedId), {
          method: state.creating ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).then(function (body) {
          state.templates = body.templates || [];
          state.selectedId = body.template.id;
          resetDraft(body.template);
          renderNav();
          renderEditor();
          say("Template saved.", "ok");
          notify(body.template.id);
        }).catch(function (err) { say(err.message, "error"); }).then(function () { save.disabled = false; });
      });
      actions.appendChild(save);

      if (!state.creating) {
        var duplicate = el(doc, "button", "x-template-secondary", "Duplicate Template");
        duplicate.type = "button";
        duplicate.addEventListener("click", function () {
          syncDraftFromFields(nameInput, descriptionInput, accentInput);
          say("Duplicating template…");
          adminFetch("/api/x/templates/" + encodeURIComponent(state.selectedId) + "/duplicate", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
          }).then(function (body) {
            state.templates = body.templates || [];
            state.selectedId = body.template.id;
            resetDraft(body.template);
            renderNav(); renderEditor(); say("Template duplicated.", "ok"); notify(body.template.id);
          }).catch(function (err) { say(err.message, "error"); });
        });
        actions.appendChild(duplicate);

        var remove = el(doc, "button", "x-template-danger", "Delete Template");
        remove.type = "button";
        remove.disabled = state.selectedId === "markets";
        remove.title = remove.disabled ? "The default template cannot be deleted" : "";
        remove.addEventListener("click", function () {
          if (!window.confirm("Delete " + draft.name + "? Accounts and cached X data will be kept.")) return;
          adminFetch("/api/x/templates/" + encodeURIComponent(state.selectedId), { method: "DELETE" })
            .then(function (body) {
              state.templates = body.templates || [];
              state.selectedId = "markets";
              resetDraft(state.templates.find(function (template) { return template.id === state.selectedId; }));
              renderNav(); renderEditor(); say("Template deleted; tracked accounts were kept.", "ok"); notify("markets");
            }).catch(function (err) { say(err.message, "error"); });
        });
        actions.appendChild(remove);
      }
      editor.appendChild(actions);
    }

    function load() {
      say("Loading templates…");
      return Promise.all([
        fetch("/api/x/templates", { headers: { Accept: "application/json" } }).then(readJson),
        fetch("/api/x/accounts/config", { headers: { Accept: "application/json" } }).then(readJson),
      ]).then(function (results) {
        state.templates = results[0].templates || [];
        state.accounts = results[1].accounts || [];
        if (!state.templates.some(function (template) { return template.id === state.selectedId; })) state.selectedId = "markets";
        resetDraft(state.creating ? null : selected());
        renderNav();
        renderEditor();
        say("");
      }).catch(function (err) { say(err.message || "Could not load templates.", "error"); });
    }

    close.addEventListener("click", cleanup);
    overlay.addEventListener("click", function (event) { if (event.target === overlay) cleanup(); });
    doc.addEventListener("keydown", onKey, true);
    load();
  }

  return {
    open: open,
    ACCENTS: ACCENTS,
    slugify: slugify,
    normalizeDraft: normalizeDraft,
    sameHandle: sameHandle,
    isMember: isMember,
  };
});
