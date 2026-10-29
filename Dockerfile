# ---- build stage: install production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# Unprivileged user (the node image ships a "node" user with uid 1000)
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node healthcheck-worker.js ./

USER node
EXPOSE 3000

# Default process is the API. The worker overrides the command in Compose.
CMD ["node", "src/server.js"]