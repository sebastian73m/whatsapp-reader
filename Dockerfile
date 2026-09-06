# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="WhatsApp Reader"
LABEL org.opencontainers.image.description="Ingesta local de WhatsApp y servidor MCP de consulta y envío"
LABEL org.opencontainers.image.source="https://github.com/sebastian73m/whatsapp-reader"
LABEL org.opencontainers.image.licenses="MIT"

# Configuración por defecto incorporada en la imagen para el ingestor y el MCP.
ENV NODE_ENV=production \
    WHATSAPP_READER_DATA_DIR=/app/data \
    WHATSAPP_READER_DB_PATH=/app/data/whatsapp.sqlite \
    WHATSAPP_READER_AUTH_DIR=/app/auth \
    WHATSAPP_READER_SEND_SOCKET=/app/data/send.sock \
    WHATSAPP_READER_SEND_TIMEOUT_MS=15000 \
    WHATSAPP_READER_TIME_ZONE=America/Argentina/Buenos_Aires \
    WHATSAPP_READER_DEFAULT_LIMIT=20 \
    WHATSAPP_READER_LOG_LEVEL=info \
    WHATSAPP_READER_MAX_RECONNECT_ATTEMPTS=8 \
    WHATSAPP_READER_RECONNECT_BASE_MS=1000
WORKDIR /app

RUN mkdir -p /app/data /app/auth && chown node:node /app /app/data /app/auth

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json LICENSE ./

USER node
CMD ["node", "dist/ingest.js"]
