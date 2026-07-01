require("dotenv").config();

const { createApp } = require("./src/app");
const { config } = require("./src/config/env");
const { resolveDataDir } = require("./src/utils/data-dir");

const app = createApp();

app.listen(config.port, () => {
  console.log(`Market Intel running on port ${config.port}`);
  console.log(`Persistent data directory: ${resolveDataDir()}`);
});
