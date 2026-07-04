// Free alternative to chart-img.com: screenshots a public TradingView chart
// URL — a live layout (tradingview.com/chart/<id>/?symbol=...) or a static
// snapshot (tradingview.com/x/<id>/) — directly with a headless browser
// instead of paying a third-party rendering API. More fragile than a
// purpose-built image API — TradingView can change its markup at any time —
// but avoids a paid subscription for personal/low-volume use.
const { chromium } = require("playwright");

const DISMISS_SELECTORS = [
  'button:has-text("Got it")',
  'button:has-text("Accept")',
  '[aria-label="Close"]',
  '[data-name="dialog-close"]',
];

const CHART_SELECTORS = [".layout__area--center", ".chart-container"];

class LayoutCaptureService {
  constructor({ timeoutMs, settleMs } = {}) {
    this._timeoutMs = timeoutMs || 25000;
    this._settleMs = settleMs || 4000;
    this._browserPromise = null;
  }

  async _getBrowser() {
    if (!this._browserPromise) {
      // Chromium runs its own network stack and doesn't inherit HTTPS_PROXY
      // the way Node's fetch does, so an environment sitting behind an
      // outbound proxy needs it passed explicitly.
      const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
      this._browserPromise = chromium
        .launch({
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          proxy: proxyServer ? { server: proxyServer } : undefined,
        })
        .catch((err) => {
          this._browserPromise = null;
          throw err;
        });
    }
    return this._browserPromise;
  }

  async _dismissOverlays(page) {
    for (const selector of DISMISS_SELECTORS) {
      try {
        const button = page.locator(selector).first();
        if (await button.isVisible({ timeout: 800 })) {
          await button.click({ timeout: 800 });
        }
      } catch {
        // No such overlay this run — fine, keep going.
      }
    }
  }

  /**
   * Screenshots a public TradingView shared-layout URL and returns a PNG
   * buffer. Throws on navigation/timeout failure.
   */
  async capture(layoutUrl) {
    const browser = await this._getBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      // A live chart page never reaches "networkidle" — TradingView keeps
      // websocket/quote traffic streaming forever — so waiting for it is a
      // guaranteed timeout. Wait for the DOM plus a rendered chart canvas
      // instead, then give indicators a fixed beat to finish painting.
      await page.goto(layoutUrl, { waitUntil: "domcontentloaded", timeout: this._timeoutMs });
      await page.waitForSelector("canvas", { timeout: this._timeoutMs }).catch(() => {});
      await this._dismissOverlays(page);
      await page.waitForTimeout(this._settleMs);

      let target = page;
      for (const selector of CHART_SELECTORS) {
        const locator = page.locator(selector).first();
        if (await locator.count()) {
          target = locator;
          break;
        }
      }
      return await target.screenshot({ type: "png" });
    } finally {
      await context.close();
    }
  }

  async close() {
    if (!this._browserPromise) return;
    const browser = await this._browserPromise;
    this._browserPromise = null;
    await browser.close();
  }
}

module.exports = { LayoutCaptureService };
