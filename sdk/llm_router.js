/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Unified LLM Router
 *
 *  Single place that knows how to call every supported LLM backend
 *  (Anthropic Claude, NVIDIA NIM, Google Gemini, OpenAI-compatible,
 *  and local Ollama) and fall through a configurable priority chain
 *  when a provider is missing a key or fails. Any module in this
 *  codebase that needs an LLM call (dedup.js's judge, etc.) uses this
 *  instead of re-implementing HTTP plumbing per provider.
 *
 *  Uses Node's built-in fetch (Node >= 18) — no dependency added.
 *  With no API keys configured at all, every cloud provider is
 *  simply skipped and the chain falls through to Ollama (a local,
 *  optional install) — no required dependency, no crash.
 * ══════════════════════════════════════════════════════════════
 */

import { MODELS, PROVIDER_ORDER } from './models_config.js';

// Smaller / less strictly instruction-tuned models (the NVIDIA and Ollama
// fallback tiers especially) reliably get the JSON *structure* right but
// forget to escape control characters inside a string value — e.g. a
// multi-paragraph "message" field with real newlines instead of "\n", or a
// stray tab. That's invalid JSON that JSON.parse rejects outright even
// though the response is otherwise perfectly usable, which previously threw
// away a good answer and forced a fallback to the next (weaker or costlier)
// provider for no real reason. Walk the text tracking whether we're inside a
// string literal (respecting backslash-escapes so we don't get confused by
// an escaped quote) and escape raw control characters only there — anything
// outside a string (formatting whitespace between tokens) is untouched.
const JSON_SHORT_ESCAPES = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f' };

function escapeRawControlCharsInStrings(text) {
  let out = '';
  let inString = false;
  let escapedNext = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escapedNext) {
      out += ch;
      escapedNext = false;
      continue;
    }
    if (ch === '\\') { out += ch; escapedNext = true; continue; }
    if (ch === '"') { out += ch; inString = false; continue; }
    const code = text.charCodeAt(i);
    if (code < 0x20) {
      // Any raw C0 control character is invalid inside a JSON string, not
      // just newline/CR/tab — use the short escape where JSON defines one,
      // otherwise fall back to a \u00XX escape.
      out += JSON_SHORT_ESCAPES[ch] || `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function tryParseJSON(candidate) {
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  try { return JSON.parse(escapeRawControlCharsInStrings(candidate)); } catch { return undefined; }
}

// ── JSON extraction ──────────────────────────────────────────────────────────
// LLMs sometimes wrap JSON in markdown fences or add stray prose. This pulls
// out the first well-formed JSON object/array, trying the whole string first.
export function extractJSON(text) {
  if (typeof text !== 'string') throw new Error('No text to parse as JSON');
  const trimmed = text.trim();

  let result = tryParseJSON(trimmed);
  if (result !== undefined) return result;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    result = tryParseJSON(fenced[1].trim());
    if (result !== undefined) return result;
  }

  const first = trimmed.indexOf('{');
  const last  = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    result = tryParseJSON(trimmed.slice(first, last + 1));
    if (result !== undefined) return result;
  }

  throw new Error(`Could not extract valid JSON from response: ${trimmed.slice(0, 200)}`);
}

// ── Provider callers (all return raw text) ────────────────────────────────────
// A hung provider (dead DNS, a stalled proxy, a silently dropped connection)
// must not block the whole fallback chain indefinitely — every call gets an
// upper bound. Ollama runs a local model and can be much slower to warm up
// or generate on CPU, so it gets a longer allowance than the cloud APIs.
const CLOUD_TIMEOUT_MS  = 30_000;
const OLLAMA_TIMEOUT_MS = 120_000;

// Default output budget/temperature for every provider call. Callers that
// know a response will be long-form can override via opts.maxTokens — see
// routeLLM's JSDoc.
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.2;

async function callAnthropic(apiKey, systemPrompt, userPrompt, { json = false, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, temperature = DEFAULT_TEMPERATURE } = {}) {
  const cfg = MODELS.anthropic;
  const effectiveSystem = json
    ? `${systemPrompt}\n\nRespond ONLY with valid JSON. No markdown fences, no commentary.`
    : systemPrompt;

  const res = await fetch(`${cfg.apiBase}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': cfg.version,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      temperature,
      system: effectiveSystem,
      messages: [{ role: 'user', content: userPrompt }],
    }),
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = (data.content || []).map(block => block.text || '').join('');
  if (!text) throw new Error('Anthropic returned no content');
  return text;
}

async function callOpenAICompatible(apiKey, apiBase, model, systemPrompt, userPrompt, { json = false, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, temperature = DEFAULT_TEMPERATURE } = {}) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('No content in chat completion response');
  return text;
}

async function callGemini(apiKey, systemPrompt, userPrompt, { json = false, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, temperature = DEFAULT_TEMPERATURE } = {}) {
  const model = MODELS.gemini.model;
  const generationConfig = { temperature, maxOutputTokens: maxTokens };
  if (json) generationConfig.responseMimeType = 'application/json';

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${systemPrompt}\n\nUser request:\n${userPrompt}` }] }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No content generated by Gemini');
  return text;
}

async function callOllama(host, model, systemPrompt, userPrompt, { json = false, maxTokens = DEFAULT_MAX_OUTPUT_TOKENS, temperature = DEFAULT_TEMPERATURE } = {}) {
  const res = await fetch(new URL('/api/chat', host), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      options: { temperature, num_predict: maxTokens },
      ...(json ? { format: 'json' } : {}),
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  }).catch(e => { throw new Error(`Ollama connection failed: ${e.message}. Make sure Ollama is running at ${host}`); });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const text = data.message?.content;
  if (!text) throw new Error('No content in Ollama response');
  return text;
}

// ── Provider availability & dispatch ───────────────────────────────────────────
function isConfigured(provider, keys) {
  switch (provider) {
    case 'anthropic': return !!keys.anthropicKey;
    case 'nvidia':    return !!keys.nvidiaKey;
    case 'gemini':    return !!keys.geminiKey;
    case 'openai':    return !!keys.openaiKey;
    case 'ollama':    return true; // always the last-resort local fallback
    default:          return false;
  }
}

async function callProvider(provider, keys, systemPrompt, userPrompt, opts) {
  switch (provider) {
    case 'anthropic':
      return callAnthropic(keys.anthropicKey, systemPrompt, userPrompt, opts);
    case 'nvidia':
      return callOpenAICompatible(keys.nvidiaKey, MODELS.nvidia.apiBase, MODELS.nvidia.model, systemPrompt, userPrompt, opts);
    case 'gemini':
      return callGemini(keys.geminiKey, systemPrompt, userPrompt, opts);
    case 'openai':
      return callOpenAICompatible(keys.openaiKey, MODELS.openai.apiBase, MODELS.openai.model, systemPrompt, userPrompt, opts);
    case 'ollama':
      return callOllama(keys.ollamaHost, keys.ollamaModel, systemPrompt, userPrompt, opts);
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}

/**
 * Route an LLM call through the configured provider priority chain,
 * falling through to the next provider on any failure (missing key,
 * network error, bad JSON, a shape that fails `validate`, rate limit, etc).
 *
 * @param {object}   keys         - from models_config.resolveKeys()
 * @param {string}   systemPrompt
 * @param {string}   userPrompt
 * @param {object}   opts         - { json?, logFn?, validate?, maxTokens?, temperature? }
 * @param {(obj: object) => true | string} [opts.validate] - only used when
 *   json is true. Return true to accept the parsed object, or an error
 *   string to reject it — a rejection is treated the same as a network
 *   error or bad JSON and falls through to the next provider. This catches
 *   the case a provider returns syntactically valid JSON in the wrong
 *   shape, which would otherwise silently reach — and break — whatever
 *   calls routeLLM.
 * @param {number}   [opts.maxTokens] - output token budget, forwarded to
 *   every provider's own max-output-tokens param. Defaults to a
 *   conservative 4096; pass a larger value for calls expected to produce
 *   long-form output to avoid silent mid-response truncation.
 * @returns {Promise<string|object>} raw text, or parsed JSON if opts.json
 */
export async function routeLLM(keys, systemPrompt, userPrompt, opts = {}) {
  const { json = false, logFn = () => {}, validate, maxTokens, temperature } = opts;
  const order = order_for(keys);
  const errors = [];

  for (const provider of order) {
    try {
      const text = await callProvider(provider, keys, systemPrompt, userPrompt, { json, maxTokens, temperature });
      const result = json ? extractJSON(text) : text;
      if (json && validate) {
        const verdict = validate(result);
        if (verdict !== true) throw new Error(`Response failed validation: ${verdict}`);
      }
      return result;
    } catch (err) {
      errors.push(`${provider}: ${err.message}`);
      logFn(`[llm] ${provider} call failed, falling back: ${err.message}`);
    }
  }

  throw new Error(`All LLM providers failed.\n${errors.join('\n')}`);
}

function order_for(keys) {
  return PROVIDER_ORDER.filter(p => isConfigured(p, keys));
}

/** Returns the provider that would be used first for the given keys (for status/logging). */
export function activeProvider(keys) {
  const order = order_for(keys);
  return order[0] || 'none';
}

export { MODELS, PROVIDER_ORDER };
