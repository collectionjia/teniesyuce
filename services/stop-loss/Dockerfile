FROM node:20-alpine
WORKDIR /app/stop-loss
COPY services/stop-loss/package.json ./
RUN npm install --omit=dev
COPY services/stop-loss/src ./src
COPY services/_lib /app/_lib
EXPOSE 9104
CMD ["node", "src/index.js"]
