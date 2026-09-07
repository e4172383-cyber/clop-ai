'use strict';

(() => {
  const api = window.clopAgent;
  const tasks = document.getElementById('tasks');
  const count = document.getElementById('count');
  const labels = { thinking: 'Думает', list: 'Смотрит папку', read: 'Читает файл', write: 'Изменяет файл', shell: 'Выполняет команду', screenshot: 'Смотрит экран', click: 'Работает в интерфейсе', type: 'Вводит текст', key: 'Нажимает клавишу' };
  const icons = { running: '•', done: '✓', error: '!' };
  api.onTasks((payload = {}) => {
    const items = Array.isArray(payload.tasks) ? payload.tasks : [];
    count.textContent = items.length > 3 ? `${items.length} · листайте` : `${items.length}/3`;
    tasks.replaceChildren(...items.map((item) => {
      const row = document.createElement('div');
      row.className = `task ${item.status || 'running'}`;
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = icons[item.status] || '•';
      const copy = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = labels[item.tool] || 'Действие';
      const detail = document.createElement('small');
      detail.textContent = item.summary || 'Выполняется…';
      copy.append(title, detail);
      row.append(icon, copy);
      return row;
    }));
  });
  document.getElementById('panel').addEventListener('dblclick', () => api.open());
})();
