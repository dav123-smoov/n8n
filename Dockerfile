FROM chenyme/grok2api:latest

COPY config.yaml /run/grok2api/config.yaml
COPY config.yaml /app/config.yaml

ENV GROK2API_CONFIG_SOURCE=/run/grok2api/config.yaml
ENV PORT=8000

EXPOSE 8000
