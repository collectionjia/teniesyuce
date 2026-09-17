FROM node:20-alpine
WORKDIR /app/scheduler
COPY services/scheduler/package.json ./
RUN npm install --omit=dev
COPY services/scheduler/src ./src
COPY services/_lib /app/_lib
EXPOSE 9105
CMD ["node", "src/index.js"]
