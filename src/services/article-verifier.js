"use strict";

/**
 * Article verifier for the FarmBot Top 10.
 *
 * Fetches one news article and reads what FarmBot needs as evidence: the
 * final URL, the headline, when it was published, a short body excerpt and
 * the article's own preview image. The URLs come from a model's web search,
 * so the fetch is deliberately narrow:
 *
 *   - https only, no credentials, default port;
 *   - every connection (including each redirect hop) is checked at DNS
 *     lookup time and refused for loopback, private, link-local, CGNAT,
 *     multicast and other non-public addresses;
 *   - at most 4 redirects, a hard timeout and a body size cap.
 *
 * Nothing is bypassed: a login wall, CAPTCHA or an undated page simply fails
 * verification and the story is skipped.
 */

const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");
const zlib = require("node:zlib");

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 4;
const USER_AGENT = "Mozilla/5.0 (compatible; MarketDashboardTop10/1.0; +article-verification)";

function verifyError(message) {
  const err = new Error(message);
  err.verification = true;
  return err;
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

const BLOCKED_V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

/** True for any address that is not a routable public unicast address. */
function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4ToInt(address);
    return BLOCKED_V4.some(({ base, mask }) => ((value & mask) >>> 0) === ((base & mask) >>> 0));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower === "::" || lower === "::1") return true;
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast,
    // 2001:db8::/32 documentation, 64:ff9b::/96 NAT64 (could reach v4 private).
    return /^(f[cd]|fe[89ab]|ff)/.test(lower) || lower.startsWith("2001:db8") || lower.startsWith("64:ff9b");
  }
  return true;
}

/** dns.lookup that refuses to hand a non-public address to the socket. */
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (!list.length || list.some((entry) => isBlockedAddress(entry.address))) {
      return callback(verifyError(`Refused to connect to a non-public address for ${hostname}`));
    }
    if (options && options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

function checkUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw verifyError("Not a valid URL");
  }
  if (url.protocol !== "https:") throw verifyError("Only https articles are accepted");
  if (url.username || url.password) throw verifyError("URLs with credentials are refused");
  if (url.port && url.port !== "443") throw verifyError("Non-standard ports are refused");
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, ""))) throw verifyError("Bare IP addresses are refused");
  return url;
}

function requestOnce(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET",
      lookup: guardedLookup,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en",
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        resolve({ redirect: new URL(res.headers.location, url).toString(), status });
        return;
      }
      const type = String(res.headers["content-type"] || "");
      if (status !== 200) {
        res.resume();
        reject(verifyError(`Article returned HTTP ${status}`));
        return;
      }
      if (type && !/html|xml/i.test(type)) {
        res.resume();
        reject(verifyError(`Article is ${type.split(";")[0]}, not a web page`));
        return;
      }
      const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy();
          reject(verifyError("Article page is too large"));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8"), status }));
      stream.on("error", (err) => reject(verifyError(`Could not read the article (${err.message})`)));
    });
    req.on("timeout", () => req.destroy(verifyError("Article fetch timed out")));
    req.on("error", (err) => reject(err.verification ? err : verifyError(`Could not reach the article (${err.code || err.message})`)));
    req.end();
  });
}

async function fetchArticleHtml(value, { timeoutMs = TIMEOUT_MS } = {}) {
  let current = checkUrl(value).toString();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await requestOnce(current, timeoutMs);
    if (!result.redirect) return { finalUrl: current, html: result.body };
    current = checkUrl(result.redirect).toString();
  }
  throw verifyError("Too many redirects");
}

// ── HTML reading ─────────────────────────────────────────────────────────

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decodeEntities(text) {
  const code = (value) => {
    try { return String.fromCodePoint(value); } catch { return ""; }
  };
  return String(text || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => code(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => code(Number(dec)))
    .replace(/&([a-z0-9#]+);/gi, (match, name) => (name.toLowerCase() in ENTITIES ? ENTITIES[name.toLowerCase()] : match));
}

function stripTags(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attr(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? decodeEntities(match[2] ?? match[3] ?? match[4] ?? "").trim() : "";
}

function metaMap(html) {
  const map = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, "property") || attr(tag, "name") || attr(tag, "itemprop")).toLowerCase();
    const content = attr(tag, "content");
    if (key && content && !(key in map)) map[key] = content;
  }
  return map;
}

function jsonLdObjects(html) {
  const out = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    out.push(node);
    if (node["@graph"]) visit(node["@graph"]);
  };
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    try { visit(JSON.parse(match[1].trim())); } catch { /* malformed block: ignore */ }
  }
  return out;
}

function firstDate(...values) {
  for (const value of values) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

function absoluteHttps(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Pull the evidence FarmBot needs out of an article page. */
function readArticle(html, finalUrl) {
  const meta = metaMap(html);
  const ld = jsonLdObjects(html);
  const article = ld.find((node) => /Article|Posting|Report/i.test([].concat(node["@type"] || []).join(" "))) || {};
  const ldImage = [].concat(article.image || []).map((img) => (typeof img === "string" ? img : img && img.url)).find(Boolean);

  const canonicalTag = (html.match(/<link\b[^>]*rel\s*=\s*["']?canonical["']?[^>]*>/i) || [])[0];
  const canonical = absoluteHttps(canonicalTag && attr(canonicalTag, "href"), finalUrl);
  const sameSite = canonical && new URL(canonical).hostname.replace(/^www\./, "") === new URL(finalUrl).hostname.replace(/^www\./, "");

  const titleTag = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  const title = meta["og:title"] || meta["twitter:title"] || article.headline || stripTags(titleTag);
  const timeTag = (html.match(/<time\b[^>]*datetime\s*=\s*[^>]*>/i) || [])[0];
  const publishedAt = firstDate(
    meta["article:published_time"], meta["og:published_time"], meta["datepublished"], meta["publishdate"],
    meta["pubdate"], meta["date"], meta["dc.date"], meta["parsely-pub-date"], meta["sailthru.date"],
    article.datePublished, article.dateCreated, timeTag && attr(timeTag, "datetime"),
  );
  const image = absoluteHttps(meta["og:image:secure_url"] || meta["og:image"] || meta["twitter:image"] || meta["twitter:image:src"] || ldImage, finalUrl);
  const description = meta["og:description"] || meta["description"] || article.description || "";

  const body = (html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ").match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [])
    .map(stripTags)
    .filter((text) => text.length >= 60);
  const bodyText = body.join(" ");
  const siteName = meta["og:site_name"] || (article.publisher && article.publisher.name) || null;

  return {
    canonicalUrl: sameSite ? canonical : finalUrl,
    title: stripTags(title).slice(0, 300),
    publishedAt,
    imageUrl: image,
    siteName: siteName ? stripTags(siteName).slice(0, 80) : null,
    description: stripTags(description).slice(0, 500),
    excerpt: bodyText.slice(0, 600),
    bodyChars: bodyText.length,
  };
}

/**
 * Fetch and read one article. Throws a verification error (err.verification)
 * with a plain reason when the page can't serve as evidence.
 */
async function verifyArticle(url, { fetchHtml = fetchArticleHtml, now = new Date() } = {}) {
  const { finalUrl, html } = await fetchHtml(url);
  const info = readArticle(html, finalUrl);
  if (/captcha|are you a robot|access denied|subscribe to continue|sign in to continue/i.test(`${info.title} ${info.excerpt.slice(0, 200)}`) && info.bodyChars < 600) {
    throw verifyError("Article is behind a login, paywall or bot check");
  }
  if (info.bodyChars < 200 && info.description.length < 80) throw verifyError("Article body could not be read");
  if (!info.title) throw verifyError("Article has no headline");
  if (!info.publishedAt) throw verifyError("Article has no publish date");
  const ageMs = now.getTime() - Date.parse(info.publishedAt);
  if (ageMs < -60 * 1000) throw verifyError("Article publish date is in the future");
  if (ageMs > 48 * 3600 * 1000) throw verifyError("Article is older than 48 hours");
  if (!info.imageUrl) throw verifyError("Article has no preview image");
  return { ...info, ageMs };
}

module.exports = { verifyArticle, readArticle, fetchArticleHtml, isBlockedAddress, checkUrl };
