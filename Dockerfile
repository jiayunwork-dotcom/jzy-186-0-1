FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json jest.config.js ./
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/persistence/schema.sql ./dist/persistence/schema.sql
EXPOSE 3000
USER node
CMD ["node", "dist/main.js"]
