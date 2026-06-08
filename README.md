# Nexus CLI

A tiny **OpenAI-compatible adapter** that exposes the **Claude Code CLI** as an
LLM endpoint. Point any OpenAI client (e.g. the **Evo CRM** agents) at it and it
forwards each request to the `claude` CLI.

It is a **modular add-on**: it runs as its own container and does **not** change
anything in EvoNexus or the CRM. Drop it in, configure a URL + key, done.

## Principles

- **Stateless** — every request runs a fresh `claude -p`. No agents, no persona,
  no tools, no memory, no session resume. The model only sees the `messages` of
  that single request. Two calls never share context.
- **Transparent** — it just relays the messages to Claude and returns the answer.
  No Oracle, no heartbeats, no scheduler, nothing else.
- **Model-agnostic input** — the `model` field is ignored; the CLI's default
  model is used. Clients can just send `nexus-cli`.

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/v1/models` | returns a single model: `nexus-cli` |
| POST | `/v1/chat/completions` | OpenAI Chat Completions (stream + non-stream) |

Auth: if `NEXUS_CLI_API_KEY` is set, send `Authorization: Bearer <key>`.

## Quickstart

```bash
cp .env.example .env       # set NEXUS_CLI_API_KEY and CLAUDE_CODE_OAUTH_TOKEN
docker compose up -d --build
curl -s http://localhost:8088/v1/models -H "Authorization: Bearer $NEXUS_CLI_API_KEY"
curl -s http://localhost:8088/v1/chat/completions \
  -H "Authorization: Bearer $NEXUS_CLI_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"nexus-cli","messages":[{"role":"user","content":"say hi"}]}'
```

## Use it in the Evo CRM ("Nexus CLI")

Configure an OpenAI-compatible provider in the CRM with:

- **Base URL**: `https://<your-host>/v1`
- **API key**: the `NEXUS_CLI_API_KEY` you set
- **Model**: `nexus-cli`

The CRM's agents then use Claude as their model. The agent's own
instructions/messages are passed straight through to Claude.

> The Evo CRM UI does not yet have a field for a custom base URL per agent. Until
> the upstream `api_base` option lands, set `OPENAI_API_BASE=https://<your-host>/v1`
> on the `evo_processor` service and pick `nexus-cli` as the model.

## Production (behind Traefik / Dokploy)

Run the container, remove the `ports` mapping, attach it to your reverse-proxy
network, and route a domain (e.g. `llm.example.com`) to port `8088` with HTTPS.
Clients then use `https://llm.example.com/v1`.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `NEXUS_CLI_API_KEY` | — | Bearer key clients must send (empty = open) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude Max OAuth token used by the CLI |
| `ANTHROPIC_API_KEY` | — | Alternative to the Max token (pay-per-use API) |
| `PORT` | `8088` | listen port |
| `NEXUS_CLI_MODEL_ID` | `nexus-cli` | model id reported by `/v1/models` |
| `NEXUS_CLI_TIMEOUT_MS` | `180000` | per-request timeout |
| `NEXUS_CLI_MAX_CONCURRENCY` | `4` | max concurrent CLI calls |

## Notes & caveats

- **Anthropic terms**: using a **Claude Max** subscription to serve an API may
  violate Anthropic's terms (Max is for interactive use). For ToS-clean
  production, use `ANTHROPIC_API_KEY` instead — same adapter, just swap the env.
- Each call spawns a CLI process; for high volume, tune `NEXUS_CLI_MAX_CONCURRENCY`.
- Function-calling/tools are intentionally disabled (raw text completion).

## License

MIT
