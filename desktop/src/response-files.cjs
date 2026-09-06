'use strict';

const path = require('node:path');

const RESPONSE_FILE_KEYS = ['files', 'outputFiles', 'output_files', 'artifacts', 'attachments'];
const FILE_MARKER = /%%%FILE\s+([^\n%]+?)\s*%%%\r?\n([\s\S]*?)%%%ENDFILE%%%\r?\n?/g;

const MIME_BY_EXTENSION = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
};

function sanitizeOutputName(value, index = 0) {
  const lastSegment = String(value || '').split(/[\\/]/).filter(Boolean).pop() || '';
  let name = lastSegment
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!name) name = `file-${index + 1}.bin`;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/i.test(name)) name = `_${name}`;
  if (name.length > 180) {
    const extension = path.extname(name).slice(0, 24);
    name = `${name.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
  }
  return name;
}

function normalizeMimeType(value, name = '') {
  const raw = String(value || '').split(';', 1)[0].trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(raw)) return raw;
  return MIME_BY_EXTENSION[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

function responseFileCandidates(response) {
  if (!response || typeof response !== 'object') return [];
  const candidates = [];
  for (const key of RESPONSE_FILE_KEYS) {
    if (Array.isArray(response[key])) candidates.push(...response[key]);
  }
  if (response.file && typeof response.file === 'object' && !Array.isArray(response.file)) candidates.push(response.file);
  return candidates.filter((item) => item && typeof item === 'object' && !Array.isArray(item));
}

function candidateFingerprint(item) {
  const data = typeof item.data === 'string' ? item.data : (typeof item.base64 === 'string' ? item.base64 : '');
  return [
    item.id || item.file_id || '',
    item.download_url || item.downloadUrl || item.url || '',
    item.name || item.filename || item.file_name || item.path || '',
    item.size || '',
    data.length,
    data.slice(0, 48),
  ].join('\u0000');
}

function dedupeResponseFileCandidates(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const fingerprint = candidateFingerprint(item);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    result.push(item);
  }
  return result;
}

function extractMarkedFiles(value) {
  const files = [];
  const text = String(value || '').replace(FILE_MARKER, (_whole, requestedName, content) => {
    const name = sanitizeOutputName(requestedName, files.length);
    files.push({
      name,
      mime_type: normalizeMimeType('', name),
      content,
      encoding: 'utf8',
    });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text, files };
}

function extractResponseFiles(response, streamedCandidates = []) {
  const sourceText = String(response?.text || response?.answer || '');
  const marked = extractMarkedFiles(sourceText);
  return {
    text: marked.text,
    files: dedupeResponseFileCandidates([
      ...streamedCandidates,
      ...responseFileCandidates(response),
      ...marked.files,
    ]),
  };
}

function normalizeResponseFileCandidate(raw, index = 0) {
  const requestedName = raw.name || raw.filename || raw.file_name || raw.path;
  const name = sanitizeOutputName(requestedName, index);
  const dataUrlMime = typeof raw.data === 'string' ? raw.data.match(/^data:([^;,]+)/i)?.[1] : '';
  const mimeType = normalizeMimeType(
    raw.mime_type || raw.mimeType || raw.mime || raw.content_type || raw.contentType || dataUrlMime || raw.type,
    name,
  );
  const declaredSize = Number(raw.size);
  const url = raw.download_url || raw.downloadUrl || raw.url || '';
  return {
    raw,
    name,
    mimeType,
    declaredSize: Number.isFinite(declaredSize) && declaredSize >= 0 ? Math.round(declaredSize) : null,
    url: typeof url === 'string' ? url.trim() : '',
  };
}

function decodeBase64(value, maxBytes) {
  let encoded = String(value || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!encoded) return Buffer.alloc(0);
  if (!/^[a-z0-9+/]*={0,2}$/i.test(encoded) || encoded.length % 4 === 1) {
    throw new Error('Файл содержит некорректные данные base64.');
  }
  const paddingIndex = encoded.indexOf('=');
  if (paddingIndex >= 0 && paddingIndex < encoded.length - 2) throw new Error('Файл содержит некорректные данные base64.');
  const estimatedBytes = Math.floor((encoded.length * 3) / 4);
  if (estimatedBytes > maxBytes + 2) throw new Error('Файл от ИИ превышает допустимый размер.');
  while (encoded.length % 4) encoded += '=';
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > maxBytes) throw new Error('Файл от ИИ превышает допустимый размер.');
  return buffer;
}

function decodeInlineResponseFile(raw, maxBytes) {
  if (raw?.data && typeof raw.data === 'object' && raw.data.type === 'Buffer' && Array.isArray(raw.data.data)) {
    if (raw.data.data.length > maxBytes) throw new Error('Файл от ИИ превышает допустимый размер.');
    return Buffer.from(raw.data.data);
  }

  if (typeof raw?.base64 === 'string') return decodeBase64(raw.base64, maxBytes);
  if (typeof raw?.content === 'string') {
    if (String(raw.encoding || '').toLowerCase() === 'base64') return decodeBase64(raw.content, maxBytes);
    const buffer = Buffer.from(raw.content, 'utf8');
    if (buffer.length > maxBytes) throw new Error('Файл от ИИ превышает допустимый размер.');
    return buffer;
  }
  if (typeof raw?.data !== 'string') return null;

  const dataUrl = raw.data.match(/^data:([^,]*?),(.*)$/s);
  if (dataUrl) {
    const metadata = dataUrl[1];
    if (/(?:^|;)base64(?:;|$)/i.test(metadata)) return decodeBase64(dataUrl[2], maxBytes);
    let decoded;
    try { decoded = decodeURIComponent(dataUrl[2]); } catch { throw new Error('Файл содержит некорректный data URL.'); }
    const buffer = Buffer.from(decoded, 'utf8');
    if (buffer.length > maxBytes) throw new Error('Файл от ИИ превышает допустимый размер.');
    return buffer;
  }

  if (String(raw.encoding || '').toLowerCase() === 'utf8' || String(raw.encoding || '').toLowerCase() === 'text') {
    const buffer = Buffer.from(raw.data, 'utf8');
    if (buffer.length > maxBytes) throw new Error('Файл от ИИ превышает допустимый размер.');
    return buffer;
  }
  return decodeBase64(raw.data, maxBytes);
}

module.exports = {
  dedupeResponseFileCandidates,
  decodeInlineResponseFile,
  extractMarkedFiles,
  extractResponseFiles,
  normalizeMimeType,
  normalizeResponseFileCandidate,
  responseFileCandidates,
  sanitizeOutputName,
};
