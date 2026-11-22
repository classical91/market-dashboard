/**
 * Gemini summary popup for YouTube Intelligence.
 *
 *   YoutubeSummary.open({ video, channelLabel, onTimestamp })
 *
 * Shows a cached summary straight away (GET, free), otherwise asks the server
 * to generate one (POST, admin-gated because it spends Gemini credits).
 * `onTimestamp(seconds)` lets the page seek its own player; return true to
 * keep the click from opening YouTube in a new tab.
 *
 * Summary text is rendered with textContent only — headings, bullets and
 * [mm:ss] timestamps are recognised, nothing is ever parsed as HTML.
 */
(function (global) {
  var TIMESTAMP = /\[((?:\d{1,2}:)?\d{1,2}:\d{2})\]/g;
  var current = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function toSeconds(stamp) {
    return stamp.split(":").reduce(function (total, part) { return total * 60 + Number(part); }, 0);
  }

  function watchUrl(id, seconds) {
    return "https://www.youtube.com/watch?v=" + encodeURIComponent(id) + (seconds ? "&t=" + seconds + "s" : "");
  }

  // Appends `text` to `parent`, turning [mm:ss] stamps into seek links.
  function appendInline(parent, text, videoId, onTimestamp) {
    var last = 0;
    text.replace(TIMESTAMP, function (match, stamp, offset) {
      if (offset > last) parent.appendChild(document.createTextNode(text.slice(last, offset)));
      var seconds = toSeconds(stamp);
      var link = el("a", "yts-stamp", stamp);
      link.href = watchUrl(videoId, seconds);
      link.target = "_blank";
      link.rel = "noopener";
      link.setAttribute("aria-label", "Jump to " + stamp);
      link.addEventListener("click", function (event) {
        if (onTimestamp && onTimestamp(seconds) === true) event.preventDefault();
      });
      parent.appendChild(link);
      last = offset + match.length;
      return match;
    });
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  function renderSummary(root, text, videoId, onTimestamp) {
    var list = null;
    root.replaceChildren();
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim().replace(/\*\*/g, "");
      if (!line) { list = null; return; }
      var heading = line.match(/^#{1,4}\s+(.*)$/);
      if (heading) {
        list = null;
        root.appendChild(el("h3", "yts-heading", heading[1]));
        return;
      }
      var bullet = line.match(/^[-*•]\s+(.*)$/);
      if (bullet) {
        if (!list) { list = el("ul", "yts-list"); root.appendChild(list); }
        var item = el("li");
        appendInline(item, bullet[1], videoId, onTimestamp);
        list.appendChild(item);
        return;
      }
      list = null;
      var tldr = line.match(/^TL;?DR:?\s*(.*)$/i);
      var para = el("p", tldr ? "yts-tldr" : "yts-para");
      if (tldr) {
        para.appendChild(el("strong", null, "TL;DR "));
        appendInline(para, tldr[1], videoId, onTimestamp);
      } else {
        appendInline(para, line, videoId, onTimestamp);
      }
      root.appendChild(para);
    });
  }

  function readJson(res) {
    return res.json().catch(function () { return {}; }).then(function (body) {
      if (res.ok) return body;
      var error = new Error(body.error || "Request failed (" + res.status + ")");
      error.status = res.status;
      throw error;
    });
  }

  function close() {
    if (!current) return;
    var state = current;
    current = null;
    state.cancelled = true;
    clearInterval(state.timer);
    document.removeEventListener("keydown", state.onKey, true);
    state.overlay.remove();
    document.body.classList.remove("yts-open");
    if (state.returnFocus && document.contains(state.returnFocus)) state.returnFocus.focus();
  }

  function open(options) {
    var video = options && options.video;
    if (!video || !video.id) return;
    close();

    var state = { cancelled: false, timer: null, returnFocus: document.activeElement, text: "" };
    current = state;

    var overlay = el("div", "yts-overlay");
    var dialog = el("div", "yts-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "ytsTitle");
    overlay.appendChild(dialog);

    var header = el("div", "yts-header");
    var heading = el("div", "yts-heading-wrap");
    heading.appendChild(el("p", "yts-eyebrow", "Gemini summary"));
    var title = el("h2", "yts-title", video.title || "YouTube video");
    title.id = "ytsTitle";
    heading.appendChild(title);
    if (options.channelLabel) heading.appendChild(el("p", "yts-channel", options.channelLabel));
    var closeButton = el("button", "yts-close", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close summary");
    header.appendChild(heading);
    header.appendChild(closeButton);

    var body = el("div", "yts-body");
    body.setAttribute("aria-live", "polite");
    var content = el("div", "yts-content");
    body.appendChild(content);

    var footer = el("div", "yts-footer");
    var meta = el("p", "yts-meta");
    var actions = el("div", "yts-actions");
    var copyButton = el("button", "yts-button", "Copy");
    copyButton.type = "button";
    var regenButton = el("button", "yts-button", "Regenerate");
    regenButton.type = "button";
    var doneButton = el("button", "yts-button yts-primary", "Close");
    doneButton.type = "button";
    actions.appendChild(copyButton);
    actions.appendChild(regenButton);
    actions.appendChild(doneButton);
    footer.appendChild(meta);
    footer.appendChild(actions);

    dialog.appendChild(header);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    state.overlay = overlay;

    function showActions(ready) {
      copyButton.hidden = !ready;
      regenButton.hidden = !ready;
    }

    function showStatus(message, kind) {
      clearInterval(state.timer);
      body.removeAttribute("aria-busy");
      var box = el("div", "yts-status" + (kind ? " yts-" + kind : ""));
      box.appendChild(el("p", null, message));
      content.replaceChildren(box);
      meta.textContent = "";
      showActions(false);
      return box;
    }

    function showLoading() {
      var started = Date.now();
      var box = showStatus("Gemini is watching the video…", "loading");
      box.insertBefore(el("span", "yts-spinner"), box.firstChild);
      var elapsed = el("p", "yts-elapsed", "Long videos can take a minute or two.");
      box.appendChild(elapsed);
      body.setAttribute("aria-busy", "true");
      state.timer = setInterval(function () {
        var secs = Math.round((Date.now() - started) / 1000);
        elapsed.textContent = secs + "s · Long videos can take a minute or two.";
      }, 1000);
    }

    function showError(error) {
      var message = error && error.message ? error.message : "Something went wrong.";
      if (/Admin key required/.test(message)) message = "Generating a summary needs the admin key.";
      var box = showStatus(message, "error");
      var retry = el("button", "yts-button", "Try again");
      retry.type = "button";
      retry.addEventListener("click", function () { generate(false); });
      box.appendChild(retry);
    }

    function showNotConfigured() {
      var box = showStatus("Video summaries aren't set up yet.", "notice");
      box.appendChild(el("p", "yts-hint", "Add a GEMINI_API_KEY (free from Google AI Studio) to the server's environment variables, then reopen this popup."));
    }

    function showSummary(summary) {
      clearInterval(state.timer);
      body.removeAttribute("aria-busy");
      state.text = summary.summary || "";
      renderSummary(content, state.text, video.id, options.onTimestamp);
      if (summary.truncated) content.appendChild(el("p", "yts-hint", "Gemini hit its length limit, so the end of this summary may be cut off."));
      var when = new Date(summary.generatedAt);
      meta.textContent = [
        summary.model || "Gemini",
        isNaN(when.getTime()) ? "" : when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        summary.cached ? "saved" : "",
      ].filter(Boolean).join(" · ");
      showActions(true);
    }

    function generate(refresh) {
      showLoading();
      return global.AdminKey.fetchOrSession("/api/youtube/summary/" + encodeURIComponent(video.id), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ refresh: refresh === true }),
      })
        .then(readJson)
        .then(function (data) {
          if (state.cancelled) return;
          if (data.summary) showSummary(data.summary);
          else showError(new Error("Gemini returned no summary."));
        })
        .catch(function (error) {
          if (state.cancelled) return;
          if (error.status === 503 && /GEMINI_API_KEY/.test(error.message)) showNotConfigured();
          else showError(error);
        });
    }

    function load() {
      showStatus("Checking for a saved summary…", "loading");
      body.setAttribute("aria-busy", "true");
      return fetch("/api/youtube/summary/" + encodeURIComponent(video.id), { headers: { Accept: "application/json" } })
        .then(readJson)
        .then(function (data) {
          if (state.cancelled) return;
          if (data.summary) showSummary(data.summary);
          else if (!data.configured) showNotConfigured();
          else generate(false);
        })
        .catch(function (error) {
          if (state.cancelled) return;
          if (error.status === 401) showError(new Error("Your session expired. Log in again to summarize videos."));
          else showError(error);
        });
    }

    copyButton.addEventListener("click", function () {
      var text = (video.title ? video.title + "\n" + watchUrl(video.id) + "\n\n" : "") + state.text;
      var done = function () { copyButton.textContent = "Copied"; setTimeout(function () { copyButton.textContent = "Copy"; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { copyButton.textContent = "Copy failed"; });
      }
    });
    regenButton.addEventListener("click", function () { generate(true); });
    closeButton.addEventListener("click", close);
    doneButton.addEventListener("click", close);
    overlay.addEventListener("mousedown", function (event) {
      if (event.target === overlay) close();
    });

    state.onKey = function (event) {
      // The admin-key prompt can open on top of this dialog; it owns the keys then.
      var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs.length && dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      // Keep focus inside the dialog.
      var focusable = Array.prototype.filter.call(
        dialog.querySelectorAll("a[href], button:not([disabled])"),
        function (node) { return !node.hidden && node.offsetParent !== null; },
      );
      if (!focusable.length) return;
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", state.onKey, true);

    document.body.appendChild(overlay);
    document.body.classList.add("yts-open");
    closeButton.focus();
    load();
  }

  global.YoutubeSummary = { open: open, close: close };
})(window);
