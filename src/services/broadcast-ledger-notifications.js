"use strict";

const TYPE_LABELS = {
  blocked: "Blocked attempt",
  failed: "Failed broadcast",
  missingCategory: "Missing category",
};

class BroadcastLedgerNotificationService {
  constructor({ telegramService, logger = console } = {}) {
    this._telegram = telegramService;
    this._logger = logger;
  }

  get configured() {
    return Boolean(this._telegram && this._telegram.configured);
  }

  async notify(type, receipt, detail = "") {
    if (!this.configured || !TYPE_LABELS[type]) return { sent: false, reason: "not-configured" };
    const lines = [
      `Broadcast Ledger: ${TYPE_LABELS[type]}`,
      `Headline: ${receipt?.title || "Untitled"}`,
      `Category: ${receipt?.newsType || "Unclassified"}`,
      `Source: ${receipt?.source || "unknown"}`,
      `Receipt: ${receipt?.id || "not recorded"}`,
    ];
    if (detail) lines.push(`Reason: ${String(detail).slice(0, 500)}`);

    try {
      const result = await this._telegram.postText(lines.join("\n"), { parseMode: "none" });
      return { sent: true, result };
    } catch (err) {
      this._logger.error?.("[BroadcastLedger] Notification delivery failed:", err.message);
      return { sent: false, reason: err.message };
    }
  }
}

module.exports = { BroadcastLedgerNotificationService };
