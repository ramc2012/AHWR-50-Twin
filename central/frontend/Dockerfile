# --- Build stage: optimized static bundle ---
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm install --no-audit --no-fund
COPY frontend/. .
RUN npm run build

# --- Serve stage: static files behind nginx (proxies /api and /socket.io) ---
FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
# Shared server body, included by BOTH the :80 block and the generated :443 block.
# NOT under conf.d/ — it contains bare `location` blocks, valid only at server context.
COPY frontend/nginx-shared.conf /etc/nginx/crmf-shared.conf
# Writes conf.d/zz-crmf-tls.conf at container start, but only when certs are mounted.
COPY frontend/docker-entrypoint.d/40-crmf-tls.sh /docker-entrypoint.d/40-crmf-tls.sh
RUN chmod +x /docker-entrypoint.d/40-crmf-tls.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80 443
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1
CMD ["nginx", "-g", "daemon off;"]
