# Railway's default builders (Railpack/Nixpacks) don't ship the system
# libraries headless Chromium needs, and the nixpacks.toml aptPkgs route is
# ignored when the service builds with Railpack. A Dockerfile takes priority
# over both builders on Railway, and this base image ships Node plus Chromium
# with every OS dependency already installed. Keep the tag in lockstep with
# the "playwright" version in package.json so the preinstalled browser
# revision matches what the npm package expects.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
