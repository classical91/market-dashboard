/* Send one X Intelligence post straight to FarmBot Queue.

   The FarmClaw button hands a post to the FarmClaw agent, which writes its
   own copy and queues it. This is the direct route: the person writes or
   accepts the text here, and the dashboard saves it in FarmBot Queue through
   /api/farmbot/x-links. Queue rows post themselves on FarmBot's normal timer,
   so the dialog is the review step: what is in the box is what gets posted.

   Which posts were queued is remembered per browser only to restore the
   card's label; FarmBot's read-back is what the label shows. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FarmbotQueue = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var QUEUED_KEY = "xIntelligence:farmbotDirect:v1";
  var MAX_REMEMBERED = 200;
  var MAX_CHARS = 280;
  var CATEGORIES = [
    ["general", "General"],
    ["economics", "Economics"],
    ["stocks", "Stocks"],
    ["crypto", "Crypto"],
  ];

  function guessCategory(label) {
    var text = String(label || "").toLowerCase();
    if (/crypto|bitcoin|btc|eth/.test(text)) return "crypto";
    if (/stock|equit|earning/.test(text)) return "stocks";
    if (/econ|macro|fed|rates|inflation/.test(text)) return "economics";
    return "general";
  }

  function charCount(text) {
    return Array.from(String(text || "")).length;
  }

  /* The card text with trailing t.co / pic links dropped: FarmBot strips
     links from posts anyway, and they only eat the 280 characters. */
  function draftText(post) {
    return String((post && post.text) || "")
      .replace(/(?:\s*https?:\/\/t\.co\/\S+)+\s*$/i, "")
      .trim();
  }

  function readQueued() {
    try {
      var raw = localStorage.getItem(QUEUED_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (err) { return []; }
  }

  function rememberQueued(url) {
    if (!url) return;
    try {
      var list = readQueued().filter(function (u) { return u !== url; });
      list.unshift(url);
      localStorage.setItem(QUEUED_KEY, JSON.stringify(list.slice(0, MAX_REMEMBERED)));
    } catch (err) {}
  }

  function forgetQueued(url) {
    try {
      localStorage.setItem(QUEUED_KEY, JSON.stringify(readQueued().filter(function (u) { return u !== url; })));
    } catch (err) {}
  }

  function el(doc, tag, className, text) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function readJson(res) {
    return res.text().then(function (raw) {
      var body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (err) {}
      if (!res.ok) {
        var error = new Error(body.error || "Request failed (HTTP " + res.status + ")");
        error.status = res.status;
        throw error;
      }
      return body;
    });
  }

  function whenText(iso) {
    var ms = Date.parse(iso || "");
    if (!isFinite(ms)) return "";
    try {
      return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (err) { return new Date(ms).toISOString(); }
  }

  /* One line for the card and the dialog, from FarmBot's read-back. */
  function describeQueued(result) {
    if (!result) return "";
    if (result.removed) return "Removed from FarmBot Queue (#" + result.queueItemId + ").";
    var parts = ["In FarmBot Queue as #" + result.queueItemId];
    if (result.dispatchActive === false) parts.push("held — activate it in FarmBot to post");
    else if (result.dispatchStatus === "PENDING" && result.dispatchNotBefore) parts.push("posts after " + whenText(result.dispatchNotBefore));
    else if (result.dispatchStatus) parts.push(String(result.dispatchStatus).toLowerCase());
    return parts.join(" — ") + ".";
  }

  function safeHttps(url) {
    return typeof url === "string" && /^https:\/\/[^\s"'<>]+$/.test(url) ? url : "";
  }

  /* The dialog. `onQueued(result)` runs after FarmBot confirms the entry. */
  function open(post, options) {
    var opts = options || {};
    var doc = document;
    var onQueued = opts.onQueued || function () {};

    var overlay = el(doc, "div", "manage-overlay x-broadcast-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Send this post to FarmBot Queue");

    var box = el(doc, "div", "manage-box x-broadcast-box farmbot-queue-box");
    var head = el(doc, "div", "manage-head");
    var headText = el(doc, "div", "manage-head-text");
    headText.appendChild(el(doc, "h2", "manage-title", "Send to FarmBot Queue"));
    headText.appendChild(el(doc, "p", "manage-subtitle", post && post.handle ? "@" + post.handle : "Selected post"));
    head.appendChild(headText);
    var close = el(doc, "button", "manage-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    head.appendChild(close);
    box.appendChild(head);

    var form = el(doc, "div", "farmbot-queue-form");

    var textLabel = el(doc, "label", "farmbot-queue-field");
    textLabel.appendChild(el(doc, "span", "farmbot-queue-label", "Post text (this is exactly what FarmBot will post)"));
    var textarea = doc.createElement("textarea");
    textarea.className = "farmbot-queue-text";
    textarea.rows = 6;
    textarea.value = draftText(post);
    textLabel.appendChild(textarea);
    var counter = el(doc, "span", "farmbot-queue-count");
    counter.setAttribute("aria-live", "polite");
    textLabel.appendChild(counter);
    form.appendChild(textLabel);

    var row = el(doc, "div", "farmbot-queue-row");
    var catLabel = el(doc, "label", "farmbot-queue-field farmbot-queue-inline");
    catLabel.appendChild(el(doc, "span", "farmbot-queue-label", "Category"));
    var select = doc.createElement("select");
    select.className = "farmbot-queue-select";
    CATEGORIES.forEach(function (pair) {
      var option = doc.createElement("option");
      option.value = pair[0];
      option.textContent = pair[1];
      select.appendChild(option);
    });
    select.value = guessCategory(post && post.category);
    catLabel.appendChild(select);
    row.appendChild(catLabel);

    var photo = null;
    if (post && safeHttps(post.image)) {
      var photoLabel = el(doc, "label", "farmbot-queue-check");
      photo = doc.createElement("input");
      photo.type = "checkbox";
      photo.checked = true;
      photoLabel.appendChild(photo);
      photoLabel.appendChild(el(doc, "span", null, "Include the post's photo"));
      row.appendChild(photoLabel);
    }
    form.appendChild(row);
    form.appendChild(el(doc, "p", "x-broadcast-preview-note",
      "Goes straight to FarmBot Queue, without FarmClaw. It posts automatically on FarmBot's normal Queue timer."));
    box.appendChild(form);

    var status = el(doc, "div", "manage-status");
    status.setAttribute("role", "status");
    box.appendChild(status);

    var viewLink = el(doc, "a", "x-post-farmbot-link farmbot-queue-view", "View in FarmBot ↗");
    viewLink.target = "_blank";
    viewLink.rel = "noopener noreferrer";
    viewLink.hidden = true;
    box.appendChild(viewLink);

    var footer = el(doc, "div", "x-broadcast-footer");
    var cancel = el(doc, "button", "x-broadcast-toggle-all", "Cancel");
    cancel.type = "button";
    var send = el(doc, "button", "manage-add x-broadcast-send", "Queue in FarmBot");
    send.type = "button";
    footer.appendChild(cancel);
    footer.appendChild(send);
    box.appendChild(footer);

    overlay.appendChild(box);
    doc.body.appendChild(overlay);

    var sending = false;
    var done = false;
    var closed = false;

    function say(message, tone) {
      status.textContent = message || "";
      status.className = "manage-status" + (tone ? " is-" + tone : "");
    }

    function sync() {
      var n = charCount(textarea.value.trim());
      counter.textContent = n + " / " + MAX_CHARS;
      counter.className = "farmbot-queue-count" + (n > MAX_CHARS ? " is-over" : "");
      send.disabled = sending || done || !n || n > MAX_CHARS;
      send.textContent = sending ? "Queueing…" : done ? "Queued ✓" : "Queue in FarmBot";
      textarea.disabled = select.disabled = sending || done;
      if (photo) photo.disabled = sending || done;
      cancel.textContent = done ? "Done" : "Cancel";
    }

    function cleanup() {
      if (closed) return;
      closed = true;
      doc.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function onKey(e) {
      if (e.key === "Escape" && !sending) cleanup();
    }

    function showView(href) {
      var safe = safeHttps(href);
      viewLink.hidden = !safe;
      if (safe) viewLink.href = safe;
    }

    textarea.addEventListener("input", sync);
    cancel.addEventListener("click", function () { if (!sending) cleanup(); });
    close.addEventListener("click", function () { if (!sending) cleanup(); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay && !sending) cleanup(); });
    doc.addEventListener("keydown", onKey, true);

    send.addEventListener("click", function () {
      if (send.disabled) return;
      sending = true;
      say("");
      sync();
      window.AdminKey.fetchOrSession("/api/farmbot/x-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: post && post.url,
          handle: post && post.handle,
          sourceText: post && post.text,
          publishedAt: post && post.publishedAt,
          text: textarea.value.trim(),
          category: select.value,
          image: photo && photo.checked ? post.image : null,
        }),
      }).then(readJson).then(
        function (result) {
          sending = false;
          done = true;
          rememberQueued(post && post.url);
          var line = describeQueued(result);
          if (result.duplicate) line = "Already in FarmBot Queue — nothing new was added. " + line;
          say(line + " Want to see it?", "ok");
          showView(result.queueUrl);
          sync();
          onQueued(result);
        },
        function (err) {
          sending = false;
          say(err.message || "Could not queue in FarmBot.", "error");
          sync();
        },
      );
    });

    sync();
    textarea.focus();
    return { close: cleanup };
  }

  /* The card's FarmBot button: opens the dialog, and after a send (or on a
     reload of a post sent before) shows what FarmBot holds. */
  function bindButton(button, post) {
    var url = post && post.url;
    var note = null;
    var link = null;

    function setNote(text, href) {
      if (!button.parentNode || !button.ownerDocument) return;
      var doc = button.ownerDocument;
      if (!note && text) {
        note = doc.createElement("span");
        note.className = "x-post-farmclaw-status";
        note.setAttribute("role", "status");
        button.parentNode.appendChild(note);
      }
      if (note) { note.textContent = text || ""; note.hidden = !text; }
      var safe = safeHttps(href);
      if (!link && safe) {
        link = doc.createElement("a");
        link.className = "x-post-farmbot-link";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "View in FarmBot ↗";
        button.parentNode.appendChild(link);
      }
      if (link) { link.hidden = !safe; if (safe) link.href = safe; }
    }

    function show(result) {
      if (!result) {
        button.textContent = "FarmBot";
        button.title = "Send this post straight to FarmBot Queue";
        setNote("", "");
        return;
      }
      button.textContent = result.removed ? "FarmBot removed" : "FarmBot ✓";
      button.title = describeQueued(result);
      setNote(describeQueued(result), result.queueUrl);
    }

    show(null);
    if (url && readQueued().indexOf(url) !== -1 && window.AdminKey && window.AdminKey.fetchSilent) {
      window.AdminKey.fetchSilent("/api/farmbot/x-links/lookup?url=" + encodeURIComponent(url), { cache: "no-store" })
        .then(readJson)
        .then(show, function (err) {
          if (err.status === 404) forgetQueued(url);
        });
    }

    button.addEventListener("click", function () {
      if (!url) return;
      open(post, { onQueued: show });
    });
  }

  return {
    QUEUED_KEY: QUEUED_KEY,
    MAX_CHARS: MAX_CHARS,
    guessCategory: guessCategory,
    charCount: charCount,
    draftText: draftText,
    describeQueued: describeQueued,
    open: open,
    bindButton: bindButton,
  };
});
