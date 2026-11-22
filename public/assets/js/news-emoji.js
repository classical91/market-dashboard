/* Consistent color emoji, including flags on Windows. Work on text nodes,
   never report HTML; refreshes keep their existing buttons and listeners. */
(function () {
  "use strict";
  var root = document.querySelector(".cmd-main");
  if (!root || !window.twemoji) return;
  var skip = "script, style, textarea, input, select, code, pre, svg, iframe, [contenteditable], .news-emoji-fallback";
  var pending = new Set();
  var scheduled = false;

  function render(node) {
    var texts = [];
    if (node.nodeType === 3) texts.push(node);
    else if (node.nodeType === 1) {
      var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) texts.push(walker.currentNode);
    }
    texts.forEach(function (text) {
      if (!text.parentElement || text.parentElement.closest(skip) || !window.twemoji.test(text.nodeValue)) return;
      var holder = document.createElement("span");
      holder.textContent = text.nodeValue;
      window.twemoji.parse(holder, {
        base: "https://cdn.jsdelivr.net/gh/jdecked/twemoji@17.0.3/assets/",
        folder: "svg", ext: ".svg", className: "news-emoji",
        onerror: function () {
          // Keep readable native text if the CDN is unavailable. Excluding
          // this span also prevents the observer retrying a broken image.
          var fallback = document.createElement("span");
          fallback.className = "news-emoji-fallback";
          fallback.textContent = this.alt;
          this.replaceWith(fallback);
        }
      });
      text.replaceWith.apply(text, Array.from(holder.childNodes));
    });
  }

  var options = { childList: true, characterData: true, subtree: true };
  var observer = new MutationObserver(function (changes) {
    changes.forEach(function (change) {
      if (change.type === "characterData") pending.add(change.target);
      else change.addedNodes.forEach(function (node) { pending.add(node); });
    });
    if (scheduled || !pending.size) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      observer.disconnect();
      pending.forEach(function (node) { if (root.contains(node)) render(node); });
      pending.clear();
      observer.observe(root, options);
    });
  });
  render(root);
  observer.observe(root, options);
})();
