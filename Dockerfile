FROM --platform=linux/amd64 ghcr.io/chenyme/grok2api@sha256:0368bd969d31978c77329866ec3cb4924c663691de4676910f4b81b2f14939cf

COPY config.yaml /run/grok2api/config.yaml

EXPOSE 5000 8000

CMD ["/app/grok2api", "--config", "/app/config.yaml", "--listen", "0.0.0.0:5000"]
