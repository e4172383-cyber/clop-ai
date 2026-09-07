const fs = require('node:fs');
const path = require('node:path');
const ACTIONS = new Set(['list', 'read', 'write', 'shell', 'screenshot', 'click', 'type', 'key']);
const defaults = Object.freeze({ workDir: '', theme: 'dark', animations: true, enterSends: true, agentVisible: true, agentPosition: null, approvalMode: 'smart', shellTimeout: 90, model: '', effort: 'low', fast: false, agreementVersion: '', agreementAt: 0 });
function cleanSettings(input = {}, previous = defaults) {
  const out = { ...previous };
  for (const k of ['animations', 'enterSends', 'agentVisible', 'fast']) if (typeof input[k] === 'boolean') out[k] = input[k];
  if (['dark', 'light', 'system'].includes(input.theme)) out.theme = input.theme;
  if (input.agentPosition === null) out.agentPosition = null;
  else if (input.agentPosition && Number.isInteger(input.agentPosition.x) && Number.isInteger(input.agentPosition.y)
    && Math.abs(input.agentPosition.x) <= 100_000 && Math.abs(input.agentPosition.y) <= 100_000) {
    out.agentPosition = { x: input.agentPosition.x, y: input.agentPosition.y };
  }
  if (['smart', 'allow', 'ask'].includes(input.approvalMode)) out.approvalMode = input.approvalMode;
  for (const [k, min, max] of [['shellTimeout', 5, 300]]) if (Number.isFinite(input[k])) out[k] = Math.min(max, Math.max(min, Math.floor(input[k])));
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
function requiresComputerAction(userText) {
  const request = String(userText || '');
  const creationIntent = /(?:созд(?:ай|ать|а[йт]е)|сдел(?:ай|ать|а[йт]е)|добав(?:ь|ить|ьте)|собер(?:и|ите|ать)|разработ(?:ай|ать|айте)|напиш(?:и|ите)|сгенерир(?:уй|уйте)|передел(?:ай|ать|айте)|измен(?:и|ить|ите)|исправ(?:ь|ить|ьте)|оптимиз(?:ируй|ировать|ируйте)|установ(?:и|ить|ите)|create|add|build|implement|write|save|edit|fix|optimize|install)/iu.test(request);
  const computerArtifact = /(?:файл|папк|сайт|страниц|приложен|проект|игр|код|функц|мод(?:\s|$)|тем[ауеы]|интерфейс|оптимиз|hud|html|css|javascript|typescript|python|скрипт|репозитор|file|folder|website|page|app|project|game|code|function|module|theme|interface|optimiz|script|repository)/iu.test(request);
  const explanationOnly = /^(?:объясни|расскажи|покажи\s+пример|как\s+(?:работает|устроен|написать|создать)|what\s+is|explain|show\s+an?\s+example)\b/iu.test(request.trim());
  return creationIntent && computerArtifact && !explanationOnly;
}
function isUnnecessaryClarification(userText, responseText) {
  if (!requiresComputerAction(userText)) return false;
  const response = String(responseText || '');
  return /(?:что\s+(?:именно|конкретно)\s+(?:нужно\s+)?(?:исправить|добавить|изменить|сделать)|уточните?\s*,?\s*что\s+(?:нужно\s+)?(?:исправить|добавить|изменить|сделать)|какую\s+(?:ошибку|задачу)\s+(?:нужно\s+)?(?:исправить|выполнить)|what\s+(?:exactly|specifically)\s+should\s+i\s+(?:fix|add|change|do))/iu.test(response);
}
function looksLikeCodeDelivery(responseText) {
  const response = String(responseText || '');
  const fenced = /```(?:html|css|js|javascript|ts|typescript|jsx|tsx|python|py|java|kt|kotlin|c|cpp|csharp|cs|json|xml|yaml|yml|sql|bash|powershell|php|ruby|go|rust)?\s*[\s\S]{40,}?```/iu.test(response);
  const rawDocument = /<!doctype\s+html|<html(?:\s|>)|<script(?:\s|>)|<style(?:\s|>)|<\?php|(?:^|\n)\s*(?:const|let|var|function|class|def|import|from)\s+[\w{*]/iu.test(response);
  const saveInstructions = /(?:сохраните|сохрани|скопируйте|скопируй)\s+(?:этот\s+)?(?:код|текст)|copy\s+(?:this\s+)?code|save\s+(?:this\s+)?(?:code|as)/iu.test(response);
  return fenced || rawDocument || saveInstructions;
}
function needsActionRecovery(userText, responseText) {
  return requiresComputerAction(userText) && looksLikeCodeDelivery(responseText);
}
function codeFallbackAction(userText, responseText) {
  if (!needsActionRecovery(userText, responseText)) return null;
  const response = String(responseText || '');
  const fence = /```([a-z0-9+#.-]*)\s*\r?\n([\s\S]*?)```/iu.exec(response);
  let language = fence?.[1]?.toLowerCase() || '';
  let content = fence?.[2]?.trim() || '';
  if (!content) {
    const htmlStart = response.search(/<!doctype\s+html|<html(?:\s|>)/iu);
    if (htmlStart >= 0) { content = response.slice(htmlStart).trim(); language = 'html'; }
  }
  if (!content || content.length > 300_000) return null;
  const named = /(?:файл(?:е|ом)?|как|as|save\s+as)\s*[`"'«]?([a-z0-9][a-z0-9._-]{0,80}\.(?:html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|kt|json|md|txt|xml|yaml|yml|sql|php|rb|go|rs))[`"'»]?/iu.exec(response);
  const defaultsByLanguage = {
    html: 'index.html', htm: 'index.html', css: 'styles.css', js: 'app.js', javascript: 'app.js',
    ts: 'app.ts', typescript: 'app.ts', tsx: 'app.tsx', jsx: 'app.jsx', py: 'main.py', python: 'main.py',
    java: 'Main.java', kt: 'Main.kt', kotlin: 'Main.kt', json: 'data.json', md: 'README.md',
    xml: 'data.xml', yaml: 'config.yaml', yml: 'config.yml', sql: 'schema.sql', php: 'index.php',
    rb: 'main.rb', ruby: 'main.rb', go: 'main.go', rs: 'main.rs', rust: 'main.rs',
  };
  const path = named?.[1] || defaultsByLanguage[language] || (/<!doctype\s+html|<html(?:\s|>)/iu.test(content) ? 'index.html' : 'result.txt');
  return { tool: 'write', path, content };
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
function approvalDecision(mode, tool, target = {}, approvalMode = 'smart', options = {}) {
  let verdict = decision(mode, tool, target);
  if (verdict === 'deny') return verdict;
  if (tool === 'external') return 'ask';
  if (approvalMode === 'allow') return 'allow';
  if (approvalMode === 'ask') return 'ask';
  if (options.alwaysAsk || (target.outside && mode === 'full') || options.targetExists) verdict = 'ask';
  return verdict;
}
module.exports = { defaults, cleanSettings, parseAction, requiresComputerAction, isUnnecessaryClarification, looksLikeCodeDelivery, needsActionRecovery, codeFallbackAction, resolveTarget, decision, approvalDecision, sensitive };
