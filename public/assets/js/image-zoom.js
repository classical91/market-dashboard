/* Image zoom viewer.

   Any <img data-zoomable> on the page opens a full-screen viewer on click,
   Enter or Space. Inside the viewer:
     - mouse wheel / trackpad pinch zooms toward the cursor
     - two-finger pinch zooms on touch screens
     - drag pans once zoomed in
     - double-click (or double-tap) toggles between fit and 2.5x
     - + / - / 0 zoom in, zoom out and reset; Esc closes
   Focus returns to the image that opened it. Delegated from document, so
   cards re-rendered by a feed refresh need no rebinding. */
(function () {
  "use strict";

  var MIN_SCALE = 1;
  var MAX_SCALE = 8;
  var STEP = 1.4;

  var overlay = null;
  var stage = null;
  var img = null;
  var level = null;
  var openLink = null;
  var opener = null;
  var view = { scale: 1, x: 0, y: 0 };
  var pointers = {};
  var pinch = null;
  var drag = null;
  var lastTap = 0;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function button(label, title, action) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "img-zoom-btn";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.setAttribute("data-action", action);
    return b;
  }

  function build() {
    overlay = document.createElement("div");
    overlay.className = "img-zoom-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Image viewer");
    overlay.hidden = true;

    var bar = document.createElement("div");
    bar.className = "img-zoom-bar";
    level = document.createElement("span");
    level.className = "img-zoom-level";
    level.setAttribute("aria-live", "polite");
    openLink = document.createElement("a");
    openLink.className = "img-zoom-btn img-zoom-open";
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.textContent = "Original";
    openLink.title = "Open the original image in a new tab";
    bar.appendChild(button("−", "Zoom out", "out"));
    bar.appendChild(level);
    bar.appendChild(button("+", "Zoom in", "in"));
    bar.appendChild(button("Fit", "Reset zoom", "reset"));
    bar.appendChild(openLink);
    bar.appendChild(button("×", "Close", "close"));

    stage = document.createElement("div");
    stage.className = "img-zoom-stage";
    img = document.createElement("img");
    img.className = "img-zoom-img";
    img.alt = "";
    img.draggable = false;
    stage.appendChild(img);

    overlay.appendChild(stage);
    overlay.appendChild(bar);
    document.body.appendChild(overlay);

    bar.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest("[data-action]");
      if (!t) return;
      var a = t.getAttribute("data-action");
      if (a === "in") zoomBy(STEP);
      else if (a === "out") zoomBy(1 / STEP);
      else if (a === "reset") reset();
      else if (a === "close") close();
    });

    // A click on the dark backdrop (not the image) closes, unless it ended a drag.
    stage.addEventListener("click", function (e) {
      if (e.target === stage && !stage.hasAttribute("data-dragged")) close();
    });

    stage.addEventListener("wheel", function (e) {
      e.preventDefault();
      // ctrlKey is set for trackpad pinch; it reports small deltas.
      var factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      zoomAt(view.scale * factor, e.clientX, e.clientY);
    }, { passive: false });

    stage.addEventListener("dblclick", function (e) {
      if (e.target !== img) return;
      if (view.scale > 1.01) reset();
      else zoomAt(2.5, e.clientX, e.clientY);
    });

    stage.addEventListener("pointerdown", onPointerDown);
    stage.addEventListener("pointermove", onPointerMove);
    stage.addEventListener("pointerup", onPointerUp);
    stage.addEventListener("pointercancel", onPointerUp);

    // On document, not the overlay: a mouse drag on the stage moves focus
    // to <body>, and Esc must still close.
    document.addEventListener("keydown", function (e) {
      if (overlay.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(STEP); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(1 / STEP); }
      else if (e.key === "0") { e.preventDefault(); reset(); }
      else if (e.key === "Tab") trapFocus(e);
    });

    window.addEventListener("resize", function () { if (!overlay.hidden) apply(); });
  }

  function trapFocus(e) {
    var items = overlay.querySelectorAll("button, a[href]");
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* Keep the image from being dragged entirely off-screen: at most it can
     pan until its edge reaches the stage's edge. */
  function bound() {
    var rect = stage.getBoundingClientRect();
    var w = img.offsetWidth * view.scale;
    var h = img.offsetHeight * view.scale;
    var maxX = Math.max(0, (w - rect.width) / 2);
    var maxY = Math.max(0, (h - rect.height) / 2);
    view.x = clamp(view.x, -maxX, maxX);
    view.y = clamp(view.y, -maxY, maxY);
  }

  function apply() {
    bound();
    img.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.scale + ")";
    level.textContent = Math.round(view.scale * 100) + "%";
    stage.setAttribute("data-zoomed", view.scale > 1.01 ? "true" : "false");
  }

  /* Zoom so the image point under (cx, cy) stays under it. */
  function zoomAt(next, cx, cy) {
    next = clamp(next, MIN_SCALE, MAX_SCALE);
    var rect = stage.getBoundingClientRect();
    var ox = cx - (rect.left + rect.width / 2);
    var oy = cy - (rect.top + rect.height / 2);
    var ratio = next / view.scale;
    view.x = ox - (ox - view.x) * ratio;
    view.y = oy - (oy - view.y) * ratio;
    view.scale = next;
    apply();
  }

  function zoomBy(factor) {
    var rect = stage.getBoundingClientRect();
    zoomAt(view.scale * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function reset() {
    view.scale = 1; view.x = 0; view.y = 0;
    apply();
  }

  function pinchState() {
    var ids = Object.keys(pointers);
    var a = pointers[ids[0]];
    var b = pointers[ids[1]];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2
    };
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    try { stage.setPointerCapture(e.pointerId); } catch (_) { /* not supported */ }
    stage.removeAttribute("data-dragged");
    var count = Object.keys(pointers).length;
    if (count === 2) {
      drag = null;
      pinch = pinchState();
      pinch.scale = view.scale;
    } else if (count === 1) {
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      // Double-tap on touch screens.
      if (e.pointerType === "touch" && e.target === img) {
        var now = Date.now();
        if (now - lastTap < 300) {
          if (view.scale > 1.01) reset();
          else zoomAt(2.5, e.clientX, e.clientY);
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    }
  }

  function onPointerMove(e) {
    if (!pointers[e.pointerId]) return;
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (pinch && Object.keys(pointers).length >= 2) {
      var now = pinchState();
      zoomAt(pinch.scale * (now.dist / pinch.dist), now.cx, now.cy);
      stage.setAttribute("data-dragged", "true");
      return;
    }
    if (!drag) return;
    var dx = e.clientX - drag.x;
    var dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    drag.moved = true;
    stage.setAttribute("data-dragged", "true");
    if (view.scale <= 1.01) return;
    view.x = drag.vx + dx;
    view.y = drag.vy + dy;
    apply();
  }

  function onPointerUp(e) {
    delete pointers[e.pointerId];
    var count = Object.keys(pointers).length;
    if (count < 2) pinch = null;
    if (count === 1) {
      var id = Object.keys(pointers)[0];
      drag = { x: pointers[id].x, y: pointers[id].y, vx: view.x, vy: view.y, moved: true };
    } else if (count === 0) {
      drag = null;
      // Let the click that follows this pointerup see data-dragged, then clear it.
      setTimeout(function () { stage.removeAttribute("data-dragged"); }, 0);
    }
  }

  function open(source) {
    if (!overlay) build();
    opener = source;
    var src = source.currentSrc || source.src;
    img.src = src;
    img.alt = source.alt || "";
    openLink.href = src;
    view = { scale: 1, x: 0, y: 0 };
    pointers = {}; pinch = null; drag = null;
    overlay.hidden = false;
    document.documentElement.classList.add("img-zoom-lock");
    apply();
    var closeBtn = overlay.querySelector('[data-action="close"]');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  }

  function close() {
    if (!overlay || overlay.hidden) return;
    overlay.hidden = true;
    img.removeAttribute("src");
    document.documentElement.classList.remove("img-zoom-lock");
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    opener = null;
  }

  function target(e) {
    var t = e.target;
    return t && t.closest ? t.closest("img[data-zoomable]") : null;
  }

  document.addEventListener("click", function (e) {
    var t = target(e);
    if (!t) return;
    e.preventDefault();
    open(t);
  });

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var t = target(e);
    if (!t) return;
    e.preventDefault();
    open(t);
  });

  window.ImageZoom = { open: open, close: close };
})();
