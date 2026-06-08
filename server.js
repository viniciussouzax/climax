/**
 * Nexus CLI — OpenAI-compatible adapter for the Claude Code CLI.
 *
 * Exposes a minimal OpenAI Chat Completions API that forwards each request to a
 * fresh, STATELESS `claude -p` invocation. No agents, no persona, no tools, no
 * memory, no session resume — every call is independent. The only context the
 * model sees is the `messages` of that single request.
 *
 * Endpoints:
 *   GET  /health                 -> liveness
 *   GET  /v1/models              -> [{ id: "nexus-cli" }]
 *   POST /v1/chat/completions    -> OpenAI ChatCompletion (stream + non-stream)
 *
 * Auth: if NEXUS_CLI_API_KEY is set, requests must send
 *   Authorization: Bearer <NEXUS_CLI_API_KEY>
 *
 * Engine: the `claude` CLI authenticated via CLAUDE_CODE_OAUTH_TOKEN (or an
 * Anthropic API key the CLI already trusts). The requested `model` field is
 * ignored — the CLI's configured default model is always used.
 */
'use strict';

const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '8088', 10);
const API_KEY = process.env.NEXUS_CLI_API_KEY || '';
const MODEL_ID = process.env.NEXUS_CLI_MODEL_ID || 'nexus-cli';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = parseInt(process.env.NEXUS_CLI_TIMEOUT_MS || '180000', 10);
const MAX_CONCURRENCY = parseInt(process.env.NEXUS_CLI_MAX_CONCURRENCY || '4', 10);

let inFlight = 0;

// ---- helpers ---------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(data);
}

function oaiError(res, status, message, type = 'invalid_request_error') {
  send(res, status, { error: { message, type, code: status } });
}

function authOk(req) {
  if (!API_KEY) return true; // open if no key configured
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m && m[1] === API_KEY;
}

// OpenAI message content can be a string or an array of parts. Extract text.
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// Render OpenAI messages into a system prompt + a single conversation prompt.
function buildPrompt(messages) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToText(m.content))
    .filter(Boolean)
    .join('\n\n');

  const turns = messages.filter((m) => m.role !== 'system');
  const prompt = turns
    .map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role;
      return `${role}: ${contentToText(m.content)}`;
    })
    .join('\n\n');

  return { system, prompt };
}

// Run a fresh, stateless `claude -p`. Resolves with { text, usage }.
function runClaude(system, prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--max-turns', '1', '--allowedTools', ''];
    if (system) args.push('--system-prompt', system);

    const child = spawn(CLAUDE_BIN, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      let json;
      try { json = JSON.parse(out); } catch (e) { return reject(new Error(`bad claude JSON: ${out.slice(0, 500)}`)); }
      if (json.is_error) return reject(new Error(`claude error: ${json.result || json.subtype || 'unknown'}`));
      const u = json.usage || {};
      resolve({
        text: json.result || '',
        usage: {
          prompt_tokens: u.input_tokens || 0,
          completion_tokens: u.output_tokens || 0,
          total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
        },
      });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---- handlers --------------------------------------------------------------

function handleModels(res) {
  send(res, 200, {
    object: 'list',
    data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'nexus-cli' }],
  });
}

async function handleChat(req, res, body) {
  let payload;
  try { payload = JSON.parse(body || '{}'); } catch (_) { return oaiError(res, 400, 'invalid JSON body'); }
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return oaiError(res, 400, '`messages` is required');
  }

  if (inFlight >= MAX_CONCURRENCY) {
    return oaiError(res, 429, 'too many concurrent requests', 'rate_limit_error');
  }
  inFlight++;

  const { system, prompt } = buildPrompt(messages);
  const id = 'chatcmpl-' + crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const stream = payload.stream === true;

  try {
    const { text, usage } = await runClaude(system, prompt);

    if (!stream) {
      return send(res, 200, {
        id, object: 'chat.completion', created, model: MODEL_ID,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage,
      });
    }

    // Streaming: emit the result as a single content delta then [DONE].
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const base = { id, object: 'chat.completion.chunk', created, model: MODEL_ID };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    if (stream && res.headersSent) { try { res.end(); } catch (_) {} }
    else oaiError(res, 502, String(e.message || e), 'api_error');
  } finally {
    inFlight--;
  }
}

// ---- server ----------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') return send(res, 200, { status: 'ok' });
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    if (!authOk(req)) return oaiError(res, 401, 'invalid api key', 'authentication_error');
    return handleModels(res);
  }
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    if (!authOk(req)) return oaiError(res, 401, 'invalid api key', 'authentication_error');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 25 * 1024 * 1024) req.destroy(); });
    req.on('end', () => handleChat(req, res, body));
    return;
  }
  return oaiError(res, 404, `no route for ${req.method} ${url}`, 'not_found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[nexus-cli] listening on :${PORT} (model=${MODEL_ID}, auth=${API_KEY ? 'on' : 'off'})`);
});
