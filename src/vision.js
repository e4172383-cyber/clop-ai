import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/* Картинки для моделей.

   Оба CLI принимают изображения только файлами, поэтому присланное фото
   сначала ложится на диск, а после ответа удаляется. Папку заводим в системной
   временной, а не рядом с проектом: Claude ради картинок приходится пускать к
   инструменту чтения файлов, и чем дальше его рабочий каталог от исходников и
   настроек сервиса, тем спокойнее.

   Каждый запрос получает свою папку со случайным именем и видит только те
   файлы, что в неё положили. */

const ROOT = path.join(os.tmpdir(), 'clop-vision');

export const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGES = 4;

export const isImage = (name = '', mime = '') => IMAGE_EXTENSIONS.has(String(name).split('.').pop().toLowerCase())
  || /^image\/(png|jpe?g|gif|webp|bmp)$/i.test(mime);

// По первым байтам: расширение из имени может врать или отсутствовать вовсе
export function sniffExt(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 2 && buf.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

/* Кладёт картинки на диск и возвращает { dir, paths, names }.
   Принимает буферы; всё, что не опознано как картинка, отбрасывается. */
export function stash(buffers) {
  const list = (buffers || []).filter(Buffer.isBuffer).slice(0, MAX_IMAGES);
  if (!list.length) return null;

  const dir = path.join(ROOT, crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const paths = [], names = [];
  list.forEach((buf, i) => {
    if (buf.length > MAX_IMAGE_BYTES) return;
    const ext = sniffExt(buf);
    if (!ext) return;
    const name = `image${i + 1}.${ext}`;
    const p = path.join(dir, name);
    fs.writeFileSync(p, buf);
    paths.push(p);
    names.push(name);
  });
  if (!paths.length) { drop(dir); return null; }
  return { dir, paths, names };
}

export function drop(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* уже могло не быть */ }
}

// Разбирает data:image/...;base64,... — так картинки приходят с сайта и из приложения
export function fromDataUrl(s) {
  const m = /^data:(image\/[a-z+]+);base64,([\s\S]+)$/i.exec(String(s || ''));
  if (!m) return null;
  try {
    const buf = Buffer.from(m[2], 'base64');
    return buf.length && buf.length <= MAX_IMAGE_BYTES && sniffExt(buf) ? buf : null;
  } catch { return null; }
}

// Убираем папки, забытые из-за падения процесса: держать их вечно незачем
export function sweep(maxAgeMs = 60 * 60_000) {
  try {
    for (const name of fs.readdirSync(ROOT)) {
      const p = path.join(ROOT, name);
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > maxAgeMs) drop(p);
    }
  } catch { /* папки может не быть — это нормально */ }
}
