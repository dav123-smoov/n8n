FROM --platform=linux/amd64 ghcr.io/chenyme/grok2api@sha256:0368bd969d31978c77329866ec3cb4924c663691de4676910f4b81b2f14939cf

USER root
RUN apk add --no-cache ffmpeg nodejs

COPY config.yaml /app/config.yaml
COPY config.yaml /run/grok2api/config.yaml
COPY server.js /app/server.js

EXPOSE 5000 8000

CMD ["node", "/app/server.js"]
