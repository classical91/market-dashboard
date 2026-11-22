"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const { chromium } = require("playwright");
const { THEMES } = require("../public/assets/js/settings");

// Exercise the real page markup, styles and navigation scripts, with dashboard
// data/widget scripts excluded so these tests need no upstream services.
test("shared sidebar browser regressions", {
  skip: !fs.existsSync(chromium.executablePath()) && "Install Chromium with npx playwright install chromium",
}, async (t) => {
  const app = express();
  const publicDir = path.join(__dirname, "..", "public");
  for (const [url, file] of [["/overview-v1", "index.html"], ["/terminal-suite.html", "terminal-suite.html"], ["/", "overview-v2.html"], ["/overview-v2", "overview-v2.html"], ["/reporter.html", "reporter.html"], ["/briefings/crypto", "terminal-suite.html"], ["/heatmaps.html", "heatmaps.html"]]) {
    app.get(url, (_req, res) => {
      const html = fs.readFileSync(path.join(publicDir, file), "utf8");
      res.type("html").send(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) =>
        /src="\/assets\/js\/(settings|sidebar)\.js"/.test(tag) ? tag : ""));
    });
  }
  app.use(express.static(publicDir));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  t.after(() => browser.close());

  async function open(t, { initial = {}, blockedStorage = false, session } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    t.after(() => context.close());
    await context.addInitScript(({ initial, blockedStorage }) => {
      if (blockedStorage) {
        Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error("Storage disabled"); };
      } else if (!sessionStorage.getItem("sidebar-test-seeded")) {
        for (const [key, value] of Object.entries(initial)) localStorage.setItem(key, value);
        sessionStorage.setItem("sidebar-test-seeded", "1");
      }
    }, { initial, blockedStorage });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, [], "no uncaught page errors"));
    await page.route("**/api/auth/session", async (route) => {
      if (session) await session;
      await route.fulfill({ json: { authenticated: true, role: "owner", identifier: "Owner" } }).catch(() => {});
    });
    await page.goto(base + "/overview-v1", { waitUntil: "domcontentloaded" });
    await page.locator(".sidebar [data-dropdown-key]").first().waitFor();
    return page;
  }

  const menu = (page, key, root = ".sidebar, .cmd-sidebar") => page.locator(root)
    .locator(`[data-dropdown-key="sidebar_dropdown_${key}"]`);
  const toggle = (group) => group.locator(":scope > button, :scope > .nav-split > button, :scope > .cmd-nav-split > button");
  async function state(group, expected) {
    assert.equal(await group.evaluate((node) => node.classList.contains("open")), expected);
    assert.equal(await toggle(group).getAttribute("aria-expanded"), String(expected));
  }

  await t.test("Reporter Room sits directly above Trades in both navigation shells, and Overview nests under v2", async (t) => {
    const page = await open(t);
    for (const [url, root, drawer, prefix] of [["/overview-v1", ".sidebar", ".mob-drawer", ""], ["/terminal-suite.html", ".cmd-sidebar", ".cmd-drawer", "cmd-"]]) {
      await page.goto(base + url);
      for (const shell of [root, drawer]) {
        const primary = page.locator(`${shell} .${prefix}nav-primary`);
        assert.deepEqual(await primary.evaluate(nav => Array.from(nav.children).slice(0, 4).map(child => child.dataset.dropdownKey || child.getAttribute("data-nav-href"))),
          ["/terminal-suite.html", "sidebar_dropdown_overview_v2", "/reporter.html", "sidebar_dropdown_my_trades"]);
        assert.equal(await menu(page, "terminal_suite", shell).count(), 0);
        assert.equal(await primary.locator(':scope > a[data-nav-href="/reporter.html"]').count(), 1);
        assert.equal(await menu(page, "reporter", shell).locator('a[data-nav-href="/reporter.html"]').count(), 1);
        assert.equal(await menu(page, "overview_v2", shell).locator('a[data-nav-href="/overview-v1"]').count(), 1);
        assert.equal(await primary.locator(':scope > a[data-nav-href="/overview-v1"]').count(), 0);
      }
    }
    await page.locator('.cmd-sidebar .cmd-nav-primary > a[data-nav-href="/reporter.html"]').click();
    await page.waitForURL(base + "/reporter.html");
    await state(menu(page, "reporter"), true);
    if (process.env.SIDEBAR_SCREENSHOT_DIR) await page.locator(".cmd-sidebar").screenshot({ path: path.join(process.env.SIDEBAR_SCREENSHOT_DIR, "sidebar-reporter-above-trades.png") });
    const overview = menu(page, "overview_v2");
    await toggle(overview).click();
    assert.equal(page.url(), base + "/reporter.html", "the caret expands without navigating");
    await overview.locator('a[data-nav-href="/overview-v1"]').click();
    await page.waitForURL(base + "/overview-v1");
    assert.equal(await menu(page, "overview_v2").locator('a[data-nav-href="/overview-v1"]').getAttribute("aria-current"), "page");
    await menu(page, "overview_v2").locator('a[data-nav-href="/"]').click();
    await page.waitForURL(base + "/");
    assert.equal(await menu(page, "overview_v2").locator('a[data-nav-href="/"]').getAttribute("aria-current"), "page");
  });

  await t.test("open and closed choices survive both page directions and reloads", async (t) => {
    const page = await open(t);
    await toggle(menu(page, "my_trades")).click();
    await toggle(menu(page, "tradehunter")).click();
    await toggle(menu(page, "screeners")).click();
    await toggle(menu(page, "reporter")).click();
    await page.locator('.sidebar a[data-nav-href="/terminal-suite.html"]').click();
    for (const key of ["my_trades", "tradehunter", "screeners", "reporter"]) await state(menu(page, key), true);
    await toggle(menu(page, "my_trades")).click();
    await toggle(menu(page, "screeners")).click();
    await toggle(menu(page, "overview_v2")).click();
    await page.locator('.cmd-sidebar a[data-nav-href="/overview-v1"]').click();
    await state(menu(page, "my_trades"), false);
    await state(menu(page, "screeners"), false);
    await state(menu(page, "tradehunter"), true);
    await state(menu(page, "reporter"), true);
    await page.reload();
    await state(menu(page, "my_trades"), false);
    await state(menu(page, "screeners"), false);
    await state(menu(page, "reporter"), true);
  });

  await t.test("legacy preferences migrate once and shared choices take precedence", async (t) => {
    const page = await open(t, { initial: {
      sidebar_dropdown_overview_my_trades: "open", sidebar_dropdown_command_my_trades: "closed",
      sidebar_dropdown_command_reporter: "open", sidebar_dropdown_my_trades: "closed",
      sidebar_dropdown_overview_tradehunter: "open", sidebar_dropdown_command_tradehunter: "closed",
    } });
    await state(menu(page, "my_trades"), false);
    await state(menu(page, "reporter"), true);
    await state(menu(page, "tradehunter"), true);
    await page.goto(base + "/terminal-suite.html");
    await state(menu(page, "my_trades"), false);
    await state(menu(page, "reporter"), true);
    await state(menu(page, "tradehunter"), true);
  });

  await t.test("hash highlighting preserves defaults, collapsed groups and explicit choices", async (t) => {
    const page = await open(t);
    assert.equal(await menu(page, "overview").count(), 0);
    assert.equal(await menu(page, "widgets").count(), 0);
    await page.evaluate(() => { location.hash = "technical-analysis"; });
    await page.waitForFunction(() => document.querySelector('.sidebar [data-nav-href="/overview-v1"]').classList.contains("active"));
    await page.goto(base + "/heatmaps.html#market-heatmap");
    await state(menu(page, "tradehunter"), true);
    await state(menu(page, "screeners"), true);
    await state(menu(page, "heatmaps"), true);
    await toggle(menu(page, "heatmaps")).click();
    await page.evaluate(() => { location.hash = "crypto-heatmap"; });
    await page.waitForFunction(() => document.querySelector('.sidebar [data-nav-href="/heatmaps.html#crypto-heatmap"]').hasAttribute("aria-current"));
    await state(menu(page, "heatmaps"), false);
    await page.goto(base + "/briefings/crypto");
    await state(menu(page, "reporter"), true);
    await state(menu(page, "markets"), false);
    await page.evaluate(() => { location.hash = "test"; });
    await page.waitForFunction(() => document.querySelector('.cmd-sidebar [data-nav-href="/briefings/crypto"]').classList.contains("active"));
    await state(menu(page, "markets"), false);
  });

  await t.test("late account responses preserve menu nodes, focus, scroll and storage-free choices", async (t) => {
    let release;
    const session = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const page = await open(t, { session, blockedStorage: true });
    await toggle(menu(page, "reporter")).click();
    await page.evaluate(() => {
      window.savedToggle = document.activeElement;
      window.savedNav = document.querySelector(".nav-primary");
      document.querySelector(".sidebar").scrollTop = 160;
      window.savedScroll = document.querySelector(".sidebar").scrollTop;
    });
    release();
    await page.waitForFunction(() => !!document.querySelector(".sidebar .account-form"));
    assert.equal(await page.evaluate(() => savedToggle === document.activeElement && savedNav === document.querySelector(".nav-primary")), true);
    assert.equal(await page.evaluate(() => savedScroll === document.querySelector(".sidebar").scrollTop), true);
    await state(menu(page, "reporter"), true);
    await state(menu(page, "reporter", ".mob-drawer"), true);
  });

  await t.test("desktop and mobile choices stay synchronized in both shells", async (t) => {
    const page = await open(t);
    for (const [url, drawer, sidebar] of [["/overview-v1", ".mob-drawer", ".sidebar"], ["/terminal-suite.html", ".cmd-drawer", ".cmd-sidebar"]]) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(base + url);
      await toggle(menu(page, "my_trades", sidebar)).click();
      await page.setViewportSize({ width: 390, height: 850 });
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
      await state(menu(page, "my_trades", drawer), true);
      await toggle(menu(page, "my_trades", drawer)).click();
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.body.style.overflow), "");
      await page.setViewportSize({ width: 1440, height: 900 });
      await state(menu(page, "my_trades", sidebar), false);
    }
  });

  await t.test("every theme and accent has matching sidebar and drawer styles", async (t) => {
    const page = await open(t);
    async function styles(root) {
      return page.locator(root).evaluate((node) => {
        const take = (el, keys) => Object.fromEntries(keys.map((key) => [key, getComputedStyle(el)[key]]));
        const item = node.querySelector('[data-nav-href="/terminal-suite.html"]');
        const group = node.querySelector('[data-dropdown-key="sidebar_dropdown_my_trades"] > button');
        return {
          shell: take(node, ["backgroundColor", "borderRightColor", "padding", "gap", "fontFamily"]),
          item: take(item, ["color", "fontSize", "fontWeight", "lineHeight", "padding", "borderRadius"]),
          toggle: take(group, ["fontSize", "fontWeight", "lineHeight", "padding"]),
        };
      });
    }
    for (const theme of Object.keys(THEMES)) {
      await page.goto(base + "/overview-v1");
      await page.evaluate((theme) => { AppSettings.applyTheme(theme); AppSettings.applyAccent("purple"); }, theme);
      const overview = await styles(".sidebar");
      const drawer = await styles(".mob-drawer");
      // The link is active on Terminal; compare typography independently of
      // the deliberate active weight/color and compare its active style below.
      await page.goto(base + "/terminal-suite.html");
      const terminal = await styles(".cmd-sidebar");
      const terminalDrawer = await styles(".cmd-drawer");
      for (const [first, second] of [[overview, terminal], [drawer, terminalDrawer]]) {
        assert.deepEqual(first.shell, second.shell, `${theme} shell`);
        assert.deepEqual(first.toggle, second.toggle, `${theme} toggle`);
        for (const key of ["fontSize", "lineHeight", "padding"]) assert.equal(first.item[key], second.item[key], `${theme} item ${key}`);
      }
      assert.equal(await page.evaluate(() => AppSettings.getTheme()), theme);
      assert.equal(await page.evaluate(() => AppSettings.getAccent()), "purple");
      const active = await page.locator('.cmd-sidebar [data-nav-href="/terminal-suite.html"]').evaluate((node) => getComputedStyle(node).color);
      await page.goto(base + "/overview-v1");
      const overviewActive = await page.locator('.sidebar [data-nav-href="/overview-v1"]').evaluate((node) => getComputedStyle(node).color);
      assert.equal(overviewActive, active, `${theme} selected accent`);
    }
  });

  await t.test("both pages switch to mobile navigation at the same width", async (t) => {
    const page = await open(t);
    for (const width of [390, 768, 1024, 1025, 1100, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [url, root] of [["/overview-v1", ".sidebar"], ["/terminal-suite.html", ".cmd-sidebar"]]) {
        await page.goto(base + url);
        assert.equal(await page.locator(root).isVisible(), width > 1024, `${url} at ${width}px`);
        assert.equal(await page.getByRole("button", { name: "Open navigation", exact: true }).isVisible(), width <= 1024);
      }
    }
  });

  await t.test("the logo loads in both shells and mobile navigation", async (t) => {
    const page = await open(t);
    for (const url of ["/overview-v1", "/terminal-suite.html", "/"]) {
      await page.goto(base + url);
      const marks = page.locator(".market-brand-image");
      assert.equal(await marks.count(), 3);
      await page.waitForFunction(() => Array.from(document.querySelectorAll(".market-brand-image")).every((image) => image.complete && image.naturalWidth > 0));
      for (const mark of await marks.all()) assert.equal(await mark.getAttribute("alt"), "");
      if (url === "/" && process.env.SIDEBAR_SCREENSHOT_DIR) {
        await page.screenshot({ path: path.join(process.env.SIDEBAR_SCREENSHOT_DIR, "market-overview-header.png"), clip: { x: 0, y: 0, width: 1440, height: 270 } });
      }
      await page.setViewportSize({ width: 390, height: 850 });
      assert.equal(await page.locator(".aurora-brand--mobile .market-brand-image").isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (url === "/" && process.env.SIDEBAR_SCREENSHOT_DIR) {
        await page.screenshot({ path: path.join(process.env.SIDEBAR_SCREENSHOT_DIR, "market-overview-mobile.png"), clip: { x: 0, y: 0, width: 390, height: 500 } });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  });

  await t.test("motion can be paused, survives navigation, and follows reduced-motion changes", async (t) => {
    const page = await open(t);
    await page.goto(base + "/");
    const button = page.locator("#market-motion-toggle");
    const brand = page.locator(".cmd-sidebar .aurora-brand");
    await brand.hover({ position: { x: 25, y: 25 } });
    await page.waitForFunction(() => !!document.querySelector(".cmd-sidebar .aurora-brand").style.getPropertyValue("--brand-x"));
    await page.mouse.move(1200, 400);
    assert.equal(await brand.evaluate((node) => node.style.getPropertyValue("--brand-x")), "");
    await button.click();
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator(".market-brand-orbit").first().evaluate((node) => getComputedStyle(node).animationPlayState), "paused");
    await page.reload();
    assert.equal(await button.textContent(), "Motion off");
    await brand.hover();
    assert.equal(await brand.evaluate((node) => node.style.getPropertyValue("--brand-x")), "");
    await button.click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => document.getElementById("market-motion-toggle").disabled);
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    assert.equal(await brand.evaluate((node) => getComputedStyle(node.querySelector(".market-brand-orbit")).animationName), "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForFunction(() => !document.getElementById("market-motion-toggle").disabled);
    assert.equal(await button.getAttribute("aria-pressed"), "true");
  });
});
