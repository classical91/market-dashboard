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
const { candleToleranceMs } = require("./data-freshness");

const STATE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const STATE_KEY = "signal-bot:last-signals";
const DELIVERY_KEY = "pendingTelegram";
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;

class SignalBotService {
  constructor({
    signalScreenerService,
    patternScannerService,
    telegramService,
    patternTrackerService,
    tradeBridge,
    stateCache,
    intervalMs,
    timeframes,
    minChecks,
    // Optional. When wired, the bot watches the same token universes the
    // Settings page configures for the Directional Bias and Pattern Scanner
    // pages, so an alert can never name a row the dashboard stopped showing.
    // Without it both scanners keep their own default lists.
    screenerSettingsService,
  }) {
    this._screener = signalScreenerService;
    this._patternScanner = patternScannerService;
    this._telegram = telegramService;
    this._tracker = patternTrackerService;
    this._bridge = tradeBridge && tradeBridge.active ? tradeBridge : null;
    this._stateCache = stateCache;
    this._intervalMs = intervalMs || 15 * 60 * 1000;
    this._timeframes = timeframes && timeframes.length ? timeframes : ["4h", "1D"];
    this._minChecks = minChecks || 4;
    this._screenerSettings = screenerSettingsService || null;
    this._timer = null;
    this._running = false;
  }

  // The loop earns its keep either by alerting (Telegram) or by driving paper
  // trades through the Trading Lab bridge. Auto-marking rides along on a cycle
  // that is already happening; it is not on its own a reason to start scanning.
  get enabled() {
    return Boolean(
      (this._telegram && this._telegram.configured) || (this._bridge && this._bridge.requiresSchedule),
    );
  }

  start() {
    if (!this.enabled) {
      console.log("[SignalBot] Telegram not configured and trade bridge inactive — signal loop disabled");
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

  // Read per cycle rather than cached on the instance: the universes are
  // edited from Settings while the bot is running, and the next scan should
  // already respect the change. `undefined` leaves each scanner on its own
  // default list.
  _universe(screener) {
    return this._screenerSettings ? this._screenerSettings.getUniverse(screener) : undefined;
  }

  async _scanScreener(next) {
    const transitions = [];
    const symbols = this._universe("directionalBias");
    for (const interval of this._timeframes) {
      const results = await this._screener.scanAll(interval, this._minChecks, { symbols }).catch((err) => {
        console.error(`[SignalBot] ${interval} Directional scan failed:`, err.message);
        return [];
      });
      for (const result of results) {
        if (result.error || !result.signal) continue;
        const key = `${result.symbol}:${interval}`;
        const last = next[key];
        next[key] = result.signal;
        // No prior state for this key (first ever scan, or a token newly
        // added to the list): record silently rather than "alerting" the
        // standing state.
        if (last == null || last === result.signal) continue;
        // The price rides along with the transition: the Trading Lab bridge
        // sizes its entry off it, and re-fetching later would enter at a
        // different price than the one the signal confirmed at.
        transitions.push({
          symbol: result.symbol,
          interval,
          from: last,
          to: result.signal,
          score: result.score,
          price: result.price ?? null,
          trendRegime: result.trendRegime || null,
          indicators: result.indicators || null,
        });
      }
    }
    return transitions;
  }

  async _scanPatterns(known, next) {
    if (!this._patternScanner) return [];
    const events = [];
    const results = await this._patternScanner.scanAll({ symbols: this._universe("patternScanner") });
    const now = Date.now();
    for (const result of results) {
      const { symbol, interval, pattern, divergence, candleCloseTime } = result;
      const maxAge = candleToleranceMs(interval);
      if (result.error || !Number.isFinite(candleCloseTime)
        || candleCloseTime > now || now - candleCloseTime > maxAge) continue;

      const patternKey = `pattern:${symbol}:${interval}`;
      const priorCandle = known[patternKey];
      const seenBefore = Object.prototype.hasOwnProperty.call(known, patternKey);
      if (typeof priorCandle === "number" && candleCloseTime <= priorCandle) continue;
      next[patternKey] = candleCloseTime;

      const lastClose = result.chart?.candles.at(-1)?.[4] ?? null;
      if (seenBefore && pattern?.breakoutCrossed && priorCandle !== `${pattern.pattern}:breakout`) {
        events.push({
          symbol, interval, kind: "breakout", name: pattern.pattern, bias: pattern.bias,
          score: pattern.score, entryPrice: lastClose, candleCloseTime,
        });
      }

      if (!divergence?.pivotTimes?.every(Number.isFinite) || divergence.pivotTimes.length !== 2) continue;
      const divKey = `divergence:${symbol}:${interval}`;
      const priorDivergences = known[divKey];
      const pivotsByType = priorDivergences && typeof priorDivergences === "object" ? priorDivergences : {};
      const priorPivot = pivotsByType[divergence.type]?.[1];
      if (priorPivot != null && divergence.pivotTimes[1] <= priorPivot) continue;
      next[divKey] = { ...pivotsByType, [divergence.type]: divergence.pivotTimes };
      // The old state stored a type string. Seed its pivot on upgrade without
      // repeating an alert the old bot may have sent for this same divergence.
      if (seenBefore && priorDivergences !== divergence.type) {
        events.push({
          symbol, interval, kind: "divergence", name: divergence.type, bias: divergence.bias,
          entryPrice: lastClose, candleCloseTime,
        });
      }
    }
    return events;
  }

  // Trading Lab bridge, isolated from the scan proper: a paper-trading fault
  // must never cost the deploy its signal alerts.
  async _runBridge(screenerTransitions) {
    if (!this._bridge) return [];
    try {
      await this._bridge.markOpenPositions();
      return await this._bridge.handleTransitions(screenerTransitions);
    } catch (err) {
      console.error("[SignalBot] Trade bridge failed:", err.message);
      return [];
    }
  }

  _saveState(state) {
    this._stateCache.set(STATE_KEY, state, STATE_TTL_MS);
  }

  async _deliverPending(state) {
    if (!this._telegram?.configured) return;
    const now = Date.now();
    const deferredTargets = new Set();
    for (const delivery of state[DELIVERY_KEY]) {
      if (now - delivery.queuedAt >= DELIVERY_TTL_MS) {
        console.warn("[SignalBot] Expired an undelivered Telegram alert");
      } else if (deferredTargets.has(delivery.targetKey) || delivery.retryAt > now) {
        deferredTargets.add(delivery.targetKey);
        continue;
      } else {
        try {
          const sent = await this._telegram.sendAlertDelivery(delivery);
          if (!sent) console.warn("[SignalBot] Dropped an alert for a removed Telegram destination");
        } catch (err) {
          const status = err.telegramStatus;
          console.error(`[SignalBot] Telegram alert failed (${status || "transport error"})`);
          if (!status || status === 429 || status >= 500) {
            deferredTargets.add(delivery.targetKey);
            const retryAt = Date.now() + Math.max(0, err.retryAfterMs || 0);
            const pending = state[DELIVERY_KEY].map((entry) => (
              entry === delivery ? { ...entry, retryAt } : entry
            ));
            state = { ...state, [DELIVERY_KEY]: pending };
            this._saveState(state);
            continue;
          }
        }
      }
      state = { ...state, [DELIVERY_KEY]: state[DELIVERY_KEY].filter((entry) => entry !== delivery) };
      this._saveState(state);
    }
  }

  async runOnce() {
    if (this._running) return { screenerTransitions: [], patternEvents: [], tradeActions: [] }; // a slow cycle shouldn't stack another on top
    this._running = true;
    try {
      const known = this._stateCache.get(STATE_KEY) || {};
      const next = { ...known };

      const screenerTransitions = await this._scanScreener(next).catch((err) => {
        console.error("[SignalBot] Directional scan failed:", err.message);
        return [];
      });
      const patternEvents = await this._scanPatterns(known, next).catch((err) => {
        console.error("[SignalBot] Pattern scan failed:", err.message);
        return [];
      });

      const queuedAt = Date.now();
      const queue = (messages) => this._telegram.alertDeliveries(messages).map((entry) => ({ ...entry, queuedAt }));
      const pending = (known[DELIVERY_KEY] || []).slice();
      const hasTelegram = this._telegram?.configured;
      if (hasTelegram && patternEvents.length) {
        pending.push(...queue(this._telegram.patternAlertMessages(patternEvents)));
      }
      const signalDeliveries = (tradeActions) => hasTelegram && screenerTransitions.length
        ? queue(this._telegram.signalAlertMessages(screenerTransitions, tradeActions))
        : [];

      // Commit the market state and the new alerts together before sending them
      // or acting on a Directional Bias transition in the Trading Lab.
      let state = { ...next, [DELIVERY_KEY]: [...pending, ...signalDeliveries([])] };
      this._saveState(state);
      if (this._tracker) {
        const detectedAt = new Date(queuedAt).toISOString();
        for (const { symbol, interval, kind, name, bias, entryPrice, candleCloseTime } of patternEvents) {
          if (entryPrice != null) {
            this._tracker.log({
              symbol, interval, kind: kind === "breakout" ? "pattern" : kind, name, bias, entryPrice, detectedAt, candleCloseTime,
            });
          }
        }
      }
      const tradeActions = await this._runBridge(screenerTransitions);
      if (hasTelegram && tradeActions.length && screenerTransitions.length) {
        state = { ...state, [DELIVERY_KEY]: [...pending, ...signalDeliveries(tradeActions)] };
        this._saveState(state);
      }
      await this._deliverPending(state);
      if (this._tracker) {
        await this._tracker.resolveDue().catch((err) => console.error("[SignalBot] resolveDue failed:", err.message));
      }

      return { screenerTransitions, patternEvents, tradeActions };
    } finally {
      this._running = false;
    }
  }
}

module.exports = { SignalBotService };
