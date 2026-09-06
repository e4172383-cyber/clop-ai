import { MAX_CONTEXT_MESSAGES } from './config.js';
import { runJob, countTokens, healthCheck as localHealth } from './codexrun.js';
import * as relay from './relay.js';

/* GPT-модели через Codex CLI.

   Сам запуск живёт в codexrun.js, здесь — только сборка задания и выбор места
   исполнения. Мест два:

   — ретранслятор: CLI крутится на домашнем компьютере владельца, где вход по
     подписке ChatGPT законен и не отзывается;
   — свой процесс: так работает разработка на том же компьютере, где и CLI.

   Выбор делается сам собой: настроен и на связи ретранслятор — идём к нему,
   иначе пробуем локально. */

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

/**
 * Отправляет сообщение в GPT-модель. modelCli — реальный id модели Codex
 * (например gpt-5.6-terra). Держит контекст через resume по thread_id,
 * при потере сессии — досылает историю текстом заново.
 */
export async function ask({ chat, modelCli, prompt, onDelta, fixedEffort, hideIdentity, fast, images, signal }) {
  const started = Date.now();
  const threadId = chat.gptThreadId;
  const job = {
    modelCli,
    fixedEffort,
    hideIdentity,
    fast,
    threadId,
    resumeStdin: prompt,
    freshStdin: transcript(chat, prompt),
    imagePaths: (images && images.paths) || [],
  };

  const домаЛи = relay.configured() && relay.online();
  console.log(`[gpt] -> модель=${modelCli} эффорт=${fixedEffort || 'н/д'} чат=${chat.id} `
    + `resume=${Boolean(threadId)} где=${домаЛи ? 'ретранслятор' : 'свой процесс'}`);

  const res = домаЛи ? await relay.run(job, onDelta, signal) : await runJob(job, onDelta, signal);

  if (!res.text && !res.ok) {
    const reason = res.errMsg || res.error || (res.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${res.code}`;
    // Полный вывод CLI в лог: по одной строке причину не отличить —
    // истёкший вход, нехватка прав и сетевой сбой выглядят одинаково
    console.error(`[gpt] <- ОШИБКА code=${res.code} errMsg=${res.errMsg || '—'}`);
    if (res.stderr) console.error(`[gpt] stderr: ${String(res.stderr).slice(0, 1500)}`);
    return { ok: false, error: reason, durationMs: Date.now() - started };
  }
  const text = (res.text || '').trim();
  if (!text) return { ok: false, error: 'пустой ответ модели', durationMs: Date.now() - started };

  console.log(`[gpt] <- OK usage=${JSON.stringify(countTokens(res.usage))}`);

  return {
    ok: true,
    text,
    threadId: res.threadId || threadId,
    tokens: countTokens(res.usage),
    costUsd: 0,
    durationMs: Date.now() - started,
    stopReason: null,
  };
}

/* Здоровье GPT-пути: на сервере считаем по ретранслятору, а не по своему CLI —
   своего там всё равно нет и быть не должно. */
export async function healthCheck() {
  if (relay.configured()) {
    const s = relay.status();
    return {
      ok: s.online,
      version: s.online ? `ретранслятор на связи (${s.agent || 'без имени'})` : 'ретранслятор не на связи',
    };
  }
  return localHealth();
}
