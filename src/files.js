// Модель заворачивает файлы многофайлового ответа (сайт/проект) в маркеры
// %%%FILE путь%%% ... %%%ENDFILE%%%  (см. SYSTEM_PROMPT). Здесь их достаём
// и убираем из текста, который уходит в чат.

const FILE_RE = /%%%FILE\s+([^\n%]+?)\s*%%%\r?\n([\s\S]*?)%%%ENDFILE%%%\r?\n?/g;

const MAX_FILES = 60;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const MIME_BY_EXT = new Map([
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.ts', 'text/typescript; charset=utf-8'],
  ['.tsx', 'text/typescript; charset=utf-8'],
  ['.jsx', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.py', 'text/x-python; charset=utf-8'],
  ['.java', 'text/x-java-source; charset=utf-8'],
  ['.c', 'text/x-c; charset=utf-8'],
  ['.h', 'text/x-c; charset=utf-8'],
  ['.cpp', 'text/x-c++; charset=utf-8'],
  ['.hpp', 'text/x-c++; charset=utf-8'],
  ['.rs', 'text/x-rust; charset=utf-8'],
  ['.go', 'text/x-go; charset=utf-8'],
  ['.sh', 'text/x-shellscript; charset=utf-8'],
  ['.ps1', 'text/plain; charset=utf-8'],
  ['.yml', 'application/yaml; charset=utf-8'],
  ['.yaml', 'application/yaml; charset=utf-8'],
]);

export function mimeForPath(filePath) {
  const normalized = String(filePath || '').toLowerCase();
  const dot = normalized.lastIndexOf('.');
  return MIME_BY_EXT.get(dot >= 0 ? normalized.slice(dot) : '') || 'text/plain; charset=utf-8';
}

// Desktop-клиенту нужны отдельные файлы, а не только zip сайта. Маркеры
// содержат UTF-8 текст, поэтому безопасно передаём его как base64 и вместе с
// ним возвращаем размер и MIME — приложение сможет сохранить всё на диск.
export function filesForJson(files) {
  return files.map((file) => {
    const data = Buffer.from(String(file.content ?? ''), 'utf8');
    return {
      name: file.path,
      path: file.path,
      mimeType: mimeForPath(file.path),
      size: data.length,
      encoding: 'base64',
      data: data.toString('base64'),
    };
  });
}

function sanitizePath(raw) {
  let s = String(raw).trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!s) return null;
  if (s.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (/^[a-zA-Z]:/.test(s)) return null;
  if (s.length > 240) return null;
  return s;
}

export function extractFiles(text) {
  const files = [];
  let totalBytes = 0;
  FILE_RE.lastIndex = 0;
  let m;
  while ((m = FILE_RE.exec(text))) {
    if (files.length >= MAX_FILES) break;
    const path = sanitizePath(m[1]);
    if (!path) continue;
    const content = m[2];
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_TOTAL_BYTES) break;
    files.push({ path, content });
  }

  // Ответ мог оборваться по лимиту длины прямо посреди файла — тогда маркер
  // %%%FILE открылся, а %%%ENDFILE%%% так и не пришёл. Ловим это отдельно,
  // чтобы не показывать пользователю сырой недописанный код в чате.
  let cleanText = text.replace(FILE_RE, '');
  let truncated = null;
  let truncatedContent = '';
  const dangling = cleanText.match(/%%%FILE\s+([^\n%]+)%%%/);
  if (dangling) {
    truncated = sanitizePath(dangling[1]) || dangling[1].trim();
    truncatedContent = cleanText.slice(dangling.index + dangling[0].length).replace(/^\r?\n/, '');
    cleanText = cleanText.slice(0, dangling.index);
  }
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  if (!files.length && !truncated) {
    return { files: [], cleanText: text, truncated: null, truncatedContent: '' };
  }
  return { files, cleanText, truncated, truncatedContent };
}
