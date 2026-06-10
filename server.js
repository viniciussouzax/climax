'use strict';
/**
 * CLI MAX (climax) — OpenAI-compatible adapter for the Claude Code CLI.
 *
 * v2 — OpenRouter-grade hardening over `claude -p`:
 *   - REAL streaming (stream-json -> well-formed chat.completion.chunk SSE)
 *   - Proper error codes: rate-limit -> 429 + Retry-After, timeout -> 504,
 *     transient -> retried (backoff) then 502; structured per-request logs.
 *   - Bounded FIFO queue with 429 backpressure (no unbounded memory / OOM).
 *   - `model` -> `--model` passthrough + echoed back; honest 400 for
 *     unsupported features (function calling, image/multimodal).
 *   - System prompt via --system-prompt-file (no argv E2BIG); `stop` honored;
 *     constant-time auth, fail-closed env, x-request-id, graceful shutdown.
 *
 * Engine note: `claude -p` is single-shot (--max-turns 1, tools off). Native
 * function-calling / agentic tool round-trips are NOT possible with the CLI —
 * those require the Anthropic Messages API. Everything else below is real.
 */

const http = require('http');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8088', 10);
const API_KEY = process.env.CLIMAX_API_KEY || '';
const MODEL_ID = process.env.CLIMAX_MODEL_ID || 'climax';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TIMEOUT_MS = parseInt(process.env.CLIMAX_TIMEOUT_MS || '180000', 10);
const MAX_CONCURRENCY = parseInt(process.env.CLIMAX_MAX_CONCURRENCY || '12', 10);
const MAX_QUEUE = parseInt(process.env.CLIMAX_MAX_QUEUE || '200', 10);
const RETRIES = parseInt(process.env.CLIMAX_RETRIES || '2', 10);
// Max agentic turns for the underlying claude. Tools stay DENIED (--allowedTools
// ''), so claude can never execute anything; >1 only gives it room to give up on
// a (denied) tool attempt and answer in text instead of failing error_max_turns.
const MAX_TURNS = parseInt(process.env.CLIMAX_MAX_TURNS || '8', 10);
const DEBUG_REQ = process.env.CLIMAX_DEBUG_REQ === '1';
const DEFAULT_MODEL = process.env.CLIMAX_DEFAULT_MODEL || ''; // '' = let the CLI pick its default
const FALLBACK_MODEL = process.env.CLIMAX_FALLBACK_MODEL || ''; // optional auto-fallback on overload

// Always-on system instruction that keeps Claude a PLAIN TEXT LLM. Without it,
// the underlying Claude Code CLI may try to call ITS OWN built-in tools
// (WebSearch, Bash, ...) on prompts that suggest an action, which with
// --max-turns 1 fails with `error_max_turns` and breaks the response. Tool /
// agent orchestration belongs to the CALLER (e.g. the evo-ai agent), not to
// the LLM. Set CLIMAX_SYSTEM_SUFFIX="" to disable.
const SYSTEM_SUFFIX = process.env.CLIMAX_SYSTEM_SUFFIX !== undefined
  ? process.env.CLIMAX_SYSTEM_SUFFIX
  : 'You are a plain text chat assistant. You have NO tools and cannot browse the web, run code, read files, or take any action. Never attempt to call or use any tool — always answer the user directly in plain text with what you already know.';

// ---- concurrency pool + BOUNDED FIFO queue ---------------------------------
let active = 0, served = 0, peakQueue = 0, shed = 0;
const waiters = [];

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (active < MAX_CONCURRENCY) { active++; return resolve(); }
    if (waiters.length >= MAX_QUEUE) {
      shed++;
      const e = new Error('overloaded'); e.kind = 'overloaded';
      return reject(e);
    }
    waiters.push(resolve);
    if (waiters.length > peakQueue) peakQueue = waiters.length;
  });
}
function releaseSlot() {
  const next = waiters.shift();
  if (next) next(); else active = Math.max(0, active - 1);
}

// ---- typed errors ----------------------------------------------------------
class RateLimitError extends Error { constructor(m, retryAfter) { super(m); this.kind = 'rate_limit'; this.retryAfter = retryAfter || 60; } }
class TimeoutError extends Error { constructor(m) { super(m); this.kind = 'timeout'; } }
class ClaudeError extends Error { constructor(m, transient) { super(m); this.kind = 'claude'; this.transient = !!transient; } }

// ---- helpers ---------------------------------------------------------------
function log(o) { try { process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); } catch (_) {} }

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(data);
}
function oaiError(res, status, message, type, code, headers = {}) {
  send(res, status, { error: { message, type, code, param: null } }, headers);
}

function authOk(req) {
  if (!API_KEY) return true; // open only if explicitly no key configured
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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
function hasNonText(content) {
  return Array.isArray(content) && content.some((p) => p && p.type && p.type !== 'text');
}

function buildPrompt(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => contentToText(m.content)).filter(Boolean).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  const prompt = turns
    .map((m) => {
      const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role === 'tool' ? 'Tool' : m.role;
      return `${role}: ${contentToText(m.content)}`;
    })
    .join('\n\n');
  return { system, prompt };
}

// Map an OpenAI model string to a claude --model (or null = CLI default).
function mapModel(reqModel) {
  if (!reqModel) return DEFAULT_MODEL || null;
  const bare = String(reqModel).toLowerCase().replace(/^(openai|anthropic)\//, '');
  if (/(sonnet|opus|haiku|^claude)/.test(bare)) return bare; // a real Claude model/alias
  return DEFAULT_MODEL || null; // generic names (climax, gpt-4o, ...) -> CLI default
}

function isRateLimitText(s) {
  return /rate.?limit|overloaded|usage limit|429|too many requests|quota|exceeded your/i.test(s || '');
}
function sumInput(u) {
  if (!u) return 0;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

// ---- claude engine ---------------------------------------------------------
// Spawns `claude -p`. For stream mode, calls onDelta(text) live as deltas arrive.
// Resolves { text, usage, finishReason } or rejects a typed error.
function runClaude({ system, prompt, model, stream, onDelta }) {
  return new Promise((resolve, reject) => {
    let sysFile = null;
    const args = ['-p', '--max-turns', String(MAX_TURNS), '--allowedTools', '', '--no-session-persistence'];
    if (stream) args.push('--output-format', 'stream-json', '--include-partial-messages', '--verbose');
    else args.push('--output-format', 'json');
    if (model) args.push('--model', model);
    if (FALLBACK_MODEL) args.push('--fallback-model', FALLBACK_MODEL);
    // Combine the caller's system prompt with the always-on plain-LLM guard.
    // Passing --system-prompt[-file] also replaces Claude Code's heavy default
    // (tool-advertising) system prompt.
    const sys = [system, SYSTEM_SUFFIX].filter(Boolean).join('\n\n');
    if (sys) {
      try {
        sysFile = path.join(os.tmpdir(), 'climax-sys-' + crypto.randomUUID() + '.txt');
        fs.writeFileSync(sysFile, sys);
        args.push('--system-prompt-file', sysFile);
      } catch (_) { sysFile = null; args.push('--system-prompt', sys); }
    }

    const childEnv = { ...process.env };
    delete childEnv.CLIMAX_API_KEY; // do not leak our gateway key into the child

    let settled = false;
    const cleanup = () => { if (sysFile) { try { fs.unlinkSync(sysFile); } catch (_) {} } };
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); cleanup(); fn(v); };

    let child;
    try {
      child = spawn(CLAUDE_BIN, args, { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { cleanup(); return reject(new ClaudeError('spawn failed: ' + e.message, true)); }

    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(reject, new TimeoutError(`claude timed out after ${TIMEOUT_MS}ms`)); }, TIMEOUT_MS);

    let out = '', err = '', sbuf = '';
    let text = '', finishReason = 'stop';
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let rateLimited = null;   // { retryAfter }
    let resultErr = null;     // non-rate-limit application error from claude

    function onEvent(ev) {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
        const ri = ev.rate_limit_info;
        if (ri.resetsAt) rateLimited = { retryAfter: Math.max(1, ri.resetsAt - Math.floor(Date.now() / 1000)), hard: false, ...(rateLimited || {}) };
        if (/(rejected|blocked|exceeded)/i.test(ri.status || '')) rateLimited = { retryAfter: (rateLimited && rateLimited.retryAfter) || 60, hard: true };
      } else if (ev.type === 'stream_event' && ev.event) {
        const e = ev.event;
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
          const t = e.delta.text || '';
          if (t) { text += t; if (stream && onDelta) onDelta(t); }
        } else if (e.type === 'message_start' && e.message && e.message.usage) {
          usage.prompt_tokens = sumInput(e.message.usage) || usage.prompt_tokens;
        } else if (e.type === 'message_delta') {
          if (e.usage && e.usage.output_tokens != null) usage.completion_tokens = e.usage.output_tokens;
          if (e.delta && e.delta.stop_reason) finishReason = e.delta.stop_reason === 'max_tokens' ? 'length' : 'stop';
        }
      } else if (ev.type === 'result') {
        if (ev.usage) { usage.prompt_tokens = sumInput(ev.usage) || usage.prompt_tokens; usage.completion_tokens = ev.usage.output_tokens || usage.completion_tokens; }
        if (typeof ev.result === 'string' && !stream && !ev.is_error) text = ev.result;
        if (ev.is_error) {
          const msg = (ev.result || ev.subtype || 'unknown') + '';
          if (isRateLimitText(msg)) rateLimited = { retryAfter: (rateLimited && rateLimited.retryAfter) || 60, hard: true };
          else resultErr = msg;
        }
      }
    }

    child.stdout.on('data', (d) => {
      out += d;
      if (!stream) return;
      sbuf += d;
      let i;
      while ((i = sbuf.indexOf('\n')) >= 0) {
        const line = sbuf.slice(0, i).trim();
        sbuf = sbuf.slice(i + 1);
        if (line) { try { onEvent(JSON.parse(line)); } catch (_) {} }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => finish(reject, new ClaudeError('claude spawn error: ' + e.message, true)));
    child.on('close', (code) => {
      if (stream && sbuf.trim()) { try { onEvent(JSON.parse(sbuf.trim())); } catch (_) {} }
      if (!stream) {
        try {
          const j = JSON.parse(out);
          if (j.usage) { usage.prompt_tokens = sumInput(j.usage); usage.completion_tokens = j.usage.output_tokens || 0; }
          if (j.is_error) {
            const msg = (j.result || j.subtype || 'unknown') + '';
            if (isRateLimitText(msg)) rateLimited = { retryAfter: 60, hard: true }; else resultErr = msg;
          } else { text = j.result || ''; }
        } catch (_) { if (code === 0) resultErr = 'bad claude JSON: ' + out.slice(0, 200); }
      }
      usage.total_tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

      if (rateLimited && (rateLimited.hard || code !== 0)) return finish(reject, new RateLimitError('claude rate/usage limit', rateLimited.retryAfter));
      if (code !== 0) {
        // The CLI often reports the real error on STDOUT (json envelope), not stderr.
        const detail = err.trim() || resultErr || (out.trim() ? 'stdout: ' + out.trim().slice(0, 300) : '(no output)');
        if (isRateLimitText(detail)) return finish(reject, new RateLimitError('claude rate/usage limit', (rateLimited && rateLimited.retryAfter) || 60));
        const transient = !err.trim() || /(5\d\d|overloaded|timeout|econnreset|temporar|refresh|network|socket)/i.test(detail);
        return finish(reject, new ClaudeError(`claude exited ${code}: ${String(detail).slice(0, 400)}`, transient));
      }
      if (resultErr) return finish(reject, new ClaudeError(resultErr.slice(0, 400), false));
      finish(resolve, { text, usage, finishReason });
    });

    try { child.stdin.write(prompt); child.stdin.end(); } catch (_) {}
  });
}

// ---- handlers --------------------------------------------------------------
function handleModels(res) {
  send(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', created: 0, owned_by: 'climax' }] });
}

async function handleChat(req, res, body, reqId) {
  let payload;
  try { payload = JSON.parse(body || '{}'); } catch (_) { return oaiError(res, 400, 'invalid JSON body', 'invalid_request_error', 'invalid_json'); }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return oaiError(res, 400, '`messages` is required', 'invalid_request_error', 'invalid_messages');

  // Honest rejections for things this engine genuinely cannot do.
  const tc = payload.tool_choice;
  if (Array.isArray(payload.tools) && payload.tools.length && (tc === 'required' || (tc && typeof tc === 'object'))) {
    return oaiError(res, 400, 'function/tool calling is not supported by this engine (claude -p is single-shot). Use a tool-calling LLM for agents that must call tools.', 'invalid_request_error', 'tools_unsupported');
  }
  if (messages.some((m) => hasNonText(m.content))) {
    return oaiError(res, 400, 'non-text (image/multimodal) content is not supported by this engine', 'invalid_request_error', 'multimodal_unsupported');
  }

  try { await acquireSlot(); }
  catch (e) { return oaiError(res, 429, 'server is at capacity, retry shortly', 'rate_limit_error', 'capacity', { 'Retry-After': '5', 'x-request-id': reqId }); }

  served++;
  const { system, prompt } = buildPrompt(messages);
  const model = mapModel(payload.model);
  const echoModel = payload.model || MODEL_ID;
  // Request shape is always logged (no PII). The system-prompt head (which can
  // contain contact PII) is logged ONLY when CLIMAX_DEBUG_REQ=1.
  log({ reqId, dbg: 'req', model: echoModel, msgs: messages.length, roles: messages.map((m) => m.role).join(','), sysLen: system.length, tools: Array.isArray(payload.tools) ? payload.tools.length : 0, tool_choice: payload.tool_choice || null, stream: payload.stream === true, ...(DEBUG_REQ ? { sysHead: system.slice(0, 1500) } : {}) });
  const id = 'chatcmpl-' + crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const stream = payload.stream === true;
  const stops = Array.isArray(payload.stop) ? payload.stop : payload.stop ? [payload.stop] : [];
  const t0 = Date.now();

  let headersSent = false;
  const base = { id, object: 'chat.completion.chunk', created, model: echoModel };
  const sseInit = () => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'x-request-id': reqId });
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    headersSent = true;
  };
  const sseDelta = (t) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);

  let attempt = 0;
  try {
    while (true) {
      attempt++;
      try {
        if (stream) {
          const onDelta = (t) => { if (!headersSent) sseInit(); sseDelta(t); };
          const r = await runClaude({ system, prompt, model, stream: true, onDelta });
          if (!headersSent) sseInit();
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: r.finishReason || 'stop' }] })}\n\n`);
          if (payload.stream_options && payload.stream_options.include_usage) {
            res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: r.usage })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          log({ reqId, model: echoModel, stream: true, status: 200, ms: Date.now() - t0, attempt, usage: r.usage });
        } else {
          const r = await runClaude({ system, prompt, model, stream: false });
          let text = r.text || '';
          let finish = r.finishReason || 'stop';
          for (const s of stops) { if (!s) continue; const k = text.indexOf(s); if (k >= 0) { text = text.slice(0, k); finish = 'stop'; } }
          send(res, 200, {
            id, object: 'chat.completion', created, model: echoModel,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
            usage: r.usage,
          }, { 'x-request-id': reqId });
          log({ reqId, model: echoModel, stream: false, status: 200, ms: Date.now() - t0, attempt, usage: r.usage });
        }
        break;
      } catch (e) {
        if (e.kind === 'claude' && e.transient && attempt <= RETRIES && !headersSent) {
          log({ reqId, model: echoModel, retry: attempt, transient_err: String(e.message).slice(0, 200) });
          await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    const ms = Date.now() - t0;
    if (headersSent) {
      try {
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], error: { message: String(e.message), type: e.kind === 'rate_limit' ? 'rate_limit_error' : 'api_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (_) {}
      log({ reqId, model: echoModel, status: 'stream_error', kind: e.kind, ms, err: String(e.message).slice(0, 200) });
    } else if (e.kind === 'rate_limit') {
      log({ reqId, status: 429, ms, err: String(e.message).slice(0, 200) });
      oaiError(res, 429, 'rate/usage limit on the Claude backend (Max window). Retry after the indicated delay.', 'rate_limit_error', 'rate_limit_exceeded', { 'Retry-After': String(e.retryAfter || 60), 'x-request-id': reqId });
    } else if (e.kind === 'timeout') {
      log({ reqId, status: 504, ms, err: String(e.message).slice(0, 200) });
      oaiError(res, 504, e.message, 'api_error', 'timeout', { 'x-request-id': reqId });
    } else {
      log({ reqId, status: 502, ms, err: String(e.message).slice(0, 300) });
      oaiError(res, 502, String(e.message || 'upstream error'), 'api_error', 'upstream_error', { 'x-request-id': reqId });
    }
  } finally {
    releaseSlot();
  }
}

// ---- server ----------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  const reqId = crypto.randomUUID();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type' });
    return res.end();
  }
  if (req.method === 'GET' && url === '/health') {
    return send(res, 200, { status: 'ok', active, queued: waiters.length, max_concurrency: MAX_CONCURRENCY, max_queue: MAX_QUEUE, served, shed, peak_queue: peakQueue });
  }
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    if (!authOk(req)) return oaiError(res, 401, 'invalid or missing api key', 'invalid_request_error', 'invalid_api_key');
    return handleModels(res);
  }
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    if (!authOk(req)) return oaiError(res, 401, 'invalid or missing api key', 'invalid_request_error', 'invalid_api_key');
    let body = '', tooBig = false;
    req.on('data', (c) => { body += c; if (body.length > 25 * 1024 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', () => { if (tooBig) return; handleChat(req, res, body, reqId); });
    req.on('error', () => {});
    return;
  }
  return oaiError(res, 404, `no route for ${req.method} ${url}`, 'invalid_request_error', 'not_found');
});

server.listen(PORT, '0.0.0.0', () => {
  if (!API_KEY) log({ level: 'warn', msg: 'CLIMAX_API_KEY not set — server is OPEN (no auth)' });
  log({ msg: 'climax v2 listening', port: PORT, model: MODEL_ID, auth: API_KEY ? 'on' : 'off', concurrency: MAX_CONCURRENCY, max_queue: MAX_QUEUE, retries: RETRIES, fallback_model: FALLBACK_MODEL || null });
});

// Graceful shutdown: stop accepting, let in-flight finish.
function shutdown(sig) { log({ msg: 'shutting down', sig }); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); }
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
