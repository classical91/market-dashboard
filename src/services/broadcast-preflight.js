"use strict";

/**
 * Broadcast ledger preflight.
 *
 * docs/production-verification.md lists a set of checks that "cannot be
 * established from the repository" — they depend on how the live service is
 * configured. Most of them can be established by the live service itself,
 * which is what this does: it answers the environment, persistence and
 * routing half of that checklist in one request, from inside the running
 * process where the real values are.
 *
 * What it deliberately does NOT do is send anything. Delivery, the guard
 * rails and the retry path all put real messages in real rooms, so those stay
 * a human decision.
 *
 * No secret ever leaves here. Tokens and keys are reported as set/unset and
 * compared to each other by digest, never echoed.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";

/** Compare two secrets without revealing either. */
function sameSecret(a, b) {
  if (!a || !b) return false;
  const digest = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
  return digest(a) === digest(b);
}

function check(id, status, title, detail, extra = {}) {
  return { id, status, title, detail, ...extra };
}

/**
 * Is this directory plausibly a mounted volume rather than container storage?
 *
 * There is no reliable way to prove a mount from inside the process, so this
 * reports what it can see and says which it is: RAILWAY_VOLUME_MOUNT_PATH is
 * proof, a path under the app root is proof of the opposite, and anything else
 * is reported as unconfirmed rather than guessed either way.
 */
function classifyDataDir(dataDir, env) {
  const mountPath = String(env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  const defaultDir = path.join(process.cwd(), "data");

  if (mountPath && path.resolve(dataDir) === path.resolve(mountPath)) {
    return { status: PASS, detail: `Matches RAILWAY_VOLUME_MOUNT_PATH (${mountPath}) — receipts survive deploys.` };
  }
  if (!String(env.DATA_DIR || "").trim() && !mountPath) {
    return {
      status: FAIL,
      detail:
        `Neither DATA_DIR nor RAILWAY_VOLUME_MOUNT_PATH is set, so the ledger is writing to ${defaultDir} ` +
        "inside the container. Every deploy wipes it. Set DATA_DIR to the mounted volume, usually /app/data.",
    };
  }
  if (path.resolve(dataDir) === path.resolve(defaultDir)) {
    return {
      status: FAIL,
      detail: `Resolves to ${defaultDir}, the in-container default. Every deploy wipes the ledger.`,
    };
  }
  if (mountPath) {
    return {
      status: WARN,
      detail:
        `DATA_DIR (${dataDir}) is not the same path as RAILWAY_VOLUME_MOUNT_PATH (${mountPath}). ` +
        "That can be deliberate — a subdirectory of the mount is fine — but confirm it is under the mount.",
    };
  }
  return {
    status: WARN,
    detail:
      `DATA_DIR is ${dataDir}. RAILWAY_VOLUME_MOUNT_PATH is not set, so this cannot be confirmed as a mounted ` +
      "volume from inside the process. Check the Railway volume is attached and mounted here.",
  };
}

/** Prove the directory is actually writable, rather than assuming it. */
function probeWritable(dataDir) {
  const probe = path.join(dataDir, `.preflight-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return { status: PASS, detail: "Wrote and removed a probe file — the ledger can persist here." };
  } catch (err) {
    return { status: FAIL, detail: `Cannot write to ${dataDir}: ${err.message}. No receipt can be stored.` };
  }
}

/**
 * Build the report.
 *
 * `env` is injected so this is testable without mutating process.env, and so
 * the checks read the same values the app booted with.
 */
function buildPreflight({
  config,
  broadcastLedgerStore,
  broadcastIngestService,
  telegramService,
  newsTelegramService,
  destinationsForNewsType,
  env = process.env,
  bootedAt,
} = {}) {
  const checks = [];
  const ledger = (config && config.broadcastLedger) || {};
  const admin = (config && config.admin) || {};
  const telegram = (config && config.telegram) || {};
  const newsTelegram = (config && config.newsTelegram) || {};

  /* ── environment and persistence ── */

  const dataDir = (broadcastLedgerStore && broadcastLedgerStore.dataDir) || "";
  const dirClass = classifyDataDir(dataDir, env);
  checks.push(
    check("data-dir", dirClass.status, "Ledger data directory", dirClass.detail, { value: dataDir }),
  );
  const writable = probeWritable(dataDir);
  checks.push(check("data-dir-writable", writable.status, "Data directory is writable", writable.detail));

  const ledgerKey = ledger.apiKey || "";
  const adminKey = admin.apiKey || "";
  if (!ledgerKey && !adminKey) {
    checks.push(
      check("ledger-key", FAIL, "Ledger API key",
        "Neither BROADCAST_LEDGER_API_KEY nor ADMIN_API_KEY is set, so every ledger endpoint returns 503."),
    );
  } else if (!ledgerKey) {
    checks.push(
      check("ledger-key", WARN, "Ledger API key",
        "BROADCAST_LEDGER_API_KEY is unset and the endpoints are falling back to ADMIN_API_KEY. That fallback " +
        "exists for continuity, not as the target state — it puts an admin credential on the phone."),
    );
  } else if (sameSecret(ledgerKey, adminKey)) {
    checks.push(
      check("ledger-key", WARN, "Ledger API key",
        "BROADCAST_LEDGER_API_KEY is set to the same value as ADMIN_API_KEY, which defeats the separation. " +
        "Generate a distinct key: openssl rand -hex 32"),
    );
  } else {
    checks.push(check("ledger-key", PASS, "Ledger API key", "Set, and distinct from ADMIN_API_KEY."));
  }

  /* ── the bot that actually sends news ── */

  const newsConfigured = Boolean(newsTelegramService && newsTelegramService.configured);
  checks.push(
    check(
      "news-telegram",
      newsConfigured ? PASS : FAIL,
      "News Telegram bot",
      newsConfigured
        ? `NEWS_TELEGRAM_BOT_TOKEN set with ${(newsTelegram.chatIds || []).length} configured chat target(s). ` +
          "This is the bot /broadcast and its retry send through."
        : "NEWS_TELEGRAM_BOT_TOKEN / NEWS_TELEGRAM_CHAT_IDS are not both set. /broadcast cannot deliver.",
      { chatIds: newsTelegram.chatIds || [] },
    ),
  );

  const notificationTargets = ledger.notificationTargets || [];
  checks.push(
    check(
      "notification-targets",
      notificationTargets.length ? PASS : WARN,
      "Alert destination",
      notificationTargets.length
        ? "Set. Confirm these point at a PRIVATE chat/topic — blocked, failed and missing-category alerts go here."
        : "BROADCAST_LEDGER_NOTIFICATION_CHAT_IDS is unset, so operational alerts silently do not send.",
      { value: notificationTargets },
    ),
  );

  /* ── the 409 case: two consumers on one token ── */

  const watch = broadcastIngestService ? broadcastIngestService.describe() : null;
  const sharedToken = sameSecret(telegram.botToken, newsTelegram.botToken);
  if (watch && watch.enabled && sharedToken) {
    checks.push(
      check("bot-token-separation", FAIL, "Bot token separation",
        "The channel watch polls the same bot token the news sender uses. Telegram allows one getUpdates " +
        "consumer per token, so these fight and one loses with 409. Give the dashboard its own bot."),
    );
  } else if (sharedToken) {
    checks.push(
      check("bot-token-separation", WARN, "Bot token separation",
        "TELEGRAM_BOT_TOKEN and NEWS_TELEGRAM_BOT_TOKEN are the same bot. Harmless while the watch is off; " +
        "turning it on would cause a 409 conflict."),
    );
  } else {
    checks.push(
      check("bot-token-separation", PASS, "Bot token separation",
        "The watch bot and the news bot are different tokens, so neither competes for updates."),
    );
  }

  /* ── what the watch actually covers ── */

  if (!watch || !watch.enabled) {
    checks.push(
      check("channel-watch", WARN, "Channel watch",
        "Off. Nothing is audited independently — every path must record itself. That is a valid choice, but it " +
        "means an unrecorded post leaves no trace at all.",
        { watch }),
    );
  } else if (watch.conflict) {
    checks.push(
      check("channel-watch", FAIL, "Channel watch",
        "Telegram is returning 409 Conflict — another process is consuming this bot's updates.", { watch }),
    );
  } else if (!watch.watchedTargets || !watch.watchedTargets.length) {
    checks.push(
      check("channel-watch", WARN, "Channel watch",
        "Enabled but watching no destinations, so it can never record anything.", { watch }),
    );
  } else {
    // The asymmetry the verification doc calls out: the watch polls the
    // dashboard bot, while news goes out through the news bot. Say plainly
    // whether the watched rooms overlap the rooms news actually lands in.
    const newsRooms = new Set((newsTelegram.chatIds || []).map((entry) => String(entry).split(":")[0]));
    const overlap = watch.watchedTargets.filter((target) => newsRooms.has(String(target.chatId)));
    checks.push(
      check(
        "channel-watch",
        overlap.length ? PASS : WARN,
        "Channel watch",
        overlap.length
          ? `Watching ${watch.watchedTargets.length} destination(s), ${overlap.length} of which overlap the news ` +
            "rooms. Note it still cannot see this bot's own posts — that is a Telegram protocol limit."
          : `Watching ${watch.watchedTargets.length} destination(s), none of which are rooms news is sent to. ` +
            "The watch is running but audits nothing relevant to the ledger.",
        { watch },
      ),
    );
  }

  /* ── where categorized news is routed ── */

  if (typeof destinationsForNewsType === "function") {
    const settings = broadcastLedgerStore ? broadcastLedgerStore.getSettings() : {};
    const routing = {};
    ["Stock", "Crypto", "Economics", "Geopolitics"].forEach((newsType) => {
      routing[newsType] = destinationsForNewsType(newsType, settings) || "falls back to configured chat list";
    });
    const locked = Object.values(routing).filter((value) => Array.isArray(value)).length;
    checks.push(
      check(
        "news-routing",
        locked ? PASS : WARN,
        "Category routing",
        locked
          ? "These are the exact destinations each category is locked to. The repository proves the code routes " +
            "here and nowhere else; only you can confirm the ids and topics are the rooms you mean."
          : "Category routing is disabled in Ledger Settings, so every category follows the configured chat list.",
        { routing },
      ),
    );
  }

  /* ── evidence of persistence across deploys ── */

  if (broadcastLedgerStore) {
    const count = broadcastLedgerStore.count();
    const [newest] = broadcastLedgerStore.list({ limit: 1 });
    const oldest = broadcastLedgerStore.list({ limit: 500 }).slice(-1)[0];
    checks.push(
      check(
        "persistence-evidence",
        count ? PASS : WARN,
        "Stored receipts",
        count
          ? `${count} receipt(s) on disk. If the oldest predates your last deploy, persistence is proven.`
          : "No receipts stored yet, so persistence across deploys is still unproven.",
        {
          count,
          oldestAt: oldest ? oldest.createdAt : null,
          newestAt: newest ? newest.createdAt : null,
        },
      ),
    );
  }

  /* ── the one thing a process cannot check about itself ── */

  checks.push(
    check(
      "replica-count",
      WARN,
      "Replica count",
      "A process cannot see its siblings. Confirm in Railway that this service runs a SINGLE replica — the store " +
      "is a lock-guarded whole-file writer, correct across processes sharing one mounted volume, but not across " +
      "separate volumes. This instance booted at " + (bootedAt || "unknown") + ".",
      { pid: process.pid, bootedAt: bootedAt || null },
    ),
  );

  const summary = checks.reduce(
    (acc, item) => ({ ...acc, [item.status]: (acc[item.status] || 0) + 1 }),
    { pass: 0, warn: 0, fail: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    summary,
    // A single line to read first.
    //
    // Warnings deliberately do not get their own verdict: replica-count can
    // never be anything but a warning, because a process cannot see its
    // siblings. Branching on the warning count therefore made the "delivery is
    // still unproven" line unreachable — which is the one thing this report
    // must always say, since it never sends anything.
    verdict: summary.fail
      ? `Not ready — ${summary.fail} failing check(s) below. Fix these before trusting the ledger.`
      : `Configuration checks pass${summary.warn ? ` (${summary.warn} advisory)` : ""}. ` +
        "Delivery still needs one real broadcast to prove — this report never sends anything.",
    checks,
    // Named rather than implied: these need a human and a real message.
    requiresHuman: [
      "Send one real broadcast and confirm the receipt carries a true Telegram message id.",
      "Trip the guard rails: a repeat category inside its window, and a story with no category.",
      "Force a delivery failure against a bad chat id, then retry it from the ledger page.",
      "Redeploy and confirm pre-deploy receipts are still listed.",
      "Confirm the iOS Shortcut posts to /api/broadcast-ledger/broadcast, not api.telegram.org.",
    ],
  };
}

module.exports = { buildPreflight, classifyDataDir, sameSecret, PASS, WARN, FAIL };
