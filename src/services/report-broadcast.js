"use strict";

/**
 * Per-category delivery of a generated daily report.
 *
 * This is the body of the Daily Reporter's broadcast route, lifted into a
 * service so the scheduled newsroom cycle sends through exactly the same code
 * rather than growing a second, subtly different sender. Two copies of a send
 * path is how one caller ends up honouring the ledger's idempotency key and
 * the other quietly resends a category that already landed.
 *
 * Behaviour preserved from the route verbatim:
 *   - one send, one receipt and one destination list per category;
 *   - a `pending` receipt is written *before* each send, so a crash
 *     mid-broadcast leaves a trace rather than a silent gap;
 *   - the idempotency key is per category, so a repeat cannot fork the ledger
 *     or resend a category that already posted;
 *   - the create deliberately carries no explicit status, letting the store's
 *     own no-regression guard keep a posted receipt from being walked back.
 */

const { destinationsForNewsType } = require("./news-routing");
const { isPostedStatus } = require("./broadcast-ledger");

// The reporter's own section keys, mapped to the ledger's news categories.
// `markets` is the Stock category — the section key predates the category
// vocabulary and renaming it would rewrite stored reports.
const REPORT_CATEGORIES = [
  { key: "crypto", newsType: "Crypto" },
  { key: "markets", newsType: "Stock" },
  { key: "economics", newsType: "Economics" },
];

/**
 * @param {object}  options
 * @param {object}  options.report            The aggregate report to send.
 * @param {object}  options.telegramService   Sender exposing postReportSection.
 * @param {object}  options.broadcastLedgerStore Receipt store (optional).
 * @param {string}  [options.cycleId]         Newsroom cycle this send belongs to.
 * @param {string}  [options.source]          Ledger source for created receipts.
 * @param {boolean} [options.continueOnError] When true a failing category is
 *   recorded and the remaining categories are still attempted. The interactive
 *   route leaves this false so a broken send surfaces as an error response;
 *   a scheduled cycle sets it, because one dead topic must not cost the other
 *   two categories their delivery.
 * @returns {{receipts: object[], destinations: object[], failures: object[]}}
 */
async function broadcastReportSections({
  report,
  telegramService,
  broadcastLedgerStore,
  cycleId = null,
  source = "dashboard",
  actor = "dashboard",
  continueOnError = false,
} = {}) {
  const settings = broadcastLedgerStore ? broadcastLedgerStore.getSettings() : null;
  const stamp = report.generatedAt || report.dateStr || Date.now();
  const date = report.dateStr || new Date().toISOString().slice(0, 10);
  const sections = REPORT_CATEGORIES.filter((section) => report[section.key]);

  const receipts = [];
  const destinations = [];
  const failures = [];

  for (const section of sections) {
    // A cycle-scoped key is what lets delivery be retried without regenerating:
    // the retry lands on the same receipts, so categories that already posted
    // are recognized rather than re-sent.
    const idempotencyKey = cycleId
      ? `newsroom:${cycleId}:${section.newsType}`
      : `digest:${section.newsType}:${stamp}`;

    const created = broadcastLedgerStore
      ? broadcastLedgerStore.createReceipt({
          source,
          kind: "digest",
          newsType: section.newsType,
          title: `${section.newsType} daily report — ${date}`,
          idempotencyKey,
          cycleId,
          text: report[section.key],
          // Deliberately no explicit status. A create with no destinations
          // already defaults to "pending", and a repeat under the same key is
          // an update — where an explicit "pending" would win outright and
          // walk an already-posted receipt back, re-sending a category that
          // had landed.
        })
      : null;
    const receipt = created ? created.receipt : null;

    // Already posted under this key: record it and move on rather than sending
    // the same category twice.
    if (receipt && created.created === false && isPostedStatus(receipt.status)) {
      receipts.push(receipt);
      destinations.push(...(receipt.destinations || []).map((d) => ({ ...d, newsType: section.newsType })));
      continue;
    }

    let result;
    try {
      result = await telegramService.postReportSection({
        newsType: section.newsType,
        text: report[section.key],
        date: report.dateStr,
        targets: destinationsForNewsType(section.newsType, settings),
      });
    } catch (err) {
      if (receipt) {
        receipts.push(
          broadcastLedgerStore.updateReceipt(
            receipt.id,
            { status: "failed", error: err, destinations: err.destinations || [], action: "broadcast" },
            { actor },
          ),
        );
      }
      failures.push({ newsType: section.newsType, section: section.key, error: err });
      if (!continueOnError) throw err;
      continue;
    }

    const sent = (result && result.destinations) || [];
    destinations.push(...sent.map((d) => ({ ...d, newsType: section.newsType })));
    if (receipt) {
      receipts.push(
        broadcastLedgerStore.updateReceipt(receipt.id, { destinations: sent, action: "broadcast" }, { actor }),
      );
    }
  }

  return { receipts, destinations, failures };
}

module.exports = { broadcastReportSections, REPORT_CATEGORIES };
