const REQUEST_RE = /^\s*<clop_vm_request>\s*([\s\S]{1,2400}?)\s*<\/clop_vm_request>\s*$/i;

export const VM_TOOL_INSTRUCTIONS = `
<clop_vm_tool>
У тебя есть временная изолированная Linux-машина Clop VM с shell, Node.js 22 и Python 3. Используй её только когда реальный запуск команды поможет выполнить запрос: проверить код, сделать вычисление, преобразовать текст или файл, воспроизвести ошибку либо получить точный вывод программы. Эта VM не видит файлы и приложения на компьютере пользователя; для задач Clop Code на пользовательском ПК продолжай использовать clop_action.
Если машина нужна, ответь только одним блоком:
<clop_vm_request>{"command":"одна shell-команда"}</clop_vm_request>
Команда выполняется без интернета, максимум 15 секунд, в /home/clop. Между шагами одной задачи файлы сохраняются. После результата продолжи работу; при необходимости запроси следующую команду. Не говори, что команда выполнена, пока не получил clop_vm_result. Если VM не нужна, сразу дай обычный ответ.
</clop_vm_tool>`;

export function parseVmRequest(text) {
  const value = String(text || '');
  const match = value.match(REQUEST_RE);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const command = typeof parsed?.command === 'string' ? parsed.command.trim() : '';
    if (!command || command.length > 1000 || command.includes('\0')) return null;
    return { command };
  } catch {
    return null;
  }
}

// Поток обычного ответа показываем сразу. Служебный запрос VM удерживаем,
// чтобы пользователь никогда не видел внутренний XML/JSON инструмента.
export function vmSafeDelta(onDelta) {
  if (typeof onDelta !== 'function') return undefined;
  let ordinaryAnswer = false;
  const opening = '<clop_vm_request>';
  return (snapshot) => {
    const text = String(snapshot || '');
    if (!text) return;
    if (ordinaryAnswer) return onDelta(text);
    const start = text.trimStart().toLowerCase();
    if (opening.startsWith(start) || start.startsWith(opening)) return;
    ordinaryAnswer = true;
    return onDelta(text);
  };
}

function addTokens(total, tokens = {}) {
  for (const key of ['input', 'output', 'cacheWrite', 'cacheRead', 'promptTokens', 'total', 'billable']) {
    total[key] += Math.max(0, Number(tokens[key] || 0));
  }
}

function safeToolResult(command, result) {
  return {
    command,
    ok: result?.ok === true,
    exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
    output: String(result?.output || '').slice(-32_000),
    error: result?.ok === true ? '' : String(result?.error || 'VM command failed').slice(0, 500),
  };
}

export async function runVmAgent({ prompt, invokeModel, executeCommand, cleanup, onDelta, maxCommands = 3 }) {
  const tokens = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, promptTokens: 0, total: 0, billable: 0 };
  let currentPrompt = `${prompt}\n\n${VM_TOOL_INSTRUCTIONS}`;
  let durationMs = 0;
  let lastResult = null;
  const commands = [];

  try {
    for (let step = 0; step <= maxCommands; step += 1) {
      const result = await invokeModel(currentPrompt);
      lastResult = result;
      durationMs += Math.max(0, Number(result?.durationMs || 0));
      addTokens(tokens, result?.tokens);
      if (!result?.ok) return { ...result, tokens, durationMs, vm: { used: commands.length > 0, commands } };

      const request = parseVmRequest(result.text);
      if (!request) {
        try { onDelta?.(result.text); } catch {}
        return { ...result, tokens, durationMs, vm: { used: commands.length > 0, commands } };
      }

      if (step === maxCommands) {
        currentPrompt = '<clop_vm_result>{"ok":false,"error":"Лимит команд VM для одного ответа исчерпан."}</clop_vm_result>\nДай итоговый ответ по уже полученным результатам без новых запросов к VM.';
        const finalResult = await invokeModel(currentPrompt);
        durationMs += Math.max(0, Number(finalResult?.durationMs || 0));
        addTokens(tokens, finalResult?.tokens);
        if (finalResult?.ok) {
          try { onDelta?.(finalResult.text); } catch {}
        }
        return { ...finalResult, tokens, durationMs, vm: { used: commands.length > 0, commands } };
      }

      const vmResult = safeToolResult(request.command, await executeCommand(request.command));
      commands.push({ command: request.command, ok: vmResult.ok, exitCode: vmResult.exitCode });
      currentPrompt = [
        '<clop_vm_result>',
        JSON.stringify(vmResult),
        '</clop_vm_result>',
        'Используй реальный вывод выше. Если задача завершена, дай пользователю краткий итог. Если нужен ещё один запуск, верни следующий clop_vm_request.',
      ].join('\n');
    }
    return lastResult;
  } finally {
    try { await cleanup?.(); } catch {}
  }
}
