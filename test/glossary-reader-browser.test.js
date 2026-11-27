"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { chromium } = require("playwright");
const { ALL_GLOSSARY, conceptHref } = require("../public/assets/js/indicators.js");

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();

test("the glossary reader picks matching topics and controls read-aloud", {
  skip: !fs.existsSync(executablePath) && "Install Chromium or set PLAYWRIGHT_CHROMIUM_EXECUTABLE",
}, async (t) => {
  const app = express();
  app.use(express.static(path.join(__dirname, "..", "public")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const url = `http://127.0.0.1:${server.address().port}/indicators.html`;
  const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
  await page.addInitScript(() => {
    window.readerSpeech = { lines: [], cancellations: 0, startedOnClick: false };
    Object.defineProperty(window, "speechSynthesis", { value: {
      speak(utterance) {
        const speech = window.readerSpeech;
        if (!speech.lines.length) speech.startedOnClick = navigator.userActivation.isActive;
        speech.lines.push(utterance.text);
        speech.current = utterance;
      },
      cancel() { window.readerSpeech.cancellations++; },
    } });
  });
  await page.goto(url);

  const search = page.getByRole("searchbox");
  const open = page.getByRole("button", { name: "Read a random topic" });
  const dialog = page.getByRole("dialog");
  const next = page.getByRole("button", { name: "Another topic" });
  await search.fill("therearenomatchingtopics");
  assert.equal(await open.isDisabled(), true);
  await search.fill("mvrv");
  await open.click();
  const bounds = await dialog.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320);
  const title = dialog.getByRole("heading", { level: 2 });
  const first = await title.textContent();
  await next.click();
  assert.notEqual(await title.textContent(), first);
  const href = await dialog.getByRole("link", { name: "Open full topic" }).getAttribute("href");
  assert.match(href, /^\/concept\.html\?id=(mvrv|on-chain-metrics|realized-price)$/);
  const entry = ALL_GLOSSARY.find((candidate) => conceptHref(candidate) === href);
  assert.equal(await title.textContent(), entry.term);
  const spoken = await page.evaluate(() => {
    const speech = window.readerSpeech;
    speech.lines = [speech.current.text];
    while (speech.current) {
      const utterance = speech.current;
      speech.current = null;
      utterance.onend();
    }
    return { lines: speech.lines.join(" "), cancellations: speech.cancellations, startedOnClick: speech.startedOnClick };
  });
  assert.deepEqual(spoken, {
    lines: `${entry.term}. ${entry.def} How to read it. ${entry.read}`,
    cancellations: 1,
    startedOnClick: true,
  });
  await dialog.getByRole("button", { name: "Read aloud" }).click();
  await dialog.getByRole("button", { name: "Stop reading" }).click();
  await dialog.getByRole("button", { name: "Read aloud" }).click();
  await page.evaluate(() => window.readerSpeech.current.onerror());
  assert.match(await dialog.getByRole("status").textContent(), /Audio couldn’t play/);
  await dialog.getByRole("button", { name: "Read aloud" }).click();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => window.readerSpeech.cancellations === 3);
  assert.equal(await open.evaluate((element) => element === document.activeElement), true);

  const fallback = await browser.newPage();
  await fallback.addInitScript(() => Object.defineProperty(window, "speechSynthesis", { value: undefined }));
  await fallback.goto(url);
  await fallback.getByRole("searchbox").fill("parabolic sar");
  await fallback.getByRole("button", { name: "Read a random topic" }).click();
  assert.match(await fallback.getByRole("status").filter({ hasText: "Read-aloud" }).textContent(), /unavailable/);
  assert.equal(await fallback.getByRole("button", { name: "Another topic" }).isDisabled(), true);
  await fallback.getByRole("link", { name: "Open full topic" }).click();
  assert.equal(await fallback.getByRole("heading", { name: "Parabolic SAR", level: 1 }).isVisible(), true);
});
