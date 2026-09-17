FROM node:20-alpine
WORKDIR /app/rules
COPY rules/package.json ./
RUN npm install --omit=dev
COPY rules/src ./src
COPY _lib /app/_lib
EXPOSE 9102
CMD ["node", "src/index.js"]
