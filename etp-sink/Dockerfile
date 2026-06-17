FROM node:18-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev && npm cache clean --force
COPY server.js .
EXPOSE 9011 9012
CMD ["node", "server.js"]
