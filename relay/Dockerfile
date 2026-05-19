FROM node:20-slim AS build

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

CMD ["node", "relay/dist/index.js"]
