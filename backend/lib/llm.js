'use strict';
// On-prem LLM client for the Operator Advisor.
//
// Talks to a LOCAL, OpenAI-compatible chat endpoint — Ollama (`/v1`), vLLM, llama.cpp
// server, LocalAI — so rig telemetry NEVER leaves the site (ONGC data-residency).
// Open-weights models like Gemma / Mistral / Llama are the target. Disabled by default;
// when no endpoint is reachable the advisor falls back to deterministic rule-based
// guidance, so the feature works with or without a model. No external SaaS, no new deps
// (uses Node http/https, same as the sync agent).
const http = require('http');
const https = require('https');
const { URL } = require('url');

const cfg = {
    enabled: String(process.env.LLM_ENABLED || 'false').toLowerCase() === 'true',
    // Default targets a host/sidecar Ollama; in production point at the internal model service.
    baseUrl: (process.env.LLM_BASE_URL || 'http://host.docker.internal:11434/v1').replace(/\/$/, ''),
    model: process.env.LLM_MODEL || 'gemma2:2b',
    apiKey: process.env.LLM_API_KEY || '',          // dummy ok for Ollama; some servers require it
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 20000),
};

let lastProbe = null; // { ok, at }

function postJson(urlStr, body, timeoutMs) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(urlStr); } catch { return resolve({ ok: false, err: 'bad LLM_BASE_URL' }); }
        const lib = u.protocol === 'https:' ? https : http;
        const payload = Buffer.from(JSON.stringify(body));
        const headers = { 'Content-Type': 'application/json', 'Content-Length': payload.length };
        if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
        const req = lib.request(u, { method: 'POST', headers, timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on('data', (d) => chunks.push(d));
            res.on('end', () => {
                const txt = Buffer.concat(chunks).toString();
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return resolve({ ok: false, status: res.statusCode, err: `model HTTP ${res.statusCode}` });
                }
                try { resolve({ ok: true, json: JSON.parse(txt) }); }
                catch { resolve({ ok: false, err: 'bad json from model' }); }
            });
        });
        req.on('error', (e) => resolve({ ok: false, err: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, err: 'timeout' }); });
        req.end(payload);
    });
}

// messages: [{ role, content }]. Returns { ok, text } or { ok:false, err }.
async function chat(messages, { temperature = 0.2, maxTokens = 500 } = {}) {
    if (!cfg.enabled) return { ok: false, err: 'LLM disabled' };
    const r = await postJson(`${cfg.baseUrl}/chat/completions`, {
        model: cfg.model, messages, temperature, max_tokens: maxTokens, stream: false,
    }, cfg.timeoutMs);
    lastProbe = { ok: r.ok, at: Date.now() };
    if (!r.ok) return r;
    const text = r.json?.choices?.[0]?.message?.content?.trim() || '';
    return text ? { ok: true, text } : { ok: false, err: 'empty completion' };
}

function status() {
    return {
        enabled: cfg.enabled,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        reachable: lastProbe ? lastProbe.ok : null,   // null until first call
        checkedAt: lastProbe ? new Date(lastProbe.at).toISOString() : null,
    };
}

module.exports = { chat, status, config: cfg };
