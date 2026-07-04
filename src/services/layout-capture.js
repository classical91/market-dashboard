// Free alternative to chart-img.com: screenshots a public TradingView shared
// layout URL (tradingview.com/x/<id>/) directly with a headless browser
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
    this._settleMs = settleMs || 2500;
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
      await page.goto(layoutUrl, { waitUntil: "networkidle", timeout: this._timeoutMs });
      await this._dismissOverlays(page);
      // Chart drawing (indicators, studies) can finish slightly after the
      // network goes idle, so give it a moment before capturing.
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
