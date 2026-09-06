'use strict';

(() => {
  const api = window.clop;
  const byId = (id) => document.getElementById(id);
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];

  const elements = {};
  for (const id of [
    'app', 'workspaceCrumb', 'workspaceName', 'connectionStatus', 'updateButton', 'sidebar', 'newChatButton',
    'railNewChatButton', 'chatRailButton', 'sidebarArtifactsButton', 'guestLoginPrompt',
    'chatSearch', 'chatGroups', 'chatList', 'accountButton', 'userAvatar', 'accountName',
    'accountPlan', 'chatTitle', 'chatSubtitle', 'modeSwitch',
    'toggleInspector', 'conversation', 'emptyState', 'messageList', 'terminalPanel',
    'terminalRailButton', 'terminalOutput', 'terminalForm', 'terminalInput', 'clearTerminal',
    'closeTerminal', 'attachmentStrip', 'composerForm', 'promptInput', 'attachButton',
    'modelButton', 'modelLabel', 'effortButton', 'effortLabel', 'fastToggle', 'composerHint',
    'sendButton', 'stopButton', 'inspector', 'closeInspector', 'filesPane', 'activityPane',
    'activityBadge', 'folderName', 'folderPath', 'chooseFolderButton', 'refreshFiles',
    'fileTree', 'filePreview', 'previewName', 'previewContent', 'closePreview', 'actionCount',
    'activityList', 'modelMenu', 'effortMenu', 'onboardingModal', 'onboardingBack',
    'onboardingNext', 'termsCheckbox', 'openTermsButton', 'telegramModal', 'authIdle',
    'authWaiting', 'startLoginButton', 'loginCode', 'copyLoginCode', 'cancelLoginButton',
    'approvalModal', 'approvalTitle', 'approvalDescription', 'approvalKind', 'approvalRisk',
    'approvalCode', 'approvalNote', 'denyAction', 'allowAction', 'fullModeModal',
    'fullModeAcknowledge', 'confirmFullMode', 'settingsButton', 'settingsModal',
    'settingsTitle', 'settingsAccount', 'settingsAvatar', 'settingsAccountName', 'settingsPlan',
    'themeSelect', 'animationsSetting', 'enterSendsSetting', 'approvalModeSetting', 'modelSelect', 'effortSelect',
    'fastSetting', 'maxStepsSetting', 'maxStepsValue', 'shellTimeoutSetting', 'emptyLoginButton',
    'settingsModeName', 'settingsModeDescription', 'changeModeButton', 'openBackups',
    'openTermsSettings', 'openWebsite', 'logoutButton', 'toastStack',
  ]) elements[id] = byId(id);

  const fallbackModels = [
    { key: 'gpt-5-4-mini', title: 'GPT 5.4 Mini', provider: 'gpt', description: 'Быстрая компактная GPT-модель', available: true, plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'gpt-luna', title: 'GPT 5.6 Луна', provider: 'gpt', description: 'Быстрая GPT-модель', available: true, plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'gpt-spark', title: 'Codex 5.3 Спарк', provider: 'gpt', description: 'GPT-модель для кода', available: true, plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'kimi-k2-6', title: 'Kimi K2.6', provider: 'kimi', description: 'Kimi без силы мышления', available: true, plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'gpt-astra', title: 'GPT-6 Astra', provider: 'gpt', description: 'Новое поколение GPT — от GO', available: false, plans: ['go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'gpt-5-5', title: 'GPT 5.5', provider: 'gpt', description: 'Мощная универсальная GPT — от GO', available: false, plans: ['go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'kimi-k2-7-code', title: 'Kimi K2.7 Code', provider: 'kimi', description: 'Кодовая Kimi — от GO', available: false, plans: ['go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'kimi-k3', title: 'Kimi K3', provider: 'kimi', description: 'Флагманская Kimi — от GO', available: false, plans: ['go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'gpt-terra', title: 'GPT 5.6 Терра', provider: 'gpt', description: 'Мощная GPT-модель — доступна всем', available: true, plans: ['free', 'go', 'pro', 'max', 'max20', 'coderplus'] },
    { key: 'kimi-k3-swarm', title: 'Kimi K3 Swarm', provider: 'kimi', description: 'Максимальная Kimi — от Pro', available: false, plans: ['pro', 'max', 'max20', 'coderplus'] },
    { key: 'gpt-sol', title: 'GPT 5.6 Соль', provider: 'gpt', description: 'Топовая GPT — от Max', available: false, plans: ['max', 'max20', 'coderplus'] },
  ];
  const fallbackEfforts = [
    { key: 'low', title: 'Низкое' },
    { key: 'medium', title: 'Среднее' },
    { key: 'high', title: 'Высокое' },
  ];
  const modeCopy = {
    chat: ['Только чат', 'Файлы и действия на компьютере отключены'],
    workspace: ['Рабочая папка', 'Чтение и подтверждённые изменения внутри папки'],
    full: ['Полный доступ', 'Файлы вне папки доступны после необходимых подтверждений'],
  };
  const toolNames = {
    list: 'Просмотр папки', read: 'Чтение файла', write: 'Изменение файла', shell: 'Команда Windows',
    screenshot: 'Снимок экрана', click: 'Щелчок мышью', type: 'Ввод текста', key: 'Нажатие клавиши',
    attachment: 'Отправка вложений', 'response-file': 'Файл от ИИ', restore: 'Восстановление копии', external: 'Открытие ссылки',
  };
  const DRAFT_STORAGE_KEY = 'clop-code-message-drafts-v1';
  const QUEUE_STORAGE_KEY = 'clop-code-message-queue-v1';

  const state = {
    loaded: false,
    loggedIn: false,
    user: null,
    settings: {
      workDir: '', theme: 'dark', animations: true, enterSends: true, approvalMode: 'smart', maxSteps: 12,
      shellTimeout: 90, model: '', effort: 'low', fast: false,
    },
    mode: 'chat',
    chats: [],
    currentChat: null,
    files: [],
    fileCache: new Map(),
    expandedFolders: new Set(),
    selectedFile: '',
    logs: [],
    backups: [],
    attachments: [],
    responseFilePreviews: new Map(),
    busy: false,
    busyChatId: '',
    busyStartedAt: 0,
    busyTimer: 0,
    messageQueue: readStoredMessageQueue(),
    activeQueueItem: null,
    queueRunning: false,
    reservedAttachmentIds: new Set(),
    drafts: readStoredDrafts(),
    answerMetadata: new Map(),
    step: null,
    liveAction: '',
    liveActionDetail: '',
    unreadActions: 0,
    inspectorOpen: true,
    inspectorTab: 'files',
    sidebarOpen: true,
    onboardingStep: 0,
    onboardingMode: 'workspace',
    agreementRequired: false,
    agreementVersion: '',
    fullFromOnboarding: false,
    currentApproval: null,
    approvalQueue: [],
    login: null,
    loginTimer: null,
    loginPolling: false,
    loginPromptShown: false,
    terminalRunning: false,
    terminalHistory: [],
    terminalHistoryIndex: 0,
  };

  let settingsQueue = Promise.resolve();
  let restoreFocus = null;
  const systemTheme = window.matchMedia('(prefers-color-scheme: light)');
  const compactSidebar = window.matchMedia('(max-width: 820px)');

  function readStoredDrafts() {
    try {
      const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function cleanStoredString(value, maxLength = 50_000) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
  }

  function cleanStoredAttachment(value) {
    if (!value || typeof value !== 'object') return null;
    const id = cleanStoredString(value.id, 240);
    if (!id) return null;
    return {
      id,
      name: cleanStoredString(value.name, 500) || 'Вложение',
      kind: cleanStoredString(value.kind, 40),
      mime: cleanStoredString(value.mime, 160),
      size: Number.isFinite(Number(value.size)) ? Math.max(0, Number(value.size)) : 0,
    };
  }

  function cleanStoredQueueItem(value, restoring = false) {
    if (!value || typeof value !== 'object' || value.accepted === true) return null;
    const id = cleanStoredString(value.id, 240);
    const text = cleanStoredString(value.text);
    const attachmentItems = Array.isArray(value.attachmentItems)
      ? value.attachmentItems.map(cleanStoredAttachment).filter(Boolean).slice(0, 20)
      : [];
    const knownAttachmentIds = new Set(attachmentItems.map((item) => item.id));
    const attachments = Array.isArray(value.attachments)
      ? value.attachments.map((item) => cleanStoredString(item, 240)).filter((item) => item && knownAttachmentIds.has(item)).slice(0, 20)
      : [];
    if (!id || (!text && !attachments.length && !attachmentItems.length)) return null;
    const previousStatus = ['queued', 'sending', 'failed'].includes(value.status) ? value.status : 'queued';
    const interrupted = restoring && previousStatus === 'sending';
    const needsReattach = Boolean(value.needsReattach) || (restoring && attachments.length > 0);
    return {
      id,
      chatId: cleanStoredString(value.chatId, 240),
      text,
      attachments: needsReattach ? [] : attachments,
      attachmentItems,
      model: cleanStoredString(value.model, 240),
      effort: cleanStoredString(value.effort, 40),
      fast: Boolean(value.fast),
      ts: Number.isFinite(Number(value.ts)) ? Number(value.ts) : Date.now(),
      status: interrupted || needsReattach ? 'failed' : previousStatus,
      error: needsReattach
        ? 'Добавьте вложения заново после перезагрузки. Текст сообщения сохранён.'
        : (interrupted
          ? 'Отправка была прервана перезагрузкой. Проверьте чат и нажмите «Повторить», чтобы избежать дубля.'
          : cleanStoredString(value.error, 2_000)),
      accepted: false,
      restored: Boolean(restoring || value.restored),
      needsReattach,
    };
  }

  function readStoredMessageQueue() {
    try {
      const parsed = JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) || '[]');
      const values = Array.isArray(parsed) ? parsed : parsed?.items;
      if (!Array.isArray(values)) return [];
      const seen = new Set();
      return values.map((item) => cleanStoredQueueItem(item, true)).filter((item) => {
        if (!item || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).slice(0, 100);
    } catch {
      return [];
    }
  }

  function persistMessageQueue() {
    try {
      const values = [
        ...(state.activeQueueItem && !state.activeQueueItem.accepted ? [state.activeQueueItem] : []),
        ...state.messageQueue,
      ];
      const seen = new Set();
      const items = values.map((item) => cleanStoredQueueItem(item)).filter((item) => {
        if (!item || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).slice(0, 100);
      localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify({ version: 1, items }));
    } catch {
      // Queue persistence must never block typing or sending.
    }
  }

  function draftKey(chatId = state.currentChat?.id) {
    return chatId || '__new_chat__';
  }

  function persistDrafts() {
    try {
      const entries = Object.entries(state.drafts)
        .filter(([, value]) => typeof value === 'string' && value)
        .slice(-100);
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // Draft persistence is a convenience; an unavailable store must not block typing.
    }
  }

  function rememberDraft() {
    const key = draftKey();
    const value = elements.promptInput?.value || '';
    if (value) state.drafts[key] = value;
    else delete state.drafts[key];
    persistDrafts();
  }

  function restoreDraft() {
    elements.promptInput.value = state.drafts[draftKey()] || '';
    resizeComposer();
  }

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = String(text);
    return item;
  }

  function icon(paths, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    if (className) svg.setAttribute('class', className);
    for (const definition of Array.isArray(paths) ? paths : [paths]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', definition);
      svg.append(path);
    }
    return svg;
  }

  function insertRuntimeRules() {
    const rules = [
      '.preview-image{display:block;max-width:100%;max-height:calc(100% - 38px);object-fit:contain;margin:auto}',
      '.message-attachments{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
      '.backup-copy{min-width:0;display:flex;flex-direction:column;gap:3px}.backup-copy strong,.backup-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ];
    try {
      const sheet = [...document.styleSheets].find((candidate) => candidate.href?.endsWith('/styles.css')) || document.styleSheets[0];
      for (const rule of rules) sheet.insertRule(rule, sheet.cssRules.length);
    } catch {
      // The application remains usable if a restrictive policy prevents cosmetic runtime rules.
    }
  }

  function errorText(error) {
    const value = String(error?.message || error || 'Неизвестная ошибка.');
    return value
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim() || 'Неизвестная ошибка.';
  }

  function toast(message, kind = 'info', timeout = 4300) {
    if (!elements.toastStack) return;
    const item = node('div', `toast ${kind}`);
    item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const mark = node('span', 'toast-icon', kind === 'success' ? '✓' : (kind === 'error' ? '!' : 'i'));
    item.append(mark, node('span', '', message));
    elements.toastStack.append(item);
    const remove = () => {
      if (!item.isConnected || item.classList.contains('leaving')) return;
      item.classList.add('leaving');
      window.setTimeout(() => item.remove(), 220);
    };
    item.addEventListener('click', remove);
    window.setTimeout(remove, timeout);
  }

  function setConnection(label, status = '') {
    const copy = elements.connectionStatus?.lastElementChild;
    if (copy) copy.textContent = label;
    elements.connectionStatus?.classList.toggle('busy', status === 'busy');
    elements.connectionStatus?.classList.toggle('offline', status === 'offline');
  }

  function updateConnection() {
    if (state.busy) {
      const label = state.step ? `Шаг ${state.step.step} из ${state.step.maxSteps}` : 'Clop работает';
      setConnection(label, 'busy');
    } else {
      setConnection(state.loggedIn ? 'Готов' : 'Локальный режим');
    }
  }

  function formatTime(value) {
    const date = new Date(Number(value) || Date.now());
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function formatDateTime(value) {
    const date = new Date(Number(value) || Date.now());
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} КБ`;
    return `${(bytes / (1024 ** 2)).toFixed(1)} МБ`;
  }

  function folderBaseName(value) {
    const parts = String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/);
    return parts.pop() || value || '';
  }

  function relativeWhen(value) {
    const elapsed = Math.max(0, Date.now() - Number(value || 0));
    if (elapsed < 60_000) return 'только что';
    if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} мин назад`;
    if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} ч назад`;
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(new Date(value));
  }

  function formatElapsed(value) {
    const seconds = Math.max(0, Math.floor(Number(value || 0) / 1_000));
    const hours = Math.floor(seconds / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    const remainder = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
      : `${minutes}:${String(remainder).padStart(2, '0')}`;
  }

  function busyElapsed() {
    return state.busyStartedAt ? Math.max(0, Date.now() - state.busyStartedAt) : 0;
  }

  function tokenCount(value) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
    if (!value || typeof value !== 'object') return null;
    for (const key of ['total', 'totalTokens', 'total_tokens', 'billable', 'tokens']) {
      if (Number.isFinite(Number(value[key]))) return Math.max(0, Number(value[key]));
    }
    return null;
  }

  function formatDuration(value) {
    const duration = Number(value);
    if (!Number.isFinite(duration) || duration < 0) return '';
    if (duration < 1_000) return `${Math.round(duration)} мс`;
    const seconds = duration / 1_000;
    if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} с`;
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes} мин${remainder ? ` ${remainder} с` : ''}`;
  }

  function availableModels() {
    const models = Array.isArray(state.user?.models) ? state.user.models : [];
    return models.length ? models : fallbackModels;
  }

  function availableEfforts() {
    const efforts = Array.isArray(state.user?.efforts) ? state.user.efforts : [];
    return efforts.length ? efforts : fallbackEfforts;
  }

  function selectedModel() {
    const models = availableModels();
    const configured = models.find((item) => item.key === state.settings.model);
    const profileDefault = models.find((item) => item.key === state.user?.model);
    return (configured?.available !== false ? configured : null)
      || (profileDefault?.available !== false ? profileDefault : null)
      || models.find((item) => item.available !== false)
      || configured
      || profileDefault
      || models[0];
  }

  function selectedEffort() {
    const efforts = availableEfforts();
    return efforts.find((item) => item.key === state.settings.effort)
      || efforts.find((item) => item.key === state.user?.effort)
      || efforts[0];
  }

  function effortTitle(item) {
    if (item?.title) return item.title;
    return ({ low: 'Низкое', medium: 'Среднее', high: 'Высокое', xhigh: 'Максимальное' })[item?.key] || item?.key || 'Низкое';
  }

  function modelLimitDetails(model) {
    const provider = String(model?.provider || '').toLowerCase();
    const providerLimits = state.user?.limits?.[provider];
    const states = Array.isArray(providerLimits?.states)
      ? providerLimits.states
      : (providerLimits && typeof providerLimits === 'object'
        ? Object.entries(providerLimits).map(([key, value]) => ({ key, ...(value && typeof value === 'object' ? value : {}) }))
        : []);
    const windowDetail = (key, fallbackTitle) => {
      const value = states.find((item) => item?.key === key) || null;
      const rawPercent = Number(value?.percent);
      const rawLeft = Number(value?.left);
      const percent = Number.isFinite(rawPercent)
        ? Math.max(0, Math.min(100, rawPercent))
        : (Number.isFinite(rawLeft) ? Math.max(0, Math.min(100, 100 - rawLeft)) : null);
      const resetAt = Number(value?.resetAt) || 0;
      const percentText = percent === null
        ? 'Данные пока недоступны'
        : `${Number.isInteger(percent) ? percent : percent.toFixed(1)}% использовано`;
      return {
        title: value?.title || fallbackTitle,
        percent,
        resetAt,
        tone: percent === null ? 'normal' : (percent >= 90 ? 'critical' : (percent >= 60 ? 'warning' : 'normal')),
        text: percentText,
      };
    };
    const short = windowDetail('short', '5 часов');
    const long = windowDetail('long', '7 дней');
    return {
      provider,
      short,
      long,
      compact: `5ч ${short.percent === null ? '—' : `${Number.isInteger(short.percent) ? short.percent : short.percent.toFixed(1)}%`}`,
      title: `${short.title}: ${short.text}; ${long.title}: ${long.text}`,
    };
  }

  function renderModelLimitTooltip(details, id) {
    const tooltip = node('span', 'model-limit-tooltip');
    tooltip.id = id;
    tooltip.setAttribute('role', 'tooltip');
    tooltip.append(node('span', 'model-limit-provider', `Общий лимит ${details.provider.toUpperCase() || 'модели'}`));
    for (const window of [details.short, details.long]) {
      const row = node('span', `model-limit-row model-limit-${window.tone}`);
      row.append(node('span', 'model-limit-window', window.title), node('span', 'model-limit-value', window.text));
      tooltip.append(row);
    }
    return tooltip;
  }

  function limitsText(limits) {
    if (!limits || typeof limits !== 'object') return '';
    const candidates = [limits.requests, limits.messages, limits.gpt, limits.current, limits];
    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const remaining = [item.remaining, item.left, item.requestsLeft, item.messagesLeft, item.tokensLeft]
        .find((value) => Number.isFinite(Number(value)));
      const limit = [item.limit, item.total, item.maximum, item.max]
        .find((value) => Number.isFinite(Number(value)));
      if (remaining !== undefined && limit !== undefined) return `${Number(remaining).toLocaleString('ru-RU')} из ${Number(limit).toLocaleString('ru-RU')}`;
      if (remaining !== undefined) return `осталось ${Number(remaining).toLocaleString('ru-RU')}`;
      if (Number.isFinite(Number(item.used)) && limit !== undefined) {
        return `${Math.max(0, Number(limit) - Number(item.used)).toLocaleString('ru-RU')} из ${Number(limit).toLocaleString('ru-RU')}`;
      }
    }
    const primitive = Object.entries(limits).find(([, value]) => typeof value === 'number' || typeof value === 'string');
    return primitive ? `${primitive[0]}: ${primitive[1]}` : '';
  }

  function renderAccount() {
    const user = state.user;
    if (state.loggedIn && user) {
      const initial = String(user.name || 'C').trim().charAt(0).toUpperCase() || 'C';
      elements.userAvatar.textContent = initial;
      elements.settingsAvatar.textContent = initial;
      elements.accountName.textContent = user.name || 'Пользователь Clop';
      elements.settingsAccountName.textContent = user.name || 'Пользователь Clop';
      const limits = limitsText(user.limits);
      elements.accountPlan.textContent = [user.plan || 'Clop', limits].filter(Boolean).join(' · ');
      elements.settingsPlan.textContent = user.plan || 'Аккаунт Clop';
      elements.logoutButton.classList.remove('hidden');
    } else {
      elements.userAvatar.replaceChildren(icon(['M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7', 'M5.5 20a6.5 6.5 0 0 1 13 0']));
      elements.settingsAvatar.textContent = 'C';
      elements.accountName.textContent = 'Войти через Telegram';
      elements.accountPlan.textContent = 'Синхронизация и лимиты';
      elements.settingsAccountName.textContent = 'Гость';
      elements.settingsPlan.textContent = 'Войти';
      elements.logoutButton.classList.add('hidden');
    }
    elements.guestLoginPrompt.classList.toggle('hidden', state.loggedIn);
  }

  function applyTheme() {
    const requested = state.settings.theme || 'dark';
    elements.app.dataset.theme = requested === 'system' ? (systemTheme.matches ? 'light' : 'dark') : requested;
    elements.app.classList.toggle('no-animations', state.settings.animations === false);
    document.documentElement.style.colorScheme = elements.app.dataset.theme;
  }

  function renderSettings() {
    const settings = state.settings;
    elements.themeSelect.value = settings.theme || 'dark';
    elements.animationsSetting.checked = settings.animations !== false;
    elements.enterSendsSetting.checked = settings.enterSends !== false;
    elements.approvalModeSetting.value = settings.approvalMode || 'smart';
    elements.fastToggle.checked = Boolean(settings.fast);
    elements.fastSetting.checked = Boolean(settings.fast);
    elements.maxStepsSetting.value = String(settings.maxSteps || 12);
    elements.maxStepsValue.value = String(settings.maxSteps || 12);
    elements.maxStepsValue.textContent = String(settings.maxSteps || 12);
    elements.shellTimeoutSetting.value = String(settings.shellTimeout || 90);
    elements.composerHint.textContent = settings.enterSends === false ? 'Ctrl Enter — отправить' : 'Enter — отправить';
    const copy = modeCopy[state.mode] || modeCopy.chat;
    elements.settingsModeName.textContent = copy[0];
    elements.settingsModeDescription.textContent = copy[1];
    applyTheme();
    renderSelectors();
  }

  function populateSelect(select, items, chosen, titleFn = (item) => item.title || item.key, configureOption) {
    select.replaceChildren();
    for (const item of items) {
      const option = node('option', '', titleFn(item));
      option.value = item.key;
      option.selected = item.key === chosen;
      if (configureOption) configureOption(option, item);
      select.append(option);
    }
  }

  function renderSelectors() {
    const models = availableModels();
    const efforts = availableEfforts();
    const model = selectedModel();
    const effort = selectedEffort();
    const fastAvailable = model?.provider === 'gpt' || String(model?.key || '').startsWith('gpt-');
    elements.fastToggle.disabled = !fastAvailable;
    elements.fastToggle.closest('.fast-toggle')?.classList.toggle('hidden', !fastAvailable);
    elements.fastSetting.disabled = !fastAvailable;
    elements.fastSetting.closest('.setting-row')?.classList.toggle('hidden', !fastAvailable);
    const selectedLimits = modelLimitDetails(model);
    elements.modelLabel.textContent = model?.title || model?.key || 'Модель';
    elements.modelButton.title = selectedLimits.title;
    elements.modelButton.dataset.provider = selectedLimits.provider;
    elements.modelButton.setAttribute('data-limit-5h-percent', selectedLimits.short.percent ?? '');
    elements.modelButton.setAttribute('data-limit-weekly-percent', selectedLimits.long.percent ?? '');
    elements.effortLabel.textContent = `${effortTitle(effort)} усиление`;
    populateSelect(elements.modelSelect, models, model?.key, (item) => item.title || item.key, (option, item) => {
      const details = modelLimitDetails(item);
      option.disabled = item.available === false;
      option.textContent = `${item.title || item.key} · ${details.compact}${item.available === false ? ' · Недоступно' : ''}`;
      option.title = details.title;
      option.dataset.available = String(item.available !== false);
      option.dataset.provider = details.provider;
      option.setAttribute('data-limit-5h-percent', details.short.percent ?? '');
      option.setAttribute('data-limit-weekly-percent', details.long.percent ?? '');
    });
    populateSelect(elements.effortSelect, efforts, effort?.key, effortTitle);

    elements.modelMenu.replaceChildren(node('div', 'menu-label', 'Модель'));
    const markClasses = ['coral', 'orange', 'violet', 'blue'];
    models.forEach((item, index) => {
      const available = item.available !== false;
      const details = modelLimitDetails(item);
      const button = node('button', `model-option${available ? '' : ' model-option-locked'}`);
      button.type = 'button';
      button.dataset.model = item.key;
      button.dataset.provider = details.provider;
      button.dataset.available = String(available);
      button.dataset.plans = Array.isArray(item.plans) ? item.plans.join(',') : '';
      button.setAttribute('data-limit-5h-percent', details.short.percent ?? '');
      button.setAttribute('data-limit-weekly-percent', details.long.percent ?? '');
      button.setAttribute('data-limit-5h-reset-at', details.short.resetAt || '');
      button.setAttribute('data-limit-weekly-reset-at', details.long.resetAt || '');
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(item.key === model?.key));
      button.setAttribute('aria-disabled', String(!available));
      button.title = details.title;
      button.classList.toggle('selected', item.key === model?.key);
      const mark = node('span', `model-mark ${markClasses[index % markClasses.length]}`, String(item.title || item.key).charAt(0).toUpperCase());
      const copy = node('span', 'model-option-copy');
      copy.append(node('strong', '', item.title || item.key), node('small', 'model-option-description', item.description || item.key));
      const meta = node('span', 'model-option-meta');
      const chip = node('span', `model-limit-chip model-limit-${details.short.tone}`, details.compact);
      const tooltipId = `model-limit-tooltip-${index}`;
      chip.setAttribute('aria-hidden', 'true');
      meta.append(chip, renderModelLimitTooltip(details, tooltipId));
      if (!available) meta.append(node('span', 'model-lock', 'Недоступно'));
      meta.append(icon('m5 12 4 4L19 6', 'check'));
      button.setAttribute('aria-describedby', tooltipId);
      button.append(mark, copy, meta);
      button.addEventListener('click', () => {
        if (!available) return;
        closeMenus();
        saveSetting({ model: item.key });
      });
      elements.modelMenu.append(button);
    });

    elements.effortMenu.replaceChildren(node('div', 'menu-label', 'Усиление ответа'));
    efforts.forEach((item) => {
      const button = node('button');
      button.type = 'button';
      button.dataset.effort = item.key;
      button.classList.toggle('selected', item.key === effort?.key);
      const copy = node('span');
      copy.append(node('strong', '', effortTitle(item)), node('small', '', item.key === 'xhigh' ? 'Максимальная глубина' : 'Глубина рассуждения'));
      button.append(copy, icon('m5 12 4 4L19 6', 'check'));
      button.addEventListener('click', () => {
        closeMenus();
        saveSetting({ effort: item.key });
      });
      elements.effortMenu.append(button);
    });
  }

  function saveSetting(patch) {
    const previous = { ...state.settings };
    state.settings = { ...state.settings, ...patch };
    renderSettings();
    settingsQueue = settingsQueue
      .catch(() => undefined)
      .then(() => api.settings(patch))
      .then((result) => {
        if (result?.settings) state.settings = { ...state.settings, ...result.settings };
        if (result?.user) state.user = result.user;
        renderAccount();
        renderSelectors();
        renderSettings();
      })
      .catch((error) => {
        state.settings = { ...state.settings, ...Object.fromEntries(Object.keys(patch).map((key) => [key, previous[key]])) };
        renderSettings();
        toast(errorText(error), 'error');
      });
    return settingsQueue;
  }

  function appendInline(parent, text) {
    const pattern = /(\*\*([^*]+)\*\*|`([^`\n]+)`|\[([^\]]+)\]\((https:\/\/[^)\s]+)\))/g;
    let cursor = 0;
    for (const match of String(text).matchAll(pattern)) {
      if (match.index > cursor) parent.append(document.createTextNode(text.slice(cursor, match.index)));
      if (match[2] !== undefined) parent.append(node('strong', '', match[2]));
      else if (match[3] !== undefined) parent.append(node('code', '', match[3]));
      else {
        const link = node('a', '', match[4]);
        link.href = match[5];
        link.addEventListener('click', (event) => {
          event.preventDefault();
          openExternal(match[5]);
        });
        parent.append(link);
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) parent.append(document.createTextNode(text.slice(cursor)));
  }

  function markdownFragment(value) {
    const fragment = document.createDocumentFragment();
    const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
    let paragraph = [];
    let list = null;
    let listType = '';
    let codeBlock = null;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const paragraphNode = node('p');
      paragraph.forEach((line, index) => {
        if (index) paragraphNode.append(document.createElement('br'));
        appendInline(paragraphNode, line);
      });
      fragment.append(paragraphNode);
      paragraph = [];
    };
    const flushList = () => {
      if (list) fragment.append(list);
      list = null;
      listType = '';
    };
    for (const line of lines) {
      if (/^```/.test(line)) {
        flushParagraph();
        flushList();
        if (codeBlock) {
          const pre = node('pre');
          pre.append(node('code', '', codeBlock.join('\n')));
          fragment.append(pre);
          codeBlock = null;
        } else {
          codeBlock = [];
        }
        continue;
      }
      if (codeBlock) {
        codeBlock.push(line);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }
      const unordered = line.match(/^\s*[-*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const nextType = unordered ? 'ul' : 'ol';
        if (!list || listType !== nextType) {
          flushList();
          list = node(nextType);
          listType = nextType;
        }
        const item = node('li');
        appendInline(item, (unordered || ordered)[1]);
        list.append(item);
        continue;
      }
      flushList();
      const heading = line.match(/^#{1,3}\s+(.+)$/);
      if (heading) {
        flushParagraph();
        const paragraphNode = node('p');
        const strong = node('strong');
        appendInline(strong, heading[1]);
        paragraphNode.append(strong);
        fragment.append(paragraphNode);
      } else {
        paragraph.push(line);
      }
    }
    flushParagraph();
    flushList();
    if (codeBlock) {
      const pre = node('pre');
      pre.append(node('code', '', codeBlock.join('\n')));
      fragment.append(pre);
    }
    return fragment;
  }

  async function responseFilePreview(fileId) {
    if (!state.responseFilePreviews.has(fileId)) {
      const request = api.responseFile({ action: 'preview', id: fileId })
        .catch((error) => ({ ok: false, error: errorText(error) }));
      state.responseFilePreviews.set(fileId, request);
    }
    return state.responseFilePreviews.get(fileId);
  }

  async function loadResponseImage(file, card, preview, image) {
    const result = await responseFilePreview(file.id);
    if (!card.isConnected) return false;
    if (!result?.ok) {
      card.classList.add('unavailable');
      preview.remove();
      card.querySelector('.response-file-meta')?.append(document.createTextNode(' · недоступен'));
      return false;
    }
    if (!result.previewable || typeof result.content !== 'string' || !result.content.startsWith('data:image/')) {
      preview.remove();
      return false;
    }
    image.src = result.content;
    preview.classList.remove('hidden');
    return true;
  }

  async function saveResponseFile(file, button) {
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = 'Сохранение…';
    try {
      const result = await api.responseFile({ action: 'save', id: file.id });
      if (result?.ok) toast(`Файл «${file.name || 'Файл'}» сохранён.`, 'success');
    } catch (error) {
      toast(errorText(error), 'error', 6000);
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  }

  function renderResponseFile(file) {
    const card = node('section', 'response-file-card');
    card.dataset.fileId = file.id || '';
    const preview = node('div', 'response-file-preview hidden');
    const image = node('img', 'response-file-image');
    image.alt = file.name || 'Изображение от Clop';
    image.loading = 'lazy';
    image.addEventListener('error', () => preview.remove());
    preview.append(image);

    const row = node('div', 'response-file-row');
    const mark = node('div', 'response-file-icon');
    mark.append(icon(file.kind === 'image'
      ? ['M4 5h16v14H4z', 'm6 16 4-4 3 3 2-2 3 3', 'M15 9h.01']
      : ['M6 3h8l4 4v14H6z', 'M14 3v5h5']));
    const copy = node('div', 'response-file-copy');
    copy.append(
      node('strong', 'response-file-name', file.name || 'Файл'),
      node('small', 'response-file-meta', [file.mimeType || 'Файл', formatBytes(file.size)].filter(Boolean).join(' · ')),
    );
    const actions = node('div', 'response-file-actions');
    if (file.kind === 'image') {
      const show = node('button', 'response-file-preview-button', 'Просмотр');
      show.type = 'button';
      show.setAttribute('aria-label', `Показать ${file.name || 'изображение'}`);
      show.addEventListener('click', async () => {
        if (!preview.classList.contains('hidden')) {
          preview.classList.add('hidden');
          show.textContent = 'Просмотр';
          return;
        }
        show.disabled = true;
        show.textContent = 'Загрузка…';
        const shown = await loadResponseImage(file, card, preview, image);
        if (show.isConnected) {
          show.disabled = false;
          show.textContent = shown ? 'Скрыть' : 'Нет просмотра';
          if (!shown) show.disabled = true;
        }
      });
      actions.append(show);
    } else {
      preview.remove();
    }
    const save = node('button', 'response-file-save', 'Сохранить');
    save.type = 'button';
    save.setAttribute('aria-label', `Сохранить ${file.name || 'файл'}`);
    save.addEventListener('click', () => saveResponseFile(file, save));
    actions.append(save);
    row.append(mark, copy, actions);
    card.append(preview, row);
    return card;
  }

  function renderMessageAttachments(message, role) {
    if (!Array.isArray(message.attachments) || !message.attachments.length) return null;
    const container = node('div', role === 'assistant' ? 'response-files' : 'message-attachments');
    for (const attachment of message.attachments) {
      if (role === 'assistant' && attachment?.source === 'assistant' && attachment.id) {
        container.append(renderResponseFile(attachment));
        continue;
      }
      const chip = node('div', 'attachment');
      chip.append(
        icon(attachment.kind === 'image'
          ? ['M4 5h16v14H4z', 'm6 16 4-4 3 3 2-2 3 3', 'M15 9h.01']
          : ['M6 3h8l4 4v14H6z', 'M14 3v5h5']),
        node('span', '', attachment.name || 'Вложение'),
      );
      container.append(chip);
    }
    return container;
  }

  function isInterruptedMessage(message) {
    const messages = state.currentChat?.messages;
    return !state.busy
      && Array.isArray(messages)
      && messages.at(-1) === message
      && message?.role === 'user'
      && Boolean(message.clientMessageId);
  }

  async function retryInterruptedMessage(message, button) {
    if (state.busy || !message?.clientMessageId) return;
    button.disabled = true;
    button.textContent = 'Повторяем…';
    setBusy(true, state.currentChat?.id || '');
    renderMessages(true);
    try {
      const result = await api.retryAnswer({
        messageId: message.clientMessageId,
        model: selectedModel()?.key,
        effort: selectedEffort()?.key,
        fast: Boolean(state.settings.fast),
      });
      if (result?.chat) {
        upsertChat(result.chat);
        state.currentChat = result.chat;
      }
      renderChats();
      renderMessages(true);
    } catch (error) {
      toast(errorText(error), 'error', 7000);
    } finally {
      setBusy(false);
      renderMessages(true);
    }
  }

  function renderMessage(message) {
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const article = node('article', `message ${role}`);
    article.append(node('div', 'message-avatar', role === 'assistant' ? 'C' : (state.user?.name?.charAt(0)?.toUpperCase() || 'Вы')));
    const main = node('div', 'message-main');
    const meta = node('div', 'message-meta');
    meta.append(node('strong', '', role === 'assistant' ? 'Clop' : 'Вы'));
    const time = node('time', '', formatTime(message.ts));
    time.dateTime = new Date(Number(message.ts) || Date.now()).toISOString();
    meta.append(time);
    const content = node('div', 'message-content');
    content.append(markdownFragment(message.content));
    main.append(meta, content);
    if (isInterruptedMessage(message)) {
      const status = node('div', 'message-status interrupted-message-status');
      status.append(document.createTextNode('Ответ не завершён. '));
      if (Array.isArray(message.attachments) && message.attachments.length) {
        status.append(document.createTextNode('Добавьте файлы заново и отправьте запрос ещё раз.'));
      } else {
        const retry = node('button', 'text-link', 'Повторить ответ');
        retry.type = 'button';
        retry.addEventListener('click', () => retryInterruptedMessage(message, retry));
        status.append(retry);
      }
      main.append(status);
    }
    if (role === 'assistant') {
      const tokens = tokenCount(message.tokens);
      const duration = formatDuration(message.durationMs);
      const model = cleanStoredString(message.model, 240);
      const modelName = availableModels().find((item) => item.key === model)?.title || model;
      const steps = Number.isFinite(Number(message.steps)) ? Math.max(0, Math.round(Number(message.steps))) : 0;
      if (modelName || tokens !== null || duration || steps) {
        const runMeta = node('div', 'message-run-metadata');
        if (modelName) {
          article.dataset.model = model;
          runMeta.append(node('span', 'message-run-stat message-run-model', modelName));
        }
        if (tokens !== null) {
          article.dataset.tokens = String(tokens);
          runMeta.append(node('span', 'message-run-stat message-run-tokens', `${Math.round(tokens).toLocaleString('ru-RU')} ток.`));
        }
        if (duration) {
          article.dataset.durationMs = String(Number(message.durationMs));
          runMeta.append(node('span', 'message-run-stat message-run-duration', duration));
        }
        if (steps > 1) runMeta.append(node('span', 'message-run-stat message-run-steps', `${steps} шагов`));
        main.append(runMeta);
      }
    }
    const attachments = renderMessageAttachments(message, role);
    if (attachments) main.append(attachments);
    article.append(main);
    return article;
  }

  function renderTyping() {
    const article = node('article', 'message assistant ai-live-message');
    article.id = 'assistantTyping';
    article.append(node('div', 'message-avatar', 'C'));
    const main = node('div', 'message-main');
    const meta = node('div', 'message-meta');
    const status = node('span', 'ai-live-status', state.step ? `шаг ${state.step.step}/${state.step.maxSteps}` : 'думает');
    const elapsed = node('time', 'ai-live-elapsed', formatElapsed(busyElapsed()));
    elapsed.dataset.busyElapsed = '';
    elapsed.setAttribute('aria-label', `Прошло ${formatElapsed(busyElapsed())}`);
    meta.append(node('strong', '', 'Clop'), status, elapsed);
    const content = node('div', 'message-content');
    const dots = node('span', 'typing-dots');
    dots.append(node('i'), node('i'), node('i'));
    content.append(dots);
    const card = node('div', 'step-card ai-live-step');
    card.dataset.step = String(state.step?.step || 0);
    card.dataset.maxSteps = String(state.step?.maxSteps || state.settings.maxSteps || 0);
    const stepState = node('span', 'step-state', '…');
    const copy = node('span', 'ai-live-copy');
    copy.append(node('strong', 'ai-live-action', state.liveAction || (state.step ? 'Готовлю следующий ответ' : 'Анализирую запрос')));
    if (state.liveActionDetail) copy.append(node('small', 'ai-live-detail', state.liveActionDetail));
    copy.append(node('small', 'ai-live-progress', state.step ? `Шаг ${state.step.step} из ${state.step.maxSteps}` : 'Подготовка первого шага'));
    card.append(stepState, copy);
    content.append(card);
    main.append(meta, content);
    article.append(main);
    return article;
  }

  function queueItemBelongsToCurrent(item) {
    const currentId = state.currentChat?.id || '';
    return !item.chatId || !currentId || item.chatId === currentId;
  }

  function renderQueuedMessage(item, position = 0) {
    const article = node('article', 'message user queued-message');
    article.dataset.queueId = item.id;
    article.append(node('div', 'message-avatar', state.user?.name?.charAt(0)?.toUpperCase() || 'Вы'));
    const main = node('div', 'message-main');
    const meta = node('div', 'message-meta');
    meta.append(node('strong', '', 'Вы'));
    const badgeText = item.status === 'sending'
      ? 'Отправляется'
      : (item.status === 'failed' ? 'Не отправлено' : `В очереди · ${position}`);
    meta.append(node('span', 'queued-badge', badgeText), node('time', '', formatTime(item.ts)));
    const content = node('div', 'message-content');
    if (item.text) content.append(markdownFragment(item.text));
    if (Array.isArray(item.attachmentItems) && item.attachmentItems.length) {
      const attachments = node('div', 'message-attachments');
      for (const attachment of item.attachmentItems) {
        const chip = node('div', 'attachment');
        chip.append(
          icon(attachment.kind === 'image'
            ? ['M4 5h16v14H4z', 'm6 16 4-4 3 3 2-2 3 3', 'M15 9h.01']
            : ['M6 3h8l4 4v14H6z', 'M14 3v5h5']),
          node('span', '', attachment.name || 'Вложение'),
        );
        attachments.append(chip);
      }
      content.append(attachments);
    }
    const status = node('div', 'message-status');
    if (item.status === 'failed') {
      status.append(document.createTextNode(`${item.error || 'Сообщение осталось в очереди и не потеряно.'} `));
      const retry = node('button', 'text-link', 'Повторить');
      retry.type = 'button';
      retry.addEventListener('click', () => retryQueuedMessage(item.id));
      status.append(retry);
    } else if (item.status === 'queued') {
      status.append(document.createTextNode('Будет отправлено автоматически после текущего ответа. '));
    } else {
      status.append(document.createTextNode('Передаём сообщение в чат…'));
    }
    if (item.status !== 'sending') {
      const restore = node('button', 'text-link', 'Вернуть в поле');
      restore.type = 'button';
      restore.addEventListener('click', () => restoreQueuedMessage(item.id));
      status.append(restore);
    }
    main.append(meta, content, status);
    article.append(main);
    return article;
  }

  function renderQueuedMessages() {
    const container = node('div', 'queued-messages');
    const active = state.activeQueueItem;
    if (active && !active.accepted && queueItemBelongsToCurrent(active)) {
      container.append(renderQueuedMessage(active, 0));
    }
    let position = 0;
    for (const item of state.messageQueue) {
      if (!queueItemBelongsToCurrent(item)) continue;
      position += 1;
      container.append(renderQueuedMessage(item, position));
    }
    return container.childElementCount ? container : null;
  }

  function restoreQueuedMessage(id) {
    const index = state.messageQueue.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = state.messageQueue.splice(index, 1);
    for (const attachmentId of item.attachments) state.reservedAttachmentIds.delete(attachmentId);
    const current = elements.promptInput.value;
    elements.promptInput.value = [item.text, current].filter(Boolean).join(current && item.text ? '\n\n' : '');
    if (!item.needsReattach) {
      const known = new Set(state.attachments.map((attachment) => attachment.id));
      for (const attachment of item.attachmentItems || []) {
        if (!known.has(attachment.id)) state.attachments.push(attachment);
      }
    } else {
      toast('Текст восстановлен. Добавьте вложения заново.');
    }
    persistMessageQueue();
    rememberDraft();
    renderAttachments();
    renderMessages(true);
    elements.promptInput.focus();
    queueMicrotask(drainMessageQueue);
  }

  function retryQueuedMessage(id) {
    const item = state.messageQueue.find((entry) => entry.id === id);
    if (!item) return;
    if (item.needsReattach) {
      restoreQueuedMessage(id);
      return;
    }
    item.status = 'queued';
    item.error = '';
    persistMessageQueue();
    renderMessages(true);
    queueMicrotask(drainMessageQueue);
  }

  function renderMessages(scroll = false) {
    const messages = Array.isArray(state.currentChat?.messages) ? state.currentChat.messages : [];
    const hasQueuedMessages = Boolean(state.activeQueueItem && queueItemBelongsToCurrent(state.activeQueueItem))
      || state.messageQueue.some(queueItemBelongsToCurrent);
    elements.emptyState.classList.toggle('hidden', messages.length > 0 || state.busy || hasQueuedMessages);
    elements.messageList.replaceChildren();
    for (const message of messages) elements.messageList.append(renderMessage(message));
    if (state.busy && (!state.busyChatId || state.busyChatId === state.currentChat?.id)) elements.messageList.append(renderTyping());
    const queued = renderQueuedMessages();
    if (queued) elements.messageList.append(queued);
    if (scroll) requestAnimationFrame(() => { elements.conversation.scrollTop = elements.conversation.scrollHeight; });
    renderChatHeader();
  }

  function renderChatHeader() {
    elements.chatTitle.textContent = state.currentChat?.title || 'Новый чат';
    const queuedCount = state.messageQueue.filter(queueItemBelongsToCurrent).length;
    if (state.busy && (!state.busyChatId || state.busyChatId === state.currentChat?.id)) {
      const progress = state.liveAction || (state.step ? `Выполняется шаг ${state.step.step} из ${state.step.maxSteps}` : 'Clop готовит ответ…');
      const running = `${progress} · ${formatElapsed(busyElapsed())}`;
      elements.chatSubtitle.textContent = queuedCount ? `${running} · в очереди ${queuedCount}` : running;
    } else if (queuedCount) {
      elements.chatSubtitle.textContent = `В очереди ${queuedCount} сообщ.`;
    } else if (state.currentChat?.messages?.length) {
      elements.chatSubtitle.textContent = `${state.currentChat.messages.length} сообщ. · ${relativeWhen(state.currentChat.updatedAt)}`;
    } else {
      elements.chatSubtitle.textContent = 'Clop готов помочь';
    }
  }

  function chatGroup(value) {
    const date = new Date(Number(value) || 0);
    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.floor((startToday - start) / 86_400_000);
    if (days <= 0) return 'Сегодня';
    if (days === 1) return 'Вчера';
    if (days < 7) return 'Последние 7 дней';
    return 'Ранее';
  }

  function renderChats() {
    const query = elements.chatSearch.value.trim().toLocaleLowerCase('ru');
    const chats = state.chats
      .filter((chat) => !query || String(chat.title || '').toLocaleLowerCase('ru').includes(query))
      .slice()
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    elements.chatGroups.replaceChildren();
    if (!chats.length) {
      const section = node('section', 'chat-group');
      section.append(node('h2', '', query ? 'Поиск' : 'Сегодня'), node('div', 'chat-list-empty', query ? 'Ничего не найдено' : 'История появится после первого сообщения'));
      elements.chatGroups.append(section);
      return;
    }
    const groups = new Map();
    for (const chat of chats) {
      const label = chatGroup(chat.updatedAt || chat.createdAt);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(chat);
    }
    for (const [label, entries] of groups) {
      const section = node('section', 'chat-group');
      section.append(node('h2', '', label));
      const list = node('div', 'chat-list');
      for (const chat of entries) {
        const button = node('button', 'chat-item');
        button.type = 'button';
        button.classList.toggle('active', chat.id === state.currentChat?.id);
        button.append(node('strong', '', chat.title || 'Новый чат'), node('small', '', relativeWhen(chat.updatedAt || chat.createdAt)));
        if (chat.id === state.busyChatId) button.append(node('span', 'chat-dot'));
        button.addEventListener('click', () => openChat(chat.id));
        list.append(button);
      }
      section.append(list);
      elements.chatGroups.append(section);
    }
  }

  function applyKnownAnswerMetadata(chat) {
    if (!chat?.id || !Array.isArray(chat.messages)) return chat;
    const records = state.answerMetadata.get(chat.id) || [];
    for (const record of records) {
      const message = chat.messages.slice().reverse().find((item) => item?.role === 'assistant'
        && (record.ts ? Number(item.ts) === record.ts : String(item.content || '') === record.text));
      if (message) Object.assign(message, record.metadata);
    }
    return chat;
  }

  function captureAnswerMetadata(event) {
    const metadata = {};
    if (typeof event.model === 'string' && event.model) metadata.model = event.model;
    if (event.tokens !== undefined && event.tokens !== null) metadata.tokens = event.tokens;
    if (Number.isFinite(Number(event.durationMs))) metadata.durationMs = Math.max(0, Number(event.durationMs));
    if (Number.isFinite(Number(event.steps))) metadata.steps = Math.max(0, Math.round(Number(event.steps)));
    if (!Object.keys(metadata).length || !event.chatId) return;
    const chat = state.chats.find((item) => item.id === event.chatId)
      || (state.currentChat?.id === event.chatId ? state.currentChat : null);
    const message = chat?.messages?.slice().reverse().find((item) => item?.role === 'assistant'
      && (!event.text || String(item.content || '') === String(event.text)));
    if (message) Object.assign(message, metadata);
    const records = state.answerMetadata.get(event.chatId) || [];
    records.push({ ts: Number(message?.ts) || 0, text: String(event.text || ''), metadata });
    state.answerMetadata.set(event.chatId, records.slice(-100));
  }

  function upsertChat(chat) {
    if (!chat?.id) return;
    applyKnownAnswerMetadata(chat);
    const index = state.chats.findIndex((item) => item.id === chat.id);
    if (index >= 0) state.chats[index] = chat;
    else state.chats.unshift(chat);
  }

  async function openChat(id) {
    if (id === state.currentChat?.id) return;
    rememberDraft();
    try {
      const chat = await api.openChat(id);
      state.currentChat = chat;
      upsertChat(chat);
      restoreDraft();
      renderChats();
      renderMessages(true);
      if (compactSidebar.matches) setSidebar(false);
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }

  async function newChat() {
    if (state.busy) {
      toast('Сначала остановите текущий ответ или дождитесь его завершения.');
      return;
    }
    rememberDraft();
    try {
      const chat = await api.newChat();
      state.currentChat = chat;
      upsertChat(chat);
      restoreDraft();
      renderChats();
      renderMessages(true);
      elements.promptInput.focus();
      if (compactSidebar.matches) setSidebar(false);
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }

  function updateBusyClock() {
    if (!state.busy) return;
    const value = formatElapsed(busyElapsed());
    all('[data-busy-elapsed]').forEach((item) => {
      item.textContent = value;
      item.setAttribute('aria-label', `Прошло ${value}`);
    });
    renderChatHeader();
  }

  function startBusyClock() {
    if (!state.busyStartedAt) state.busyStartedAt = Date.now();
    if (!state.busyTimer) state.busyTimer = window.setInterval(updateBusyClock, 1_000);
  }

  function stopBusyClock() {
    if (state.busyTimer) window.clearInterval(state.busyTimer);
    state.busyTimer = 0;
    state.busyStartedAt = 0;
  }

  function setBusy(value, chatId = '', startedAt = 0) {
    const wasBusy = state.busy;
    state.busy = Boolean(value);
    const exactStartedAt = Number(startedAt);
    if (state.busy && Number.isFinite(exactStartedAt) && exactStartedAt > 0) state.busyStartedAt = exactStartedAt;
    else if (state.busy && !wasBusy) state.busyStartedAt = Date.now();
    if (state.busy) startBusyClock();
    if (value && chatId) state.busyChatId = chatId;
    if (!value) {
      stopBusyClock();
      state.busyChatId = '';
      state.step = null;
      state.liveAction = '';
      state.liveActionDetail = '';
    }
    elements.sendButton.classList.toggle('hidden', state.terminalRunning && !state.busy);
    elements.stopButton.classList.toggle('hidden', !state.busy && !state.terminalRunning);
    elements.promptInput.disabled = false;
    elements.attachButton.disabled = false;
    updateConnection();
    renderChats();
    renderMessages(value);
    resizeComposer();
    if (!state.busy) queueMicrotask(drainMessageQueue);
  }

  function resizeComposer() {
    const input = elements.promptInput;
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, Math.max(53, input.scrollHeight))}px`;
    elements.sendButton.disabled = !input.value.trim() && !state.attachments.length;
  }

  async function submitPrompt() {
    const text = elements.promptInput.value.trim();
    if (!text && !state.attachments.length) return;
    if (!state.loggedIn) {
      showModal(elements.telegramModal);
      toast('Войдите через Telegram, чтобы отправить сообщение.');
      return;
    }
    const attachmentItems = state.attachments.map((item) => ({ ...item }));
    const item = {
      id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      chatId: state.currentChat?.id || state.busyChatId || '',
      text,
      attachments: attachmentItems.map((attachment) => attachment.id),
      attachmentItems,
      model: selectedModel()?.key,
      effort: selectedEffort()?.key,
      fast: Boolean(state.settings.fast),
      ts: Date.now(),
      status: 'queued',
      error: '',
      accepted: false,
    };
    state.messageQueue.push(item);
    persistMessageQueue();
    for (const attachmentId of item.attachments) state.reservedAttachmentIds.add(attachmentId);
    state.attachments = [];
    elements.promptInput.value = '';
    rememberDraft();
    renderAttachments();
    renderMessages(true);
    if (state.busy || state.queueRunning) toast(`Сообщение добавлено в очередь · позиция ${state.messageQueue.length}`, 'success');
    queueMicrotask(drainMessageQueue);
  }

  async function reconcileQueueBusy() {
    try {
      const snapshot = await api.state();
      setBusy(Boolean(snapshot?.busy), snapshot?.currentChat?.id || state.busyChatId, snapshot?.busyStartedAt);
      if (!snapshot?.busy) queueMicrotask(drainMessageQueue);
    } catch {
      window.setTimeout(drainMessageQueue, 900);
    }
  }

  async function drainMessageQueue() {
    if (state.queueRunning || state.busy || !state.loggedIn || !state.messageQueue.length) return;
    const next = state.messageQueue[0];
    if (next.status === 'failed') return;
    const item = state.messageQueue.shift();
    item.status = 'sending';
    item.error = '';
    state.activeQueueItem = item;
    state.queueRunning = true;
    persistMessageQueue();
    let serverStillBusy = false;
    let consumed = false;
    try {
      if (item.chatId && item.chatId !== state.currentChat?.id) await api.openChat(item.chatId);
      setBusy(true, item.chatId);
      renderMessages(true);
      const result = await api.ask({
        clientMessageId: item.id,
        text: item.text,
        attachments: item.attachments,
        model: item.model,
        effort: item.effort,
        fast: item.fast,
      });
      consumed = true;
      if (result?.chat) {
        upsertChat(result.chat);
        if (!state.currentChat || result.chat.id === state.currentChat.id) state.currentChat = result.chat;
      }
      renderChats();
      renderMessages(true);
    } catch (error) {
      const message = errorText(error);
      consumed = Boolean(item.accepted);
      if (!consumed && message.includes('Дождитесь текущего ответа')) {
        item.status = 'queued';
        state.messageQueue.unshift(item);
        serverStillBusy = true;
        toast('Сообщение осталось в очереди и отправится после текущего ответа.');
      } else if (!consumed) {
        item.status = 'failed';
        item.error = message;
        state.messageQueue.unshift(item);
        toast(`${message} Сообщение сохранено в очереди.`, 'error', 7000);
      }
      persistMessageQueue();
      if (message.includes('Войдите через Telegram')) showModal(elements.telegramModal);
    } finally {
      if (consumed) {
        for (const attachmentId of item.attachments) state.reservedAttachmentIds.delete(attachmentId);
      }
      const visibleChatId = state.currentChat?.id || '';
      if (visibleChatId && item.chatId && visibleChatId !== item.chatId) {
        try { await api.openChat(visibleChatId); } catch { /* The visible chat remains intact locally. */ }
      }
      state.activeQueueItem = null;
      state.queueRunning = false;
      persistMessageQueue();
      if (!serverStillBusy) setBusy(false);
      else reconcileQueueBusy();
      renderMessages(true);
      elements.promptInput.focus();
    }
  }

  async function stop() {
    if (!state.busy && !state.terminalRunning) return;
    elements.stopButton.disabled = true;
    try {
      await api.stop();
      toast('Операция остановлена.');
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      elements.stopButton.disabled = false;
      setBusy(false);
      state.terminalRunning = false;
    }
  }

  function renderAttachments() {
    elements.attachmentStrip.replaceChildren();
    for (const attachment of state.attachments) {
      const chip = node('div', 'attachment');
      chip.title = `${attachment.name} · ${formatBytes(attachment.size)}`;
      chip.append(icon(attachment.kind === 'image' ? ['M4 5h16v14H4z', 'm6 16 4-4 3 3 2-2 3 3', 'M15 9h.01'] : ['M6 3h8l4 4v14H6z', 'M14 3v5h5']), node('span', '', attachment.name));
      const remove = node('button', '', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Убрать ${attachment.name}`);
      remove.addEventListener('click', async () => {
        try {
          const attachments = await api.attach({ remove: attachment.id });
          state.attachments = attachments.filter((item) => !state.reservedAttachmentIds.has(item.id));
          renderAttachments();
          resizeComposer();
        } catch (error) {
          toast(errorText(error), 'error');
        }
      });
      chip.append(remove);
      elements.attachmentStrip.append(chip);
    }
    resizeComposer();
  }

  async function attachFiles() {
    try {
      const attachments = await api.attach({});
      state.attachments = attachments.filter((item) => !state.reservedAttachmentIds.has(item.id));
      renderAttachments();
      if (state.attachments.length) toast(`Добавлено вложений: ${state.attachments.length}`, 'success');
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }

  function renderFolder() {
    const path = state.settings.workDir || '';
    if (path) {
      elements.folderName.textContent = folderBaseName(path);
      elements.folderPath.textContent = path;
      elements.workspaceName.textContent = folderBaseName(path);
      elements.workspaceCrumb.title = path;
      elements.chooseFolderButton.textContent = 'Сменить';
    } else if (state.mode === 'full') {
      elements.folderName.textContent = 'Файлы Windows';
      elements.folderPath.textContent = 'Домашняя папка';
      elements.workspaceName.textContent = 'Полный доступ';
      elements.workspaceCrumb.title = 'Полный доступ на текущий сеанс';
      elements.chooseFolderButton.textContent = 'Выбрать';
    } else {
      elements.folderName.textContent = 'Рабочая папка';
      elements.folderPath.textContent = 'Не выбрана';
      elements.workspaceName.textContent = 'Без рабочей папки';
      elements.workspaceCrumb.title = 'Рабочая папка не выбрана';
      elements.chooseFolderButton.textContent = 'Выбрать';
    }
  }

  function filePlaceholder(message) {
    const placeholder = node('div', 'pane-placeholder');
    placeholder.append(icon('M3.5 7A2 2 0 0 1 5.5 5h4l2 2h7A2 2 0 0 1 20.5 9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z'), node('p', '', message));
    elements.fileTree.replaceChildren(placeholder);
  }

  function renderFileEntry(item) {
    const wrapper = node('div');
    const button = node('button', `tree-entry ${item.type === 'directory' ? 'folder' : ''}`.trim());
    button.type = 'button';
    button.title = item.path;
    button.classList.toggle('expanded', state.expandedFolders.has(item.path));
    button.classList.toggle('selected', state.selectedFile === item.path);
    if (item.type === 'directory') {
      button.append(icon('m9 6 6 6-6 6', 'tree-chevron'), icon('M3.5 7A2 2 0 0 1 5.5 5h4l2 2h7A2 2 0 0 1 20.5 9v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z'));
    } else {
      button.append(icon(['M6 3h8l4 4v14H6z', 'M14 3v5h5']));
    }
    button.append(node('span', '', item.name));
    button.addEventListener('click', () => item.type === 'directory' ? toggleFolder(item) : previewFile(item));
    wrapper.append(button);
    if (item.type === 'directory' && state.expandedFolders.has(item.path)) {
      const children = node('div', 'tree-children');
      const cached = state.fileCache.get(item.path);
      if (cached === undefined) children.append(node('div', 'chat-list-empty', 'Загрузка…'));
      else if (!cached.length) children.append(node('div', 'chat-list-empty', 'Папка пуста'));
      else for (const child of cached) children.append(renderFileEntry(child));
      wrapper.append(children);
    }
    return wrapper;
  }

  function renderFiles() {
    renderFolder();
    if (state.mode === 'chat') {
      filePlaceholder('В режиме «Только чат» доступ к файлам отключён');
      return;
    }
    if (!state.files.length) {
      filePlaceholder(state.settings.workDir || state.mode === 'full' ? 'Папка пуста или ещё не обновлена' : 'Выберите папку, чтобы видеть файлы проекта');
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const item of state.files) fragment.append(renderFileEntry(item));
    elements.fileTree.replaceChildren(fragment);
  }

  async function toggleFolder(item) {
    if (state.expandedFolders.has(item.path)) {
      state.expandedFolders.delete(item.path);
      renderFiles();
      return;
    }
    state.expandedFolders.add(item.path);
    renderFiles();
    if (!state.fileCache.has(item.path)) {
      try {
        const children = await api.files(item.path);
        state.fileCache.set(item.path, Array.isArray(children) ? children : []);
      } catch (error) {
        state.expandedFolders.delete(item.path);
        toast(errorText(error), 'error');
      }
    }
    renderFiles();
  }

  async function refreshFiles() {
    if (state.mode === 'chat') {
      renderFiles();
      return;
    }
    elements.refreshFiles.disabled = true;
    try {
      const files = await api.files('.');
      state.files = Array.isArray(files) ? files : [];
      state.fileCache.clear();
      state.expandedFolders.clear();
      renderFiles();
    } catch (error) {
      toast(errorText(error), 'error');
      renderFiles();
    } finally {
      elements.refreshFiles.disabled = false;
    }
  }

  async function previewFile(item) {
    try {
      const preview = await api.preview(item.path);
      state.selectedFile = item.path;
      elements.previewName.textContent = preview.name || item.name;
      elements.previewContent.textContent = '';
      all('.preview-image', elements.filePreview).forEach((image) => image.remove());
      if (preview.binary && preview.mime?.startsWith('image/') && preview.content) {
        elements.previewContent.classList.add('hidden');
        const image = node('img', 'preview-image');
        image.src = preview.content;
        image.alt = preview.name || item.name;
        elements.filePreview.append(image);
      } else {
        elements.previewContent.classList.remove('hidden');
        elements.previewContent.textContent = preview.binary
          ? `Двоичный файл · ${formatBytes(preview.size)}\nПредпросмотр содержимого недоступен.`
          : preview.content;
      }
      elements.filePreview.classList.remove('hidden');
      renderFiles();
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }

  function closePreview() {
    state.selectedFile = '';
    elements.filePreview.classList.add('hidden');
    elements.previewContent.classList.remove('hidden');
    all('.preview-image', elements.filePreview).forEach((image) => image.remove());
    renderFiles();
  }

  async function chooseFolder() {
    try {
      const result = await api.pickFolder();
      if (!result?.ok) return result;
      state.settings.workDir = result.path || '';
      state.files = Array.isArray(result.files) ? result.files : [];
      state.mode = result.mode || 'workspace';
      state.fileCache.clear();
      state.expandedFolders.clear();
      applyMode();
      renderFiles();
      toast(`Выбрана папка «${folderBaseName(result.path)}»`, 'success');
      return result;
    } catch (error) {
      toast(errorText(error), 'error');
      return null;
    }
  }

  function applyMode() {
    elements.app.dataset.mode = state.mode;
    all('[data-mode]', elements.modeSwitch).forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
    renderFolder();
    renderSettings();
    if (state.mode === 'chat') closePreview();
  }

  async function setMode(mode) {
    try {
      const result = await api.setMode(mode);
      if (result?.needsFolder) {
        const folder = await chooseFolder();
        if (folder?.ok && mode === 'workspace' && state.mode !== 'workspace') return setMode('workspace');
        return folder;
      }
      if (result?.ok) {
        state.mode = result.mode;
        applyMode();
        renderFiles();
        if (state.mode !== 'chat' && !state.files.length) refreshFiles();
      }
      return result;
    } catch (error) {
      toast(errorText(error), 'error');
      return null;
    }
  }

  function requestMode(mode, fromOnboarding = false) {
    if (state.agreementRequired && !fromOnboarding) {
      showModal(elements.onboardingModal);
      return;
    }
    if (mode === 'full') {
      state.fullFromOnboarding = fromOnboarding;
      elements.fullModeAcknowledge.checked = false;
      elements.confirmFullMode.disabled = true;
      showModal(elements.fullModeModal);
      return;
    }
    setMode(mode).then((result) => {
      if (fromOnboarding && result?.ok) finishOnboarding();
    });
  }

  function renderActivity() {
    elements.actionCount.textContent = String(state.logs.length);
    elements.activityList.replaceChildren();
    if (!state.logs.length) {
      const placeholder = node('div', 'pane-placeholder compact');
      placeholder.append(icon(['M4 12a8 8 0 1 0 2.3-5.7L4 8.5', 'M4 4.5v4h4', 'M12 7.5V12l3 2']), node('p', '', 'Действия агента появятся здесь'));
      elements.activityList.append(placeholder);
      return;
    }
    for (const entry of state.logs.slice(0, 100)) {
      const status = entry.status === 'denied' ? 'error' : (entry.status || 'done');
      const item = node('div', `activity-entry ${status}`);
      item.append(node('span', 'activity-time', formatDateTime(entry.ts)), node('strong', '', toolNames[entry.tool] || entry.tool || 'Действие'), node('p', '', entry.summary || 'Выполнено'));
      elements.activityList.append(item);
    }
  }

  function updateActivityBadge() {
    elements.activityBadge.textContent = String(state.unreadActions);
    elements.activityBadge.classList.toggle('hidden', state.unreadActions < 1);
  }

  function renderBackupsModal(path = '') {
    let backdrop = byId('backupsModal');
    if (!backdrop) {
      backdrop = node('div', 'modal-backdrop hidden');
      backdrop.id = 'backupsModal';
      backdrop.setAttribute('role', 'dialog');
      backdrop.setAttribute('aria-modal', 'true');
      const modal = node('div', 'modal compact-modal');
      const close = node('button', 'modal-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Закрыть');
      close.addEventListener('click', () => hideModal(backdrop));
      modal.append(close, node('p', 'eyebrow', 'ЛОКАЛЬНЫЕ ДАННЫЕ'), node('h2', '', 'Резервные копии'), node('p', 'backups-path'));
      const list = node('div', 'terms-box backups-list');
      list.dataset.backupList = 'true';
      modal.append(list);
      const actions = node('div', 'modal-actions');
      const done = node('button', 'button primary', 'Готово');
      done.type = 'button';
      done.addEventListener('click', () => hideModal(backdrop));
      actions.append(done);
      modal.append(actions);
      backdrop.append(modal);
      elements.app.append(backdrop);
    }
    const pathCopy = backdrop.querySelector('.backups-path');
    if (pathCopy) pathCopy.textContent = path ? `Хранятся локально: ${path}` : 'Копии создаются перед изменением существующих файлов.';
    const list = backdrop.querySelector('[data-backup-list]');
    list.replaceChildren();
    if (!state.backups.length) {
      list.append(node('p', '', 'Резервных копий пока нет.'));
      return backdrop;
    }
    for (const backup of state.backups.slice(0, 50)) {
      const row = node('div', 'setting-row');
      const copy = node('div', 'backup-copy');
      copy.append(node('strong', '', folderBaseName(backup.target)), node('small', '', `${backup.target} · ${formatDateTime(backup.createdAt)} · ${formatBytes(backup.size)}`));
      const restore = node('button', 'button secondary small-button', 'Восстановить');
      restore.type = 'button';
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        try {
          await api.backups({ restore: backup.id });
          toast(`Восстановлен файл «${folderBaseName(backup.target)}»`, 'success');
          await refreshFiles();
        } catch (error) {
          toast(errorText(error), 'error', 6000);
        } finally {
          restore.disabled = false;
        }
      });
      row.append(copy, restore);
      list.append(row);
    }
    return backdrop;
  }

  async function openBackups() {
    try {
      const result = await api.backups({});
      state.backups = Array.isArray(result?.backups) ? result.backups : [];
      hideModal(elements.settingsModal);
      showModal(renderBackupsModal(result?.path || ''));
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }

  function setInspector(open, tab = state.inspectorTab) {
    state.inspectorOpen = Boolean(open);
    state.inspectorTab = tab;
    elements.inspector.classList.toggle('closed', !state.inspectorOpen);
    document.querySelector('.shell')?.classList.toggle('inspector-collapsed', !state.inspectorOpen);
    if (state.inspectorOpen) selectInspectorTab(tab);
    else setRailView('chat');
  }

  function setSidebar(open) {
    state.sidebarOpen = Boolean(open);
    const shell = document.querySelector('.shell');
    if (compactSidebar.matches) {
      shell?.classList.remove('sidebar-collapsed');
      elements.sidebar.classList.toggle('open', state.sidebarOpen);
    } else {
      elements.sidebar.classList.remove('open');
      shell?.classList.toggle('sidebar-collapsed', !state.sidebarOpen);
    }
    const label = state.sidebarOpen ? 'Скрыть панель чатов' : 'Показать панель чатов';
    elements.chatRailButton.setAttribute('aria-label', label);
    elements.chatRailButton.setAttribute('aria-expanded', String(state.sidebarOpen));
    elements.chatRailButton.title = label;
  }

  function toggleSidebar() {
    const currentlyOpen = compactSidebar.matches
      ? elements.sidebar.classList.contains('open')
      : !document.querySelector('.shell')?.classList.contains('sidebar-collapsed');
    setSidebar(!currentlyOpen);
  }

  function setRailView(view) {
    all('.activity-rail [data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  }

  function selectInspectorTab(tab) {
    state.inspectorTab = tab;
    state.inspectorOpen = true;
    elements.inspector.classList.remove('closed');
    document.querySelector('.shell')?.classList.remove('inspector-collapsed');
    all('[data-inspector-tab]').forEach((button) => button.classList.toggle('active', button.dataset.inspectorTab === tab));
    elements.filesPane.classList.toggle('active', tab === 'files');
    elements.activityPane.classList.toggle('active', tab === 'activity');
    if (tab === 'activity') {
      state.unreadActions = 0;
      updateActivityBadge();
    }
    setRailView(tab === 'files' ? 'files' : 'activity');
  }

  function appendTerminal(text, className = '') {
    if (!text) return;
    const line = node('div', `terminal-line ${className}`.trim(), text);
    elements.terminalOutput.append(line);
    elements.terminalOutput.scrollTop = elements.terminalOutput.scrollHeight;
  }

  function setTerminalOpen(open) {
    elements.terminalPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    elements.terminalRailButton.classList.toggle('active', open);
    if (open) requestAnimationFrame(() => elements.terminalInput.focus());
  }

  async function runTerminal(command) {
    const value = String(command || '').trim();
    if (!value || state.terminalRunning) return;
    state.terminalHistory.push(value);
    state.terminalHistory = state.terminalHistory.slice(-100);
    state.terminalHistoryIndex = state.terminalHistory.length;
    elements.terminalInput.value = '';
    appendTerminal(`› ${value}`, 'command');
    state.terminalRunning = true;
    elements.terminalInput.disabled = true;
    elements.sendButton.classList.add('hidden');
    elements.stopButton.classList.remove('hidden');
    try {
      const result = await api.terminal({ command: value });
      if (!result?.ok && result?.stderr && !elements.terminalOutput.textContent.includes(result.stderr)) appendTerminal(result.stderr, 'error');
    } catch (error) {
      appendTerminal(errorText(error), 'error');
      toast(errorText(error), 'error');
    } finally {
      state.terminalRunning = false;
      elements.terminalInput.disabled = false;
      elements.sendButton.classList.remove('hidden');
      elements.stopButton.classList.toggle('hidden', !state.busy);
      elements.terminalInput.focus();
    }
  }

  function showModal(modal) {
    if (!modal) return;
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : restoreFocus;
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]')?.focus());
  }

  function hideModal(modal) {
    if (!modal) return;
    modal.classList.add('hidden');
    if (restoreFocus?.isConnected) restoreFocus.focus();
  }

  function visibleModal() {
    const modals = all('.modal-backdrop:not(.hidden)');
    return modals[modals.length - 1] || null;
  }

  function renderOnboarding() {
    all('[data-step]', elements.onboardingModal).forEach((step) => step.classList.toggle('active', Number(step.dataset.step) === state.onboardingStep));
    all('.step-dots span', elements.onboardingModal).forEach((dot, index) => dot.classList.toggle('active', index === state.onboardingStep));
    elements.onboardingBack.classList.toggle('hidden', state.onboardingStep === 0);
    elements.onboardingNext.textContent = state.onboardingStep === 2 ? 'Начать работу' : 'Продолжить';
    all('[data-onboarding-mode]').forEach((button) => button.classList.toggle('selected', button.dataset.onboardingMode === state.onboardingMode));
  }

  async function onboardingNext() {
    if (state.onboardingStep === 0) {
      state.onboardingStep = 1;
      renderOnboarding();
      return;
    }
    if (state.onboardingStep === 1) {
      if (!elements.termsCheckbox.checked) {
        toast('Примите условия, чтобы продолжить.');
        elements.termsCheckbox.focus();
        return;
      }
      elements.onboardingNext.disabled = true;
      try {
        await api.acceptTerms({ version: state.agreementVersion });
        state.agreementRequired = false;
        state.onboardingStep = 2;
        renderOnboarding();
      } catch (error) {
        toast(errorText(error), 'error');
      } finally {
        elements.onboardingNext.disabled = false;
      }
      return;
    }
    if (state.onboardingMode === 'workspace') {
      let result;
      if (state.settings.workDir) result = await setMode('workspace');
      else result = await chooseFolder();
      if (result?.ok) finishOnboarding();
    } else {
      requestMode(state.onboardingMode, true);
    }
  }

  function closeMenus() {
    elements.modelMenu.classList.add('hidden');
    elements.effortMenu.classList.add('hidden');
    elements.modelButton.classList.remove('open');
    elements.effortButton.classList.remove('open');
  }

  function toggleMenu(menu, anchor) {
    const opening = menu.classList.contains('hidden');
    closeMenus();
    if (!opening) return;
    menu.classList.remove('hidden');
    anchor.classList.add('open');
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, rect.left));
    let top = rect.top - menu.offsetHeight - 8;
    if (top < 8) top = rect.bottom + 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, top)}px`;
  }

  function switchSettingsTab(tab) {
    all('[data-settings-tab]').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
    all('[data-settings-pane]').forEach((pane) => pane.classList.toggle('active', pane.dataset.settingsPane === tab));
    elements.settingsTitle.textContent = ({ general: 'Основные', model: 'Модель', privacy: 'Доступ и данные', about: 'О приложении' })[tab] || 'Настройки';
  }

  function openSettings(tab = 'general') {
    renderSettings();
    renderAccount();
    switchSettingsTab(tab);
    showModal(elements.settingsModal);
    if (state.loggedIn) refreshAccount(false);
  }

  async function refreshAccount(showFeedback = false) {
    if (!state.loggedIn) return;
    try {
      const result = await api.me();
      state.user = result?.user || state.user;
      renderAccount();
      renderSelectors();
      if (showFeedback) toast('Данные аккаунта и лимиты обновлены.', 'success');
    } catch (error) {
      if (showFeedback) toast(errorText(error), 'error');
    }
  }

  function showLogin() {
    if (state.loggedIn) {
      openSettings('about');
      refreshAccount(true);
      return;
    }
    resetLoginUi();
    state.loginPromptShown = true;
    showModal(elements.telegramModal);
  }

  function maybePromptLogin() {
    if (state.loggedIn || state.agreementRequired || state.loginPromptShown) return;
    if (!elements.onboardingModal.classList.contains('hidden')) return;
    showLogin();
  }

  function finishOnboarding() {
    hideModal(elements.onboardingModal);
    window.setTimeout(maybePromptLogin, 120);
  }

  function resetLoginUi() {
    elements.authIdle.classList.remove('hidden');
    elements.authWaiting.classList.add('hidden');
    elements.startLoginButton.disabled = false;
    elements.loginCode.textContent = '••••••';
  }

  function clearLoginTimer() {
    if (state.loginTimer) window.clearTimeout(state.loginTimer);
    state.loginTimer = null;
  }

  async function startLogin() {
    elements.startLoginButton.disabled = true;
    try {
      const result = await api.login();
      state.login = result;
      elements.loginCode.textContent = result.code || '••••••';
      elements.authIdle.classList.add('hidden');
      elements.authWaiting.classList.remove('hidden');
      scheduleLoginPoll(300);
      if (result.opened === false) toast(`Telegram не открылся. Найдите @${result.bot} и используйте показанный код.`, 'error', 7000);
    } catch (error) {
      elements.startLoginButton.disabled = false;
      toast(errorText(error), 'error', 6000);
    }
  }

  function scheduleLoginPoll(delay = 1800) {
    clearLoginTimer();
    if (!state.login) return;
    state.loginTimer = window.setTimeout(pollLogin, delay);
  }

  async function pollLogin() {
    if (!state.login || state.loginPolling) return;
    state.loginPolling = true;
    try {
      const result = await api.pollLogin({ id: state.login.id });
      if (result?.status === 'complete') {
        state.loggedIn = true;
        state.user = result.user || null;
        state.login = null;
        clearLoginTimer();
        hideModal(elements.telegramModal);
        resetLoginUi();
        renderAccount();
        renderSelectors();
        toast('Вход выполнен. Лимиты синхронизированы.', 'success');
      } else if (result?.status === 'expired') {
        state.login = null;
        clearLoginTimer();
        resetLoginUi();
        toast(result.error || 'Время подтверждения истекло.', 'error');
      } else {
        scheduleLoginPoll(1800);
      }
    } catch (error) {
      if (state.login) scheduleLoginPoll(4000);
      toast(`Не удалось проверить вход: ${errorText(error)}`, 'error');
    } finally {
      state.loginPolling = false;
    }
  }

  async function cancelLogin() {
    const hadLogin = Boolean(state.login);
    state.login = null;
    clearLoginTimer();
    resetLoginUi();
    if (hadLogin) {
      try { await api.cancelLogin(); } catch { /* The local login UI is already reset. */ }
    }
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(String(value));
    } catch {
      const temporary = node('textarea');
      temporary.value = String(value);
      temporary.setAttribute('readonly', '');
      document.body.append(temporary);
      temporary.select();
      document.execCommand('copy');
      temporary.remove();
    }
    toast('Код скопирован.', 'success');
  }

  async function openExternal(url) {
    try {
      await api.external(url);
    } catch (error) {
      toast(errorText(error), 'error');
    }
  }

  function queueApproval(approval) {
    if (!approval?.id) return;
    if (state.currentApproval?.id === approval.id || state.approvalQueue.some((item) => item.id === approval.id)) return;
    state.approvalQueue.push(approval);
    showNextApproval();
  }

  function showNextApproval() {
    if (state.currentApproval || !state.approvalQueue.length) return;
    const approval = state.approvalQueue.shift();
    state.currentApproval = approval;
    elements.approvalTitle.textContent = approval.title || 'Разрешить действие?';
    elements.approvalDescription.textContent = approval.description || 'Clop запрашивает одноразовое разрешение.';
    elements.approvalKind.textContent = approval.kind || toolNames[approval.tool] || 'Действие';
    elements.approvalRisk.textContent = approval.risk || 'Требует внимания';
    elements.approvalCode.textContent = approval.code || 'Действие не содержит дополнительных данных.';
    elements.approvalNote.textContent = approval.note || 'Проверьте действие и разрешите только ожидаемый шаг.';
    elements.allowAction.disabled = false;
    elements.denyAction.disabled = false;
    showModal(elements.approvalModal);
  }

  async function answerApproval(allow) {
    const approval = state.currentApproval;
    if (!approval) return;
    elements.allowAction.disabled = true;
    elements.denyAction.disabled = true;
    state.currentApproval = null;
    hideModal(elements.approvalModal);
    try {
      const result = await api.approve({ id: approval.id, allow });
      if (result?.expired) toast('Запрос подтверждения уже истёк.');
      else if (!allow) toast('Действие отклонено.');
    } catch (error) {
      toast(errorText(error), 'error');
    } finally {
      showNextApproval();
    }
  }

  function expireApproval(id) {
    if (state.currentApproval?.id === id) {
      state.currentApproval = null;
      hideModal(elements.approvalModal);
      toast('Время подтверждения истекло.');
      showNextApproval();
    } else {
      state.approvalQueue = state.approvalQueue.filter((item) => item.id !== id);
    }
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'settings':
        state.settings = { ...state.settings, ...(event.settings || {}) };
        renderSettings();
        renderFolder();
        break;
      case 'agreement':
        state.agreementRequired = event.accepted !== true;
        break;
      case 'mode':
        state.mode = event.mode || state.mode;
        applyMode();
        renderFiles();
        break;
      case 'folder':
        state.settings.workDir = event.path || '';
        state.files = Array.isArray(event.files) ? event.files : [];
        state.mode = event.mode || state.mode;
        state.fileCache.clear();
        applyMode();
        renderFiles();
        break;
      case 'chat':
        if (Array.isArray(event.chats)) state.chats = event.chats;
        if (event.chat) {
          upsertChat(event.chat);
          state.currentChat = event.chat;
        }
        renderChats();
        renderMessages(true);
        break;
      case 'message': {
        const previousChatId = state.currentChat?.id || '';
        if (event.chat) upsertChat(event.chat);
        if (event.message?.role === 'user' && state.activeQueueItem && !state.activeQueueItem.accepted) {
          const active = state.activeQueueItem;
          const sameChat = !active.chatId || !event.chatId || active.chatId === event.chatId;
          const sameId = event.message.clientMessageId && event.message.clientMessageId === active.id;
          const sameText = String(event.message.content || '').trim() === String(active.text || '').trim();
          if (sameId || (sameChat && sameText)) {
            active.accepted = true;
            if (!active.chatId) active.chatId = event.chatId || '';
            if (event.chatId) {
              for (const queued of state.messageQueue) {
                if (!queued.chatId) queued.chatId = event.chatId;
              }
            }
            persistMessageQueue();
          }
        }
        if (!state.currentChat || event.chatId === state.currentChat.id) {
          state.currentChat = event.chat || state.currentChat;
          if (!event.chat && state.currentChat && event.message) state.currentChat.messages = [...(state.currentChat.messages || []), event.message];
        }
        if (!previousChatId && state.currentChat?.id) {
          const draft = elements.promptInput.value || state.drafts.__new_chat__ || '';
          if (draft) state.drafts[state.currentChat.id] = draft;
          delete state.drafts.__new_chat__;
          persistDrafts();
        }
        renderChats();
        renderMessages(true);
        break;
      }
      case 'busy':
        setBusy(Boolean(event.value), event.chatId || '', event.startedAt);
        break;
      case 'step':
        state.step = { step: Number(event.step) || 1, maxSteps: Number(event.maxSteps) || state.settings.maxSteps };
        updateConnection();
        renderMessages(true);
        break;
      case 'action':
        state.liveAction = event.status === 'running' ? `${toolNames[event.tool] || event.tool || 'Действие'}…` : '';
        state.liveActionDetail = event.status === 'running' ? cleanStoredString(event.detail, 500) : '';
        if (event.status === 'error' && event.error) toast(event.error, 'error');
        renderMessages(true);
        break;
      case 'action-log':
        if (Array.isArray(event.logs)) state.logs = event.logs;
        else if (event.entry) state.logs.unshift(event.entry);
        if (state.inspectorTab !== 'activity' || !state.inspectorOpen) state.unreadActions += 1;
        renderActivity();
        updateActivityBadge();
        break;
      case 'backups':
        state.backups = Array.isArray(event.backups) ? event.backups : state.backups;
        if (byId('backupsModal')) renderBackupsModal();
        break;
      case 'attachments':
        state.attachments = Array.isArray(event.attachments)
          ? event.attachments.filter((item) => !state.reservedAttachmentIds.has(item.id))
          : [];
        renderAttachments();
        break;
      case 'file-warning':
        toast(event.message || 'Не удалось получить файл из ответа.', 'error', 7000);
        break;
      case 'approval':
        queueApproval(event.approval || event);
        break;
      case 'approval-expired':
        expireApproval(event.id);
        break;
      case 'terminal':
        if (event.text) appendTerminal(event.text, event.stream === 'stderr' ? 'error' : '');
        if (event.done) {
          appendTerminal(event.timedOut ? 'Команда остановлена по тайм-ауту.' : `Процесс завершён${event.code === null || event.code === undefined ? '' : ` с кодом ${event.code}`}.`, event.ok ? '' : 'error');
          state.terminalRunning = false;
          elements.terminalInput.disabled = false;
        }
        break;
      case 'auth':
        state.loggedIn = Boolean(event.loggedIn);
        state.user = event.user || null;
        if (state.loggedIn) {
          state.login = null;
          clearLoginTimer();
          hideModal(elements.telegramModal);
          resetLoginUi();
        }
        renderAccount();
        renderSelectors();
        updateConnection();
        if (state.loggedIn) queueMicrotask(drainMessageQueue);
        break;
      case 'answer':
        captureAnswerMetadata(event);
        state.liveAction = '';
        state.liveActionDetail = '';
        renderMessages(true);
        break;
      case 'stopped':
        toast('Ответ остановлен.');
        break;
      case 'error':
        toast(event.message || 'Не удалось выполнить запрос.', 'error', 6000);
        setConnection('Ошибка', 'offline');
        window.setTimeout(updateConnection, 3000);
        break;
      default:
        break;
    }
  }

  function hydrate(snapshot) {
    state.loggedIn = Boolean(snapshot.loggedIn);
    state.user = snapshot.user || null;
    state.settings = { ...state.settings, ...(snapshot.settings || {}) };
    state.mode = snapshot.mode || 'chat';
    state.chats = Array.isArray(snapshot.chats) ? snapshot.chats : [];
    state.currentChat = snapshot.currentChat || null;
    const deliveredQueueIds = new Set(
      [...state.chats, ...(state.currentChat ? [state.currentChat] : [])]
        .flatMap((chat) => Array.isArray(chat?.messages) ? chat.messages : [])
        .map((message) => message?.clientMessageId)
        .filter(Boolean),
    );
    if (deliveredQueueIds.size) state.messageQueue = state.messageQueue.filter((item) => !deliveredQueueIds.has(item.id));
    state.files = Array.isArray(snapshot.files) ? snapshot.files : [];
    state.logs = Array.isArray(snapshot.logs) ? snapshot.logs : [];
    state.backups = Array.isArray(snapshot.backups) ? snapshot.backups : [];
    state.attachments = Array.isArray(snapshot.attachments) ? snapshot.attachments : [];
    persistMessageQueue();
    state.agreementRequired = Boolean(snapshot.agreementRequired);
    state.agreementVersion = snapshot.agreementVersion || '';
    state.busy = Boolean(snapshot.busy);
    state.busyChatId = snapshot.busy ? (snapshot.currentChat?.id || '') : '';
    renderAccount();
    renderSettings();
    applyMode();
    renderChats();
    renderMessages();
    renderFiles();
    renderActivity();
    renderAttachments();
    restoreDraft();
    setBusy(state.busy, state.busyChatId, snapshot.busyStartedAt);
    setSidebar(!compactSidebar.matches);
    setInspector(window.innerWidth > 1120, state.inspectorTab);
    if (snapshot.pendingApproval) queueApproval(snapshot.pendingApproval);
    if (state.agreementRequired) {
      state.onboardingStep = 0;
      renderOnboarding();
      showModal(elements.onboardingModal);
    }
    state.loaded = true;
    if (!state.agreementRequired && !state.loggedIn) window.setTimeout(maybePromptLogin, 120);
  }

  function bindEvents() {
    elements.updateButton.addEventListener('click', async () => {
      elements.updateButton.disabled = true;
      elements.updateButton.textContent = 'Скачиваю…';
      try { await api.installUpdate(); }
      catch (error) {
        elements.updateButton.disabled = false;
        elements.updateButton.textContent = 'Обновить';
        toast(errorText(error), 'error');
      }
    });
    all('[data-window]').forEach((button) => button.addEventListener('click', () => api.window(button.dataset.window).catch((error) => toast(errorText(error), 'error'))));
    elements.newChatButton.addEventListener('click', newChat);
    elements.railNewChatButton.addEventListener('click', newChat);
    elements.chatSearch.addEventListener('input', renderChats);
    elements.accountButton.addEventListener('click', showLogin);
    elements.settingsAccount.addEventListener('click', showLogin);
    elements.emptyLoginButton.addEventListener('click', showLogin);
    elements.composerForm.addEventListener('submit', (event) => { event.preventDefault(); submitPrompt(); });
    elements.promptInput.addEventListener('input', () => {
      rememberDraft();
      resizeComposer();
    });
    elements.promptInput.addEventListener('keydown', (event) => {
      const shouldSend = state.settings.enterSends === false
        ? event.key === 'Enter' && (event.ctrlKey || event.metaKey)
        : event.key === 'Enter' && !event.shiftKey;
      if (shouldSend && !event.isComposing) {
        event.preventDefault();
        submitPrompt();
      }
    });
    elements.stopButton.addEventListener('click', stop);
    elements.attachButton.addEventListener('click', attachFiles);
    all('.starter').forEach((button) => button.addEventListener('click', () => {
      elements.promptInput.value = button.dataset.prompt || '';
      rememberDraft();
      resizeComposer();
      elements.promptInput.focus();
    }));

    elements.modelButton.addEventListener('click', (event) => { event.stopPropagation(); toggleMenu(elements.modelMenu, elements.modelButton); });
    elements.effortButton.addEventListener('click', (event) => { event.stopPropagation(); toggleMenu(elements.effortMenu, elements.effortButton); });
    elements.fastToggle.addEventListener('change', () => saveSetting({ fast: elements.fastToggle.checked }));
    elements.themeSelect.addEventListener('change', () => saveSetting({ theme: elements.themeSelect.value }));
    elements.animationsSetting.addEventListener('change', () => saveSetting({ animations: elements.animationsSetting.checked }));
    elements.enterSendsSetting.addEventListener('change', () => saveSetting({ enterSends: elements.enterSendsSetting.checked }));
    elements.approvalModeSetting.addEventListener('change', () => saveSetting({ approvalMode: elements.approvalModeSetting.value }));
    elements.modelSelect.addEventListener('change', () => saveSetting({ model: elements.modelSelect.value }));
    elements.effortSelect.addEventListener('change', () => saveSetting({ effort: elements.effortSelect.value }));
    elements.fastSetting.addEventListener('change', () => saveSetting({ fast: elements.fastSetting.checked }));
    elements.maxStepsSetting.addEventListener('input', () => { elements.maxStepsValue.textContent = elements.maxStepsSetting.value; });
    elements.maxStepsSetting.addEventListener('change', () => saveSetting({ maxSteps: Number(elements.maxStepsSetting.value) }));
    elements.shellTimeoutSetting.addEventListener('change', () => saveSetting({ shellTimeout: Number(elements.shellTimeoutSetting.value) }));

    all('[data-mode]', elements.modeSwitch).forEach((button) => button.addEventListener('click', () => requestMode(button.dataset.mode)));
    elements.chooseFolderButton.addEventListener('click', chooseFolder);
    elements.refreshFiles.addEventListener('click', refreshFiles);
    elements.closePreview.addEventListener('click', closePreview);
    elements.toggleInspector.addEventListener('click', () => setInspector(!state.inspectorOpen));
    elements.closeInspector.addEventListener('click', () => setInspector(false));
    all('[data-inspector-tab]').forEach((button) => button.addEventListener('click', () => selectInspectorTab(button.dataset.inspectorTab)));
    all('[data-view]').forEach((button) => button.addEventListener('click', () => {
      const view = button.dataset.view;
      if (view === 'chat') {
        const wasInspectorOpen = state.inspectorOpen;
        setInspector(false);
        if (wasInspectorOpen) setSidebar(true);
        else toggleSidebar();
      } else {
        selectInspectorTab(view);
        if (compactSidebar.matches) setSidebar(false);
      }
    }));

    elements.terminalRailButton.addEventListener('click', () => setTerminalOpen(elements.terminalPanel.getAttribute('aria-hidden') === 'true'));
    elements.closeTerminal.addEventListener('click', () => setTerminalOpen(false));
    elements.clearTerminal.addEventListener('click', () => elements.terminalOutput.replaceChildren(node('div', 'terminal-welcome', 'Терминал очищен')));
    elements.terminalForm.addEventListener('submit', (event) => { event.preventDefault(); runTerminal(elements.terminalInput.value); });
    elements.terminalInput.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp' && state.terminalHistory.length) {
        event.preventDefault();
        state.terminalHistoryIndex = Math.max(0, state.terminalHistoryIndex - 1);
        elements.terminalInput.value = state.terminalHistory[state.terminalHistoryIndex] || '';
      } else if (event.key === 'ArrowDown' && state.terminalHistory.length) {
        event.preventDefault();
        state.terminalHistoryIndex = Math.min(state.terminalHistory.length, state.terminalHistoryIndex + 1);
        elements.terminalInput.value = state.terminalHistory[state.terminalHistoryIndex] || '';
      }
    });

    elements.onboardingBack.addEventListener('click', () => { state.onboardingStep = Math.max(0, state.onboardingStep - 1); renderOnboarding(); });
    elements.onboardingNext.addEventListener('click', onboardingNext);
    all('[data-onboarding-mode]').forEach((button) => button.addEventListener('click', () => { state.onboardingMode = button.dataset.onboardingMode; renderOnboarding(); }));
    elements.openTermsButton.addEventListener('click', () => openExternal('terms'));
    elements.openTermsSettings.addEventListener('click', () => openExternal('terms'));

    elements.startLoginButton.addEventListener('click', startLogin);
    elements.cancelLoginButton.addEventListener('click', cancelLogin);
    elements.copyLoginCode.addEventListener('click', () => copyText(state.login?.code || elements.loginCode.textContent));
    elements.allowAction.addEventListener('click', () => answerApproval(true));
    elements.denyAction.addEventListener('click', () => answerApproval(false));
    elements.fullModeAcknowledge.addEventListener('change', () => { elements.confirmFullMode.disabled = !elements.fullModeAcknowledge.checked; });
    elements.confirmFullMode.addEventListener('click', async () => {
      if (!elements.fullModeAcknowledge.checked) return;
      elements.confirmFullMode.disabled = true;
      const result = await setMode('full');
      if (result?.ok) {
        hideModal(elements.fullModeModal);
        if (state.fullFromOnboarding) finishOnboarding();
        state.fullFromOnboarding = false;
      } else {
        elements.confirmFullMode.disabled = false;
      }
    });

    elements.settingsButton.addEventListener('click', () => openSettings('general'));
    all('[data-settings-tab]').forEach((button) => button.addEventListener('click', () => switchSettingsTab(button.dataset.settingsTab)));
    elements.changeModeButton.addEventListener('click', () => { hideModal(elements.settingsModal); document.querySelector(`[data-mode="${state.mode}"]`)?.focus(); });
    elements.openBackups.addEventListener('click', openBackups);
    elements.openWebsite.addEventListener('click', () => openExternal('https://clop-ai.onrender.com'));
    elements.logoutButton.addEventListener('click', async () => {
      elements.logoutButton.disabled = true;
      try {
        await api.logout();
        state.loggedIn = false;
        state.user = null;
        hideModal(elements.settingsModal);
        renderAccount();
        renderSelectors();
        toast('Вы вышли из аккаунта.');
      } catch (error) {
        toast(errorText(error), 'error');
      } finally {
        elements.logoutButton.disabled = false;
      }
    });

    all('[data-close-modal]').forEach((button) => button.addEventListener('click', async () => {
      const modal = byId(button.dataset.closeModal);
      if (modal === elements.telegramModal) await cancelLogin();
      if (modal === elements.fullModeModal) {
        state.fullFromOnboarding = false;
        elements.fullModeAcknowledge.checked = false;
        elements.confirmFullMode.disabled = true;
      }
      hideModal(modal);
    }));
    for (const modal of [elements.telegramModal, elements.settingsModal]) {
      modal.addEventListener('mousedown', (event) => {
        if (event.target !== modal) return;
        if (modal === elements.telegramModal) cancelLogin();
        hideModal(modal);
      });
    }

    document.addEventListener('click', (event) => {
      if (!event.target.closest('.menu-popover, #modelButton, #effortButton')) closeMenus();
    });
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        newChat();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault();
        openSettings('general');
        return;
      }
      if (event.key !== 'Escape') return;
      if (!elements.modelMenu.classList.contains('hidden') || !elements.effortMenu.classList.contains('hidden')) {
        closeMenus();
        return;
      }
      const modal = visibleModal();
      if (modal === elements.approvalModal) answerApproval(false);
      else if (modal === elements.telegramModal) { cancelLogin(); hideModal(modal); }
      else if (modal && modal !== elements.onboardingModal) hideModal(modal);
      else if (elements.sidebar.classList.contains('open')) setSidebar(false);
    });
    window.addEventListener('resize', closeMenus);
    compactSidebar.addEventListener('change', (event) => setSidebar(!event.matches));
    window.addEventListener('unhandledrejection', (event) => {
      event.preventDefault();
      toast(errorText(event.reason), 'error');
    });
    systemTheme.addEventListener('change', () => { if (state.settings.theme === 'system') applyTheme(); });
  }

  async function initialise() {
    insertRuntimeRules();
    bindEvents();
    renderOnboarding();
    renderAccount();
    renderSettings();
    setSidebar(!compactSidebar.matches);
    setInspector(window.innerWidth > 1120, state.inspectorTab);
    resizeComposer();
    if (!api) {
      setConnection('API недоступен', 'offline');
      toast('Не удалось подключить защищённый интерфейс приложения.', 'error', 8000);
      return;
    }
    api.onEvent((event) => {
      try { handleEvent(event); } catch (error) { toast(errorText(error), 'error'); }
    });
    setConnection('Загрузка…', 'busy');
    try {
      hydrate(await api.state());
      updateConnection();
      const update = await api.checkUpdate().catch(() => null);
      if (update?.available) elements.updateButton.classList.remove('hidden');
    } catch (error) {
      setConnection('Ошибка загрузки', 'offline');
      toast(errorText(error), 'error', 8000);
    }
  }

  initialise();
})();
