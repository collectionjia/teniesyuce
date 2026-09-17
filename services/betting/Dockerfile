FROM node:20-alpine
WORKDIR /app/betting
COPY betting/package.json ./
RUN npm install --omit=dev
COPY betting/src ./src
COPY _lib /app/_lib
EXPOSE 9103
CMD ["node", "src/index.js"]
