# Multi-stage build. Final image: non-root, read-only filesystem friendly, no build tools.
FROM node:22.18-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22.18-bookworm-slim
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web/dist
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/db ./db
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.ts"]
