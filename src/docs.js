import zlib from 'node:zlib';

/* Чтение документов Microsoft 365 без внешних библиотек.

   .docx, .xlsx и .pptx — это обычные zip-архивы с XML внутри, поэтому всё,
   что нужно, — распаковать нужные части и вытащить из них текст. Свой
   распаковщик здесь не прихоть: тянуть зависимость ради трёх файлов дороже,
   чем полсотни строк, а формат zip за тридцать лет не поменялся.

   Разбираем не «правильным» XML-парсером, а по тегам: у офисных форматов
   разметка машинная и предсказуемая, а полноценный парсер на документе в
   мегабайт стоил бы заметно дороже. */

const EOCD = 0x06054b50;  // конец центрального каталога
const CEN = 0x02014b50;   // запись центрального каталога
const MAX_UNPACKED_ENTRY = 8 * 1024 * 1024;
const MAX_UNPACKED_TOTAL = 24 * 1024 * 1024;

/* ---------- распаковка zip ---------- */
function readZip(buf) {
  // Каталог лежит в конце файла, перед возможным комментарием — ищем с хвоста
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66_000; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('это не zip-архив');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const unpackedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    // Длины полей имени и extra в локальном заголовке свои, каталогу не равны
    if (localOff + 30 > buf.length) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    if (start > buf.length || compSize > buf.length - start) continue;
    // Отбрасываем очевидный zip-bomb до распаковки. Реальный предел ещё раз
    // применяется самим zlib, потому что размер из каталога нельзя считать
    // доверенным.
    if (unpackedSize > MAX_UNPACKED_ENTRY) continue;
    const chunk = buf.subarray(start, start + compSize);
    files.set(name, { method, chunk, unpackedSize });
  }
  files.unpackedBytes = 0;
  files.unpackedExhausted = false;
  return files;
}

function unpack(files, name) {
  const e = files.get(name);
  if (!e || files.unpackedExhausted) return null;
  try {
    let buf = null;
    if (e.method === 0) buf = e.chunk;
    if (e.method === 8) buf = zlib.inflateRawSync(e.chunk, { maxOutputLength: MAX_UNPACKED_ENTRY });
    if (!buf || buf.length > MAX_UNPACKED_ENTRY) return null;
    files.unpackedBytes += buf.length;
    if (files.unpackedBytes > MAX_UNPACKED_TOTAL) {
      files.unpackedExhausted = true;
      return null;
    }
    return buf.toString('utf8');
  } catch { return null; }
  return null;
}

/* ---------- разбор XML ---------- */
const unesc = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
  .replace(/&amp;/g, '&');

// Все значения тега вида <w:t>текст</w:t>
function tagTexts(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(unesc(m[1]));
  return out;
}

/* ---------- Word ---------- */
function readDocx(files) {
  const xml = unpack(files, 'word/document.xml');
  if (!xml) return null;
  // Абзацы и переносы строк восстанавливаем по разметке, иначе весь документ
  // слипся бы в одну строку
  const body = xml
    .replace(/<w:p[\s>]/g, '\n<w:p ')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<w:tab\s*\/>/g, '\t');
  const parts = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|\n/g;
  let m;
  while ((m = re.exec(body))) parts.push(m[1] === undefined ? '\n' : unesc(m[1]));
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- Excel ---------- */
const colIndex = (ref) => {
  const letters = (/^[A-Z]+/.exec(ref) || [''])[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function readXlsx(files) {
  const shared = unpack(files, 'xl/sharedStrings.xml');
  // В общей таблице строк текст может быть разбит на куски <t> внутри <si>
  const strings = shared
    ? (shared.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) => tagTexts(si, 't').join(''))
    : [];

  const names = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  const out = [];
  for (const name of names) {
    const xml = unpack(files, name);
    if (!xml) continue;
    const rows = [];
    for (const row of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      const re = /<c\s([^>]*)>([\s\S]*?)<\/c>/g;
      let m;
      while ((m = re.exec(row))) {
        const attrs = m[1], inner = m[2];
        const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1] || '';
        const type = (/t="([^"]+)"/.exec(attrs) || [])[1] || '';
        let v = tagTexts(inner, 'v')[0] ?? '';
        if (type === 's') v = strings[Number(v)] ?? '';
        else if (type === 'inlineStr') v = tagTexts(inner, 't').join('');
        const i = ref ? colIndex(ref) : cells.length;
        while (cells.length < i) cells.push('');
        cells[i] = String(v);
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }
    if (rows.length) {
      const num = (/sheet(\d+)\.xml/.exec(name) || [])[1];
      out.push(`--- Лист ${num} ---\n${rows.join('\n')}`);
    }
  }
  return out.join('\n\n').trim() || null;
}

/* ---------- PowerPoint ---------- */
function readPptx(files) {
  const names = [...files.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  const out = [];
  for (const name of names) {
    const xml = unpack(files, name);
    if (!xml) continue;
    // Абзац слайда — <a:p>, внутри куски текста <a:t>
    const lines = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || [])
      .map((p) => tagTexts(p, 'a:t').join('').trim())
      .filter(Boolean);
    if (lines.length) out.push(`--- Слайд ${/\d+/.exec(name)[0]} ---\n${lines.join('\n')}`);
  }
  return out.join('\n\n').trim() || null;
}

export const OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'docm', 'xlsm', 'pptm']);

export const isOffice = (name, mime = '') => OFFICE_EXTENSIONS.has(String(name).split('.').pop().toLowerCase())
  || /officedocument|ms-word|ms-excel|ms-powerpoint/i.test(mime);

/* Достаёт текст из документа Microsoft 365. Возвращает { ok, text } либо
   { ok:false, error } — вызывающий сам решает, что показать пользователю. */
export function extractOffice(buf, name) {
  const ext = String(name).split('.').pop().toLowerCase();
  let files;
  try { files = readZip(buf); } catch (e) {
    // Старые .doc/.xls — это не zip, а двоичный формат: честно об этом говорим
    return { ok: false, error: 'не удалось открыть файл: ' + e.message };
  }
  let text = null;
  if (ext.startsWith('doc')) text = readDocx(files);
  else if (ext.startsWith('xls')) text = readXlsx(files);
  else if (ext.startsWith('ppt')) text = readPptx(files);
  else text = readDocx(files) || readXlsx(files) || readPptx(files);

  if (!text) return { ok: false, error: 'в документе не нашлось текста' };
  return { ok: true, text };
}
