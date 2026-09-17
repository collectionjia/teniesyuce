FROM node:20-alpine
WORKDIR /app/scheduler
COPY scheduler/package.json ./
RUN npm install --omit=dev
COPY scheduler/src ./src
COPY _lib /app/_lib
EXPOSE 9105
CMD ["node", "src/index.js"]
