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
