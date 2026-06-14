# syntax=docker/dockerfile:1
# --- build stage: install everything, compile libs + SPA ---
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# --- deploy stage: production deps only ---
FROM node:22-slim AS deploy
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
# Drop dev dependencies (tsx, eslint, vitest, the Angular toolchain, …) from the
# runtime image; the compiled JS in each package's dist/ is all the server needs.
RUN pnpm prune --prod

# --- runtime image ---
FROM node:22-slim
WORKDIR /app
COPY --from=deploy /app /app
ENV ATLAS_DATA_DIR=/data ATLAS_PORT=4848
VOLUME /data
EXPOSE 4848
# Run the COMPILED entrypoint (no tsx, no TS source at runtime). start() reads
# ATLAS_* env; ATLAS_SECRET and optional ATLAS_ADMIN_* are provided at run.
CMD ["node", "packages/server/dist/cli.js"]
