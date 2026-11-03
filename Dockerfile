# One image, three roles. The command picks which process runs:
#   api (default)   node dist/server.js
#   worker          node dist/worker.js
#   mock suppliers  node dist/mockSuppliers.js
#
# Debian slim, not Alpine: the Temporal worker loads a native Rust module built for glibc.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docs/openapi.yaml ./docs/openapi.yaml
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
