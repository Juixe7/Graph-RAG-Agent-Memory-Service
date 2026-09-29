/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Central Model Configuration
 *
 *  Single source of truth for every LLM/embedding model ID and API
 *  base URL used across the LLM router, dedup judge, and embeddings
 *  store. Every value is overridable via environment variable so an
 *  upgrade never requires touching code — just bump the env var
 *  (or the default below) in one place.
 * ══════════════════════════════════════════════════════════════
 */

export const PROVIDER_ORDER = (process.env.LLM_PROVIDER_ORDER || 'anthropic,nvidia,gemini,openai,ollama')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Hosted model IDs get retired by providers with little notice (NVIDIA NIM and
// OpenRouter's free tier churn especially fast) — if a provider starts failing
// across the board, check whether its model id here is still live before
// assuming a code bug.
export const MODELS = {
  anthropic: {
    model:   process.env.ANTHROPIC_MODEL   || 'claude-sonnet-5',
    apiBase: process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com/v1',
    version: process.env.ANTHROPIC_API_VERSION || '2023-06-01',
  },
  openai: {
    model:   process.env.OPENAI_MODEL   || 'gpt-5-mini',
    apiBase: process.env.OPENAI_API_BASE || 'https://api.openai.com/v1',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    // Deliberately separate from `apiBase` above: OPENAI_API_BASE is commonly
    // repointed at an OpenAI-compatible chat provider (OpenRouter, etc.),
    // which doesn't serve OpenAI's embeddings API at the same path.
    // Embeddings need a real OpenAI-compatible embeddings endpoint
    // regardless of where chat completions are routed.
    embeddingApiBase: process.env.OPENAI_EMBEDDING_API_BASE || 'https://api.openai.com/v1',
  },
  gemini: {
    model:   process.env.GEMINI_MODEL   || 'gemini-3.6-flash',
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001',
  },
  nvidia: {
    model:   process.env.NVIDIA_MODEL   || 'meta/llama-3.2-11b-vision-instruct',
    apiBase: process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com/v1',
  },
  ollama: {
    model: process.env.OLLAMA_MODEL || 'llama3.2:3b',
    host:  process.env.OLLAMA_HOST  || 'http://localhost:11434',
  },
};

/**
 * Resolve the full credential/config bundle for the LLM router,
 * merging explicit params (e.g. from an API request body) over
 * environment variables. Never mutates process.env.
 */
export function resolveKeys(params = {}) {
  return {
    anthropicKey: params.anthropicKey || process.env.ANTHROPIC_API_KEY || '',
    // OPENROUTER_API_KEY takes priority: a machine-wide OPENAI_API_KEY set by
    // some other tool (a real OpenAI key) would otherwise silently shadow a
    // project's .env value here and get sent to OPENAI_API_BASE if that's
    // pointed at OpenRouter — producing a confusing auth failure.
    openaiKey:    params.openaiKey    || process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || '',
    geminiKey:    params.geminiKey    || process.env.GEMINI_API_KEY    || '',
    nvidiaKey:    params.nvidiaKey    || process.env.NVIDIA_API_KEY    || '',
    ollamaHost:   params.ollamaHost   || MODELS.ollama.host,
    ollamaModel:  params.ollamaModel  || MODELS.ollama.model,
  };
}
