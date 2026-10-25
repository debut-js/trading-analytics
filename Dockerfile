FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts || npm install --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY demo ./demo
RUN npx tsc -p tsconfig.json && npm prune --omit=dev
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/server.js"]
