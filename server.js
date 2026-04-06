require("dotenv").config();

const { createApp } = require("./src/app");
const { config } = require("./src/config/env");

const app = createApp();

app.listen(config.port, () => {
  console.log(`Market Intel running on port ${config.port}`);
});
