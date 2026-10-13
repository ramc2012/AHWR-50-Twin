FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server.js .
COPY lib ./lib
USER node
EXPOSE 9011 9012
CMD ["node", "server.js"]
