# IdleForge API/worker image. Single image, separate commands per process.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY drizzle.config.ts ./
EXPOSE 3000
# Default: API. Override for worker/scheduler:
#   docker run idleforge node dist/worker.js
#   docker run idleforge node dist/scheduler.js
CMD ["node", "dist/server.js"]
