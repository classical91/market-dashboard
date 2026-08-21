"use strict";

(function () {
  var mobileWatch = document.querySelector(".watch");
  if (mobileWatch && window.matchMedia("(max-width: 760px)").matches) {
    mobileWatch.removeAttribute("open");
  }

  var mobileFilters = document.querySelector(".filter-panel");
  if (mobileFilters && window.matchMedia("(max-width: 760px)").matches) {
    var params = new URLSearchParams(window.location.search);
    var hasActiveFilters = Boolean(
      params.get("q") || params.get("newsType") || params.get("status") ||
      (params.get("range") && params.get("range") !== "today")
    );
    if (!hasActiveFilters) mobileFilters.removeAttribute("open");
  }

  function toast(message) {
    var old = document.querySelector(".toast");
    if (old) old.remove();
    var el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2400);
  }

  function requestRetryText() {
    return new Promise(function (resolve) {
      var overlay = document.createElement("div");
      overlay.className = "retry-dialog";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.innerHTML = '<form><strong>Retry failed broadcast</strong><p>Paste the exact message. Private broadcast bodies are not stored in the ledger.</p><label>Broadcast message<textarea required></textarea></label><div><button type="button" class="retry-cancel">Cancel</button><button type="submit" class="retry-confirm">Retry broadcast</button></div></form>';
      var form = overlay.querySelector("form");
      var textarea = overlay.querySelector("textarea");
      function finish(value) {
        overlay.remove();
        resolve(value);
      }
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (textarea.value.trim()) finish(textarea.value.trim());
      });
      overlay.querySelector(".retry-cancel").addEventListener("click", function () { finish(""); });
      overlay.addEventListener("click", function (event) { if (event.target === overlay) finish(""); });
      document.body.appendChild(overlay);
      textarea.focus();
    });
  }

  function retryReceipt(retry, text) {
    if (!text) return;
    retry.disabled = true;
    retry.textContent = "Retrying…";
    var key = new URLSearchParams(window.location.search).get("key");
    var retryUrl = "/api/broadcast-ledger/receipts/" + encodeURIComponent(retry.getAttribute("data-id")) + "/retry";
    if (key) retryUrl += "?key=" + encodeURIComponent(key);
    fetch(retryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    }).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || "Retry failed.");
        toast("Broadcast retried successfully.");
        setTimeout(function () { window.location.reload(); }, 500);
      });
    }).catch(function (error) {
      toast(error.message);
      retry.disabled = false;
      retry.textContent = "Retry";
    });
  }

  document.addEventListener("click", function (event) {
    var copy = event.target.closest(".copy-receipt");
    if (copy) {
      var details = copy.getAttribute("data-receipt") || "";
      navigator.clipboard.writeText(JSON.stringify(JSON.parse(details), null, 2))
        .then(function () { toast("Receipt details copied."); })
        .catch(function () { toast("Could not copy receipt details."); });
      return;
    }

    var retry = event.target.closest(".retry-receipt");
    if (!retry) return;
    requestRetryText().then(function (text) { retryReceipt(retry, text); });
  });
})();
