FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    WORKSPACE_ROOT=/workspace
COPY package*.json ./
RUN npm ci --omit=dev && mkdir -p /workspace && chown node:node /workspace
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3333
# Listening on 0.0.0.0 requires MCP_AUTH_TOKEN; the server refuses to start without it.
CMD ["node", "dist/index.js", "--http", "--host", "0.0.0.0", "--port", "3333"]
