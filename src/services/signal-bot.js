// Background signal bot: periodically re-runs the Signal Screener and pushes
// a Telegram alert whenever a token's confluence signal *changes state*
// (FLAT -> LONG, LONG -> SHORT, ...). Only transitions are alerted — never
// the standing state — so a signal that stays LONG for three days produces
// exactly one message, not one per scan.
//
// Last-known signals are persisted to disk, so a redeploy diffs against the
// state from before the restart instead of re-baselining and going silent
// (or worse, re-alerting everything currently non-FLAT).
const STATE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const STATE_KEY = "signal-bot:last-signals";

class SignalBotService {
  constructor({ signalScreenerService, telegramService, stateCache, intervalMs, timeframes, minChecks }) {
    this._screener = signalScreenerService;
    this._telegram = telegramService;
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

  /**
   * One scan cycle: fetch signals for every timeframe, diff against the
   * persisted last-known state, alert the changes, persist the new state.
   * Exposed for tests and returns the transitions it alerted.
   */
  async runOnce() {
    if (this._running) return []; // a slow cycle shouldn't stack another on top
    this._running = true;
    try {
      const previous = this._stateCache.get(STATE_KEY);
      const known = previous || {};
      const next = { ...known };
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
          transitions.push({
            symbol: result.symbol,
            interval,
            from: last,
            to: result.signal,
            score: result.score,
          });
        }
      }

      this._stateCache.set(STATE_KEY, next, STATE_TTL_MS);
      if (transitions.length) {
        await this._telegram.postSignalAlerts(transitions);
      }
      return transitions;
    } finally {
      this._running = false;
    }
  }
}

module.exports = { SignalBotService };
