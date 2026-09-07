import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MAX_CONTEXT_MESSAGES, REQUEST_TIMEOUT_MS } from './config.js';
import { home as kimiHome, isReady as isKimiReady, save as saveKimiAuth } from './kimiauth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIMI_ENTRY = path.join(ROOT, 'node_modules', '@moonshot-ai', 'kimi-code', 'dist', 'main.mjs');

function transcript(chat, prompt) {
  const history = chat.messages.slice(-MAX_CONTEXT_MESSAGES);
  if (!history.length) return prompt;
  return ['Продолжай диалог. История переписки:', '---',
    history.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`).join('\n\n'),
    '---', 'Новое сообщение пользователя:', prompt].join('\n');
}

const roughTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 4));

// Kimi Code пишет фактическое потребление каждого запуска в wire.jsonl.
// Рабочая папка у каждого запроса уникальна, поэтому её workspace-каталог
// однозначно связывает ответ с нужной записью даже при параллельных запросах.
function exactUsage(workDir) {
  try {
    const sessionsRoot = path.join(kimiHome(), 'sessions');
    const prefix = `wd_${path.basename(workDir)}_`;
    const workspace = fs.readdirSync(sessionsRoot, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.startsWith(prefix));
    if (!workspace) return null;
    const workspaceDir = path.join(sessionsRoot, workspace.name);
    const sessions = fs.readdirSync(workspaceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('session_'))
      .map((entry) => path.join(workspaceDir, entry.name));
    const wireFiles = sessions
      .map((dir) => path.join(dir, 'agents', 'main', 'wire.jsonl'))
      .filter((file) => fs.existsSync(file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (!wireFiles.length) return null;
    let input = 0, output = 0, found = false;
    for (const line of fs.readFileSync(wireFiles[0], 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type !== 'usage.record' || !event.usage) continue;
        input += Number(event.usage.inputOther || 0)
          + Number(event.usage.inputCacheRead || 0)
          + Number(event.usage.inputCacheCreation || 0);
        output += Number(event.usage.output || 0);
        found = true;
      } catch {}
    }
    return found ? { input, output, cacheWrite: 0, cacheRead: 0, total: input + output, billable: input + output } : null;
  } catch {
    return null;
  }
}
function assistantText(obj) {
  if (obj?.role !== 'assistant' || obj.tool_calls?.length) return '';
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.content)) return obj.content.filter((p) => p?.type === 'text').map((p) => p.text || '').join('');
  return '';
}

function publicError(value) {
  const error = String(value || '').trim();
  if (/\b500\b|server had an error|server_error/i.test(error)) {
    return 'Сервис Kimi временно вернул серверную ошибку. Лимит не списан — повторите запрос через минуту.';
  }
  if (/\b429\b|rate.?limit|quota|balance/i.test(error)) {
    return 'Kimi временно ограничил запросы. Лимит Clop не списан — попробуйте немного позже.';
  }
  return error || 'Kimi не вернул ответ';
}

export async function ask({ chat, modelCli, kimiEffort, prompt, onDelta, signal, client = 'chat' }) {
  if (signal?.aborted) return { ok: false, error: 'aborted', durationMs: 0 };
  if (!isKimiReady()) return { ok: false, error: 'Вход Kimi не настроен. Администратору нужно повторно подключить Kimi Code.', durationMs: 0 };
  const started = Date.now();
  const fullPrompt = transcript(chat, prompt);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clop-kimi-job-'));
  const agentFile = path.join(workDir, 'chat-agent.md');
  const desktopClient = client === 'desktop';
  fs.writeFileSync(agentFile, [
    '---',
    'name: clop-chat',
    `description: ${desktopClient ? 'Clop Code desktop response engine' : 'Safe chat-only assistant'}`,
    'tools: []',
    'subagents: []',
    '---',
    desktopClient
      ? 'You are the response engine for Clop Code desktop. You cannot touch the user computer directly, but the desktop application executes each <clop_action> block it receives. Follow the clop_protocol in the user message exactly: emit one requested action at a time, wait for clop_result, continue until the work is complete, and never paste code instead of requesting write.'
      : 'You are a chat assistant. Answer the user directly. You have no tools and cannot access files.',
  ].join('\n'));
  return await new Promise((resolve) => {
    const args = [KIMI_ENTRY, '-m', modelCli, '--agent-file', agentFile,
      '-p', fullPrompt, '--output-format', 'stream-json'];
    const env = {
      ...process.env,
      KIMI_CODE_HOME: kimiHome(),
      KIMI_MODEL_THINKING_EFFORT: kimiEffort,
      KIMI_CODE_NO_AUTO_UPDATE: '1',
      KIMI_DISABLE_CRON: '1',
      KIMI_LOOP_MAX_ATTEMPTS_PER_STEP: '2',
      NO_COLOR: '1',
    };
    const child = spawn(process.execPath, args, { cwd: workDir, env, windowsHide: true });
    let buf = '', stderr = '', finalText = '', lastApiError = '', done = false;
    const finish = async (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      fs.rm(workDir, { recursive: true, force: true }, () => {});
      try { await saveKimiAuth(); } catch {}
      resolve(result);
    };
    const abort = () => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, error: 'aborted', durationMs: Date.now() - started });
    };
    const handle = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        const text = assistantText(event);
        if (text) finalText = text;
        if (event?.error_message) lastApiError = event.error_message;
      } catch {}
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish({ ok: false, error: 'timeout', durationMs: Date.now() - started });
    }, REQUEST_TIMEOUT_MS);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (e) => finish({ ok: false, error: `exec: ${e.message}`, durationMs: Date.now() - started }));
    child.on('close', (code) => {
      if (buf.trim()) handle(buf);
      if (code !== 0 || !finalText.trim()) {
        const detail = lastApiError || stderr.trim().slice(-1200) || `exit ${code}`;
        return finish({ ok: false, error: publicError(detail), durationMs: Date.now() - started });
      }
      try { onDelta?.(finalText); } catch {}
      const usage = exactUsage(workDir);
      const input = roughTokens(fullPrompt), output = roughTokens(finalText);
      finish({ ok: true, text: finalText.trim(), tokens: usage || { input, output, cacheWrite: 0, cacheRead: 0, total: input + output, billable: input + output }, costUsd: 0, durationMs: Date.now() - started, stopReason: null });
    });
  });
}

export async function healthCheck() {
  const authReady = isKimiReady();
  return {
    ok: fs.existsSync(KIMI_ENTRY) && authReady,
    version: !fs.existsSync(KIMI_ENTRY)
      ? 'Kimi Code не найден'
      : authReady ? 'Kimi Code готов' : 'Требуется вход в Kimi Code',
  };
}
