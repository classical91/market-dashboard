/* Persistent X Intelligence template manager. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XTemplatesAdmin = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  function slugify(value) {
    return String(value == null ? "" : value)
      .trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
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
    return window.AdminKey.fetch(url, options || {}).then(readJson);
  }

  function normalizeDraft(draft) {
    var sections = [];
    (draft.sections || []).forEach(function (name) {
      name = String(name || "").trim().slice(0, 60);
      if (name && !sections.some(function (entry) { return entry.toLowerCase() === name.toLowerCase(); })) {
        sections.push(name);
      }
    });
    var memberships = [];
    (draft.memberships || []).forEach(function (entry) {
      var canonicalSection = sections.find(function (name) { return name.toLowerCase() === String(entry.section).toLowerCase(); });
      if (!entry.handle || !canonicalSection) return;
      if (!memberships.some(function (item) { return item.handle.toLowerCase() === entry.handle.toLowerCase(); })) {
        memberships.push({ handle: entry.handle, section: canonicalSection });
      }
    });
    return {
      id: slugify(draft.id || draft.name),
      name: String(draft.name || "").trim().slice(0, 60),
      description: String(draft.description || "").trim().slice(0, 240),
      accent: slugify(draft.accent || "market") || "market",
      sections: sections,
      memberships: memberships,
    };
  }

  function open(options) {
    var opts = options || {};
    var doc = document;
    var overlay = el(doc, "div", "x-manage-overlay x-template-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Manage X Intelligence templates");
    var box = el(doc, "div", "x-manage-box x-template-manager");
    var head = el(doc, "div", "x-manage-head");
    head.appendChild(el(doc, "div", "x-template-heading-wrap"));
    head.firstChild.appendChild(el(doc, "h2", "x-manage-title", "Manage Templates"));
    head.firstChild.appendChild(el(doc, "p", "x-template-help", "Organize global X accounts into reusable intelligence workspaces."));
    var close = el(doc, "button", "x-manage-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    head.appendChild(close);
    var status = el(doc, "div", "x-manage-status");
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
      status.className = "x-manage-status" + (tone ? " is-" + tone : "");
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
        id: "", name: "", description: "", accent: "world", sections: [], memberships: [],
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
      var nameInput = el(doc, "input", "x-manage-input");
      nameInput.value = draft.name;
      nameInput.placeholder = "Wars & Geopolitics";
      nameInput.addEventListener("input", function () {
        draft.name = nameInput.value;
        if (state.creating) draft.id = slugify(nameInput.value);
      });
      var descriptionInput = el(doc, "textarea", "x-manage-input x-template-description-input");
      descriptionInput.value = draft.description;
      descriptionInput.placeholder = "What this workspace monitors";
      descriptionInput.addEventListener("input", function () { draft.description = descriptionInput.value; });
      var accentInput = el(doc, "select", "x-manage-input");
      ["market", "world", "tech", "macro", "energy", "neutral"].forEach(function (accent) {
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

      var sectionHead = el(doc, "div", "x-template-section-head");
      sectionHead.appendChild(el(doc, "h3", "x-template-section-title", "Sections & accounts"));
      var addSection = el(doc, "button", "x-template-secondary", "+ Add Section");
      addSection.type = "button";
      addSection.addEventListener("click", function () {
        var count = draft.sections.length + 1;
        draft.sections.push("New Section " + count);
        renderEditor();
      });
      sectionHead.appendChild(addSection);
      editor.appendChild(sectionHead);

      var sectionsRoot = el(doc, "div", "x-template-sections");
      if (!draft.sections.length) sectionsRoot.appendChild(el(doc, "div", "x-manage-empty", "Add a section, then assign tracked accounts."));
      draft.sections.forEach(function (section, sectionIndex) {
        var sectionBox = el(doc, "section", "x-template-section");
        var sectionToolbar = el(doc, "div", "x-template-section-toolbar");
        var sectionName = el(doc, "input", "x-template-section-name");
        sectionName.value = section;
        sectionName.setAttribute("aria-label", "Section name");
        sectionName.addEventListener("change", function () {
          var nextName = sectionName.value.trim();
          if (!nextName) { sectionName.value = section; return; }
          draft.sections[sectionIndex] = nextName;
          draft.memberships.forEach(function (member) { if (member.section === section) member.section = nextName; });
          renderEditor();
        });
        sectionToolbar.appendChild(sectionName);
        [["↑", -1], ["↓", 1]].forEach(function (entry) {
          var move = el(doc, "button", "x-template-order", entry[0]);
          move.type = "button";
          move.disabled = entry[1] < 0 ? sectionIndex === 0 : sectionIndex === draft.sections.length - 1;
          move.addEventListener("click", function () {
            var moved = draft.sections.splice(sectionIndex, 1)[0];
            draft.sections.splice(sectionIndex + entry[1], 0, moved);
            renderEditor();
          });
          sectionToolbar.appendChild(move);
        });
        var removeSection = el(doc, "button", "x-template-delete-link", "Remove section");
        removeSection.type = "button";
        removeSection.addEventListener("click", function () {
          draft.sections.splice(sectionIndex, 1);
          draft.memberships = draft.memberships.filter(function (member) { return member.section !== section; });
          renderEditor();
        });
        sectionToolbar.appendChild(removeSection);
        sectionBox.appendChild(sectionToolbar);

        draft.memberships.filter(function (member) { return member.section === section; }).forEach(function (member) {
          var account = state.accounts.find(function (entry) { return entry.handle.toLowerCase() === member.handle.toLowerCase(); });
          var row = el(doc, "div", "x-template-member");
          row.appendChild(el(doc, "span", "x-template-member-name", "@" + member.handle + (account && account.label !== account.handle ? " · " + account.label : "")));
          var sectionSelect = el(doc, "select", "x-template-member-section");
          draft.sections.forEach(function (name) {
            var option = el(doc, "option", "", name);
            option.value = name;
            option.selected = name === member.section;
            sectionSelect.appendChild(option);
          });
          sectionSelect.addEventListener("change", function () { member.section = sectionSelect.value; renderEditor(); });
          row.appendChild(sectionSelect);
          var removeMember = el(doc, "button", "x-template-member-remove", "×");
          removeMember.type = "button";
          removeMember.setAttribute("aria-label", "Remove @" + member.handle + " from template");
          removeMember.addEventListener("click", function () {
            draft.memberships = draft.memberships.filter(function (entry) { return entry !== member; });
            renderEditor();
          });
          row.appendChild(removeMember);
          sectionBox.appendChild(row);
        });

        var available = state.accounts.filter(function (account) {
          return !draft.memberships.some(function (member) { return member.handle.toLowerCase() === account.handle.toLowerCase(); });
        });
        if (available.length) {
          var addRow = el(doc, "div", "x-template-add-account");
          var accountSelect = el(doc, "select", "x-manage-input");
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
            draft.memberships.push({ handle: accountSelect.value, section: section });
            renderEditor();
          });
          addRow.appendChild(accountSelect);
          sectionBox.appendChild(addRow);
        }
        sectionsRoot.appendChild(sectionBox);
      });
      editor.appendChild(sectionsRoot);

      var actions = el(doc, "div", "x-template-actions");
      var save = el(doc, "button", "x-manage-add", state.creating ? "Create Template" : "Save Changes");
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

  return { open: open, slugify: slugify, normalizeDraft: normalizeDraft };
});
