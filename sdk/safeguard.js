/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — PII & Secrets Safeguard Utility
 *
 *  Regex-based sanitization of prompts, RAG context, sandbox
 *  commands, stdout, stderr, and any other text before it gets
 *  logged, stored, or echoed back — so an accidentally pasted key
 *  or personal identifier never ends up committed to the vault.
 * ══════════════════════════════════════════════════════════════
 */

// Regular expressions for secrets and PII patterns. Broad provider coverage
// (AI/LLM providers, cloud, source control, payments, comms, DB URLs, and
// PEM/JWT formats) so a pasted credential from any common service gets
// caught, not just the one or two a project happens to use itself.
const PATTERNS = {
  openaiKey: /\bsk-[a-zA-Z0-9]{48}\b/g,
  openaiProjKey: /\bsk-(?:proj|svcacct)-[a-zA-Z0-9-_]{40,}\b/g,
  anthropicKey: /\bsk-ant-(?:api03|admin01)-[a-zA-Z0-9\-_]{80,}\b/g,
  geminiKey: /\bAIzaSy[a-zA-Z0-9-_]{33}\b/g,
  xaiKey: /\bxai-[a-zA-Z0-9]{40,}\b/g,
  cohereKey: /\b[a-zA-Z0-9]{40}\b(?=.{0,20}cohere)/gi,
  groqKey: /\bgsk_[a-zA-Z0-9]{20,}\b/g,
  huggingfaceToken: /\bhf_[a-zA-Z0-9]{20,}\b/g,
  replicateToken: /\br8_[a-zA-Z0-9]{20,}\b/g,
  perplexityKey: /\bpplx-[a-zA-Z0-9]{20,}\b/g,
  mistralKey: /\b[a-zA-Z0-9]{32}\b(?=.{0,20}mistral)/gi,
  openrouterKey: /\bsk-or-v1-[a-zA-Z0-9]{20,}\b/g,
  togetherKey: /\btgp_v1_[a-zA-Z0-9_-]{20,}\b/g,
  deepseekKey: /\bsk-[a-zA-Z0-9]{32}\b(?=.{0,20}deepseek)/gi,
  awsAccessKeyId: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  azureKey: /\b[a-zA-Z0-9+/]{88}==\b(?=.{0,20}azure)/gi,
  gcpApiKey: /\bAIza[a-zA-Z0-9_-]{35}\b/g,
  digitaloceanToken: /\bdo[a-z]*_v1_[a-f0-9]{64}\b/g,
  githubToken: /\bgh[pousr]_[a-zA-Z0-9]{36,}\b/g,
  githubFineGrainedToken: /\bgithub_pat_[a-zA-Z0-9_]{20,}\b/g,
  gitlabToken: /\bglpat-[a-zA-Z0-9_-]{20,}\b/g,
  npmToken: /\bnpm_[a-zA-Z0-9]{36}\b/g,
  pypiToken: /\bpypi-AgEIcHlwaS5vcmc[a-zA-Z0-9_-]{20,}\b/g,
  slackToken: /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g,
  stripeKey: /\b(?:sk|pk|rk)_(?:live|test)_[a-zA-Z0-9]{20,}\b/g,
  squareToken: /\bsq0[a-z]{3}-[a-zA-Z0-9_-]{20,}\b/g,
  twilioKey: /\bSK[a-f0-9]{32}\b/g,
  sendgridKey: /\bSG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}\b/g,
  mailgunKey: /\bkey-[a-f0-9]{32}\b/g,
  discordToken: /\b[MN][a-zA-Z0-9_-]{23,}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,}\b/g,
  telegramBotToken: /\b\d{8,10}:[a-zA-Z0-9_-]{35}\b/g,
  shopifyToken: /\bshp(?:at|ss|ca)_[a-fA-F0-9]{32}\b/g,
  dbUrlGeneric: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:[^\s/@]+@[^\s]+/gi,
  privateKeyPem: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/g,
  jwt: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,7}\b/g,
  // Matched separately and validated with a Luhn checksum below — a bare
  // 16-digit regex (the naive approach) flags plenty of non-card numbers
  // (order IDs, hashes, phone sequences) as credit cards.
  // Anchored to start AND end on a digit (not `(?:\d[ -]?){13,19}`, which
  // can greedily swallow a trailing space/dash into the match and merge the
  // redaction into the following word).
  creditCard: /\b\d(?:[ -]?\d){12,18}\b/g,
  // Matches generic API Key assignments, capturing the secret
  genericApiKey: /\b(api[_-]key|auth[_-]token|bearer|password|secret|token)\s*[:=]\s*['"]?([a-zA-Z0-9-._~+/]{12,})['"]?/gi,
};

// Luhn checksum — the credit-card regex alone over-matches (any 13-19 digit
// run: order numbers, hashes, phone numbers). Requiring a valid Luhn digit
// keeps false positives rare.
function isLuhnValid(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * Sanitizes input text by redacting API keys, secrets, and PII.
 * @param {string} text - The raw input content to sanitize
 * @returns {string} The sanitized text with placeholders
 */
export function sanitizeContent(text) {
  if (typeof text !== 'string' || !text) return text;

  let sanitized = text;

  // Redact specific known API Key types
  sanitized = sanitized.replace(PATTERNS.openaiKey, '[REDACTED_OPENAI_KEY]');
  sanitized = sanitized.replace(PATTERNS.openaiProjKey, '[REDACTED_OPENAI_KEY]');
  sanitized = sanitized.replace(PATTERNS.anthropicKey, '[REDACTED_ANTHROPIC_KEY]');
  sanitized = sanitized.replace(PATTERNS.geminiKey, '[REDACTED_GEMINI_KEY]');
  sanitized = sanitized.replace(PATTERNS.xaiKey, '[REDACTED_XAI_KEY]');
  sanitized = sanitized.replace(PATTERNS.cohereKey, '[REDACTED_COHERE_KEY]');
  sanitized = sanitized.replace(PATTERNS.groqKey, '[REDACTED_GROQ_KEY]');
  sanitized = sanitized.replace(PATTERNS.huggingfaceToken, '[REDACTED_HUGGINGFACE_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.replicateToken, '[REDACTED_REPLICATE_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.perplexityKey, '[REDACTED_PERPLEXITY_KEY]');
  sanitized = sanitized.replace(PATTERNS.mistralKey, '[REDACTED_MISTRAL_KEY]');
  sanitized = sanitized.replace(PATTERNS.openrouterKey, '[REDACTED_OPENROUTER_KEY]');
  sanitized = sanitized.replace(PATTERNS.togetherKey, '[REDACTED_TOGETHER_KEY]');
  sanitized = sanitized.replace(PATTERNS.deepseekKey, '[REDACTED_DEEPSEEK_KEY]');
  sanitized = sanitized.replace(PATTERNS.awsAccessKeyId, '[REDACTED_AWS_KEY]');
  sanitized = sanitized.replace(PATTERNS.azureKey, '[REDACTED_AZURE_KEY]');
  sanitized = sanitized.replace(PATTERNS.gcpApiKey, '[REDACTED_GCP_KEY]');
  sanitized = sanitized.replace(PATTERNS.digitaloceanToken, '[REDACTED_DIGITALOCEAN_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.githubToken, '[REDACTED_GITHUB_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.githubFineGrainedToken, '[REDACTED_GITHUB_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.gitlabToken, '[REDACTED_GITLAB_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.npmToken, '[REDACTED_NPM_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.pypiToken, '[REDACTED_PYPI_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.slackToken, '[REDACTED_SLACK_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.stripeKey, '[REDACTED_STRIPE_KEY]');
  sanitized = sanitized.replace(PATTERNS.squareToken, '[REDACTED_SQUARE_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.twilioKey, '[REDACTED_TWILIO_KEY]');
  sanitized = sanitized.replace(PATTERNS.sendgridKey, '[REDACTED_SENDGRID_KEY]');
  sanitized = sanitized.replace(PATTERNS.mailgunKey, '[REDACTED_MAILGUN_KEY]');
  sanitized = sanitized.replace(PATTERNS.discordToken, '[REDACTED_DISCORD_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.telegramBotToken, '[REDACTED_TELEGRAM_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.shopifyToken, '[REDACTED_SHOPIFY_TOKEN]');
  sanitized = sanitized.replace(PATTERNS.dbUrlGeneric, '[REDACTED_DB_URL]');
  sanitized = sanitized.replace(PATTERNS.privateKeyPem, '[REDACTED_PRIVATE_KEY]');
  sanitized = sanitized.replace(PATTERNS.jwt, '[REDACTED_JWT]');

  // Redact PII patterns
  sanitized = sanitized.replace(PATTERNS.ssn, '[REDACTED_SSN]');
  sanitized = sanitized.replace(PATTERNS.email, '[REDACTED_EMAIL]');
  // Only redact a matched digit run if it actually passes a Luhn checksum —
  // the bare regex alone matches plenty of non-card numbers (order IDs,
  // hashes, phone numbers) that would otherwise be redacted needlessly.
  sanitized = sanitized.replace(PATTERNS.creditCard, (match) => {
    const digits = match.replace(/[ -]/g, '');
    if (digits.length < 13 || digits.length > 19 || !isLuhnValid(digits)) return match;
    return '[REDACTED_CREDIT_CARD]';
  });

  // Redact generic secrets (preserving the key structure)
  sanitized = sanitized.replace(PATTERNS.genericApiKey, (match, keyLabel) => {
    // Preserve the key identifier and just redact the value
    return `${keyLabel}: "[REDACTED_SECRET]"`;
  });

  return sanitized;
}
