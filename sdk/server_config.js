const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Validate the REST API bind address before opening a socket.
 * Non-loopback listeners require an API key so the vault is never exposed
 * over the network by an unset or misspelled host configuration.
 */
export function validateServerConfig(host, apiKey) {
  if (!LOOPBACK_HOSTS.has(host) && !apiKey) {
    throw new Error(
      `BRAIN_HOST=${host} exposes the API beyond loopback. Set BRAIN_KEY or bind to 127.0.0.1.`,
    );
  }
  return { host, apiKey };
}
