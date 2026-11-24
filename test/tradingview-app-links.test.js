const test = require('node:test');
const assert = require('node:assert/strict');

const AppSettings = require('../public/assets/js/settings.js');

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

test('Android chart links become an intent for the TradingView app with a web fallback', () => {
  const web = 'https://www.tradingview.com/chart/?symbol=CRYPTOCAP%3ABTC.D';
  assert.equal(
    AppSettings.tradingViewAppHref(web, ANDROID),
    'intent://www.tradingview.com/chart/?symbol=CRYPTOCAP%3ABTC.D#Intent;scheme=https;' +
      'package=com.tradingview.tradingviewapp;S.browser_fallback_url=' + encodeURIComponent(web) + ';end'
  );
});

test('a fragment on the web URL is dropped from the intent path but kept in the fallback', () => {
  const web = 'https://tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT&interval=60#x';
  const href = AppSettings.tradingViewAppHref(web, ANDROID);
  assert.ok(href.startsWith('intent://tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT&interval=60#Intent;'));
  assert.ok(href.includes('S.browser_fallback_url=' + encodeURIComponent(web) + ';end'));
});

test('symbol pages are rewritten too', () => {
  assert.ok(AppSettings.tradingViewAppHref('https://www.tradingview.com/symbols/BTCUSDT/', ANDROID).startsWith('intent://'));
});

test('iPhone, desktop and non-chart links are left alone', () => {
  const web = 'https://www.tradingview.com/chart/?symbol=CRYPTOCAP%3AUSDT.D';
  assert.equal(AppSettings.tradingViewAppHref(web, IPHONE), null);
  assert.equal(AppSettings.tradingViewAppHref(web, DESKTOP), null);
  assert.equal(AppSettings.tradingViewAppHref('https://www.tradingview.com/pricing/', ANDROID), null);
  assert.equal(AppSettings.tradingViewAppHref('https://www.tradingview.com.evil.example/chart/', ANDROID), null);
  assert.equal(AppSettings.tradingViewAppHref('https://example.com/chart/', ANDROID), null);
});

test('the phone link preference defaults to the app and rejects unknown values', () => {
  assert.equal(AppSettings.getTradingViewLinks(), 'app');
  AppSettings.setTradingViewLinks('web');
  assert.equal(AppSettings.getTradingViewLinks(), 'web');
  AppSettings.setTradingViewLinks('bogus');
  assert.equal(AppSettings.getTradingViewLinks(), 'app');
});
