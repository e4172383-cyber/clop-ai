import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, SANDBOX_DIR } from './config.js';
import { ensureImageSkill } from './image-skill.js';
import { findGeneratedImage } from './image-result.js';

// Бесплатный инстанс Render — очень слабый CPU (0.1 CPU), imagegen там
// заметно медленнее, чем локально — даём до 8 минут вместо 4
const IMAGE_TIMEOUT_MS = 8 * 60_000;

function codexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  return process.platform === 'win32' ? 'codex.cmd' : 'codex';
}

/**
 * Генерирует изображение через встроенный imagegen-скилл Codex CLI (на квоте
 * ChatGPT-подписки, без отдельного OPENAI_API_KEY). Модель сама решает, какой
 * промпт составить для built-in image_gen — мы просим сохранить результат в
 * конкретный путь и потом читаем файл.
 */
export async function generateImage(prompt) {
  const started = Date.now();
  console.log(`[imagegen] -> старт, промпт="${prompt.slice(0, 80)}"`);
  try {
    ensureImageSkill(ROOT);
  } catch (error) {
    console.error(`[imagegen] <- навык недоступен: ${error.message}`);
    return { ok: false, error: error.message };
  }
  const dir = path.join(SANDBOX_DIR, 'imagegen-' + randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

  const instruction = [
    `$imagegen ${prompt}`,
    '',
    'After generation, state the exact absolute path of the saved image in backticks.',
    'Do not copy or move the generated file.',
    'Do not ask questions — pick reasonable defaults and generate one image.',
  ].join('\n');

  const args = [
    'exec', '--json', '--skip-git-repo-check',
    '-s', 'workspace-write',
    '-m', 'gpt-5.6-luna',
    '--color', 'never',
    '-',
  ];

  const result = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexBin(), args, {
        cwd: dir,
        windowsHide: true,
        shell: process.platform === 'win32',
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn: ' + e.message });
    }

    let buf = '', err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout', buf, stderr: err });
    }, IMAGE_TIMEOUT_MS);

    child.stdout.on('data', (d) => { buf += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: false, error: 'exec: ' + e.message });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: true, stderr: err, buf, code });
    });
    child.stdin.end(instruction);
  });

  try {
    const generatedFile = findGeneratedImage(result.buf, codexHome, started);
    if (!generatedFile) {
      // последние строки JSON-потока и stderr — для диагностики, почему файл не появился
      const tail = (result.buf || '').trim().split('\n').slice(-3).join(' | ');
      const errTail = (result.stderr || '').trim().slice(-300);
      const diagnostic = errTail || tail;
      const reason = result.error || (diagnostic
        ? `модель не сохранила изображение: ${diagnostic.slice(-180)}`
        : 'модель не сохранила файл изображения');
      console.error(`[imagegen] <- FAIL за ${Date.now() - started}мс: ${reason} | stdout_tail=${tail} | stderr_tail=${errTail}`);
      return { ok: false, error: reason };
    }
    const buffer = fs.readFileSync(generatedFile);
    console.log(`[imagegen] <- OK за ${Date.now() - started}мс, ${buffer.length} байт`);
    // The built-in tool creates one UUID directory per result. Remove only
    // that generated result after loading it; the buffer is already in memory.
    const generatedRoot = path.resolve(codexHome, 'generated_images');
    const parent = path.dirname(generatedFile);
    if (path.dirname(parent) === generatedRoot) fs.rm(parent, { recursive: true, force: true }, () => {});
    return { ok: true, buffer };
  } finally {
    // подчищаем временную папку в любом случае
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}
