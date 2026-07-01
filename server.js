require("dotenv").config();

const path = require("path");
const { createApp } = require("./src/app");
const { config } = require("./src/config/env");

const app = createApp();

app.listen(config.port, () => {
  console.log(`Market Intel running on port ${config.port}`);
  console.log(`Persistent data directory: ${path.join(process.cwd(), "data")}`);
});
