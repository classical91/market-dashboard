// Background signal bot: periodically re-runs the Signal Screener and
// Pattern Scanner and pushes Telegram alerts whenever something *changes
// state* — a confluence signal flips (FLAT -> LONG), a pattern reaches
// breakout, or a fresh divergence appears. Only transitions are alerted —
// never the standing state — so a signal that stays LONG for three days
// produces exactly one message, not one per scan.
//
// Last-known state is persisted to disk, so a redeploy diffs against the
// state from before the restart instead of re-baselining and going silent
// (or worse, re-alerting everything currently non-FLAT).
//
// Every newly-detected pattern/divergence instance is also logged to the
// PatternTrackerService with its entry price, so their real-world hit rate
// can be measured later instead of trusting the heuristics blind.
const STATE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const STATE_KEY = "signal-bot:last-signals";

class SignalBotService {
  constructor({
    signalScreenerService,
    patternScannerService,
    telegramService,
    patternTrackerService,
    stateCache,
    intervalMs,
    timeframes,
    minChecks,
  }) {
    this._screener = signalScreenerService;
    this._patternScanner = patternScannerService;
    this._telegram = telegramService;
    this._tracker = patternTrackerService;
    this._stateCache = stateCache;
    this._intervalMs = intervalMs || 15 * 60 * 1000;
    this._timeframes = timeframes && timeframes.length ? timeframes : ["4h", "1D"];
    this._minChecks = minChecks || 4;
    this._timer = null;
    this._running = false;
  }

  get enabled() {
    return Boolean(this._telegram && this._telegram.configured);
  }

  start() {
    if (!this.enabled) {
      console.log("[SignalBot] Telegram not configured — signal alerts disabled");
      return;
    }
    if (this._timer) return;
    console.log(
      `[SignalBot] Watching ${this._timeframes.join(", ")} every ${Math.round(this._intervalMs / 60000)}m`,
    );
    this._timer = setInterval(() => {
      this.runOnce().catch((err) => console.error("[SignalBot] Scan failed:", err.message));
    }, this._intervalMs);
    if (this._timer.unref) this._timer.unref();
    // First pass right away so a fresh deploy baselines (or diffs against
    // persisted state) without waiting a full interval.
    this.runOnce().catch((err) => console.error("[SignalBot] Initial scan failed:", err.message));
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _scanScreener(next) {
    const transitions = [];
    for (const interval of this._timeframes) {
      const results = await this._screener.scanAll(interval, this._minChecks);
      for (const result of results) {
        if (result.error || !result.signal) continue;
        const key = `${result.symbol}:${interval}`;
        const last = next[key];
        next[key] = result.signal;
        // No prior state for this key (first ever scan, or a token newly
        // added to the list): record silently rather than "alerting" the
        // standing state.
        if (last == null || last === result.signal) continue;
        transitions.push({ symbol: result.symbol, interval, from: last, to: result.signal, score: result.score });
      }
    }
    return transitions;
  }

  async _scanPatterns(known, next) {
    if (!this._patternScanner) return [];
    const events = [];
    const detectedAt = new Date().toISOString();
    const results = await this._patternScanner.scanAll();
    for (const result of results) {
      if (result.error) continue;
      const seenBefore = Object.prototype.hasOwnProperty.call(known, `pattern:${result.symbol}:${result.interval}`);
      const lastClose = result.chart && result.chart.candles.length
        ? result.chart.candles[result.chart.candles.length - 1][4]
        : null;

      // Tracker logging shares the exact same trigger as the breakout alert:
      // a "forming" wedge isn't a completed call yet, so the meaningful
      // entry moment (and the only one worth backtesting) is the breakout.
      const patternKey = `pattern:${result.symbol}:${result.interval}`;
      const patternName = result.pattern ? result.pattern.pattern : null;
      const patternSig = result.pattern ? `${result.pattern.pattern}:${result.pattern.status}` : null;
      const priorPatternSig = known[patternKey];
      next[patternKey] = patternSig;

      if (seenBefore && patternSig && patternSig.endsWith(":breakout") && patternSig !== priorPatternSig) {
        events.push({ symbol: result.symbol, interval: result.interval, kind: "breakout", name: patternName, bias: result.pattern.bias, score: result.pattern.score });
        if (lastClose != null) {
          this._tracker?.log({
            symbol: result.symbol,
            interval: result.interval,
            kind: "pattern",
            name: patternName,
            bias: result.pattern.bias,
            entryPrice: lastClose,
            detectedAt,
          });
        }
      }

      const divKey = `divergence:${result.symbol}:${result.interval}`;
      const divName = result.divergence ? result.divergence.type : null;
      const priorDivName = known[divKey];
      next[divKey] = divName;

      if (seenBefore && divName && divName !== priorDivName && lastClose != null) {
        this._tracker?.log({
          symbol: result.symbol,
          interval: result.interval,
          kind: "divergence",
          name: divName,
          bias: result.divergence.bias,
          entryPrice: lastClose,
          detectedAt,
        });
        events.push({ symbol: result.symbol, interval: result.interval, kind: "divergence", name: divName, bias: result.divergence.bias });
      }
    }
    return events;
  }

  /**
   * One scan cycle: screener + pattern scans, diffed against persisted
   * state, alerted, tracker-logged, then the new state persisted. Exposed
   * for tests and returns everything it alerted.
   */
  async runOnce() {
    if (this._running) return { screenerTransitions: [], patternEvents: [] }; // a slow cycle shouldn't stack another on top
    this._running = true;
    try {
      const known = this._stateCache.get(STATE_KEY) || {};
      const next = { ...known };

      const screenerTransitions = await this._scanScreener(next);
      const patternEvents = await this._scanPatterns(known, next);

      this._stateCache.set(STATE_KEY, next, STATE_TTL_MS);
      if (screenerTransitions.length) await this._telegram.postSignalAlerts(screenerTransitions);
      if (patternEvents.length) await this._telegram.postPatternAlerts(patternEvents);
      if (this._tracker) {
        await this._tracker.resolveDue().catch((err) => console.error("[SignalBot] resolveDue failed:", err.message));
      }
      return { screenerTransitions, patternEvents };
    } finally {
      this._running = false;
    }
  }
}

module.exports = { SignalBotService };
