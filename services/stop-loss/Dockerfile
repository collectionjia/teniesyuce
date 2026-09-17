FROM node:20-alpine
WORKDIR /app/stop-loss
COPY stop-loss/package.json ./
RUN npm install --omit=dev
COPY stop-loss/src ./src
COPY _lib /app/_lib
EXPOSE 9104
CMD ["node", "src/index.js"]
