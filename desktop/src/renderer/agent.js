'use strict';

(() => {
  const api = window.clopAgent;
  const agent = document.getElementById('agent');
  const setOnline = (online) => {
    agent.classList.remove('is-loading');
    agent.classList.toggle('is-offline', !online);
    agent.title = online ? 'Открыть Clop Code' : 'Нет связи · открыть Clop Code';
  };

  api.onCursor(({ point, bounds }) => {
    if (!point || !bounds || agent.classList.contains('is-offline') || agent.classList.contains('is-loading')) return;
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    const length = Math.max(1, Math.hypot(dx, dy));
    const scale = Math.min(7, length * .055) / length;
    agent.style.setProperty('--eye-x', `${(dx * scale).toFixed(2)}px`);
    agent.style.setProperty('--eye-y', `${(dy * scale).toFixed(2)}px`);
  });
  api.onNetwork(({ online }) => setOnline(Boolean(online)));
  agent.addEventListener('click', () => api.open());
  agent.addEventListener('contextmenu', (event) => { event.preventDefault(); api.menu(); });
  api.state().then(({ online }) => setOnline(Boolean(online))).catch(() => setOnline(false));
})();
