"use strict";

// GET /api/market-session — which trading session is open right now.
//
// The overview chip has always worked this out in the browser. Main Hub's Daily
// Dashboard shows the same status, and it reads it from here rather than
// restating Sydney/Tokyo/London/New York hours in another repository.
//
// Both this route and the chip load the same public/assets/js/trading-sessions.js,
// so there is one set of session hours with two readers.

const express = require("express");
const path = require("path");

const {
  TRADING_SESSIONS,
  describeSession,
} = require(path.join(__dirname, "..", "..", "public", "assets", "js", "trading-sessions.js"));

function createMarketSessionRouter() {
  const router = express.Router();

  router.get("/", (req, res) => {
    const now = new Date();
    res.set("Cache-Control", "no-store");
    res.json({
      now: now.toISOString(),
      // Sessions are UTC. They are not on anyone's local clock, and a caller
      // that converts them to one is reporting the wrong thing.
      timezone: "UTC",
      ...describeSession(now),
      hours: TRADING_SESSIONS,
    });
  });

  return router;
}

module.exports = { createMarketSessionRouter };
