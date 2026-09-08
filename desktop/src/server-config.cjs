'use strict';

const DEFAULT_SERVER = 'https://clop-ai.onrender.com';
const SERVER_CONFIG_URL = 'https://e4172383-cyber.github.io/clop-ai/server.json';
const GITHUB_RELEASE_PREFIX = '/e4172383-cyber/clop-ai/releases/download/';

function normalizeServerUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    if (url.pathname !== '/' && url.pathname !== '') return '';
    return url.origin;
  } catch {
    return '';
  }
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
    const config = await response.json();
    const remote = normalizeServerUrl(config?.apiBase);
    if (remote) return { url: remote, source: 'remote-config' };
  } catch {
    // Keep a bundled address so startup still works if the tiny configuration
    // file is briefly unavailable.
  } finally {
    clearTimeout(timer);
  }
  return { url: DEFAULT_SERVER, source: 'bundled-fallback' };
}

function trustedUpdateUrl(value, { platform = process.platform, serverBase = DEFAULT_SERVER } = {}) {
  let url;
  try { url = new URL(String(value || '')); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
  const suffix = platform === 'linux' ? '.tar.xz' : '.exe';
  const filenamePrefix = platform === 'linux' ? 'Clop-Code-' : 'Clop-Code-Setup-';
  if (!url.pathname.endsWith(suffix) || !url.pathname.split('/').pop()?.startsWith(filenamePrefix)) return false;

  const configured = normalizeServerUrl(serverBase);
  if (configured && url.origin === configured && url.pathname.startsWith('/downloads/')) return true;
  return url.origin === 'https://github.com' && url.pathname.startsWith(GITHUB_RELEASE_PREFIX);
}

module.exports = { DEFAULT_SERVER, SERVER_CONFIG_URL, normalizeServerUrl, resolveServer, trustedUpdateUrl };
