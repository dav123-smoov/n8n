FROM --platform=linux/amd64 ghcr.io/chenyme/grok2api@sha256:0368bd969d31978c77329866ec3cb4924c663691de4676910f4b81b2f14939cf

USER root

COPY config.yaml /app/config.yaml
COPY config.yaml /run/grok2api/config.yaml

RUN mkdir -p /app/data /run/grok2api /var/lib/grok2api-quality-guard && \
    chown -R grok2api:grok2api /app /run/grok2api /var/lib/grok2api-quality-guard 2>/dev/null || true

EXPOSE 5000 8000

CMD ["/app/grok2api", "--config", "/app/config.yaml", "--listen", "0.0.0.0:5000"]
