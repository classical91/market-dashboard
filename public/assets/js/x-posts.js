/* Shared X (Twitter) post-card rendering helpers, used by both the curated
   feed page (x-intelligence.js) and the keyword search page (x-search.js). */
(function () {
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
  var formatRelativeTime = window.XFreshness.formatRelativeTime;

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
        var link = document.createElement("a");
        link.className = "x-post-link";
        link.href = post.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.title = post.url;
        link.textContent = post.url.replace(/^https?:\/\//, "");
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
      copyButton.textContent = "Copy";
      copyButton.addEventListener("click", function () {
        copyButton.disabled = true;
        copyButton.textContent = "Copying...";
        copyPostToClipboard(post)
          .then(function (mode) {
            setCopyStatus(
              copyButton,
              mode === "image" ? "Copied text + photo" : mode === "textImageUrl" ? "Copied text + photo URL" : "Copied text",
            );
          })
          .catch(function () {
            setCopyStatus(copyButton, "Copy failed");
          })
          .then(function () {
            copyButton.disabled = false;
          });
      });

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

  window.XPosts = {
    esc: esc,
    formatRelativeDate: formatRelativeDate,
    formatRelativeTime: formatRelativeTime,
    sortByPublishedDesc: sortByPublishedDesc,
    copyPostToClipboard: copyPostToClipboard,
    renderPostCards: renderPostCards,
    renderFeedError: renderFeedError,
    renderStaleNotice: renderStaleNotice,
    renderFeedStatus: renderFeedStatus,
  };
})();
