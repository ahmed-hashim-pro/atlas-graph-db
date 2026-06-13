FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
ENV ATLAS_DATA_DIR=/data ATLAS_PORT=4848
VOLUME /data
EXPOSE 4848
# start() reads ATLAS_* env (ATLAS_SECRET and optional ATLAS_ADMIN_* must be provided at run).
CMD ["node", "--import", "tsx", "packages/server/src/cli.ts"]
