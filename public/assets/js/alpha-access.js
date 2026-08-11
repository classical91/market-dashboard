(function () {
  "use strict";

  function isAlphaView() {
    try {
      return new URLSearchParams(window.location.search || "").get("view") === "alpha";
    } catch {
      return false;
    }
  }

  if (!isAlphaView()) return;

  var storageKey = "marketDashboardAlphaAccessGranted";

  function unlock() {
    document.documentElement.classList.remove("alpha-gate-active");
    var overlay = document.querySelector(".alpha-access-overlay");
    if (overlay) overlay.remove();
  }

  function verify(code) {
    return fetch("/api/alpha-team/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code || "" }),
    }).then(function (res) {
      if (!res.ok) throw new Error("Invalid access code");
      return res.json();
    });
  }

  function renderGate() {
    if (document.querySelector(".alpha-access-overlay")) return;

    var overlay = document.createElement("div");
    overlay.className = "alpha-access-overlay";
    overlay.innerHTML =
      '<section class="alpha-access-card" role="dialog" aria-modal="true" aria-labelledby="alpha-access-title">' +
        '<div class="alpha-access-kicker">Alpha Team</div>' +
        '<h1 class="alpha-access-title" id="alpha-access-title">Access required</h1>' +
        '<p class="alpha-access-copy">Enter the Alpha Team access code to review the shared Market Dashboard page.</p>' +
        '<form class="alpha-access-form">' +
          '<input class="alpha-access-input" type="password" name="code" autocomplete="current-password" placeholder="Access code" aria-label="Access code" required />' +
          '<button class="alpha-access-button" type="submit">Visit page</button>' +
          '<div class="alpha-access-error" role="status" aria-live="polite"></div>' +
        '</form>' +
      '</section>';

    var form = overlay.querySelector("form");
    var input = overlay.querySelector("input");
    var button = overlay.querySelector("button");
    var error = overlay.querySelector(".alpha-access-error");

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      error.textContent = "";
      button.disabled = true;
      button.textContent = "Checking";

      verify(input.value)
        .then(function () {
          try { sessionStorage.setItem(storageKey, "true"); } catch {}
          unlock();
        })
        .catch(function () {
          error.textContent = "Access code was not accepted.";
          input.select();
        })
        .finally(function () {
          button.disabled = false;
          button.textContent = "Visit page";
        });
    });

    document.body.appendChild(overlay);
    input.focus();
  }

  document.documentElement.classList.add("alpha-gate-active");

  try {
    if (sessionStorage.getItem(storageKey) === "true") {
      unlock();
      return;
    }
  } catch {}

  verify("")
    .then(unlock)
    .catch(renderGate);
})();
