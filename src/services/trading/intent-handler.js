"use strict";

// The one boundary a trade intent crosses to become an action.
//
// Both entries and exits come through handle(). What happens on the other side
// is deliberately asymmetric:
//
//   Entry  ->  runChecklist() -> assessEdge() -> planTrade() -> openPosition()
//   Exit   ->  closePosition(), no gates
//
// That asymmetry is the point, not an oversight. Entries need gates: the
// checklist decides whether the setup is worth taking and the edge gate decides
// whether setups like it have historically paid. Exits need *protection*. If
// the strategy reports its thesis has broken, a gate that could veto the close
// would convert a risk control into a risk — the edge gate would be holding a
// losing position open on the grounds that positions like it have done badly,
// which is precisely backwards. So an exit never consults the checklist or the
// edge gate, and cannot be blocked by a kill switch, a loss limit, or a
// position cap.
//
// Paper only. This routes to TradingLabService and the paper trader; no
// authenticated exchange path is reachable from here.

const { isEntry, isExit, exitDirection } = require("./trade-intent");

const DEFAULT_EXIT_REASON = "SCANNER_EXIT";

class TradeIntentHandler {
  constructor({
    tradingLabService,
    book = "main",
    contextInterval = "4h",
    paperTradeEnabled = true,
    exitReason = DEFAULT_EXIT_REASON,
    signalSource = "live-scanner",
    logger = console,
  } = {}) {
    this._lab = tradingLabService;
    this.book = String(book || "main").toLowerCase();
    this.contextInterval = String(contextInterval || "4h");
    this.paperTradeEnabled = Boolean(paperTradeEnabled);
    this.exitReason = String(exitReason || DEFAULT_EXIT_REASON);
    this.signalSource = String(signalSource);
    this._logger = logger;
  }

  /**
   * Route one intent. Returns an outcome describing what happened — including
   * when nothing happened — so the caller can log the decision trail rather
   * than inferring it.
   */
  async handle(intent) {
    if (!this._lab) return { status: "skipped", reason: "Trading Lab not configured" };
    if (isExit(intent)) return this._handleExit(intent);
    if (isEntry(intent)) return this._handleEntry(intent);
    return { status: "ignored", reason: `Unroutable intent signal "${intent && intent.signal}"` };
  }

  /**
   * Where this intent's positions live.
   *
   * Delegated to the Trading Lab so there is one answer to the question. A
   * A registered strategy always resolves to its own account. The Trading Lab
   * refuses ineligible or unattributed persistent execution instead of falling
   * back to an archived legacy ledger.
   */
  _ledgerFor(intent) {
    const strategyId = intent && intent.strategy ? intent.strategy : null;
    if (typeof this._lab.ledgerFor === "function") {
      return this._lab.ledgerFor({ strategyId });
    }
    return this._lab.strategyLedger(strategyId);
  }

  // ── Exits: no gates ───────────────────────────────────────────────────────

  async _handleExit(intent) {
    // The ledger this strategy's trades actually live in. A scanner-eligible
    // strategy writes to its own account, so an exit has to look for the
    // position there — searching the portfolio book would find nothing and
    // silently leave the position open.
    const trader = this._ledgerFor(intent);
    const direction = exitDirection(intent);
    const open = trader
      .getOpenPositions()
      .filter((p) => p.symbol === intent.symbol && p.direction === direction);

    // Nothing to invalidate. Common and uninteresting: the strategy reports a
    // broken long thesis on every bar it is bearish, whether or not a long is
    // actually open.
    if (!open.length) {
      return { status: "noop", reason: `No open ${direction} on ${intent.symbol}` };
    }

    const closed = [];
    for (const position of open) {
      const result = await trader.closePosition(position.id, {
        reason: this.exitReason,
        // Exit at the close of the bar that invalidated the thesis, not at a
        // later ticker price — the signal confirmed on this bar.
        exitPrice: intent.price,
      });
      if (result) closed.push(result);
    }

    if (!closed.length) {
      return { status: "noop", reason: `Could not close ${direction} on ${intent.symbol}` };
    }

    return {
      status: "exited",
      reason: `Thesis invalidated — closed ${closed.map((p) => p.id).join(", ")}`,
      closed,
    };
  }

  // ── Entries: every gate ───────────────────────────────────────────────────

  async _handleEntry(intent) {
    // Same ledger the entry will be written to, so "one position per symbol"
    // counts the positions that actually exist for this strategy.
    const trader = this._ledgerFor(intent);

    // One position per symbol, whoever opened it.
    if (trader.getOpenPositions().some((p) => p.symbol === intent.symbol)) {
      return { status: "skipped", reason: `Position already open on ${intent.symbol}` };
    }

    const observations = intent.indicators || {};
    const input = {
      book: this.book,
      symbol: intent.symbol,
      direction: intent.signal,
      entryPrice: intent.price,
      // A volatility measurement, not a stop distance. risk.js applies
      // SL_ATR_MULTIPLE to turn it into levels.
      atr: observations.atr ?? null,
      // The strategy's readings feed the checklist's entry-trigger, volume and
      // volatility buckets; regime and daily bias come from the decision
      // engine. The 0-100 score and the size multiplier are produced there.
      state: {
        ...(await this._lab.stateForInterval(this.contextInterval)),
        atrRatio: observations.atrRatio,
        volumeRatio: observations.volumeRatio,
        macdBullish: observations.macdBullish,
      },
      // The edge gate's grouping key. A display string, and deliberately not
      // the attribution — see the explicit fields below.
      strategy: `live:${intent.strategy}:${intent.tf}`,
      // Attribution, carried through to the trade record. Until this existed a
      // forward-paper trade landed with `signalSource: "live-scanner:15m"` and
      // nothing else: the strategy that produced it was known here, used as an
      // edge-gate key, and then dropped. Every strategy-level number the lab
      // reported about forward trades was really a number about a timeframe.
      strategyId: intent.strategy,
      strategyVersion: intent.strategyVersion || null,
      timeframe: intent.tf,
      regime: intent.regime || null,
      regimeConfidence: intent.regimeConfidence ?? null,
    };

    // Dry run: score it through the full pipeline, log the verdict, open
    // nothing.
    if (!this.paperTradeEnabled) {
      const assessment = this._lab.evaluate(input);
      return {
        status: "dry-run",
        reason: assessment.trade.ok ? "Would open (paper trading disabled)" : assessment.trade.reason,
        assessment,
      };
    }

    try {
      const assessment = await this._lab.execute({ ...input, signalSource: this.signalSource });
      return {
        status: assessment.opened ? "opened" : "blocked",
        reason: assessment.opened ? `Opened ${assessment.opened.id}` : assessment.trade.reason,
        assessment,
        opened: assessment.opened || null,
      };
    } catch (err) {
      // Position and risk limits surface as thrown 4xx errors from the paper
      // trader — a refusal to trade, not a fault.
      return { status: "blocked", reason: err.message };
    }
  }
}

module.exports = { TradeIntentHandler, DEFAULT_EXIT_REASON };
