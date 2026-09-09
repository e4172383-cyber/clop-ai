import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SANDBOX_DIR, REQUEST_TIMEOUT_MS, CLOP_IDENTITY_PROMPT } from './config.js';
import { countCodexTokens } from './token-accounting.js';

/* Запуск Codex CLI — общий код для сервера и ретранслятора.

   Раньше он жил внутри gpt.js. Пришлось вынести: вход по подписке ChatGPT
   держится на одноразовом токене обновления, и OpenAI отзывает его, когда
   запросы идут из дата-центра. Значит, сам CLI должен работать на домашнем
   компьютере, а сервер — только раздавать задания. Чтобы оба пути вели себя
   одинаково (одни аргументы, один разбор событий, один разговор о таймауте),
   код у них общий, различается только место запуска. */

export function codexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  // На Windows codex — .cmd-обёртка, npm-бинарник без расширения через
  // spawn() без shell не резолвится (ENOENT) — берём .cmd явно
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

// У Codex CLI нет флага вида --system-prompt, но он автоматически подхватывает
// AGENTS.md из рабочей директории и относится к нему как к инструкциям более
// высокого приоритета, чем обычный текст в промпте (в отличие от промпт-префикса,
// эта инструкция реально не даёт модели проговориться под давлением — проверено
// живыми запросами). Держим отдельную "скрытую" рабочую директорию только для
// моделей с hideIdentity — на обычные GPT-модели это никак не влияет.
const HIDDEN_IDENTITY_DIR = path.join(SANDBOX_DIR, 'clop-identity');
function hiddenIdentityCwd(identityTitle = 'Clop 4') {
  const slug = String(identityTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'clop-4';
  const dir = path.join(HIDDEN_IDENTITY_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const agentsFile = path.join(dir, 'AGENTS.md');
  // Всегда перезаписываем — если CLOP_IDENTITY_PROMPT поменяли в коде, файл
  // на диске (переживает рестарты в рамках одного деплоя) не должен отстать
  fs.writeFileSync(agentsFile, `${CLOP_IDENTITY_PROMPT}\n\nТвоё точное публичное название: ${identityTitle}.`, 'utf8');
  return dir;
}

function freshArgs(modelCli, { fixedEffort, imagePaths, fast } = {}) {
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-m', modelCli,
    '--color', 'never',
  ];
  if (fixedEffort) args.push('-c', `model_reasoning_effort=${fixedEffort}`);
  if (fast) args.push('-c', 'service_tier="fast"');
  // Codex принимает изображения отдельным флагом — файловые инструменты для
  // этого не нужны вовсе. Форма через знак равенства обязательна: у флага -i
  // список значений, и в виде «-i путь» он проглатывает идущий следом знак «-»,
  // которым мы просим читать запрос из потока ввода.
  for (const p of imagePaths || []) args.push('--image=' + p);
  return args.concat(['-']);
}

function resumeArgs(modelCli, threadId, { fixedEffort, imagePaths, fast } = {}) {
  const args = [
    'exec', 'resume', threadId,
    '--json', '--skip-git-repo-check', '-s', 'read-only',
    '-m', modelCli, '--color', 'never',
  ];
  if (fixedEffort) args.push('-c', `model_reasoning_effort=${fixedEffort}`);
  if (fast) args.push('-c', 'service_tier="fast"');
  for (const p of imagePaths || []) args.push('--image=' + p);
  return args.concat(['-']);
}

/**
 * Запускает codex exec --json, построчно разбирает JSONL событий.
 * onDelta зовём на каждый agent_message (Codex не стримит текст токен за
 * токеном в exec-режиме — обновляем "живой" текст по мере готовых кусков).
 */
export function runCodex(args, stdin, onDelta, cwd = SANDBOX_DIR, signal) {
  if (signal?.aborted) return Promise.resolve({ ok: false, error: 'aborted' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexBin(), args, {
        cwd,
        windowsHide: true,
        shell: process.platform === 'win32',
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn: ' + e.message });
    }

    let buf = '', text = '', threadId = null, usage = null, errMsg = null, err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', abort);
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS);
    const abort = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'aborted' });
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    const handleLine = (line) => {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.type === 'thread.started') threadId = obj.thread_id;
      else if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
        text = obj.item.text || text;
        try { onDelta?.(text); } catch {}
      } else if (obj.type === 'item.completed' && obj.item?.type === 'error') {
        errMsg = obj.item.message;
      } else if (obj.type === 'turn.completed') {
        usage = obj.usage;
      } else if (obj.type === 'turn.failed') {
        errMsg = obj.error?.message || 'turn failed';
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ ok: false, error: 'exec: ' + e.message });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (buf.trim()) handleLine(buf);
      resolve({ ok: Boolean(text) && !errMsg, code, text, threadId, usage, errMsg, stderr: err });
    });

    if (stdin != null) { child.stdin.write(stdin); }
    child.stdin.end();
  });
}

/**
 * Выполняет готовое задание: продолжение сессии по thread_id, а если сессия
 * потерялась — новый разговор с историей в тексте. Возвращает сырой результат
 * runCodex: решение, считать ли это ошибкой, принимает вызывающая сторона.
 *
 * Задание нарочно самодостаточно (никаких ссылок на объект чата) — в таком
 * виде оно переживает передачу по сети на чужой компьютер.
 */
export async function runJob(job, onDelta, signal) {
  const { modelCli, fixedEffort, hideIdentity, identityTitle, fast, threadId, resumeStdin, freshStdin, imagePaths = [] } = job;
  const cwd = hideIdentity ? hiddenIdentityCwd(identityTitle) : SANDBOX_DIR;
  const opts = { fixedEffort, imagePaths, fast };

  if (threadId) {
    const res = await runCodex(resumeArgs(modelCli, threadId, opts), resumeStdin, onDelta, cwd, signal);
    if (res.ok) return res;
    if (signal?.aborted) return res;
    // Сессия не нашлась/повреждена — начинаем новую с историей в тексте
  }
  return runCodex(freshArgs(modelCli, opts), freshStdin, onDelta, cwd, signal);
}

export function countTokens(usage = {}, options) {
  return countCodexTokens(usage, options);
}

export async function healthCheck() {
  const res = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexBin(), ['--version'], { cwd: SANDBOX_DIR, windowsHide: true, shell: process.platform === 'win32' });
    } catch (e) {
      return resolve({ ok: false, out: 'spawn: ' + e.message });
    }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => resolve({ ok: false, out: 'exec: ' + e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out || err }));
  });
  return { ok: res.ok, version: res.out.trim() };
}
