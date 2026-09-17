FROM node:20-alpine
WORKDIR /app/collect
COPY collect/package.json ./
RUN npm install --omit=dev
COPY collect/src ./src
COPY _lib /app/_lib
EXPOSE 9101
CMD ["node", "src/index.js"]
