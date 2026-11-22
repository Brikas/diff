# Build the browser bundle, then ship only the server source and the bundle on a distroless non-root Node.
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild esbuild
COPY build.mjs ./
COPY web ./web
COPY server/anon-icons.json ./server/
RUN node build.mjs && mkdir -p /out/data

FROM gcr.io/distroless/nodejs24-debian13:nonroot
WORKDIR /app
COPY server ./server
COPY --from=build /src/dist/public ./public
# Owned by the image's non-root user so a fresh named volume starts writable.
COPY --from=build --chown=65532:65532 /out/data /data
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data PUBLIC_DIR=/app/public
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["--disable-warning=ExperimentalWarning", "server/main.ts"]
