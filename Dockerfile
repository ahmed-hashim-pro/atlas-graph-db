# Skeleton image: builds the workspace; the real server entrypoint replaces CMD in M5.
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
