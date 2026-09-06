import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SANDBOX_DIR } from './config.js';

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
  const dir = path.join(SANDBOX_DIR, 'imagegen-' + randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'output.png');

  const instruction = [
    `$imagegen ${prompt}`,
    '',
    `Save the final generated PNG file to exactly this path: ${outFile}`,
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
    if (!fs.existsSync(outFile)) {
      // последние строки JSON-потока и stderr — для диагностики, почему файл не появился
      const tail = (result.buf || '').trim().split('\n').slice(-3).join(' | ');
      const errTail = (result.stderr || '').trim().slice(-300);
      const reason = result.error || 'модель не сохранила файл изображения';
      console.error(`[imagegen] <- FAIL за ${Date.now() - started}мс: ${reason} | stdout_tail=${tail} | stderr_tail=${errTail}`);
      return { ok: false, error: reason };
    }
    const buffer = fs.readFileSync(outFile);
    console.log(`[imagegen] <- OK за ${Date.now() - started}мс, ${buffer.length} байт`);
    return { ok: true, buffer };
  } finally {
    // подчищаем временную папку в любом случае
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}
