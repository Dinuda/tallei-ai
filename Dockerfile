FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
# Workspace root lists dashboard; provide package.json so npm ci can link it without full sources.
COPY dashboard/package.json ./dashboard/package.json
RUN mkdir -p dashboard && npm ci --legacy-peer-deps

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
COPY dashboard/package.json ./dashboard/package.json
COPY src ./src
RUN npm run build:packages && npx tsc -p tsconfig.json

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

COPY package.json package-lock.json ./
COPY packages ./packages
COPY dashboard/package.json ./dashboard/package.json
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/mcp-tools/dist ./packages/mcp-tools/dist

EXPOSE 8080
CMD ["node", "dist/index.js"]
