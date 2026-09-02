# AGENTS.md

Guidance for Codex and other AI agents working in this repository.

## Project Shape

- This is a Node.js/Express app serving static HTML, CSS, and vanilla JavaScript from `public/`.
- There is no React, Vite, Next.js, or TypeScript build pipeline in the current app.
- Backend code lives in `src/`; frontend pages and assets live in `public/`.
- Keep the distinction between `/on-chain.html` (curated links hub) and `/onchain.html` (API-backed on-chain dashboard).

## Working Rules

- Do not remove existing dashboard features or route aliases.
- Preserve API fallback behavior. Missing keys should degrade gracefully where the app already supports fallbacks.
- Prefer small, modular edits over rewrites.
- Reuse shared frontend primitives in `public/assets/js/ui.js`, `public/assets/js/sidebar.js`, `public/assets/js/sections.js`, and shared CSS in `public/assets/styles/`.
- Do not introduce a frontend framework or TypeScript unless the user explicitly asks for a migration plan.
- If adding required environment variables, update `.env.example` and README at the same time.
- If adding scripts, make sure `npm run lint` and `npm run build` still pass.

## UI Direction

- Keep the dashboard dark, dense, and operational.
- Use cards for repeated dashboard modules, not decorative page sections.
- Prefer restrained colors, clear hierarchy, accessible focus states, and responsive layouts.
- Include empty, loading, and error states for API-backed UI.

## Validation

Run before finishing:

```bash
npm run lint
npm run build
```

For API or data changes, also boot the app:

```bash
node -e "require('./src/app').createApp(); console.log('app loaded')"
```

## News Reporter Role

When operating as OpenClaw agent `newsreporter`, focus on the reporter workflow:

- `public/reporter.html` and supporting assets are the primary studio surface.
- Capture sources and separate reported facts from commentary or content angles.
- Keep public posting, market calls, and production deployments approval-gated through Penny/Studio Director.

### Broadcast ledger contract

- Use `https://market-dashboard-production-b2f4.up.railway.app/api/broadcast-ledger` with `x-broadcast-key` from `BROADCAST_LEDGER_API_KEY`.
- For every Geopolitics attempt, first call `POST /broadcast/guard` with `source: "sharebot67"`, `newsType: "Geopolitics"`, the headline/text, and a stable attempt idempotency key. If it returns `409`, stop before Telegram; the endpoint has already stored a visible `blocked` attempt. Never skip a Geopolitics attempt silently.
- For other news, call `POST /lookup` with its URL, headline, and text before posting. Treat `match: "likely"` as advisory only.
- For Stock, Crypto, and Economics, use exactly one of `newsType: "Stock"`, `newsType: "Crypto"`, or `newsType: "Economics"` and send only through `/broadcast`; the route restricts delivery to chat `-1001841650798` topic `6297` and chat `-1001941064823` topic `984`.
- Before posting, create a `pending` receipt with source `sharebot67` and a stable idempotency key.
- After posting, patch the receipt with one result per destination.
- On startup or gateway reconnect, call `POST /reconcile` with `{ "windowMs": 172800000 }`. Reconciled items are complete; only outstanding items remain actionable.
- Never infer failure from a missing gateway acknowledgment. Ask the ledger; a posted receipt outranks an absent acknowledgment.
