# syntax=docker/dockerfile:1

# Build the React SPA into client/dist.
FROM node:24-slim AS client
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Production dependencies only.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim
ENV NODE_ENV=production \
    VELVET_DATA=/data \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json *.mjs ./
COPY --from=client /app/client/dist ./client/dist

# All persisted state (signing key, collections, blobs, theme.css) lives here.
RUN mkdir /data && chown node:node /data
USER node

EXPOSE 8080
# velvet reads VELVET_PORT; the image exposes the conventional PORT instead.
CMD ["sh", "-c", "VELVET_PORT=\"$PORT\" exec node index.mjs serve"]
