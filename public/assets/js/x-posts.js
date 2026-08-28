/* Shared X (Twitter) post-card rendering helpers, used by both the curated
   feed page (x-intelligence.js) and the keyword search page (x-search.js).

   Loaded as a plain script after x-freshness.js, and required as a module by
   the tests — the copy-link state machine is the part that broke on iOS, so
   it has to be exercisable outside a browser. */
(function (root, factory) {
  "use strict";
  var freshness = root && root.XFreshness
    ? root.XFreshness
    : (typeof require === "function" ? require("./x-freshness") : null);
  var api = factory(freshness);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XPosts = api;
})(typeof window !== "undefined" ? window : null, function (XFreshness) {
  "use strict";

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function formatRelativeDate(iso) {
    if (!iso) return "";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "";
    var diffMs = Date.now() - date.getTime();
    var hour = 60 * 60 * 1000;
    var hours = Math.floor(diffMs / hour);
    if (hours < 1) return "Just now";
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");
    var days = Math.floor(hours / 24);
    if (days < 30) return days + (days === 1 ? " day ago" : " days ago");
    var months = Math.floor(days / 30);
    return months + (months === 1 ? " month ago" : " months ago");
  }

  // Owned by x-freshness.js (shared with the Node tests); re-exported here
  // so existing XPosts callers keep working.
  var formatRelativeTime = XFreshness.formatRelativeTime;

  function sortByPublishedDesc(posts) {
    return posts.slice().sort(function (a, b) {
      var aTime = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      var bTime = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return bTime - aTime;
    });
  }

  function copyTextForPost(post, includeImageUrl) {
    var lines = ["@" + post.handle, "", post.text || "", "", "Tweet: " + post.url];
    if (includeImageUrl && post.image) lines.push("Photo: " + post.image);
    return lines.join("\n").trim();
  }

  function imageBlobToPng(blob) {
    if (!blob || !blob.type || blob.type === "image/png") return Promise.resolve(blob);
    if (!window.createImageBitmap) return Promise.resolve(blob);

    return createImageBitmap(blob).then(function (bitmap) {
      var canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      var context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      if (bitmap.close) bitmap.close();

      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (pngBlob) {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error("Image conversion failed"));
        }, "image/png");
      });
    });
  }

  function copyPostToClipboard(post) {
    var plainText = copyTextForPost(post, false);
    var fallbackText = copyTextForPost(post, true);

    if (!navigator.clipboard) {
      return Promise.reject(new Error("Clipboard is unavailable"));
    }

    if (post.image && window.ClipboardItem && navigator.clipboard.write) {
      return fetch(post.image, { mode: "cors" })
        .then(function (res) {
          if (!res.ok) throw new Error("Image request failed");
          return res.blob();
        })
        .then(imageBlobToPng)
        .then(function (blob) {
          var item = new ClipboardItem({
            "text/plain": new Blob([plainText], { type: "text/plain" }),
            "image/png": blob,
          });
          return navigator.clipboard.write([item]).then(function () { return "image"; });
        })
        .catch(function () {
          return navigator.clipboard.writeText(fallbackText).then(function () { return "textImageUrl"; });
        });
    }

    return navigator.clipboard.writeText(fallbackText).then(function () {
      return post.image ? "textImageUrl" : "text";
    });
  }

  /* ── Copying a post's permalink ────────────────────────────────────────

     One helper, used by both the visible permalink and the "Copy link"
     button, because they were drifting apart and only one of them was ever
     fixed.

     The failure this is built around: on iOS Safari (and in standalone/PWA
     contexts especially) navigator.clipboard.writeText can reject oddly, or
     simply never settle. The old code disabled the button, awaited that
     promise, and restored the label in .then() — so a promise that never
     settled left the button disabled on "Copying link..." forever, with no
     way back short of a reload.

     So no path here waits on the clipboard indefinitely: the API call races a
     timeout, and the button's own watchdog restores it even if the helper
     itself misbehaves.

     The second failure, the one that still showed "Copy failed" on an iPhone
     after the button stopped sticking: WebKit only honours
     document.execCommand("copy") while it is still processing the user
     gesture that led to the call. A Clipboard API rejection arrives in a
     later task, by which time that gesture is gone — so falling back *after*
     the rejection meant falling back into a browser that had already stopped
     listening. The fallback therefore runs in the click's own synchronous
     turn; see copyPostLinkToClipboard. */

  var CLIPBOARD_TIMEOUT_MS = 2500;
  var COPY_RESET_MS = 1800;
  // A margin over the clipboard race, so the button's own watchdog only fires
  // if the helper itself failed to settle rather than racing its own timeout.
  var COPY_WATCHDOG_MS = CLIPBOARD_TIMEOUT_MS + 1500;

  var COPY_LINK_LABELS = {
    busy: "Copying link...",
    success: "Link copied",
    failure: "Copy failed",
  };

  function globalScope() {
    if (typeof globalThis !== "undefined") return globalThis;
    if (typeof window !== "undefined") return window;
    return {};
  }

  // window.setTimeout detached from window throws "Illegal invocation" in
  // WebKit and Blink, and this code stores it before calling it.
  function bound(scope, fn) {
    return typeof fn === "function" ? fn.bind(scope) : fn;
  }

  // Every browser touchpoint the copy path uses, resolved at call time so a
  // test can substitute a clipboard, a document, or a clock.
  function resolveEnv(options) {
    var scope = globalScope();
    var has = function (key) {
      return options && Object.prototype.hasOwnProperty.call(options, key);
    };
    return {
      navigator: has("navigator") ? options.navigator : scope.navigator,
      document: has("document") ? options.document : scope.document,
      setTimeout: has("setTimeout") ? options.setTimeout : bound(scope, scope.setTimeout),
      clearTimeout: has("clearTimeout") ? options.clearTimeout : bound(scope, scope.clearTimeout),
      clipboardTimeoutMs: has("clipboardTimeoutMs") ? options.clipboardTimeoutMs : CLIPBOARD_TIMEOUT_MS,
      resetMs: has("resetMs") ? options.resetMs : COPY_RESET_MS,
      watchdogMs: has("watchdogMs") ? options.watchdogMs : COPY_WATCHDOG_MS,
    };
  }

  function noop() {}

  function later(env, ms, fn) {
    if (typeof env.setTimeout !== "function") return null;
    return env.setTimeout(fn, ms);
  }

  function cancel(env, timer) {
    if (timer !== null && timer !== undefined && typeof env.clearTimeout === "function") {
      env.clearTimeout(timer);
    }
  }

  /* Issues navigator.clipboard.writeText and reports what is already known by
     the time it returns, which is what decides whether the fallback still has
     a live user gesture to run under:

       immediate === true   the write already succeeded, synchronously;
       immediate === false  it already failed — no API, or a synchronous throw;
       immediate === null   a promise is in flight and nobody knows yet.

     `promise` resolves true/false rather than rejecting: "the Clipboard API
     did not do it" is not an error here, it is the cue to prefer the
     fallback's verdict. It never stays pending either — a write still
     unsettled at clipboardTimeoutMs loses the race, which is the iOS case. */
  function startClipboardApiWrite(text, env) {
    var nav = env.navigator;
    var clipboard = nav && nav.clipboard;
    var known = function (ok) {
      return { immediate: ok, promise: Promise.resolve(ok), abandon: noop };
    };

    if (!clipboard || typeof clipboard.writeText !== "function") return known(false);

    var pending;
    try {
      pending = clipboard.writeText(text);
    } catch (err) {
      return known(false);
    }
    // A non-thenable return means an implementation that copied synchronously.
    if (!pending || typeof pending.then !== "function") return known(true);

    var settle;
    var settled = false;
    var timer = null;
    var promise = new Promise(function (resolve) {
      settle = function (ok) {
        if (settled) return;
        settled = true;
        cancel(env, timer);
        resolve(ok);
      };
    });

    timer = later(env, env.clipboardTimeoutMs, function () { settle(false); });
    pending.then(function () { settle(true); }, function () { settle(false); });

    // Called once another path has already copied: drops the race timer so a
    // finished attempt leaves no clock running behind it.
    return { immediate: null, promise: promise, abandon: function () { settle(false); } };
  }

  /* The compatibility path: a temporary off-screen field holding exactly the
     URL, plus document.execCommand("copy"). Synchronous, so it cannot hang;
     the element is removed and the page's own selection and focus are handed
     back on every exit, including the thrown ones. */
  function writeViaExecCommand(text, env) {
    var doc = env.document;
    if (!doc || !doc.body || typeof doc.createElement !== "function") return false;
    if (typeof doc.execCommand !== "function") return false;

    var field = doc.createElement("textarea");
    var restoreSelection = captureSelection(doc);
    var copied = false;
    try {
      field.value = text;
      field.setAttribute("readonly", "");
      // iOS will not select a node it considers hidden, so it is placed
      // on-screen but invisible and untouchable rather than display:none'd.
      if (field.style) {
        field.style.position = "fixed";
        field.style.top = "0";
        field.style.left = "0";
        field.style.width = "1px";
        field.style.height = "1px";
        field.style.padding = "0";
        field.style.border = "none";
        field.style.opacity = "0";
        field.style.pointerEvents = "none";
        // Under 16px iOS zooms the page when a field takes focus, and this one
        // takes focus on every copy.
        field.style.fontSize = "16px";
      }
      doc.body.appendChild(field);
      selectAll(field, text, doc);
      copied = doc.execCommand("copy") === true;
    } catch (err) {
      copied = false;
    } finally {
      if (field.parentNode && typeof field.parentNode.removeChild === "function") {
        field.parentNode.removeChild(field);
      }
      restoreSelection();
    }
    return copied;
  }

  /* The fallback borrows the page's selection and focus for the length of one
     execCommand. This gives them back, so copying a link never swallows the
     reader's own selection and never drops keyboard focus off the button that
     was just activated. */
  function captureSelection(doc) {
    var active = doc.activeElement || null;
    var selection = null;
    var ranges = [];
    try {
      selection = typeof doc.getSelection === "function" ? doc.getSelection() : null;
      if (selection && selection.rangeCount) {
        for (var i = 0; i < selection.rangeCount; i += 1) ranges.push(selection.getRangeAt(i));
      }
    } catch (err) {
      selection = null;
    }

    return function () {
      try {
        if (selection && typeof selection.removeAllRanges === "function") {
          selection.removeAllRanges();
          for (var i = 0; i < ranges.length; i += 1) {
            if (typeof selection.addRange === "function") selection.addRange(ranges[i]);
          }
        }
      } catch (err) {
        /* A selection that can no longer be restored is not worth failing over. */
      }
      try {
        if (active && typeof active.focus === "function") active.focus();
      } catch (err) {
        /* Nor is an element that has since left the page. */
      }
    };
  }

  // iOS Safari ignores select() on a readonly field; a Range over its
  // contents is what actually takes there, so both are attempted.
  function selectAll(field, text, doc) {
    if (typeof field.focus === "function") field.focus();
    if (typeof field.select === "function") field.select();
    try {
      if (typeof doc.createRange === "function" && typeof doc.getSelection === "function") {
        var range = doc.createRange();
        range.selectNodeContents(field);
        var selection = doc.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      if (typeof field.setSelectionRange === "function") field.setSelectionRange(0, text.length);
    } catch (err) {
      /* Selection is best-effort; execCommand still gets its chance. */
    }
  }

  /* Copies exactly the URL it is given — never the post text, never an image,
     never anything else off the card. Resolves with the path that copied,
     rejects only when neither did, and never stays pending.

     The Clipboard API is asked first. What is deliberate, and what the iPhone
     bug turned on, is that the fallback does not wait for that answer: it runs
     here, still inside the synchronous turn of the click, because WebKit only
     honours execCommand("copy") while the user gesture is being processed. A
     Clipboard API rejection lands a task later, with the gesture already
     spent, so a fallback deferred until then can only fail. Both paths write
     the identical URL, so trying the second before the first has reported back
     costs a discarded write at worst — and it is skipped entirely when the API
     has already said, synchronously, that it copied. */
  function copyPostLinkToClipboard(url, options) {
    var env = resolveEnv(options);
    var text = url === null || url === undefined ? "" : String(url);
    if (!text) return Promise.reject(new Error("No link to copy"));

    var api = startClipboardApiWrite(text, env);
    if (api.immediate === true) return Promise.resolve("clipboard");

    if (writeViaExecCommand(text, env)) {
      api.abandon();
      return Promise.resolve("fallback");
    }

    // The fallback declined, or this document cannot host it. The Clipboard
    // API is the only one left that can still report success.
    return api.promise.then(function (ok) {
      if (ok) return "clipboard";
      throw new Error("Copy failed");
    });
  }

  /* Wires a button to the helper above and owns its label and disabled state.

     The guarantees, in the order they matter:
       - the button is disabled only while an attempt is actually running;
       - a second tap during an attempt is ignored rather than starting a
         second one;
       - the resting label and enabled state are restored on success, on
         failure, on a thrown exception, and on the watchdog — there is no
         path that leaves the button on "Copying link...". */
  function bindCopyLinkButton(button, url, restingLabel, options) {
    var label = restingLabel === null || restingLabel === undefined ? button.textContent : restingLabel;
    var running = false;

    // The button's own label is the whole status readout, so a screen reader
    // has to be told the label changed; without this the copy silently
    // succeeds or silently fails for anyone not watching the pixels.
    if (typeof button.setAttribute === "function") button.setAttribute("aria-live", "polite");

    function attempt() {
      var env = resolveEnv(options);
      if (running) return Promise.resolve(null);
      running = true;
      button.disabled = true;
      button.textContent = COPY_LINK_LABELS.busy;

      var done = false;
      // The last line of defence: even a helper that never settles cannot
      // strand the button, because this fires regardless.
      var watchdog = later(env, env.watchdogMs, function () { finish(COPY_LINK_LABELS.failure); });

      function finish(text) {
        if (done) return;
        done = true;
        cancel(env, watchdog);
        button.textContent = text;
        // Restoring is itself unconditional: it is scheduled here, not
        // chained onto anything that could still be pending.
        if (later(env, env.resetMs, restore) === null) restore();
      }

      function restore() {
        button.textContent = label;
        button.disabled = false;
        running = false;
      }

      var pending;
      try {
        pending = copyPostLinkToClipboard(url, options);
      } catch (err) {
        pending = Promise.reject(err);
      }
      return pending.then(
        function (how) { finish(COPY_LINK_LABELS.success); return how; },
        function () { finish(COPY_LINK_LABELS.failure); return null; }
      );
    }

    button.addEventListener("click", attempt);
    return attempt;
  }

  function setCopyStatus(button, label) {
    button.textContent = label;
    window.setTimeout(function () {
      button.textContent = "Copy";
    }, 1800);
  }

  function renderPostCards(root, posts, emptyText) {
    root.innerHTML = "";
    root.classList.toggle("is-empty", !posts.length);
    var grid = document.createElement("div");
    grid.className = "x-post-grid";

    sortByPublishedDesc(posts).forEach(function (post) {
      var card = document.createElement("article");
      card.className = "x-post-card";

      var meta = document.createElement("div");
      meta.className = "x-post-meta";
      meta.innerHTML =
        '<span class="x-tag">@' + esc(post.handle) + "</span> &middot; " +
        (post.category ? esc(post.category) + " &middot; " : "") +
        formatRelativeDate(post.publishedAt);

      var text = document.createElement("div");
      text.className = "x-post-text";
      text.textContent = post.text;

      card.appendChild(meta);
      if (post.image) {
        var img = document.createElement("img");
        img.className = "x-post-image";
        img.src = post.image;
        img.loading = "lazy";
        img.alt = "";
        card.appendChild(img);
      }
      card.appendChild(text);

      // The permalink, visible on the card rather than hidden behind the
      // Open button — it gets pasted into reports and chats constantly, and
      // reading it off the card beats opening the post to copy the URL.
      if (post.url) {
        var link = document.createElement("button");
        var linkLabel = post.url.replace(/^https?:\/\//, "");
        link.type = "button";
        link.className = "x-post-link";
        link.title = "Copy " + post.url;
        link.textContent = linkLabel;
        bindCopyLinkButton(link, post.url, linkLabel);
        card.appendChild(link);
      }

      var actions = document.createElement("div");
      actions.className = "x-post-actions";

      var openLink = document.createElement("a");
      openLink.className = "x-post-open";
      openLink.href = post.url;
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openLink.textContent = "Open";

      var copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "x-post-copy";
      copyButton.textContent = "Copy link";
      // Same helper as the visible permalink above: one copy path, one state
      // machine, so a fix to either reaches both.
      bindCopyLinkButton(copyButton, post.url, "Copy link");

      actions.appendChild(openLink);
      actions.appendChild(copyButton);
      card.appendChild(actions);
      grid.appendChild(card);
    });

    if (!posts.length) {
      var empty = document.createElement("div");
      empty.className = "x-empty";
      empty.textContent = emptyText || "No posts found yet.";
      grid.appendChild(empty);
    }

    root.appendChild(grid);
  }

  function renderFeedError(root, failedFeeds) {
    if (!failedFeeds || !failedFeeds.length) return;
    var err = document.createElement("div");
    err.className = "x-feed-error";
    err.textContent =
      "Couldn't load feed" + (failedFeeds.length > 1 ? "s" : "") + " for: " +
      failedFeeds.map(function (a) { return "@" + a.handle; }).join(", ");
    root.appendChild(err);
  }

  function renderStaleNotice(root, staleFeeds) {
    if (!staleFeeds || !staleFeeds.length) return;
    var note = document.createElement("div");
    note.className = "x-feed-stale";
    note.textContent =
      "Showing cached posts for: " +
      staleFeeds
        .map(function (a) {
          var confirmed = formatRelativeTime(a.lastSuccessfulFetchAt);
          return "@" + a.handle + (confirmed ? " (last confirmed " + confirmed + ")" : "");
        })
        .join(", ") +
      " — the latest check did not succeed.";
    root.appendChild(note);
  }

  var STATUS_LABELS = {
    live: "Live",
    empty: "Empty",
    degraded: "Degraded",
    stale: "Stale",
    unavailable: "Unavailable",
    offline: "Offline",
  };

  /* The banner that keeps old-but-unchecked data from reading as current.
     It is always rendered, including when everything is healthy, so the
     absence of a warning is never what "live" has to be inferred from. */
  function renderFeedStatus(root, status) {
    if (!status || !status.message) return;
    var level = STATUS_LABELS[status.level] ? status.level : "unavailable";

    var box = document.createElement("div");
    box.className = "x-feed-status x-feed-status--" + level;

    var label = document.createElement("span");
    label.className = "x-feed-status-label";
    label.textContent = STATUS_LABELS[level];

    var text = document.createElement("span");
    text.className = "x-feed-status-text";
    text.textContent = status.message;

    box.appendChild(label);
    box.appendChild(text);
    root.insertBefore(box, root.firstChild);
  }

  return {
    esc: esc,
    formatRelativeDate: formatRelativeDate,
    formatRelativeTime: formatRelativeTime,
    sortByPublishedDesc: sortByPublishedDesc,
    copyPostToClipboard: copyPostToClipboard,
    copyPostLinkToClipboard: copyPostLinkToClipboard,
    bindCopyLinkButton: bindCopyLinkButton,
    COPY_LINK_LABELS: COPY_LINK_LABELS,
    renderPostCards: renderPostCards,
    renderFeedError: renderFeedError,
    renderStaleNotice: renderStaleNotice,
    renderFeedStatus: renderFeedStatus,
  };
});
