const path = require("path");

function resolveDataDir(value = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  const raw = String(value || "").trim();
  if (!raw) return path.join(process.cwd(), "data");
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

module.exports = { resolveDataDir };
