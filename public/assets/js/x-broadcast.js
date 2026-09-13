/* Broadcast one X Intelligence post to chosen Telegram channels.

   The dashboard could always get a post into a room — by copying the link off
   the card and pasting it somewhere. What it could not do was say *which*
   rooms, so the paste survived. This is that missing half: a picker on the
   card, the channels remembered between posts, and one send that reports what
   actually landed.

   Modelled on the farm bot's per-item "Broadcast to Telegram" button, with the
   difference this dashboard needs: farm-bot broadcasts to every channel in its
   settings, and here the finance desk and the war room are different rooms
   that should not both receive every post. So the channels are ticked, not
   assumed.

   Two things are remembered per browser, and neither is authoritative:

     - the last ticked channels, so a session of broadcasting does not mean
       re-picking the same rooms for every post. Ids come from the server and
       are derived from the chat and topic, so a relabelled channel keeps its
       tick and a reordered list does not shift it onto a different room.
     - which post urls have already been sent, so the card can say so. This is
       a convenience, not a guard: another device, or cleared storage, will not
       know. The server does not refuse a repeat, because a deliberate resend
       into a second channel is a real thing to want.

   The selection helpers are exported for the Node tests; the panel is DOM. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XBroadcast = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var SELECTION_KEY = "xIntelligence:broadcastChannels:v1";
  var SENT_KEY = "xIntelligence:broadcastSent:v1";
  // Enough to recognise a resend, small enough that the record cannot grow
  // without bound in a browser nobody ever clears.
  var MAX_REMEMBERED_SENDS = 200;
  var PREVIEW_CHARS = 220;

  function channelIds(channels) {
    return (channels || []).map(function (channel) { return channel && channel.id; }).filter(Boolean);
  }

  /* Which channels start ticked.

     No saved selection means every channel — the first broadcast should not
     silently reach nothing because a box was never ticked. A saved selection
     is filtered against what the server currently offers, so a channel removed
     from the configuration cannot be broadcast to from a stale tab; and if
     that leaves nothing, the default applies again rather than presenting an
     empty picker with a dead Send button. */
  function resolveSelection(channels, saved) {
    var available = channelIds(channels);
    if (!available.length) return [];
    if (!saved || !saved.length) return available.slice();
    var kept = available.filter(function (id) { return saved.indexOf(id) !== -1; });
    return kept.length ? kept : available.slice();
  }

  function readSelection(storage) {
    try {
      var parsed = JSON.parse((storage || localStorage).getItem(SELECTION_KEY) || "null");
      return Array.isArray(parsed) ? parsed.filter(function (id) { return typeof id === "string"; }) : null;
    } catch (err) {
      return null;
    }
  }

  function writeSelection(ids, storage) {
    try {
      (storage || localStorage).setItem(SELECTION_KEY, JSON.stringify(ids || []));
    } catch (err) {}
  }

  function readSent(storage) {
    try {
      var parsed = JSON.parse((storage || localStorage).getItem(SENT_KEY) || "null");
      return Array.isArray(parsed) ? parsed.filter(function (url) { return typeof url === "string"; }) : [];
    } catch (err) {
      return [];
    }
  }

  function rememberSent(url, storage) {
    if (!url) return;
    try {
      var sent = readSent(storage).filter(function (entry) { return entry !== url; });
      sent.unshift(url);
      (storage || localStorage).setItem(SENT_KEY, JSON.stringify(sent.slice(0, MAX_REMEMBERED_SENDS)));
    } catch (err) {}
  }

  function wasSent(url, storage) {
    return Boolean(url) && readSent(storage).indexOf(url) !== -1;
  }

  /* What to tell the reader about a completed send. A partial delivery is
     named channel by channel: "sent to 2 of 3" without saying which one failed
     is not something anyone can act on. */
  function describeResult(result) {
    var destinations = (result && result.destinations) || [];
    var sent = result && typeof result.sent === "number" ? result.sent : 0;
    var failed = destinations.filter(function (destination) { return destination.status !== "posted"; });
    if (!failed.length) {
      return {
        tone: "ok",
        message: "Broadcast to " + sent + (sent === 1 ? " channel." : " channels."),
      };
    }
    return {
      tone: "error",
      message:
        "Sent to " + sent + " of " + destinations.length + ". Failed: " +
        failed.map(function (destination) { return destination.label; }).join(", ") + ".",
    };
  }

  function previewText(post) {
    var text = String((post && post.text) || "").trim();
    if (text.length <= PREVIEW_CHARS) return text;
    return text.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, "") + "…";
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

  function request(url, options) {
    return window.AdminKey.fetchOrSession(url, options || {}).then(readJson);
  }

  /* The picker. Opens against one post, resolves when it closes; `onSent` is
     called only after a send that reached at least one channel, so the card
     can mark itself. */
  function open(post, options) {
    var opts = options || {};
    var doc = document;
    var onSent = opts.onSent || function () {};

    var overlay = el(doc, "div", "manage-overlay x-broadcast-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Broadcast this post to Telegram");

    var box = el(doc, "div", "manage-box x-broadcast-box");
    var head = el(doc, "div", "manage-head");
    var headText = el(doc, "div", "manage-head-text");
    headText.appendChild(el(doc, "h2", "manage-title", "Broadcast to Telegram"));
    headText.appendChild(el(
      doc,
      "p",
      "manage-subtitle",
      post && post.handle ? "@" + post.handle : "Selected post",
    ));
    head.appendChild(headText);
    var close = el(doc, "button", "manage-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    head.appendChild(close);
    box.appendChild(head);

    // The post as it will read in Telegram, so nobody broadcasts the wrong
    // card off a grid where several look alike.
    var preview = el(doc, "div", "x-broadcast-preview");
    var previewBody = el(doc, "div", "x-broadcast-preview-text", previewText(post));
    preview.appendChild(previewBody);
    if (post && post.url) preview.appendChild(el(doc, "div", "x-broadcast-preview-link", post.url));
    if (post && post.image) {
      preview.appendChild(el(doc, "div", "x-broadcast-preview-note", "The picture is sent with it."));
    }
    box.appendChild(preview);

    var status = el(doc, "div", "manage-status", "Loading channels…");
    status.setAttribute("role", "status");
    box.appendChild(status);

    var listRoot = el(doc, "div", "x-broadcast-channels");
    box.appendChild(listRoot);

    var footer = el(doc, "div", "x-broadcast-footer");
    var toggleAll = el(doc, "button", "x-broadcast-toggle-all", "Select none");
    toggleAll.type = "button";
    toggleAll.hidden = true;
    var send = el(doc, "button", "manage-add x-broadcast-send", "Broadcast");
    send.type = "button";
    send.disabled = true;
    footer.appendChild(toggleAll);
    footer.appendChild(send);
    box.appendChild(footer);

    overlay.appendChild(box);
    doc.body.appendChild(overlay);

    var channels = [];
    var selected = [];
    var sending = false;
    var settled = false;

    function say(message, tone) {
      status.textContent = message || "";
      status.className = "manage-status" + (tone ? " is-" + tone : "");
    }

    function cleanup() {
      if (settled) return;
      settled = true;
      doc.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function onKey(e) {
      // A send in flight owns the dialog: closing it would leave the result
      // with nowhere to be reported.
      if (e.key === "Escape" && !sending) cleanup();
    }

    function syncSend() {
      send.disabled = sending || !selected.length;
      send.textContent = sending
        ? "Broadcasting…"
        : selected.length
          ? "Broadcast to " + selected.length + (selected.length === 1 ? " channel" : " channels")
          : "Select a channel";
      toggleAll.textContent = selected.length === channels.length ? "Select none" : "Select all";
    }

    function renderChannels() {
      listRoot.innerHTML = "";
      channels.forEach(function (channel) {
        var row = el(doc, "label", "x-broadcast-channel");
        var box2 = doc.createElement("input");
        box2.type = "checkbox";
        box2.value = channel.id;
        box2.checked = selected.indexOf(channel.id) !== -1;
        box2.addEventListener("change", function () {
          selected = box2.checked
            ? selected.concat([channel.id])
            : selected.filter(function (id) { return id !== channel.id; });
          syncSend();
        });
        var text = el(doc, "span", "x-broadcast-channel-text");
        text.appendChild(el(doc, "span", "x-broadcast-channel-label", channel.label));
        if (channel.threadId) {
          text.appendChild(el(doc, "span", "x-broadcast-channel-meta", "topic " + channel.threadId));
        }
        row.appendChild(box2);
        row.appendChild(text);
        listRoot.appendChild(row);
      });
      toggleAll.hidden = channels.length < 2;
      syncSend();
    }

    toggleAll.addEventListener("click", function () {
      selected = selected.length === channels.length ? [] : channelIds(channels);
      renderChannels();
    });

    close.addEventListener("click", function () { if (!sending) cleanup(); });
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay && !sending) cleanup();
    });
    doc.addEventListener("keydown", onKey, true);

    request("/api/x/broadcast/channels").then(
      function (body) {
        channels = (body && body.channels) || [];
        if (!channels.length) {
          say(
            body && body.botConfigured
              ? "No broadcast channels configured — set X_BROADCAST_CHANNELS or TELEGRAM_CHAT_IDS."
              : "Telegram is not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS.",
            "error",
          );
          return;
        }
        selected = resolveSelection(channels, readSelection());
        say("");
        renderChannels();
      },
      function (err) {
        say(err.message || "Could not load broadcast channels.", "error");
      },
    );

    send.addEventListener("click", function () {
      if (sending || !selected.length) return;
      sending = true;
      say("");
      syncSend();

      request("/api/x/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          handle: post && post.handle,
          text: post && post.text,
          url: post && post.url,
          image: post && post.image,
          channels: selected,
        }),
      }).then(
        function (result) {
          sending = false;
          // Saved only on a send that got somewhere: a rejected selection is
          // not the one to reuse on the next post.
          writeSelection(selected);
          rememberSent(post && post.url);
          var described = describeResult(result);
          onSent(result);
          if (described.tone === "ok") {
            cleanup();
            return;
          }
          // A partial delivery stays on screen with the failed channels
          // named, so the retry can be aimed rather than repeated blind.
          say(described.message, "error");
          syncSend();
        },
        function (err) {
          sending = false;
          say(err.message || "Broadcast failed.", "error");
          syncSend();
        },
      );
    });

    return { close: cleanup };
  }

  /* What renderPostCards calls. Kept here rather than in x-posts.js so the
     card renderer stays a renderer and knows nothing about Telegram. */
  function bindBroadcastButton(button, post) {
    var resting = wasSent(post && post.url) ? "Broadcast ✓" : "Broadcast";
    button.textContent = resting;
    button.addEventListener("click", function () {
      open(post, {
        onSent: function () {
          button.textContent = "Broadcast ✓";
        },
      });
    });
  }

  return {
    SELECTION_KEY: SELECTION_KEY,
    SENT_KEY: SENT_KEY,
    channelIds: channelIds,
    resolveSelection: resolveSelection,
    readSelection: readSelection,
    writeSelection: writeSelection,
    readSent: readSent,
    rememberSent: rememberSent,
    wasSent: wasSent,
    describeResult: describeResult,
    previewText: previewText,
    open: open,
    bindBroadcastButton: bindBroadcastButton,
  };
});
