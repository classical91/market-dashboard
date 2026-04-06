function setTimestamp() {
  const timestamp = document.getElementById("ts");
  if (!timestamp) {
    return;
  }

  const now = new Date();
  timestamp.textContent =
    now.toLocaleDateString("en-CA", {
      weekday: "short",
      month: "short",
      day: "numeric",
    }) +
    " · " +
    now.toLocaleTimeString("en-CA", {
      hour: "2-digit",
      minute: "2-digit",
    });
}

document.addEventListener("DOMContentLoaded", () => {
  setTimestamp();
  window.setInterval(setTimestamp, 60_000);
  initSections("mi_collapsed");
});
