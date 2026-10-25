# syntax=docker/dockerfile:1

# ---- 前端 ----
FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- 服务端（前端产物嵌入二进制） ----
FROM golang:1-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY web/embed.go web/font_storage.go ./web/
COPY --from=web /src/web/dist ./web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/rawmark ./cmd/rawmark && mkdir -p /out/data

# ---- 运行 ----
FROM gcr.io/distroless/static:nonroot
COPY --from=server /out/rawmark /rawmark
COPY --from=server --chown=nonroot:nonroot /out/data /data
ENV RAWMARK_DATA=/data
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["/rawmark", "healthcheck"]
ENTRYPOINT ["/rawmark"]
