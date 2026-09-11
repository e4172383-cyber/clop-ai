'use strict';

const DEFAULT_SERVER = 'https://clop.195-201-169-74.sslip.io';
const SERVER_CONFIG_URL = 'https://e4172383-cyber.github.io/clop-ai/server.json';

function normalizeServerUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    if (url.pathname !== '/' && url.pathname !== '') return '';
    return url.origin;
  } catch { return ''; }
}

async function resolveServer({ fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 5_000 } = {}) {
  const override = normalizeServerUrl(env.CLOP_SERVER_URL);
  if (override) return { url: override, source: 'environment' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(SERVER_CONFIG_URL, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = normalizeServerUrl((await response.json())?.apiBase);
    if (remote) return { url: remote, source: 'remote-config' };
  } catch {} finally { clearTimeout(timer); }
  return { url: DEFAULT_SERVER, source: 'bundled-fallback' };
}

module.exports = { DEFAULT_SERVER, SERVER_CONFIG_URL, normalizeServerUrl, resolveServer };
