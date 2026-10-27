# syntax=docker/dockerfile:1

# ---- Frontend ----
FROM node:24-alpine AS web
WORKDIR /src/web
RUN corepack enable && corepack prepare pnpm@12.11.2 --activate
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/.npmrc ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

# ---- Backend (frontend assets embedded in the binary) ----
FROM golang:1-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY deploy/embed.go ./deploy/
COPY deploy/data/vault ./deploy/data/vault
COPY web/embed.go web/font_storage.go ./web/
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/rawmark ./cmd/rawmark && mkdir -p /out/data

# ---- Runtime ----
FROM gcr.io/distroless/static:nonroot
COPY --from=server /out/rawmark /rawmark
COPY --from=server --chown=nonroot:nonroot /out/data /data
ENV RAWMARK_DATA=/data
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/rawmark", "healthcheck"]
ENTRYPOINT ["/rawmark"]
