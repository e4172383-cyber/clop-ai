const fs = require('node:fs');
const path = require('node:path');
const ACTIONS = new Set(['list', 'read', 'write', 'shell', 'screenshot', 'click', 'type', 'key']);
const defaults = Object.freeze({ workDir: '', theme: 'dark', animations: true, enterSends: true, maxSteps: 12, shellTimeout: 90, model: '', effort: 'low', fast: false, agreementVersion: '', agreementAt: 0 });
function cleanSettings(input = {}, previous = defaults) {
  const out = { ...previous };
  for (const k of ['animations', 'enterSends', 'fast']) if (typeof input[k] === 'boolean') out[k] = input[k];
  if (['dark', 'light', 'system'].includes(input.theme)) out.theme = input.theme;
  for (const [k, min, max] of [['maxSteps', 1, 30], ['shellTimeout', 5, 300]]) if (Number.isFinite(input[k])) out[k] = Math.min(max, Math.max(min, Math.floor(input[k])));
  if (typeof input.model === 'string' && /^[a-z0-9-]{0,60}$/.test(input.model)) out.model = input.model;
  if (['low', 'medium', 'high', 'xhigh'].includes(input.effort)) out.effort = input.effort;
  return out;
}
function parseAction(text) {
  const matches = [...String(text).matchAll(/<clop_action>\s*([\s\S]*?)\s*<\/clop_action>/g)];
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('Модель запросила несколько действий. Требуется один шаг.');
  let a;
  try { a = JSON.parse(matches[0][1]); } catch { throw new Error('Не удалось разобрать действие модели. Ничего не выполнено.'); }
  if (!a || !ACTIONS.has(a.tool)) throw new Error('Неизвестный инструмент. Ничего не выполнено.');
  const textField = (key, max, required = true) => { if (typeof a[key] !== 'string' || a[key].length > max || (required && !a[key].trim())) throw new Error(`Некорректное поле ${key}.`); };
  if (['list', 'read', 'write'].includes(a.tool)) textField('path', 2000);
  if (a.tool === 'write') textField('content', 300000, false);
  if (a.tool === 'shell') textField('command', 20000);
  if (a.tool === 'type') textField('text', 12000);
  if (a.tool === 'key' && !['ENTER', 'TAB', 'ESC', 'BACKSPACE', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'CTRL+A', 'CTRL+C', 'CTRL+V', 'CTRL+S', 'ALT+TAB'].includes(a.key)) throw new Error('Недопустимая клавиша.');
  if (a.tool === 'click' && (!Number.isInteger(a.x) || !Number.isInteger(a.y) || a.x < 0 || a.y < 0)) throw new Error('Некорректные координаты.');
  return a;
}
function needsActionRecovery(userText, responseText) {
  const request = String(userText || '');
  const response = String(responseText || '');
  const creationIntent = /(?:созд(?:ай|ать|а[йт]е)|сдел(?:ай|ать|а[йт]е)|собер(?:и|ите|ать)|разработ(?:ай|ать|айте)|напиш(?:и|ите)|сгенерир(?:уй|уйте)|передел(?:ай|айте)|измени(?:ть|те)|исправ(?:ь|ить|ьте)|установ(?:и|ить|ите)|create|build|implement|write|save|edit|fix|install)/iu.test(request);
  const computerArtifact = /(?:файл|папк|сайт|страниц|приложен|проект|игр|код|html|css|javascript|typescript|python|скрипт|репозитор|file|folder|website|page|app|project|game|code|script|repository)/iu.test(request);
  const deliveredAsInstructions = /```[\s\S]*```|<!doctype\s+html|(?:сохраните|сохрани)\s+(?:этот\s+)?код|copy\s+(?:this\s+)?code|save\s+(?:this\s+)?(?:code|as)/iu.test(response);
  return creationIntent && computerArtifact && deliveredAsInstructions;
}
function realTarget(target) {
  let probe = path.resolve(target), tails = [];
  while (!fs.existsSync(probe)) { const parent = path.dirname(probe); if (parent === probe) break; tails.unshift(path.basename(probe)); probe = parent; }
  return path.resolve(fs.realpathSync(probe), ...tails);
}
function resolveTarget(workDir, target) {
  if (!workDir) throw new Error('Сначала выберите рабочую папку.');
  const raw = String(target || '');
  // Windows принимает и обратные, и прямые слэши для UNC/device namespaces.
  // Отсекаем их до existsSync/realpathSync, чтобы даже проверка пути не могла
  // обратиться к внешнему SMB-серверу или именованному каналу.
  if (/[\x00-\x1f]/.test(raw) || /^[\\/]{2}/.test(raw)) throw new Error('Сетевые и специальные пути не поддерживаются.');
  if (process.platform === 'win32' && raw.split(/[\\/]/).some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new Error('Зарезервированные имена устройств Windows не поддерживаются.');
  }
  const abs = realTarget(path.resolve(workDir, raw));
  if (process.platform === 'win32' && abs.slice(2).includes(':')) throw new Error('Специальные потоки файлов не поддерживаются.');
  const rel = path.relative(realTarget(workDir), abs);
  return { abs, outside: rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) };
}
function sensitive(target) { return /(^|[\\/])(\.env(?:\.[^\\/]*)?|\.ssh|\.aws|\.azure|\.codex|\.kimi|credentials|auth\.json|auth\.bin|login data|cookies|sam|security|system32)([\\/]|$)/i.test(target); }
function decision(mode, tool, target = {}) {
  if (mode === 'chat') return 'deny';
  if (target.outside && mode !== 'full') return 'deny';
  if (['shell','screenshot','click','type','key'].includes(tool) || sensitive(target.abs || '')) return 'ask';
  if (['list','read'].includes(tool)) return 'allow';
  return mode === 'full' ? 'allow' : 'ask';
}
module.exports = { defaults, cleanSettings, parseAction, needsActionRecovery, resolveTarget, decision, sensitive };
