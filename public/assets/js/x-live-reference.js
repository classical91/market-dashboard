/* Live X Reference panel.

   Purpose is inspection, not agreement: the X Intelligence pane shows what our
   ingestion captured, this panel shows what X itself currently displays, and
   the reader compares them. Nothing here claims the two are in sync — the page
   has no independent evidence for that, and asserting it would defeat the
   point of showing both.

   Uses X's official embedded profile timeline. Protected, suspended or deleted
   accounts cannot be embedded, and browser privacy settings block the widget
   outright, so every path degrades to "open it on X yourself" rather than
   breaking the page. Nothing reads inside the widget's iframe — it is
   cross-origin, and only its presence is ever inspected.

   Loaded as a plain script by x-intelligence.html and required as a module by
   the tests. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.XLiveReference = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  var WIDGET_SRC = "https://platform.twitter.com/widgets.js";
  // How long to give the widget before deciding it is not coming.
  var EMBED_TIMEOUT_MS = 8000;

  function relative(iso, now) {
    var fresh = typeof window !== "undefined" && window.XFreshness;
    if (fresh && fresh.formatRelativeTime) return fresh.formatRelativeTime(iso, now);
    if (typeof require === "function" && typeof module === "object") {
      return require("./x-freshness").formatRelativeTime(iso, now);
    }
    return "";
  }

  /* The comparison context shown above the embed: how current our capture is,
     so a difference against the live timeline can be interpreted rather than
     just noticed. Pure, so the wording is covered by tests. */
  function describeReference(handle, meta, now) {
    var checked = relative(meta && meta.lastCheckedAt, now);
    var newest = relative(meta && meta.newestPostAt, now);
    return {
      handle: handle,
      profileUrl: "https://x.com/" + handle,
      title: "Live X — @" + handle,
      trackedLine: "Tracked by Intelligence: last checked " + (checked || "at an unknown time"),
      newestLine: "Newest captured post: " + (newest || "none captured yet"),
      openLabel: "Open @" + handle + " on X ↗",
      unavailableMessage:
        "Live X timeline unavailable. Open @" + handle + " on X to compare manually.",
    };
  }

  /* Loads the widget script at most once for the page's lifetime. Re-injecting
     it on every account switch is the classic way to end up with several
     copies racing each other. */
  function createWidgetLoader(loadScript) {
    var pending = null;
    var attempts = 0;
    return {
      load: function () {
        if (!pending) {
          attempts += 1;
          pending = Promise.resolve()
            .then(loadScript)
            .catch(function (err) {
              // Keep the rejection cached: a blocked host stays blocked, and
              // retrying on every click just delays the fallback each time.
              throw err;
            });
        }
        return pending;
      },
      attempts: function () {
        return attempts;
      },
    };
  }

  function injectScript(doc) {
    return new Promise(function (resolve, reject) {
      var existing = doc.querySelector('script[data-x-widgets="1"]');
      if (existing) {
        if (doc.defaultView && doc.defaultView.twttr) resolve(doc.defaultView.twttr);
        else existing.addEventListener("load", function () { resolve(doc.defaultView.twttr); });
        existing.addEventListener("error", function () { reject(new Error("widgets.js failed")); });
        return;
      }
      var script = doc.createElement("script");
      script.src = WIDGET_SRC;
      script.async = true;
      script.charset = "utf-8";
      script.setAttribute("data-x-widgets", "1");
      script.addEventListener("load", function () { resolve(doc.defaultView.twttr); });
      script.addEventListener("error", function () { reject(new Error("widgets.js failed")); });
      doc.head.appendChild(script);
    });
  }

  var loader = null;

  function render(container, handle, meta, options) {
    var opts = options || {};
    var doc = container.ownerDocument;
    var described = describeReference(handle, meta, opts.now);
    if (!loader) loader = createWidgetLoader(opts.loadScript || function () { return injectScript(doc); });

    container.innerHTML = "";
    container.setAttribute("data-handle", handle);

    var head = doc.createElement("div");
    head.className = "x-live-head";

    var title = doc.createElement("span");
    title.className = "x-live-title";
    title.textContent = described.title;

    var open = doc.createElement("a");
    open.className = "x-live-open";
    open.href = described.profileUrl;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = described.openLabel;

    head.appendChild(title);
    head.appendChild(open);

    var meta1 = doc.createElement("div");
    meta1.className = "x-live-meta";
    meta1.textContent = described.trackedLine;

    var meta2 = doc.createElement("div");
    meta2.className = "x-live-meta";
    meta2.textContent = described.newestLine;

    var embed = doc.createElement("div");
    embed.className = "x-live-embed";

    var anchor = doc.createElement("a");
    anchor.className = "twitter-timeline";
    anchor.setAttribute("data-theme", "dark");
    anchor.setAttribute("data-chrome", "noheader nofooter transparent");
    anchor.setAttribute("data-height", String(opts.height || 620));
    anchor.href = "https://twitter.com/" + encodeURIComponent(handle);
    anchor.textContent = "Posts by @" + handle;
    embed.appendChild(anchor);

    container.appendChild(head);
    container.appendChild(meta1);
    container.appendChild(meta2);
    container.appendChild(embed);

    function fallback() {
      if (container.getAttribute("data-handle") !== handle) return;
      embed.innerHTML = "";
      var note = doc.createElement("div");
      note.className = "x-live-unavailable";
      note.textContent = described.unavailableMessage;
      embed.appendChild(note);
    }

    loader
      .load()
      .then(function (twttr) {
        // A different account may have been selected while this resolved.
        if (container.getAttribute("data-handle") !== handle) return;
        if (!twttr || !twttr.widgets || !twttr.widgets.load) {
          fallback();
          return;
        }
        twttr.widgets.load(embed);
        // Only the presence of the iframe is checked; its contents are
        // cross-origin and deliberately never touched.
        var deadline = Date.now() + EMBED_TIMEOUT_MS;
        (function poll() {
          if (container.getAttribute("data-handle") !== handle) return;
          if (embed.querySelector("iframe")) return;
          if (Date.now() > deadline) {
            fallback();
            return;
          }
          (doc.defaultView || window).setTimeout(poll, 250);
        })();
      })
      .catch(fallback);

    return described;
  }

  return {
    WIDGET_SRC: WIDGET_SRC,
    describeReference: describeReference,
    createWidgetLoader: createWidgetLoader,
    render: render,
  };
});
