function createHealthRouter({ onchainService, etherscanService, covalentService, dataSource }) {
  const router = require("express").Router();

  router.get("/", (req, res) => {
    const cacheStats = onchainService.getCacheStats();

    res.json({
      status: "ok",
      etherscanKeySet: etherscanService.isConfigured(),
      covalentKeySet: covalentService.isConfigured(),
      dataSource,
      cacheSize: cacheStats.entries,
    });
  });

  return router;
}

module.exports = { createHealthRouter };
