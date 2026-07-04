// Telegram sends this as a photo caption (1024-char hard cap), so the model
// needs to self-limit rather than relying on a downstream truncate() to chop
// it — a hard mid-sentence cut reads as a broken message. ~120 words keeps
// comfortably clear of that cap even after markdown is converted to HTML.
const ANALYSIS_PROMPT =
  "Analyze this chart for a Telegram broadcast in 120 words max. Use short bullets only: Trend, Levels, Momentum, Risk, Final call. End exactly BUY, SELL, or HOLD. Be direct and avoid long explanations.";
const MAX_ANALYSIS_WORDS = 150;

// The last generated result for each preset/layout is kept in the persistent
// cache indefinitely (until a fresh generation overwrites it), so it survives
// page refreshes and server restarts. `ttlMs` only controls how long a
// generation is considered "fresh enough" to skip re-generating — it does not
// expire the display copy.
const PERSIST_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

function extractVerdict(text) {
  if (!text) return null;
  const matches = text.match(/\b(BUY|SELL|HOLD)\b/gi);
  if (!matches || !matches.length) return null;
  return matches[matches.length - 1].toUpperCase();
}

function truncateWords(text, maxWords) {
  const source = String(text || "");
  if (maxWords <= 0) return "";
  let count = 0;
  let end = 0;
  const wordPattern = /\S+/g;
  let match;
  while ((match = wordPattern.exec(source))) {
    count += 1;
    if (count === maxWords) {
      end = wordPattern.lastIndex;
      break;
    }
  }
  if (count < maxWords || !wordPattern.exec(source)) return source;
  return source.slice(0, end).trimEnd();
}

module.exports = { ANALYSIS_PROMPT, MAX_ANALYSIS_WORDS, PERSIST_TTL_MS, extractVerdict, truncateWords };
