const express = require("express");
const path = require("path");

const { config } = require("./config/env");
const { createHealthRouter } = require("./routes/health");
const { createOnchainRouter } = require("./routes/onchain");
const { MemoryCache } = require("./services/cache");
const { CovalentService } = require("./services/covalent");
const { DefiLlamaService } = require("./services/defillama");
const { EtherscanService } = require("./services/etherscan");
const { OnchainService } = require("./services/onchain");

function createApp() {
  const app = express();
  const cache = new MemoryCache();
  const defillamaService = new DefiLlamaService(config.defillama);
  const etherscanService = new EtherscanService(config.etherscan);
  const covalentService = new CovalentService(config.covalent);
  const onchainService = new OnchainService({
    cache,
    config: config.onchain,
    defillamaService,
    etherscanService,
    covalentService,
  });

  app.disable("x-powered-by");
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.use(
    "/api/health",
    createHealthRouter({
      onchainService,
      etherscanService,
      covalentService,
      dataSource: config.onchain.dataSourceLabel,
    }),
  );
  app.use("/api/onchain", createOnchainRouter({ onchainService }));

  app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, req, res, next) => {
    const status = err.statusCode || err.status || 500;
    const message = err.expose || status < 500 ? err.message : "Internal server error";

    if (status >= 500) {
      console.error(err);
    }

    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = { createApp };
