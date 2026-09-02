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
    var content = el(doc, "div", "ytm-content"); var status = el(doc, "div", "manage-status ytm-status"); status.setAttribute("role", "status");
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

    function renderTabs() {
      tabs.innerHTML = "";
      ["channels", "categories"].forEach(function (name) {
        var tab = button(doc, "ytm-tab" + (state.tab === name ? " active" : ""), name.charAt(0).toUpperCase() + name.slice(1), function () { setTab(name); });
        tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", state.tab === name ? "true" : "false");
        tabs.appendChild(tab);
      });
    }
    function categorySelect(value, includeCreate) {
      var select = el(doc, "select", "manage-input ytm-select");
      state.categories.forEach(function (category) {
        var option = el(doc, "option", "", category.name); option.value = category.id; select.appendChild(option);
      });
      if (includeCreate) { var create = el(doc, "option", "", "+ Create new category"); create.value = "__create__"; select.appendChild(create); }
      select.value = value || (state.categories[0] ? state.categories[0].id : UNCATEGORIZED_ID);
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
      form.appendChild(labeled(doc, "YouTube handle", handle, "Paste @handle or a YouTube channel URL."));
      form.appendChild(labeled(doc, "Display name", label, "Optional; the handle is used if blank."));
      form.appendChild(labeled(doc, "Category", category));
      var details = el(doc, "details", "ytm-advanced"); details.appendChild(el(doc, "summary", "", "Advanced")); details.appendChild(labeled(doc, "Channel ID", channelId, "Optional UC… identifier.")); form.appendChild(details);
      var error = el(doc, "div", "ytm-inline-error"); error.setAttribute("role", "alert"); form.appendChild(error);
      var actions = el(doc, "div", "ytm-actions"); actions.appendChild(button(doc, "ytm-btn", "Cancel", function () { state.editor = null; render(); }));
      var save = el(doc, "button", "ytm-btn primary", editing ? "Save changes" : "Add channel"); save.type = "submit"; actions.appendChild(save); form.appendChild(actions);
      category.addEventListener("change", function () { if (category.value === "__create__") setTab("categories"); });
      form.addEventListener("submit", function (event) {
        event.preventDefault(); var checked = validateHandle(handle.value); var id = validateChannelId(channelId.value);
        var duplicate = checked.ok && findDuplicate(state.channels, checked.handle, channel?.handle);
        if (!checked.ok || !id.ok || duplicate || category.value === "__create__") {
          error.textContent = !checked.ok ? checked.reason : !id.ok ? id.reason : duplicate ? duplicateMessage(duplicate) : "Choose a category."; return;
        }
        state.busy = true; save.disabled = true; save.textContent = editing ? "Saving…" : "Adding…";
        var payload = { handle: checked.handle, label: label.value.trim(), categoryId: category.value, channelId: id.channelId };
        api(editing ? "/api/youtube/channels/config/" + encodeURIComponent(channel.handle) : "/api/youtube/channels/config", {
          method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
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
      if (!state.channels.length) list.appendChild(el(doc, "div", "manage-empty", "Add your first YouTube channel to start building intelligence feeds."));
      else if (!shown.length) list.appendChild(el(doc, "div", "manage-empty", "No channels match this search and category."));
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
      input.placeholder = category ? "Category name" : "New category name"; input.value = category?.name || ""; input.required = true; input.setAttribute("aria-label", input.placeholder);
      var save = el(doc, "button", "ytm-btn primary", category ? "Save" : "+ Add Category"); save.type = "submit";
      form.appendChild(input); form.appendChild(save);
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
      wrap.appendChild(el(doc, "p", "ytm-section-copy", "Categories are reusable. Renaming one updates every assigned channel automatically."));
      wrap.appendChild(categoryForm(null));
      var real = state.categories.filter(function (category) { return !category.virtual; });
      if (!real.length) wrap.appendChild(el(doc, "div", "manage-empty", "Create your first category to organize YouTube sources."));
      real.forEach(function (category) {
        if (state.editor?.type === "category" && state.editor.category.id === category.id) { wrap.appendChild(categoryForm(category)); return; }
        var row = el(doc, "div", "manage-row ytm-category-row"); var text = el(doc, "div", "manage-row-text");
        text.appendChild(el(doc, "strong", "ytm-category-name", category.name));
        text.appendChild(el(doc, "span", "manage-row-meta", category.channelCount + (category.channelCount === 1 ? " channel" : " channels")));
        var actions = el(doc, "div", "ytm-row-actions"); actions.appendChild(button(doc, "ytm-link-btn", "Rename", function () { state.editor = { type: "category", category: category }; render(); }));
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
  };
});
