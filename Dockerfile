FROM chenyme/grok2api:latest

USER root

COPY config.yaml /app/config.yaml
COPY config.yaml /run/grok2api/config.yaml

RUN mkdir -p /app/data /run/grok2api /var/lib/grok2api-quality-guard && \
    chown -R grok2api:grok2api /app/config.yaml /run/grok2api /app/data /var/lib/grok2api-quality-guard 2>/dev/null || true

RUN printf '#!/bin/sh\nPORT="${PORT:-8000}"\nexec su-exec grok2api:grok2api /app/grok2api --config /app/config.yaml --listen "0.0.0.0:${PORT}"\n' > /app/start.sh && \
    chmod +x /app/start.sh

EXPOSE 8000 5000 10000

ENTRYPOINT ["/app/start.sh"]
