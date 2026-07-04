# Kept — multi-stage image for AWS App Runner (W2).
# Runtime is tsx (TypeScript ESM executed directly — the projection/engine changes with
# no build step), a single Node process listening on one PORT that serves Slack events,
# the OAuth install flow, webhooks, and /healthz.

# --- deps: install once, cached independently of the source ------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Full install (tsx is a dev dependency but is the runtime here).
RUN npm ci

# --- runtime -----------------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
# App Runner routes to this port; index.ts reads process.env.PORT.
ENV PORT=8080
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
COPY slack-manifest.yaml ./

EXPOSE 8080
# Everything (Slack events + OAuth install + webhooks + /healthz) is served on PORT.
CMD ["npm", "start"]
