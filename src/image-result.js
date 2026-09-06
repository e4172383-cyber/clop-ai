import fs from 'node:fs';
import path from 'node:path';

const IMAGE_EXT = /\.(?:png|jpe?g|webp)$/i;

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeCandidate(root, value, started) {
  const candidate = path.resolve(String(value || '').trim());
  if (!inside(root, candidate) || !IMAGE_EXT.test(candidate)) return null;
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() && stat.mtimeMs >= started - 5_000 ? candidate : null;
  } catch {
    return null;
  }
}

function pathsFromJsonStream(stdout) {
  const paths = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const text = event?.item?.type === 'agent_message' ? String(event.item.text || '') : '';
      for (const match of text.matchAll(/`([^`\r\n]+\.(?:png|jpe?g|webp))`/gi)) paths.push(match[1]);
    } catch { /* incomplete/non-JSON diagnostic line */ }
  }
  return paths;
}

function recentImages(dir, root, started, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) recentImages(full, root, started, out);
    else if (entry.isFile() && IMAGE_EXT.test(entry.name)) {
      const candidate = safeCandidate(root, full, started);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

export function findGeneratedImage(stdout, codexHome, started) {
  const root = path.resolve(codexHome, 'generated_images');
  const fromStream = pathsFromJsonStream(stdout)
    .map((value) => safeCandidate(root, value, started))
    .filter(Boolean);
  if (fromStream.length) return fromStream.at(-1);

  // Older Codex versions may omit the path from the final message. Accept a
  // filesystem fallback only when exactly one fresh image exists, avoiding a
  // mix-up between simultaneous users.
  const fallback = recentImages(root, root, started);
  return fallback.length === 1 ? fallback[0] : null;
}
