"use strict";

/**
 * The Telegram destinations the X Intelligence broadcast button offers.
 *
 * The dashboard already knows where it sends: TELEGRAM_CHAT_IDS is the list
 * every existing broadcast path falls back to. What it did not know is what
 * any of those destinations are *called*, and a picker that offers
 * "-1001841650798:6297" cannot be used to choose deliberately — which is the
 * whole point of choosing per post.
 *
 * So X_BROADCAST_CHANNELS is a labelled superset of the same information:
 *
 *   X_BROADCAST_CHANNELS=[{"label":"Market Desk","chatId":"-1001841650798","threadId":"6297"}]
 *
 * When it is unset the channels are derived from TELEGRAM_CHAT_IDS, so an
 * existing deploy gets a working picker with no new configuration — the labels
 * are just the raw ids until someone names them.
 *
 * Ids are derived from the destination, not from its position in the list or
 * its label: a browser remembers the channels it last broadcast to, and that
 * selection has to survive both a relabel and a reorder. Renaming "Market
 * Desk" must not silently redirect the next broadcast to a different room.
 */

const MAX_CHANNELS = 25;
const MAX_LABEL_LEN = 60;

function clampLabel(value) {
  return String(value == null ? "" : value).trim().replace(/\s+/g, " ").slice(0, MAX_LABEL_LEN);
}

function clampId(value) {
  return String(value == null ? "" : value).trim();
}

/** A stable id for a destination: the chat and topic it actually names. */
function channelId(chatId, threadId) {
  const chat = String(chatId).replace(/[^A-Za-z0-9_@-]+/g, "");
  return `tg-${chat}${threadId ? `-t${threadId}` : ""}`;
}

/** The readable fallback for a destination nobody has named yet. */
function defaultLabel(chatId, threadId) {
  return threadId ? `Chat ${chatId} · topic ${threadId}` : `Chat ${chatId}`;
}

function toChannel(chatId, threadId, label) {
  const chat = clampId(chatId);
  if (!chat) return null;
  const thread = clampId(threadId);
  // A thread id is a Telegram message id — anything else would be sent as
  // message_thread_id and rejected at the API, so it is dropped here instead.
  const topic = /^\d+$/.test(thread) ? thread : "";
  return {
    id: channelId(chat, topic),
    label: clampLabel(label) || defaultLabel(chat, topic),
    chatId: chat,
    threadId: topic || null,
  };
}

/**
 * One entry of TELEGRAM_CHAT_IDS: "chatId" or "chatId:threadId", matching
 * normalizeTarget() in telegram.js. Kept as its own function because the two
 * formats meet here and nowhere else.
 */
function fromChatIdEntry(entry) {
  if (entry && typeof entry === "object") return toChannel(entry.chatId, entry.threadId, entry.label);
  const [chatId, threadId] = String(entry || "").split(":").map((part) => part.trim());
  return toChannel(chatId, threadId, "");
}

/**
 * Parse X_BROADCAST_CHANNELS. Returns null — not an empty list — when the
 * variable is unset or unparseable, so the caller can tell "no channels
 * configured here, use the fallback" from "explicitly configured as none".
 */
function parseChannelsJson(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed
    .map((entry) => (entry && typeof entry === "object" ? toChannel(entry.chatId, entry.threadId, entry.label) : fromChatIdEntry(entry)))
    .filter(Boolean);
}

function dedupe(channels) {
  const seen = new Set();
  const result = [];
  for (const channel of channels) {
    if (seen.has(channel.id)) continue;
    seen.add(channel.id);
    result.push(channel);
    if (result.length >= MAX_CHANNELS) break;
  }
  return result;
}

/**
 * The channel list the picker renders, newest configuration winning:
 * X_BROADCAST_CHANNELS when it parses, the plain chat-id list otherwise.
 */
function resolveBroadcastChannels({ channelsJson = "", chatIds = [] } = {}) {
  const labelled = parseChannelsJson(channelsJson);
  const source = labelled && labelled.length ? labelled : (chatIds || []).map(fromChatIdEntry).filter(Boolean);
  return dedupe(source);
}

/**
 * Turn the ids a broadcast request selected into Telegram targets.
 *
 * An id that names no configured channel is refused rather than skipped: a
 * request asking for three rooms and silently reaching two is the failure
 * mode this whole feature exists to avoid.
 */
function selectTargets(channels, ids) {
  const wanted = Array.isArray(ids) ? ids.map(clampId).filter(Boolean) : [];
  if (!wanted.length) return { ok: false, reason: "Select at least one channel to broadcast to." };

  const byId = new Map((channels || []).map((channel) => [channel.id, channel]));
  const unknown = wanted.filter((id) => !byId.has(id));
  if (unknown.length) return { ok: false, reason: `Unknown broadcast channel: ${unknown[0]}` };

  const selected = [...new Set(wanted)].map((id) => byId.get(id));
  return {
    ok: true,
    channels: selected,
    targets: selected.map((channel) => (
      channel.threadId ? { chatId: channel.chatId, threadId: channel.threadId } : { chatId: channel.chatId }
    )),
  };
}

module.exports = {
  MAX_CHANNELS,
  channelId,
  defaultLabel,
  parseChannelsJson,
  resolveBroadcastChannels,
  selectTargets,
};
