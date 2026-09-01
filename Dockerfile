ARG NODE_VERSION=22
ARG GO_VERSION=1.24
ARG ALPINE_VERSION=3.21

FROM node:22-alpine AS frontend-builder

WORKDIR /src/frontend
RUN corepack enable

COPY frontend/package.json frontend/pnpm-lock.yaml ./
RUN pnpm install

COPY frontend ./
RUN pnpm build


FROM golang:1.24-alpine AS backend-builder

WORKDIR /src/backend
RUN apk add --no-cache ca-certificates git

COPY backend/go.mod backend/go.sum ./
RUN go mod download

COPY backend ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/grok2api ./cmd/grok2api


FROM alpine:3.21

ENV TZ=UTC \
    GROK2API_CONFIG_SOURCE=/run/grok2api/config.yaml

RUN apk add --no-cache ca-certificates su-exec tzdata && \
    addgroup -S -g 10001 grok2api && \
    adduser -S -D -H -u 10001 -G grok2api grok2api && \
    mkdir -p /app/data /run/grok2api /var/lib/grok2api-quality-guard && \
    chown -R grok2api:grok2api /app/data /run/grok2api /var/lib/grok2api-quality-guard && \
    chmod 0700 /var/lib/grok2api-quality-guard

WORKDIR /app

COPY --from=backend-builder /out/grok2api /app/grok2api
COPY --from=frontend-builder /src/frontend/dist /app/frontend/dist
COPY config.yaml /run/grok2api/config.yaml
COPY config.yaml /app/config.yaml
COPY VERSION /app/VERSION
COPY docker/entrypoint.sh /usr/local/bin/grok2api-entrypoint
RUN chmod 0755 /usr/local/bin/grok2api-entrypoint

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/grok2api-entrypoint"]
CMD ["/app/grok2api", "--config", "/app/config.yaml", "--listen", "0.0.0.0:8000"]
