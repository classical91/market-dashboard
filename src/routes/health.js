const { isAdminRequest } = require("../middleware/admin-auth");

function createHealthRouter({ onchainService, etherscanService, covalentService, dataSource, adminKey }) {
  const router = require("express").Router();

  router.get("/", (req, res) => {
    // Public probe stays intentionally minimal so anonymous callers can't
    // enumerate which provider keys are configured or how big the cache is.
    if (!isAdminRequest(req, adminKey)) {
      res.json({ status: "ok" });
      return;
    }

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
