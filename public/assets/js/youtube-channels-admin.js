/* Manage Channels panel for YouTube Intelligence.

   The counterpart to x-accounts-admin.js, and deliberately the same shape: add
   and delete are server-persisted through /api/youtube/channels/config rather
   than kept as a browser preference, because a localStorage-only list would
   restore deleted channels on the next redeploy and only on the one device
   that made the change.

   A channel's category is what places it in a theme, so the category field
   suggests every section the themes define. Picking "Archaeology" is all it
   takes to put the channel in the Dig Site theme — there is no second step.

   The validation helpers are exported for tests; the panel itself is DOM. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.YoutubeChannelsAdmin = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // Mirrors the server rule in src/services/youtube-channel-registry.js.
  // Duplicated deliberately: the client check is for a fast, friendly message,
  // and the server's is the one that actually guards the store.
  var HANDLE_PATTERN = /^[A-Za-z0-9._-]{3,30}$/;
  var CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

  function normalizeHandle(value) {
    return String(value == null ? "" : value).trim().replace(/^@+/, "").trim();
  }

  function validateHandle(value) {
    var handle = normalizeHandle(value);
    if (!handle) return { ok: false, reason: "Enter a YouTube handle." };
    if (!HANDLE_PATTERN.test(handle)) {
      return {
        ok: false,
        reason: "Handles are 3-30 letters, numbers, dots, dashes or underscores.",
      };
    }
    return { ok: true, handle: handle };
  }

  /* A channel ID is optional — the feed resolves it from the handle on its next
     refresh. Supplying one is the cheaper, more resilient path, so a malformed
     one is worth refusing rather than silently ignoring. */
  function validateChannelId(value) {
    var id = String(value == null ? "" : value).trim();
    if (!id) return { ok: true, channelId: "" };
    if (!CHANNEL_ID_PATTERN.test(id)) {
      return { ok: false, reason: "A channel ID is UC followed by 22 letters, numbers, dashes or underscores." };
    }
    return { ok: true, channelId: id };
  }

  /* Returns the tracked channel that already holds this handle, or null.
     Case-insensitive, matching the server. */
  function findDuplicate(channels, handle) {
    var wanted = normalizeHandle(handle).toLowerCase();
    if (!wanted) return null;
    var match = (channels || []).filter(function (channel) {
      return normalizeHandle(channel && channel.handle).toLowerCase() === wanted;
    });
    return match.length ? match[0] : null;
  }

  function isDuplicate(channels, handle) {
    return Boolean(findDuplicate(channels, handle));
  }

  function duplicateMessage(channel) {
    return (
      "@" + channel.handle + " is already tracked" +
      (channel.category ? " under " + channel.category : "") + "."
    );
  }

  function confirmationMessage(handle) {
    return "Remove @" + handle + " from YouTube Intelligence?";
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
    overlay.setAttribute("aria-label", "Manage YouTube Intelligence channels");

    var box = el(doc, "div", "manage-box");
    var head = el(doc, "div", "manage-head");
    head.appendChild(el(doc, "h2", "manage-title", "Manage Channels"));
    var close = el(doc, "button", "manage-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    head.appendChild(close);
    box.appendChild(head);

    var status = el(doc, "div", "manage-status");
    status.setAttribute("role", "status");

    var form = el(doc, "form", "manage-form");
    var handleInput = el(doc, "input", "manage-input");
    handleInput.type = "text";
    handleInput.placeholder = "@handle";
    handleInput.setAttribute("aria-label", "YouTube handle");
    handleInput.autocomplete = "off";

    var labelInput = el(doc, "input", "manage-input");
    labelInput.type = "text";
    labelInput.placeholder = "Display label (optional)";
    labelInput.setAttribute("aria-label", "Display label");
    labelInput.autocomplete = "off";

    var categoryInput = el(doc, "input", "manage-input");
    categoryInput.type = "text";
    categoryInput.placeholder = "Category (places it in a theme)";
    categoryInput.setAttribute("aria-label", "Category");
    categoryInput.setAttribute("list", "ytManageCategories");
    categoryInput.autocomplete = "off";

    var categoryList = el(doc, "datalist");
    categoryList.id = "ytManageCategories";

    var idInput = el(doc, "input", "manage-input");
    idInput.type = "text";
    idInput.placeholder = "Channel ID UC… (optional)";
    idInput.setAttribute("aria-label", "Channel ID");
    idInput.autocomplete = "off";

    // Says "already tracked" while the handle is still being typed, so a
    // duplicate is refused before anyone clicks Add rather than after.
    var dupHint = el(doc, "div", "manage-hint");
    dupHint.setAttribute("role", "status");
    dupHint.hidden = true;

    var submit = el(doc, "button", "manage-add", "Add Channel");
    submit.type = "submit";

    form.appendChild(handleInput);
    form.appendChild(dupHint);
    form.appendChild(labelInput);
    form.appendChild(categoryInput);
    form.appendChild(categoryList);
    form.appendChild(idInput);
    form.appendChild(submit);

    var listRoot = el(doc, "div", "manage-list");

    box.appendChild(form);
    box.appendChild(status);
    box.appendChild(listRoot);
    overlay.appendChild(box);
    doc.body.appendChild(overlay);

    var channels = [];
    var changed = false;

    function say(message, tone) {
      status.textContent = message || "";
      status.className = "manage-status" + (tone ? " is-" + tone : "");
    }

    function cleanup() {
      doc.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (changed) onChange(channels);
    }

    function onKey(e) {
      if (e.key === "Escape") cleanup();
    }

    function refreshDuplicateHint() {
      var existing = findDuplicate(channels, handleInput.value);
      dupHint.textContent = existing ? duplicateMessage(existing) : "";
      dupHint.hidden = !existing;
      handleInput.setAttribute("aria-invalid", existing ? "true" : "false");
      submit.disabled = Boolean(existing);
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

    function renderList() {
      listRoot.innerHTML = "";
      refreshDuplicateHint();
      if (!channels.length) {
        listRoot.appendChild(el(doc, "div", "manage-empty", "No channels are tracked yet."));
        return;
      }
      channels.forEach(function (channel) {
        var row = el(doc, "div", "manage-row");
        var text = el(doc, "div", "manage-row-text");
        text.appendChild(el(doc, "span", "manage-row-handle", "@" + channel.handle));
        text.appendChild(
          el(doc, "span", "manage-row-meta", channel.label + " · " + channel.category)
        );
        var remove = el(doc, "button", "manage-delete", "Delete");
        remove.type = "button";
        remove.addEventListener("click", function () {
          if (!window.confirm(confirmationMessage(channel.handle))) return;
          remove.disabled = true;
          say("Removing @" + channel.handle + "…");
          window.AdminKey.fetchOrSession(
            "/api/youtube/channels/config/" + encodeURIComponent(channel.handle),
            { method: "DELETE" }
          )
            .then(readJson)
            .then(function (result) {
              channels = result.channels;
              changed = true;
              renderList();
              say("Removed @" + channel.handle + ".", "ok");
              onChange(channels, { removed: channel.handle });
            })
            .catch(function (err) {
              remove.disabled = false;
              say(err.message || "Could not remove the channel.", "error");
            });
        });
        row.appendChild(text);
        row.appendChild(remove);
        listRoot.appendChild(row);
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var check = validateHandle(handleInput.value);
      if (!check.ok) {
        say(check.reason, "error");
        return;
      }
      var existing = findDuplicate(channels, check.handle);
      if (existing) {
        say(duplicateMessage(existing), "error");
        return;
      }
      var category = categoryInput.value.trim();
      if (!category) {
        say("Choose or type a category.", "error");
        return;
      }
      var id = validateChannelId(idInput.value);
      if (!id.ok) {
        say(id.reason, "error");
        return;
      }

      submit.disabled = true;
      say("Adding @" + check.handle + "…");
      window.AdminKey.fetchOrSession("/api/youtube/channels/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: check.handle,
          label: labelInput.value.trim(),
          category: category,
          channelId: id.channelId,
        }),
      })
        .then(readJson)
        .then(function (result) {
          channels = result.channels;
          changed = true;
          handleInput.value = "";
          labelInput.value = "";
          idInput.value = "";
          renderList();
          say("Added @" + check.handle + ".", "ok");
          onChange(channels, { added: check.handle });
        })
        .catch(function (err) {
          say(err.message || "Could not add the channel.", "error");
        })
        .then(function () {
          // Re-enables through the duplicate check rather than unconditionally:
          // a rejected add leaves the handle in the box, and it may still be a
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

    say("Loading tracked channels…");
    fetch("/api/youtube/channels/config", { headers: { Accept: "application/json" } })
      .then(readJson)
      .then(function (body) {
        channels = body.channels || [];
        (body.categories || []).forEach(function (name) {
          var option = doc.createElement("option");
          option.value = name;
          categoryList.appendChild(option);
        });
        renderList();
        // A registry the server could not read is worth saying out loud — the
        // list on screen would be the seed, not what was saved.
        if (body.registry && body.registry.loadState === "corrupt") {
          say("The saved channel list could not be read; showing defaults.", "error");
        } else {
          say("");
        }
      })
      .catch(function () {
        say("Could not load the tracked channels.", "error");
      });

    setTimeout(function () {
      try { handleInput.focus(); } catch (e) { /* ignore */ }
    }, 30);
  }

  return {
    open: open,
    normalizeHandle: normalizeHandle,
    validateHandle: validateHandle,
    validateChannelId: validateChannelId,
    isDuplicate: isDuplicate,
    findDuplicate: findDuplicate,
    duplicateMessage: duplicateMessage,
    confirmationMessage: confirmationMessage,
  };
});
