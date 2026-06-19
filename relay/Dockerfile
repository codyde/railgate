FROM node:20-slim AS build

# Build toolchain for better-sqlite3's native addon, used only if a prebuilt
# binary isn't available for this platform. Lives in the build stage so it
# never reaches the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY shared/package.json shared/
COPY relay/package.json relay/

RUN npm install --workspace=@railgate/relay

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY relay/ relay/

RUN npm run build --workspace=@railgate/shared && \
    npm run build --workspace=@railgate/relay

FROM node:20-slim

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/shared/package.json shared/
COPY --from=build /app/shared/dist/ shared/dist/
COPY --from=build /app/relay/package.json relay/
COPY --from=build /app/relay/dist/ relay/dist/
COPY --from=build /app/node_modules/ node_modules/

ENV NODE_ENV=production
# Tunnel history persists here; the Railway volume is mounted at /data. Without
# a volume the relay falls back to in-memory history.
ENV RAILGATE_DATA_DIR=/data

CMD ["node", "relay/dist/index.js"]
