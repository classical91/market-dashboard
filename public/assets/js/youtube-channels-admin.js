(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.YoutubeChannelsAdmin = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var HANDLE_PATTERN = /^[A-Za-z0-9._-]{3,30}$/;
  var CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
  var UNCATEGORIZED_ID = "uncategorized";

  function normalizeHandle(value) {
    var raw = String(value == null ? "" : value).trim();
    var url = raw.match(/(?:youtube\.com\/(?:@|c\/|user\/))([^/?#]+)/i);
    return String(url ? url[1] : raw).replace(/^@+/, "").trim();
  }
  function validateHandle(value) {
    var handle = normalizeHandle(value);
    if (!handle) return { ok: false, reason: "Enter a YouTube handle." };
    if (!HANDLE_PATTERN.test(handle)) return { ok: false, reason: "Use a YouTube handle or channel URL." };
    return { ok: true, handle: handle };
  }
  function validateChannelId(value) {
    var channelId = String(value == null ? "" : value).trim();
    if (!channelId) return { ok: true, channelId: "" };
    if (!CHANNEL_ID_PATTERN.test(channelId)) return { ok: false, reason: "A channel ID is UC followed by 22 characters." };
    return { ok: true, channelId: channelId };
  }
  function findDuplicate(channels, handle, exceptHandle) {
    var wanted = normalizeHandle(handle).toLowerCase();
    var except = normalizeHandle(exceptHandle).toLowerCase();
    return (channels || []).filter(function (channel) {
      var current = normalizeHandle(channel && channel.handle).toLowerCase();
      return current === wanted && current !== except;
    })[0] || null;
  }
  function isDuplicate(channels, handle) { return Boolean(findDuplicate(channels, handle)); }
  function duplicateMessage(channel) { return "@" + channel.handle + " is already tracked."; }
  function confirmationMessage(handle) { return "Remove @" + handle + " from YouTube Intelligence?"; }
  function categoryKey(value) { return String(value || "").trim().toLowerCase(); }
  function categoryDuplicate(categories, name, exceptId) {
    var wanted = categoryKey(name);
    return (categories || []).filter(function (category) {
      return category.id !== exceptId && categoryKey(category.name) === wanted;
    })[0] || null;
  }
  /**
   * The one place the channel form decides what is wrong, in the order the
   * user can act on it. Returns null when the form is submittable, so the
   * rule can be tested without a DOM.
   */
  function channelFormProblem(input) {
    var fields = input || {};
    if (!fields.handle || !fields.handle.ok) return (fields.handle && fields.handle.reason) || "Enter a YouTube handle.";
    if (!fields.channelId || !fields.channelId.ok) return (fields.channelId && fields.channelId.reason) || "Check the channel ID.";
    if (fields.duplicate) return duplicateMessage(fields.duplicate);
    if (fields.creatingCategory) {
      if (!String(fields.categoryName || "").trim()) return "Enter a name for the new category.";
      if (fields.categoryClash) return "The category \"" + fields.categoryClash.name + "\" already exists.";
    }
    return null;
  }
  /** What an empty channel list says, given the filter and search in force. */
  function emptyChannelsMessage(categories, filterId, search) {
    var query = String(search || "").trim();
    var category = (categories || []).filter(function (item) { return item.id === filterId; })[0];
    if (query) return "No channels match \"" + query + "\"" + (category ? " in " + category.name + "." : ".");
    if (category) return "No channels in " + category.name + " yet.";
    return "No channels match this search and category.";
  }
  function el(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(doc, className, text, onClick) {
    var node = el(doc, "button", className, text); node.type = "button";
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }
  function labeled(doc, text, input, hint) {
    var label = el(doc, "label", "ytm-field");
    label.appendChild(el(doc, "span", "ytm-label", text)); label.appendChild(input);
    if (hint) label.appendChild(el(doc, "span", "ytm-hint", hint));
    return label;
  }
  function readJson(res) {
    return res.json().catch(function () { return {}; }).then(function (body) {
      if (!res.ok) {
        var error = new Error(body.error || "Request failed: " + res.status); error.body = body; throw error;
      }
      return body;
    });
  }

  function open(options) {
    var opts = options || {}; var doc = document; var previousFocus = doc.activeElement;
    var state = { channels: [], categories: [], tab: "channels", search: "", filter: "all", editor: null, busy: false, changed: false };
    var overlay = el(doc, "div", "manage-overlay ytm-overlay");
    overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); overlay.setAttribute("aria-labelledby", "ytmTitle");
    var box = el(doc, "div", "manage-box ytm-box");
    var head = el(doc, "div", "manage-head ytm-head");
    var heading = el(doc, "div");
    var title = el(doc, "h2", "manage-title", "Manage YouTube Sources"); title.id = "ytmTitle";
    heading.appendChild(title); heading.appendChild(el(doc, "p", "ytm-subtitle", "Organize channels once, then filter intelligence by category."));
    var close = button(doc, "manage-close", "×", cleanup); close.setAttribute("aria-label", "Close source manager");
    head.appendChild(heading); head.appendChild(close); box.appendChild(head);
    var tabs = el(doc, "div", "ytm-tabs"); tabs.setAttribute("role", "tablist");
    var content = el(doc, "div", "ytm-content"); content.id = "ytmPanel"; content.setAttribute("role", "tabpanel"); content.tabIndex = -1; var status = el(doc, "div", "manage-status ytm-status"); status.setAttribute("role", "status");
    box.appendChild(tabs); box.appendChild(status); box.appendChild(content); overlay.appendChild(box); doc.body.appendChild(overlay);

    function say(message, tone) { status.textContent = message || ""; status.className = "manage-status ytm-status" + (tone ? " is-" + tone : ""); }
    function api(path, options) { return window.AdminKey.fetchOrSession(path, options || {}).then(readJson); }
    function cleanup() {
      doc.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (previousFocus && previousFocus.focus) previousFocus.focus();
    }
    function onKey(event) {
      if (event.key === "Escape") { cleanup(); return; }
      if (event.key !== "Tab") return;
      var focusable = Array.prototype.slice.call(box.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex='0']"));
      if (!focusable.length) return;
      var first = focusable[0]; var last = focusable[focusable.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    function sync(result, notice) {
      if (result.channels) state.channels = result.channels;
      if (result.categories) state.categories = result.categories;
      state.busy = false; state.changed = true; state.editor = null; render(); say(notice, "ok");
      if (opts.onChange) opts.onChange(state.channels, result);
    }
    function fail(error) { state.busy = false; render(); say(error.message || "The change could not be saved.", "error"); }
    function setTab(name) { state.tab = name; state.editor = null; say(""); render(); }

    var TABS = ["channels", "categories"];
    // Arrow keys move between tabs and only the selected tab is in the tab
    // order, which is what makes a tablist usable from the keyboard: Tab
    // reaches the tab strip once, then Left/Right choose within it.
    function renderTabs() {
      tabs.innerHTML = "";
      TABS.forEach(function (name, index) {
        var selected = state.tab === name;
        var tab = button(doc, "ytm-tab" + (selected ? " active" : ""), name.charAt(0).toUpperCase() + name.slice(1), function () { setTab(name); });
        tab.id = "ytmTab-" + name;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.setAttribute("aria-controls", "ytmPanel");
        tab.tabIndex = selected ? 0 : -1;
        tab.addEventListener("keydown", function (event) {
          var step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!step && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          var next = event.key === "Home" ? 0
            : event.key === "End" ? TABS.length - 1
            : (index + step + TABS.length) % TABS.length;
          setTab(TABS[next]);
          var moved = tabs.children[next];
          if (moved) moved.focus();
        });
        tabs.appendChild(tab);
      });
      content.setAttribute("aria-labelledby", "ytmTab-" + state.tab);
    }
    function categorySelect(value, includeCreate) {
      var select = el(doc, "select", "manage-input ytm-select");
      state.categories.forEach(function (category) {
        var option = el(doc, "option", "", category.name); option.value = category.id; select.appendChild(option);
      });
      if (includeCreate) { var create = el(doc, "option", "", "+ Create new category"); create.value = "__create__"; select.appendChild(create); }
      // With no categories yet there is nothing to preselect, and defaulting to
      // an ID with no matching option leaves the select rendering blank. Land on
      // "+ Create new category" instead: it is the only thing to do from here.
      var fallback = state.categories[0] ? state.categories[0].id : (includeCreate ? "__create__" : UNCATEGORIZED_ID);
      select.value = value || fallback;
      if (select.selectedIndex < 0) select.selectedIndex = 0;
      return select;
    }
    function confirmDialog(titleText, bodyText, actionText, action, extra) {
      var shade = el(doc, "div", "ytm-confirm-shade");
      var panel = el(doc, "div", "ytm-confirm"); panel.setAttribute("role", "alertdialog"); panel.setAttribute("aria-modal", "true");
      panel.appendChild(el(doc, "h3", "ytm-confirm-title", titleText)); panel.appendChild(el(doc, "p", "ytm-confirm-copy", bodyText));
      if (extra) panel.appendChild(extra);
      var actions = el(doc, "div", "ytm-actions");
      actions.appendChild(button(doc, "ytm-btn", "Cancel", function () { shade.remove(); }));
      var confirm = button(doc, "ytm-btn danger", actionText, function () { action(confirm, shade); }); actions.appendChild(confirm);
      panel.appendChild(actions); shade.appendChild(panel); box.appendChild(shade); confirm.focus();
    }

    function renderChannelForm(channel) {
      var editing = Boolean(channel); var form = el(doc, "form", "ytm-editor");
      form.appendChild(el(doc, "h3", "ytm-editor-title", editing ? "Edit channel" : "Add channel"));
      var handle = el(doc, "input", "manage-input"); handle.required = true; handle.value = channel ? "@" + channel.handle : ""; handle.autocomplete = "off";
      var label = el(doc, "input", "manage-input"); label.value = channel?.label || "";
      var category = categorySelect(channel?.categoryId, true);
      var channelId = el(doc, "input", "manage-input"); channelId.value = channel?.channelId || "";
      // Creating a category happens inline rather than by sending the user to
      // the Categories tab: leaving mid-form would throw away the handle they
      // just typed, which is the one thing this flow must never do.
      var newCategory = el(doc, "input", "manage-input"); newCategory.autocomplete = "off";
      var newCategoryField = labeled(doc, "New category name", newCategory, "Created and assigned when you save.");
      newCategoryField.hidden = true;
      form.appendChild(labeled(doc, "YouTube handle", handle, "Paste @handle or a YouTube channel URL."));
      form.appendChild(labeled(doc, "Display name", label, "Optional; the handle is used if blank."));
      form.appendChild(labeled(doc, "Category", category));
      form.appendChild(newCategoryField);
      var details = el(doc, "details", "ytm-advanced"); details.appendChild(el(doc, "summary", "", "Advanced")); details.appendChild(labeled(doc, "Channel ID", channelId, "Optional UC… identifier.")); form.appendChild(details);
      var error = el(doc, "div", "ytm-inline-error"); error.setAttribute("role", "alert"); form.appendChild(error);
      var actions = el(doc, "div", "ytm-actions"); actions.appendChild(button(doc, "ytm-btn", "Cancel", function () { state.editor = null; render(); }));
      var save = el(doc, "button", "ytm-btn primary", editing ? "Save changes" : "Add channel"); save.type = "submit"; actions.appendChild(save); form.appendChild(actions);
      function syncCreateField(focusIt) {
        var creating = category.value === "__create__";
        newCategoryField.hidden = !creating;
        if (creating && focusIt) newCategory.focus();
      }
      category.addEventListener("change", function () { syncCreateField(true); });
      // Not only on change: with no categories the select already sits on
      // "+ Create new category", so the name field has to be there on open.
      syncCreateField(false);
      form.addEventListener("submit", function (event) {
        event.preventDefault(); var checked = validateHandle(handle.value); var id = validateChannelId(channelId.value);
        var duplicate = checked.ok && findDuplicate(state.channels, checked.handle, channel?.handle);
        var creating = category.value === "__create__";
        var categoryName = newCategory.value.trim();
        var problem = channelFormProblem({
          handle: checked, channelId: id, duplicate: duplicate,
          creatingCategory: creating, categoryName: categoryName,
          categoryClash: creating ? categoryDuplicate(state.categories, categoryName) : null,
        });
        if (problem) { error.textContent = problem; return; }
        error.textContent = "";
        state.busy = true; save.disabled = true; save.textContent = editing ? "Saving…" : "Adding…";
        // The category has to exist before the channel can reference it, so a
        // new one is created first and its ID — never its name — is what the
        // channel is saved with.
        var categoryId = creating
          ? api("/api/youtube/categories/config", {
              method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: categoryName }),
            }).then(function (result) {
              if (result.categories) state.categories = result.categories;
              return result.added.id;
            })
          : Promise.resolve(category.value);
        categoryId.then(function (assigned) {
          var payload = { handle: checked.handle, label: label.value.trim(), categoryId: assigned, channelId: id.channelId };
          return api(editing ? "/api/youtube/channels/config/" + encodeURIComponent(channel.handle) : "/api/youtube/channels/config", {
            method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
          });
        }).then(function (result) { sync(result, editing ? "Channel saved." : "Channel added."); }).catch(fail);
      });
      setTimeout(function () { handle.focus(); }, 0); return form;
    }

    function channelMatches(channel) {
      var query = state.search.toLowerCase();
      return (state.filter === "all" || channel.categoryId === state.filter)
        && (!query || (channel.handle + " " + channel.label).toLowerCase().indexOf(query) >= 0);
    }
    function renderChannels() {
      var wrap = el(doc, "div", "ytm-panel");
      var toolbar = el(doc, "div", "ytm-toolbar");
      var search = el(doc, "input", "manage-input ytm-search"); search.placeholder = "Search channels…"; search.setAttribute("aria-label", "Search channels"); search.value = state.search;
      var filter = el(doc, "select", "manage-input ytm-filter");
      var all = el(doc, "option", "", "All categories"); all.value = "all"; filter.appendChild(all);
      state.categories.forEach(function (category) { var option = el(doc, "option", "", category.name); option.value = category.id; filter.appendChild(option); }); filter.value = state.filter;
      var add = button(doc, "ytm-btn primary", "+ Add Channel", function () { state.editor = { type: "channel", channel: null }; render(); });
      search.addEventListener("input", function () { state.search = search.value; render(); }); filter.addEventListener("change", function () { state.filter = filter.value; render(); });
      toolbar.appendChild(search); toolbar.appendChild(filter); toolbar.appendChild(add); wrap.appendChild(toolbar);
      if (state.editor?.type === "channel") wrap.appendChild(renderChannelForm(state.editor.channel));
      var list = el(doc, "div", "manage-list ytm-list"); var shown = state.channels.filter(channelMatches);
      function emptyState(message) {
        var empty = el(doc, "div", "manage-empty ytm-empty");
        empty.appendChild(el(doc, "p", "ytm-empty-copy", message));
        empty.appendChild(button(doc, "ytm-btn primary", "Add a channel", function () { state.editor = { type: "channel", channel: null }; render(); }));
        return empty;
      }
      if (!state.channels.length) list.appendChild(emptyState("Add your first YouTube channel to start building intelligence feeds."));
      else if (!shown.length) list.appendChild(emptyState(emptyChannelsMessage(state.categories, state.filter, state.search)));
      shown.forEach(function (channel) {
        var row = el(doc, "div", "manage-row ytm-channel-row"); var identity = el(doc, "div", "manage-row-text");
        identity.appendChild(el(doc, "strong", "ytm-channel-name", channel.label)); identity.appendChild(el(doc, "span", "manage-row-handle", "@" + channel.handle));
        var badge = el(doc, "span", "ytm-badge", channel.category || "Uncategorized"); var actions = el(doc, "div", "ytm-row-actions");
        actions.appendChild(button(doc, "ytm-link-btn", "Edit", function () { state.editor = { type: "channel", channel: channel }; render(); }));
        actions.appendChild(button(doc, "ytm-link-btn danger", "Delete", function () {
          confirmDialog("Remove " + channel.label + "?", "This removes the channel from YouTube Intelligence. It does not affect YouTube.", "Remove", function (control, shade) {
            control.disabled = true; control.textContent = "Removing…";
            api("/api/youtube/channels/config/" + encodeURIComponent(channel.handle), { method: "DELETE" })
              .then(function (result) { shade.remove(); sync(result, "Channel removed."); }).catch(function (error) { shade.remove(); fail(error); });
          });
        }));
        row.appendChild(identity); row.appendChild(badge); row.appendChild(actions); list.appendChild(row);
      });
      wrap.appendChild(list); return wrap;
    }

    function categoryForm(category) {
      var form = el(doc, "form", "ytm-category-form"); var input = el(doc, "input", "manage-input");
      var text = category ? "Category name" : "New category name";
      input.value = category?.name || ""; input.required = true;
      var save = el(doc, "button", "ytm-btn primary", category ? "Save" : "+ Add Category"); save.type = "submit";
      form.appendChild(labeled(doc, text, input)); form.appendChild(save);
      form.addEventListener("submit", function (event) {
        event.preventDefault(); var name = input.value.trim(); var duplicate = categoryDuplicate(state.categories, name, category?.id);
        if (!name || duplicate) { say(!name ? "Enter a category name." : "That category already exists.", "error"); input.focus(); return; }
        save.disabled = true; save.textContent = category ? "Saving…" : "Adding…";
        api(category ? "/api/youtube/categories/config/" + encodeURIComponent(category.id) : "/api/youtube/categories/config", {
          method: category ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }),
        }).then(function (result) { sync(result, category ? "Category renamed." : "Category created."); }).catch(fail);
      });
      if (category) form.appendChild(button(doc, "ytm-btn", "Cancel", function () { state.editor = null; render(); }));
      if (state.editor?.type === "new-category" || category) setTimeout(function () { input.focus(); }, 0);
      return form;
    }
    function renderCategories() {
      var wrap = el(doc, "div", "ytm-panel");
      var hasFallback = state.categories.some(function (category) { return category.virtual; });
      var copy = "Categories are reusable. Renaming one updates every assigned channel automatically.";
      if (hasFallback) copy += " Uncategorized is shown because it contains channels.";
      wrap.appendChild(el(doc, "p", "ytm-section-copy", copy));
      wrap.appendChild(categoryForm(null));
      var real = state.categories.filter(function (category) { return !category.virtual; });
      if (!real.length) wrap.appendChild(el(doc, "div", "manage-empty", "Create your first category to organize YouTube sources."));
      state.categories.forEach(function (category) {
        if (state.editor?.type === "category" && state.editor.category.id === category.id) { wrap.appendChild(categoryForm(category)); return; }
        var row = el(doc, "div", "manage-row ytm-category-row"); var text = el(doc, "div", "manage-row-text");
        text.appendChild(el(doc, "strong", "ytm-category-name", category.name));
        text.appendChild(el(doc, "span", "manage-row-meta", category.channelCount + (category.channelCount === 1 ? " channel" : " channels")));
        var actions = el(doc, "div", "ytm-row-actions");
        if (category.virtual) {
          actions.appendChild(el(doc, "span", "ytm-system-label", "Protected fallback"));
          row.appendChild(text); row.appendChild(actions); wrap.appendChild(row); return;
        }
        actions.appendChild(button(doc, "ytm-link-btn", "Rename", function () { state.editor = { type: "category", category: category }; render(); }));
        actions.appendChild(button(doc, "ytm-link-btn danger", "Delete", function () {
          var select = null;
          if (category.channelCount) {
            select = categorySelect(UNCATEGORIZED_ID, false);
            Array.prototype.slice.call(select.options).forEach(function (option) {
              if (option.value === category.id || option.value === UNCATEGORIZED_ID) option.remove();
            });
            var uncategorized = el(doc, "option", "", "Move to Uncategorized"); uncategorized.value = UNCATEGORIZED_ID; select.insertBefore(uncategorized, select.firstChild); select.value = UNCATEGORIZED_ID;
          }
          confirmDialog("Delete " + category.name + "?", category.channelCount ? category.name + " contains " + category.channelCount + (category.channelCount === 1 ? " channel. " : " channels. ") + "Choose where they should move." : "This category has no channels and can be safely deleted.", "Delete category", function (control, shade) {
            control.disabled = true; control.textContent = "Deleting…";
            api("/api/youtube/categories/config/" + encodeURIComponent(category.id), {
              method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reassignToCategoryId: select ? select.value : undefined }),
            }).then(function (result) { shade.remove(); sync(result, "Category deleted."); }).catch(function (error) { shade.remove(); fail(error); });
          }, select ? labeled(doc, "Move channels to", select) : null);
        }));
        row.appendChild(text); row.appendChild(actions); wrap.appendChild(row);
      });
      return wrap;
    }
    function render() { renderTabs(); content.innerHTML = ""; content.appendChild(state.tab === "channels" ? renderChannels() : renderCategories()); }

    close.addEventListener("click", cleanup); overlay.addEventListener("click", function (event) { if (event.target === overlay) cleanup(); }); doc.addEventListener("keydown", onKey, true);
    say("Loading YouTube sources…");
    fetch("/api/youtube/channels/config", { headers: { Accept: "application/json" } }).then(readJson).then(function (body) {
      state.channels = body.channels || []; state.categories = body.categories || []; render(); say(""); close.focus();
      if (body.registry?.loadState === "corrupt") say("The saved source list could not be read; showing defaults.", "error");
    }).catch(function (error) { say(error.message || "Could not load YouTube sources.", "error"); });
  }

  return {
    open: open, normalizeHandle: normalizeHandle, validateHandle: validateHandle,
    validateChannelId: validateChannelId, isDuplicate: isDuplicate,
    findDuplicate: findDuplicate, duplicateMessage: duplicateMessage,
    confirmationMessage: confirmationMessage, categoryDuplicate: categoryDuplicate,
    channelFormProblem: channelFormProblem, emptyChannelsMessage: emptyChannelsMessage,
  };
});
