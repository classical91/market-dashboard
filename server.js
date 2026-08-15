require("dotenv").config();

const { createApp } = require("./src/app");
const { config } = require("./src/config/env");
const { resolveDataDir } = require("./src/utils/data-dir");

const app = createApp();

app.listen(config.port, () => {
  console.log(`Market Intel running on port ${config.port}`);
  console.log(`Persistent data directory: ${resolveDataDir()}`);
  if (config.signalBot.enabled) {
    app.locals.signalBot.start();
  } else {
    console.log("[SignalBot] Disabled via SIGNAL_BOT_ENABLED=false");
  }
  // Same contract as the signal bot: timers are started here, never in
  // createApp(), so tests and the build check don't leave a loop running.
  // start() is a no-op that logs when ENABLE_LIVE_SCANNER is not "true"; a
  // null service means the config itself failed to load.
  if (app.locals.liveScanner) {
    app.locals.liveScanner.start();
  } else {
    console.log("[LiveScanner] Not configured — check LIVE_SCANNER_* settings");
  }
  if (app.locals.liveResearch) app.locals.liveResearch.start();
});
