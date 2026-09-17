FROM node:20-alpine
WORKDIR /app/rules
COPY services/rules/package.json ./
RUN npm install --omit=dev
COPY services/rules/src ./src
COPY services/_lib /app/_lib
EXPOSE 9102
CMD ["node", "src/index.js"]
