# Skeleton image: builds the workspace; the real server entrypoint replaces CMD in M5.
# M5 follow-ups (deliberately deferred while CMD is a banner stub):
#   - Restructure for layer caching: copy manifests + lockfile first, `pnpm install`, then copy sources.
#   - Slim the runtime stage: copy only dist + production deps (e.g. `pnpm deploy --prod`) instead of the full packages/ tree.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/packages /app/packages
COPY --from=build /app/package.json /app/package.json
CMD ["node", "-e", "console.log('atlas skeleton image — server entrypoint lands in M5')"]
