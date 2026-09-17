FROM node:20-alpine
WORKDIR /app/betting
COPY services/betting/package.json ./
RUN npm install --omit=dev
COPY services/betting/src ./src
COPY services/_lib /app/_lib
EXPOSE 9103
CMD ["node", "src/index.js"]
