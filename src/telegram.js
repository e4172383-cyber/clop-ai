let TOKEN = '';

export function setToken(t) { TOKEN = String(t || '').trim(); }
export function hasToken() { return Boolean(TOKEN); }

export async function api(method, params = {}, { timeoutMs = 65_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!data.ok) {
      const err = new Error(`${method}: ${data.description || 'unknown error'}`);
      err.telegram = data;
      throw err;
    }
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

export async function sendDocument(chatId, buffer, filename, { caption, timeoutMs = 120_000 } = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption.slice(0, 1024));
    form.append('parse_mode', 'Markdown');
  }
  form.append('document', new Blob([buffer], { type: 'application/zip' }), filename);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendDocument`, {
      method: 'POST', body: form, signal: ctrl.signal,
    });
    const data = await r.json();
    if (!data.ok) throw new Error(`sendDocument: ${data.description || 'unknown error'}`);
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

export async function sendPhoto(chatId, buffer, filename, { caption, timeoutMs = 120_000 } = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption.slice(0, 1024));
    form.append('parse_mode', 'Markdown');
  }
  form.append('photo', new Blob([buffer], { type: 'image/png' }), filename);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendPhoto`, {
      method: 'POST', body: form, signal: ctrl.signal,
    });
    const data = await r.json();
    if (!data.ok) throw new Error(`sendPhoto: ${data.description || 'unknown error'}`);
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

export async function getFile(fileId) {
  return api('getFile', { file_id: fileId });
}

export async function downloadFile(filePath, { timeoutMs = 60_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

export function chunkText(text, size = 3900) {
  const out = [];
  let rest = String(text);
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

// Telegram legacy Markdown ломается на незакрытых символах — чиним самое частое
function fixMarkdown(text) {
  let t = text.replace(/^#{1,6}\s*/gm, '');
  const fences = (t.match(/```/g) || []).length;
  if (fences % 2) t += '\n```';
  for (const ch of ['*', '_', '`']) {
    const count = (t.replace(/```[\s\S]*?```/g, '').match(new RegExp('\\' + ch, 'g')) || []).length;
    if (count % 2) t = t.split(ch).join(ch === '`' ? "'" : '');
  }
  return t;
}

export async function sendMessage(chatId, text, extra = {}) {
  const parts = chunkText(text);
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    const params = {
      chat_id: chatId,
      text: fixMarkdown(parts[i]),
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...(i === parts.length - 1 ? extra : {}),
    };
    try {
      last = await api('sendMessage', params);
    } catch (e) {
      // фолбэк — без разметки
      last = await api('sendMessage', { ...params, text: parts[i], parse_mode: undefined });
    }
  }
  return last;
}

export async function editMessage(chatId, messageId, text, extra = {}) {
  try {
    return await api('editMessageText', {
      chat_id: chatId, message_id: messageId, text: fixMarkdown(text),
      parse_mode: 'Markdown', link_preview_options: { is_disabled: true }, ...extra,
    });
  } catch {
    try {
      return await api('editMessageText', { chat_id: chatId, message_id: messageId, text, ...extra });
    } catch { return null; }
  }
}

export async function typing(chatId) {
  try { await api('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: 10_000 }); } catch {}
}

export async function answerCallback(id, text, alert = false) {
  try { await api('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }); } catch {}
}

export async function deleteMessage(chatId, messageId) {
  try { await api('deleteMessage', { chat_id: chatId, message_id: messageId }); } catch {}
}

export async function pollUpdates(handler, { onError } = {}) {
  let offset = 0;
  const allowed = ['message', 'callback_query', 'pre_checkout_query', 'edited_message'];
  // сбрасываем накопившиеся апдейты
  try {
    const old = await api('getUpdates', { offset: -1, timeout: 0, allowed_updates: allowed });
    if (old.length) offset = old[old.length - 1].update_id + 1;
  } catch {}

  for (;;) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: allowed }, { timeoutMs: 65_000 });
      for (const u of updates) {
        offset = u.update_id + 1;
        Promise.resolve(handler(u)).catch((e) => onError?.(e));
      }
    } catch (e) {
      if (e.name !== 'AbortError') onError?.(e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
