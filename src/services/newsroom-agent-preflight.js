"use strict";

/**
 * Read-only identity check against the ShareBot/OpenClaw gateway.
 *
 * This is the one preflight question the repository cannot answer from its own
 * configuration: *does the credential the scheduled run carries still resolve
 * to the agent we think it is?* On August 11 it did not, and the answer came
 * back as `HTTP 401: User not found` — from the gateway, hours into a silence
 * nothing here could explain.
 *
 * The check is deliberately narrow:
 *   - GET only. A preflight must never make the agent do work, and a POST to
 *     a gateway is how a "check" becomes a run.
 *   - No secret is ever returned. The token goes out in a header and never
 *     appears in the result, not even truncated.
 *   - It reports `warn`, not `pass`, when unconfigured. An unverifiable route
 *     is not a healthy one; it is an unknown one, and calling it a pass is how
 *     the August 11 failure stayed invisible for as long as it did.
 *
 * The response body is only searched for an expected identity string when the
 * operator supplies one. Nothing is inferred about the agent from a response
 * that does not name it.
 */

const { classifyFailure } = require("./failure-classification");

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";

const MAX_DETAIL_LEN = 500;
// Enough to find an identity string in a whoami payload, small enough that a
// gateway streaming something unexpected cannot fill memory.
const MAX_BODY_LEN = 20000;

const UNCONFIGURED_DETAIL =
  "Not verified — no NEWSROOM_AGENT_PREFLIGHT_URL is configured, so the ShareBot/OpenClaw agent and model " +
  "route cannot be checked from this service. See docs/newsroom-401-verification.md.";

function clamp(value, max = MAX_DETAIL_LEN) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

/**
 * Build the header the gateway expects. `Authorization` gets a Bearer prefix
 * unless the operator already supplied a scheme, because a raw token in that
 * header is rejected by most gateways and would look like an auth failure
 * that is really a formatting mistake.
 */
function authHeaders(header, token) {
  if (!token) return {};
  const name = header || "Authorization";
  if (name.toLowerCase() !== "authorization") return { [name]: token };
  return { [name]: /^(bearer|token|basic)\s/i.test(token) ? token : `Bearer ${token}` };
}

/**
 * A preflight function for NewsroomService, or null when no URL is set.
 *
 * The returned function resolves — it never throws — so a gateway being down
 * degrades the check rather than taking the cycle's preflight with it. The
 * severity is in the result.
 */
function createAgentRoutePreflight(settings = {}, { fetchImpl } = {}) {
  const url = clamp(settings.url, 2000);
  if (!url) return null;

  const doFetch = fetchImpl || globalThis.fetch;
  const timeoutMs = Number(settings.timeoutMs) > 0 ? Number(settings.timeoutMs) : 8000;
  const expectIdentity = clamp(settings.expectIdentity, 200);

  return async function agentRoutePreflight() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...authHeaders(settings.header, settings.token) },
        signal: controller.signal,
      });

      const body = clamp(await res.text(), MAX_BODY_LEN);

      if (!res.ok) {
        // Classify from the gateway's own words, so `User not found` is named
        // as the identity failure it is rather than a generic 401.
        const classification = classifyFailure(
          Object.assign(new Error(body || `HTTP ${res.status}`), { status: res.status }),
          { phase: "preflight" },
        );
        return {
          ok: false,
          status: FAIL,
          code: classification.code,
          retryable: classification.retryable,
          httpStatus: res.status,
          detail: `Agent route check failed: HTTP ${res.status}. ${classification.reason}`,
        };
      }

      if (expectIdentity && !body.includes(expectIdentity)) {
        return {
          ok: false,
          status: FAIL,
          code: "identity_mismatch",
          retryable: false,
          httpStatus: res.status,
          detail:
            `The agent route resolved, but the response does not name the expected identity ` +
            `(NEWSROOM_AGENT_PREFLIGHT_EXPECT). The scheduled credential may point at a different agent.`,
        };
      }

      return {
        ok: true,
        status: PASS,
        code: "verified",
        httpStatus: res.status,
        detail: expectIdentity
          ? `Agent route verified and names the expected identity.`
          : `Agent route verified (HTTP ${res.status}). No expected identity configured, so this proves the ` +
            `credential resolves, not which agent it resolves to.`,
      };
    } catch (err) {
      const classification = classifyFailure(err, { phase: "preflight" });
      return {
        ok: false,
        status: FAIL,
        code: classification.code,
        retryable: classification.retryable,
        httpStatus: null,
        detail: `Agent route check could not complete: ${classification.message || classification.reason}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

module.exports = {
  createAgentRoutePreflight,
  authHeaders,
  UNCONFIGURED_DETAIL,
  PASS,
  WARN,
  FAIL,
};
