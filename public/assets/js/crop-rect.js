(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CropRect = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Geometry for the image crop editor (potential-buys.js), ported from
  // farm-bot's lib/cropRect.ts. A crop rectangle is stored as fractions of the
  // image (0..1 on both axes), so it doesn't depend on how large the picture
  // is drawn on screen; it becomes real pixels only when the crop is rendered.

  /** Smallest crop, as a fraction of the image on either axis. */
  var MIN_CROP = 0.04;
  var FULL_CROP = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Keep a rectangle inside the image and at least MIN_CROP on each side. */
  function clampCrop(rect) {
    var width = clamp(rect.width, MIN_CROP, 1);
    var height = clamp(rect.height, MIN_CROP, 1);
    return { x: clamp(rect.x, 0, 1 - width), y: clamp(rect.y, 0, 1 - height), width: width, height: height };
  }

  /**
   * `aspect` is the wanted pixel width/height and `imageAspect` the picture's
   * own; on a 2:1 image a square crop is 0.5 wide by 1 tall in fractions.
   */
  function normalisedAspect(aspect, imageAspect) {
    return aspect / imageAspect;
  }

  /** The largest rectangle of `aspect` (or null for free) centred on `around`. */
  function fitAspect(aspect, imageAspect, around) {
    if (!aspect || !(imageAspect > 0)) return around ? clampCrop(around) : Object.assign({}, FULL_CROP);
    var k = normalisedAspect(aspect, imageAspect);
    var width = 1;
    var height = width / k;
    if (height > 1) {
      height = 1;
      width = k;
    }
    var cx = around ? around.x + around.width / 2 : 0.5;
    var cy = around ? around.y + around.height / 2 : 0.5;
    return clampCrop({ x: cx - width / 2, y: cy - height / 2, width: width, height: height });
  }

  /**
   * Apply a drag of (dx, dy) — fractions of the image — to `start`. With a
   * locked aspect only corners resize, and the opposite corner stays put.
   */
  function dragCrop(start, handle, dx, dy, aspect, imageAspect) {
    if (handle === "move") {
      return {
        x: clamp(start.x + dx, 0, 1 - start.width),
        y: clamp(start.y + dy, 0, 1 - start.height),
        width: start.width,
        height: start.height,
      };
    }

    var left = start.x;
    var top = start.y;
    var right = start.x + start.width;
    var bottom = start.y + start.height;
    var movesW = handle.indexOf("w") !== -1;
    var movesE = handle.indexOf("e") !== -1;
    var movesN = handle.indexOf("n") !== -1;
    var movesS = handle.indexOf("s") !== -1;

    if (aspect && imageAspect > 0 && (movesW || movesE) && (movesN || movesS)) {
      var k = normalisedAspect(aspect, imageAspect);
      var ax = movesE ? left : right;
      var ay = movesS ? top : bottom;
      var wFromX = movesE ? right + dx - ax : ax - (left + dx);
      var hFromY = movesS ? bottom + dy - ay : ay - (top + dy);
      var width = Math.max(wFromX, hFromY * k);
      var maxW = Math.min(movesE ? 1 - ax : ax, (movesS ? 1 - ay : ay) * k);
      var minW = Math.min(maxW, Math.max(MIN_CROP, MIN_CROP * k));
      width = clamp(width, minW, maxW);
      var height = width / k;
      return { x: movesE ? ax : ax - width, y: movesS ? ay : ay - height, width: width, height: height };
    }

    var newLeft = left;
    var newRight = right;
    var newTop = top;
    var newBottom = bottom;
    if (movesW) newLeft = clamp(left + dx, 0, right - MIN_CROP);
    if (movesE) newRight = clamp(right + dx, left + MIN_CROP, 1);
    if (movesN) newTop = clamp(top + dy, 0, bottom - MIN_CROP);
    if (movesS) newBottom = clamp(bottom + dy, top + MIN_CROP, 1);
    return { x: newLeft, y: newTop, width: newRight - newLeft, height: newBottom - newTop };
  }

  /** True when the rectangle keeps (practically) the whole picture. */
  function isFullCrop(rect) {
    var eps = 0.002;
    return rect.x <= eps && rect.y <= eps && rect.width >= 1 - eps && rect.height >= 1 - eps;
  }

  /** The crop in whole source pixels, always inside the image and at least 1px. */
  function cropToPixels(rect, naturalWidth, naturalHeight) {
    var sx = clamp(Math.round(rect.x * naturalWidth), 0, Math.max(0, naturalWidth - 1));
    var sy = clamp(Math.round(rect.y * naturalHeight), 0, Math.max(0, naturalHeight - 1));
    var sw = clamp(Math.round(rect.width * naturalWidth), 1, naturalWidth - sx);
    var sh = clamp(Math.round(rect.height * naturalHeight), 1, naturalHeight - sy);
    return { sx: sx, sy: sy, sw: sw, sh: sh };
  }

  /** Output size for a crop of sw×sh, scaled down so neither side exceeds maxSide. */
  function outputSize(sw, sh, maxSide) {
    var scale = Math.min(1, maxSide / Math.max(sw, sh, 1));
    return { width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
  }

  return {
    MIN_CROP: MIN_CROP,
    FULL_CROP: FULL_CROP,
    clampCrop: clampCrop,
    fitAspect: fitAspect,
    dragCrop: dragCrop,
    isFullCrop: isFullCrop,
    cropToPixels: cropToPixels,
    outputSize: outputSize,
  };
});
