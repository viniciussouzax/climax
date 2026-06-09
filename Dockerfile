# CLI MAX — OpenAI-compatible adapter for the Claude Code CLI.
# Small, single-runtime image: Node + the official `claude` CLI. No app deps.
FROM node:22-slim

# Official Claude Code CLI (provides the `claude` binary the adapter spawns).
RUN npm install -g @anthropic-ai/claude-code \
    && (claude --version || true)

WORKDIR /app
COPY server.js ./

ENV PORT=8088
EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8088)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
