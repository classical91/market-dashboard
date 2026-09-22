const express = require("express");

const { isAddress, normalizeAddress } = require("../utils/validators");

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function createOnchainRouter({ onchainService, onchainIntelligenceService = null }) {
  const router = express.Router();

  // Chain-level liquidity and activity for the Overview card. Separate from
  // /overview, which serves the transfer/wallet feed behind /onchain.html.
  if (onchainIntelligenceService) {
    router.get(
      "/intelligence",
      asyncRoute(async (req, res) => {
        res.json(await onchainIntelligenceService.getIntelligence());
      }),
    );
  }

  router.get(
    "/overview",
    asyncRoute(async (req, res) => {
      res.json(await onchainService.getOverview());
    }),
  );

  router.get(
    "/wallet/:address",
    asyncRoute(async (req, res) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return res.status(400).json({ error: "Invalid wallet address." });
      }

      res.json(await onchainService.getWallet(normalizeAddress(address)));
    }),
  );

  router.get(
    "/token/:address",
    asyncRoute(async (req, res) => {
      const { address } = req.params;
      if (!isAddress(address)) {
        return res.status(400).json({ error: "Invalid token contract address." });
      }

      res.json(await onchainService.getToken(normalizeAddress(address)));
    }),
  );

  return router;
}

module.exports = { createOnchainRouter };
