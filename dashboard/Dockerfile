# Build context must be the repo root so workspace packages resolve.
FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
COPY dashboard/package.json ./dashboard/package.json
RUN npm ci --legacy-peer-deps

FROM node:22-bookworm-slim AS build
WORKDIR /app

ARG API_PROXY_TARGET=https://api.tallei.com
ARG BACKEND_URL=https://api.tallei.com
ENV NODE_ENV=production
ENV API_PROXY_TARGET=${API_PROXY_TARGET}
ENV BACKEND_URL=${BACKEND_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages ./packages
COPY dashboard ./dashboard
RUN npm run build -w @tallei/mcp-tools \
  && npm run build -w dashboard

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# With outputFileTracingRoot = repo root, standalone nests under dashboard/.
COPY --from=build /app/dashboard/.next/standalone ./
COPY --from=build /app/dashboard/.next/static ./dashboard/.next/static
COPY --from=build /app/dashboard/public ./dashboard/public

EXPOSE 8080
CMD ["node", "dashboard/server.js"]
