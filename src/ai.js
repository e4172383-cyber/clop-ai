import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  claudeBin, SANDBOX_DIR, REQUEST_TIMEOUT_MS, MAX_CONTEXT_MESSAGES, MODELS, EFFORTS, DEFAULT_EFFORT, DEFAULT_MODEL, CLOP_IDENTITY_PROMPT, FILES_INSTRUCTION, SITE_INSTRUCTION,
} from './config.js';

// "Ультра"/max сознательно не входит в EFFORTS ни на одном тарифе — сюда лишний
// раз подстрахуемся, чтобы наружу никогда не ушло что-то за пределами списка.
const ALLOWED_EFFORTS = new Set(Object.keys(EFFORTS));

const DENY = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit', 'Task', 'Agent',
  'WebFetch', 'WebSearch', 'TodoWrite', 'Artifact', 'SlashCommand',
];
const DISALLOWED = DENY.join(',');
// Своими глазами модель картинку не увидит — только через инструмент чтения.
// Поэтому для запросов с изображением он разрешается, а рабочей папкой
// становится временный каталог, где кроме самих картинок ничего нет.
const DISALLOWED_VISION = DENY.filter((t) => t !== 'Read').join(',');

/**
 * Запускает claude -p в потоковом режиме (stream-json) и построчно разбирает
 * NDJSON. На каждый текстовый дельта-кусок зовёт onDelta(накопленныйТекст) —
 * это и даёт "живую" анимацию печати в Telegram. В конце потока приходит
 * строка {"type":"result",...} — та же структура, что и в обычном json-режиме.
 */
function runClaudeStream(args, stdin, onDelta, cwd = SANDBOX_DIR) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudeBin(), args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn: ' + e.message });
    }

    let buf = '', text = '', resultJson = null, err = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, error: 'timeout' });
    }, REQUEST_TIMEOUT_MS);

    const handleLine = (line) => {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.type === 'stream_event' && obj.event?.type === 'content_block_delta' && obj.event.delta?.type === 'text_delta') {
        text += obj.event.delta.text;
        try { onDelta?.(text); } catch {}
      } else if (obj.type === 'result') {
        resultJson = obj;
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
      resolve({ ok: false, error: 'exec: ' + e.message });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      if (buf.trim()) handleLine(buf);
      resolve({ ok: Boolean(resultJson), code, resultJson, text, stderr: err });
    });

    if (stdin != null) { child.stdin.write(stdin); }
    child.stdin.end();
  });
}

function countTokens(usage = {}) {
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return {
    input, output, cacheWrite, cacheRead,
    // полный расход — для панели администратора и оценки реальной стоимости
    total: input + output + cacheWrite + Math.round(cacheRead * 0.1),
    // то, что реально списывается с лимита пользователя: только его сообщение
    // и ответ. Claude Code CLI кэширует системный промпт и определения
    // инструментов (это десятки тысяч токенов даже на "привет") — это
    // фиксированный оверхед харнесса, а не расход пользователя, поэтому
    // cache_read/cache_write в лимит не идут.
    billable: input + output,
  };
}

function transcript(chat, prompt) {
  const history = chat.messages.slice(-MAX_CONTEXT_MESSAGES);
  if (!history.length) return prompt;
  const lines = history.map((m) => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`);
  return [
    'Продолжай диалог. История переписки:',
    '---',
    lines.join('\n\n'),
    '---',
    'Новое сообщение пользователя:',
    prompt,
  ].join('\n');
}

function baseArgs(modelKey, effortKey, vision = false, systemPrompt = null) {
  const model = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  const args = [
    '-p',
    '--model', model.cli,
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--disallowedTools', vision ? DISALLOWED_VISION : DISALLOWED,
    '--disable-slash-commands',
    '--safe-mode',
    '--strict-mcp-config',
  ];
  // fixedEffort (например Clop 2.5 Haiku) — сила мышления зашита жёстко,
  // выбор пользователя игнорируется. У моделей без supportsEffort и без
  // fixedEffort (Haiku 4.5) флаг --effort приведёт к ошибке CLI — не передаём
  // его вовсе, модель думает по умолчанию.
  if (model.fixedEffort) {
    args.splice(3, 0, '--effort', model.fixedEffort);
  } else if (model.supportsEffort !== false) {
    const effort = ALLOWED_EFFORTS.has(effortKey) ? effortKey : DEFAULT_EFFORT;
    args.splice(3, 0, '--effort', effort);
  }
  // Без системного промпта вообще для всех моделей, кроме тех, что скрывают
  // свою настоящую личность (сейчас — только Clop 2.5 Haiku). Добавляем и
  // FILES_INSTRUCTION — иначе модель не знает про маркеры %%%FILE%%% и на
  // просьбу "сделай сайт" просто пишет код обычным блоком вместо архива.
  if (systemPrompt) args.splice(3, 0, '--system-prompt', systemPrompt);
  else if (model.hideIdentity) args.splice(3, 0, '--system-prompt', `${CLOP_IDENTITY_PROMPT}\n\n${FILES_INSTRUCTION}

${SITE_INSTRUCTION}`);
  return args;
}

/**
 * Отправляет сообщение в модель. Держит контекст чата через сессию Claude,
 * при её потере — досылает историю текстом. onDelta(текстСейчас) вызывается
 * по мере генерации — для живой анимации печати в Telegram.
 */
export async function ask({ chat, modelKey, effortKey, prompt, onDelta, images, systemPrompt = null }) {
  // Картинки лежат отдельной папкой: она же становится рабочей для CLI, и
  // модель прямо в задании получает их имена — иначе не догадается посмотреть
  const vision = Boolean(images && images.paths && images.paths.length);
  const cwd = vision ? images.dir : SANDBOX_DIR;
  if (vision) {
    // Путь даём полный и оговариваем, что файлы лежат на сервере. В настольном
    // приложении у модели есть свои маркеры действий для файлов на компьютере
    // пользователя, и без этой оговорки она искала картинку там — и не находила.
    prompt = 'К сообщению приложены изображения. Они уже лежат на сервере, в твоей рабочей папке:\n'
      + images.paths.map((p) => '  ' + p).join('\n')
      + '\nОткрой каждое своим инструментом Read по этому пути — не маркерами действий и не на компьютере пользователя. '
      + 'После этого ответь по содержимому картинок.\n\n'
      + prompt;
  }
  const started = Date.now();
  let sessionId = chat.sessionId;
  let usedResume = Boolean(sessionId);

  const model = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  const effort = ALLOWED_EFFORTS.has(effortKey) ? effortKey : DEFAULT_EFFORT;
  const effortLabel = model.fixedEffort || (model.supportsEffort === false ? 'н/д (своё размышление)' : effort);
  console.log(`[ai] -> модель=${model.cli} эффорт=${effortLabel} чат=${chat.id} resume=${Boolean(sessionId)}`);

  let args = baseArgs(modelKey, effortKey, vision, systemPrompt);
  if (usedResume) args.push('--resume', sessionId);
  else { sessionId = randomUUID(); args.push('--session-id', sessionId); }

  let res = await runClaudeStream(args, usedResume ? prompt : transcript(chat, prompt), onDelta, cwd);
  let json = res.resultJson;

  // Сессия не найдена / повреждена — начинаем новую с историей в тексте
  const sessionLost = !json || (json.is_error && /session|resume/i.test(String(json.result || '')));
  if (sessionLost && usedResume) {
    sessionId = randomUUID();
    args = baseArgs(modelKey, effortKey, vision, systemPrompt).concat(['--session-id', sessionId]);
    res = await runClaudeStream(args, transcript(chat, prompt), onDelta, cwd);
    json = res.resultJson;
  }

  // error_during_execution нередко бывает разовым сбоем на стороне CLI/API
  // (не связан с сессией) — один автоматический повтор с новой сессией,
  // прежде чем показывать ошибку пользователю
  if (json && json.subtype === 'error_during_execution') {
    console.warn(`[ai] error_during_execution модель=${model.cli} чат=${chat.id} — повтор с новой сессией`);
    sessionId = randomUUID();
    args = baseArgs(modelKey, effortKey, vision, systemPrompt).concat(['--session-id', sessionId]);
    res = await runClaudeStream(args, transcript(chat, prompt), onDelta, cwd);
    json = res.resultJson;
  }

  if (!json) {
    const reason = res.error || (res.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${res.code}`;
    console.error(`[ai] <- нет результата модель=${model.cli} чат=${chat.id}: ${reason}`);
    return { ok: false, error: reason, durationMs: Date.now() - started };
  }
  if (json.is_error || json.subtype === 'error_during_execution') {
    const reason = String(json.result || json.subtype || 'model error').slice(0, 300);
    console.error(`[ai] <- ошибка модель=${model.cli} чат=${chat.id}: ${reason}`);
    return { ok: false, error: reason, durationMs: Date.now() - started };
  }

  const text = typeof json.result === 'string' ? json.result.trim() : '';
  if (!text) return { ok: false, error: 'пустой ответ модели', durationMs: Date.now() - started };

  // Сверяем с тем, что реально отчиталось биллингом CLI — доказательство, что
  // модель и сила мышления действительно применились, а не просто выбраны в UI
  const billedModels = Object.keys(json.modelUsage || {});
  const matched = billedModels.some((m) => m === model.cli || m.startsWith(model.cli));
  console.log(`[ai] <- ${matched ? 'OK' : 'НЕСОВПАДЕНИЕ'} биллинг=[${billedModels.join(', ')}] usage=${JSON.stringify(countTokens(json.usage))}`);

  return {
    ok: true,
    text,
    sessionId: json.session_id || sessionId,
    tokens: countTokens(json.usage),
    costUsd: json.total_cost_usd || 0,
    durationMs: Date.now() - started,
    stopReason: json.stop_reason || null,
  };
}

export async function healthCheck() {
  const res = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(claudeBin(), ['--version'], { cwd: SANDBOX_DIR, windowsHide: true });
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
