# CRMF ETP/WITSML server (ETP v1.2 + WITSML 2.1 over the CMF historian).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib ./lib
USER node
EXPOSE 8443 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD wget -qO- http://127.0.0.1:${HTTP_PORT:-8080}/healthz || exit 1
CMD ["node", "server.js"]
