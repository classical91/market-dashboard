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

  function readSent(storage, key) {
    try {
      var parsed = JSON.parse((storage || localStorage).getItem(key || SENT_KEY) || "null");
      return Array.isArray(parsed) ? parsed.filter(function (url) { return typeof url === "string"; }) : [];
    } catch (err) {
      return [];
    }
  }

  function rememberSent(url, storage, key) {
    if (!url) return;
    try {
      var sent = readSent(storage, key).filter(function (entry) { return entry !== url; });
      sent.unshift(url);
      (storage || localStorage).setItem(key || SENT_KEY, JSON.stringify(sent.slice(0, MAX_REMEMBERED_SENDS)));
    } catch (err) {}
  }

  function wasSent(url, storage, key) {
    return Boolean(url) && readSent(storage, key).indexOf(url) !== -1;
  }

  function forgetSent(url, key) {
    try {
      localStorage.setItem(key, JSON.stringify(readSent(null, key).filter(function (entry) { return entry !== url; })));
    } catch (err) {}
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

  /* FarmClaw handoff. v1 of these keys marked a post "sent" once Telegram
     accepted the dashboard bot's message, which never reached FarmClaw; v2
     marked receipts from collectors that only wrote a local file the agent
     never read. Neither is carried over. */
  var FARMCLAW_SENT_KEY = "xIntelligence:farmclawReceived:v3";
  var FARMCLAW_QUEUED_KEY = "xIntelligence:farmclawQueued:v3";
  var FARMCLAW_LABELS = {
    idle: "FarmClaw",
    busy: "Sending…",
    queued: "FarmClaw queued",
    sent: "FarmClaw received",
    failure: "FarmClaw failed",
  };
  var FARMCLAW_POLL_MS = 5000;
  var FARMCLAW_POLL_LIMIT = 36; // three minutes; a reload or later tap resumes it

  function ago(iso, nowMs) {
    var then = Date.parse(iso || "");
    if (!isFinite(then)) return null;
    var minutes = Math.max(0, Math.round(((nowMs || Date.now()) - then) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    var hours = Math.round(minutes / 60);
    return hours < 48 ? hours + " h ago" : Math.round(hours / 24) + " d ago";
  }

  /* A receipt counts as ✓ only with proof the link reached the FarmClaw
     agent: the gateway run id from the dashboard's push, or the collector's
     "Delivered to the FarmClaw session" note. Mirrors hasDeliveryProof() in
     src/services/farmclaw-handoffs.js. */
  function hasDeliveryProof(receipt) {
    if (!receipt) return false;
    if (String(receipt.receiptId || "").indexOf("openclaw-run:") === 0) return true;
    return String(receipt.note || "").indexOf("Delivered to the FarmClaw session") === 0;
  }

  /* The button's tooltip while a handoff waits. Whether FarmClaw has polled
     at all is the difference between "it will be picked up" and "nothing is
     listening", so it is said either way. */
  function describeFarmclawWait(handoff, nowMs) {
    var agent = (handoff && handoff.agent) || {};
    var status = handoff && (handoff.status || (handoff.record && handoff.record.status));
    var lead = status === "claimed"
      ? "FarmClaw has picked this up and has not confirmed it yet"
      : "Queued for FarmClaw, not yet picked up";
    var seen = ago(agent.lastPollAt, nowMs);
    return lead + (seen ? " — FarmClaw last checked in " + seen + "." : " — FarmClaw has not checked in yet.");
  }

  /* Success is FarmClaw's receipt, never the dashboard's own write: the
     POST only queues, and the button polls until FarmClaw acknowledges. */
  function bindFarmclawButton(button, post) {
    var url = post && post.url;
    var timer = null;
    var version = 0;

    function show(label, title) {
      button.textContent = label;
      button.title = title || "";
    }

    function settle(handoff) {
      var record = (handoff && handoff.record) || handoff || {};
      if (record.status === "received") {
        var receipt = record.receipt || {};
        if (!hasDeliveryProof(receipt)) {
          forgetSent(url, FARMCLAW_SENT_KEY);
          show(FARMCLAW_LABELS.idle, "Acknowledged without reaching the FarmClaw agent — tap to send it.");
          return true;
        }
        rememberSent(url, null, FARMCLAW_SENT_KEY);
        forgetSent(url, FARMCLAW_QUEUED_KEY);
        show(FARMCLAW_LABELS.sent, "Received by the FarmClaw agent (" + receipt.receiptId + "). FarmBot queueing and broadcasting are not confirmed here.");
        return true;
      }
      forgetSent(url, FARMCLAW_SENT_KEY);
      rememberSent(url, null, FARMCLAW_QUEUED_KEY);
      if (record.status === "failed") {
        show(FARMCLAW_LABELS.failure, "FarmClaw could not take it: " + (record.error || "unknown error") + " — tap to retry.");
        return true;
      }
      if (handoff && handoff.push && handoff.push.enabled) {
        show(FARMCLAW_LABELS.busy, "Sending to the FarmClaw agent…");
      } else {
        show(FARMCLAW_LABELS.queued, describeFarmclawWait({ status: record.status, agent: handoff && handoff.agent }));
      }
      return false;
    }

    function check(target, remaining, checkingVersion) {
      // Auto-refresh must not open an admin-key prompt on every restored card.
      window.AdminKey.fetchSilent(target, { cache: "no-store" }).then(readJson).then(
        function (handoff) {
          if (checkingVersion !== version) return;
          if (!settle(handoff)) poll("/api/farmclaw/handoffs/" + encodeURIComponent(handoff.id), remaining - 1, checkingVersion);
        },
        function (err) {
          if (checkingVersion !== version) return;
          if (err.status === 404) {
            forgetSent(url, FARMCLAW_SENT_KEY);
            forgetSent(url, FARMCLAW_QUEUED_KEY);
            show(FARMCLAW_LABELS.idle, "Previous handoff was not found — tap to send this link to FarmClaw.");
            return;
          }
          button.title = "Could not refresh FarmClaw status: " + (err.message || "network error") + ". The displayed status is the last known one; tap to check.";
          if (err.status !== 401 && err.status !== 403) poll(target, remaining - 1, checkingVersion);
        },
      );
    }

    function poll(target, remaining, checkingVersion) {
      if (timer) clearTimeout(timer);
      if (remaining <= 0) return;
      timer = setTimeout(function () {
        if (checkingVersion !== version || button.isConnected === false) return;
        check(target, remaining, checkingVersion);
      }, FARMCLAW_POLL_MS);
    }

    var remembered = wasSent(url, null, FARMCLAW_SENT_KEY) || wasSent(url, null, FARMCLAW_QUEUED_KEY);
    if (wasSent(url, null, FARMCLAW_SENT_KEY)) show(FARMCLAW_LABELS.sent, "Last confirmed received by FarmClaw; refreshing status. FarmBot queueing and broadcasting are not confirmed here.");
    else if (remembered) show(FARMCLAW_LABELS.queued, "Refreshing FarmClaw status…");
    else show(FARMCLAW_LABELS.idle, "Queue this post's link for FarmClaw");
    if (remembered) check("/api/farmclaw/handoffs/lookup?url=" + encodeURIComponent(url), FARMCLAW_POLL_LIMIT, version);

    button.addEventListener("click", function () {
      if (button.disabled || !url) return;
      version += 1;
      if (timer) clearTimeout(timer);
      button.disabled = true;
      button.textContent = FARMCLAW_LABELS.busy;
      // Idempotent on the post url: a repeat tap returns the same handoff,
      // re-queues a failed one, and reports a received one as received.
      request("/api/farmclaw/handoffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url, handle: post.handle || null, text: post.text || null }),
      }).then(
        function (handoff) {
          button.disabled = false;
          if (!settle(handoff)) poll("/api/farmclaw/handoffs/" + encodeURIComponent(handoff.id), FARMCLAW_POLL_LIMIT, version);
        },
        function (err) {
          button.disabled = false;
          show(FARMCLAW_LABELS.failure, (err && err.message) || "Could not queue for FarmClaw");
        },
      );
    });
  }

  return {
    SELECTION_KEY: SELECTION_KEY,
    FARMCLAW_SENT_KEY: FARMCLAW_SENT_KEY,
    FARMCLAW_QUEUED_KEY: FARMCLAW_QUEUED_KEY,
    FARMCLAW_LABELS: FARMCLAW_LABELS,
    describeFarmclawWait: describeFarmclawWait,
    hasDeliveryProof: hasDeliveryProof,
    bindFarmclawButton: bindFarmclawButton,
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
