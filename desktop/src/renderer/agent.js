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
  let dragStart = null;
  let dragged = false;
  agent.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragStart = { x: event.screenX, y: event.screenY };
    dragged = false;
    agent.setPointerCapture(event.pointerId);
    api.dragStart(dragStart);
  });
  agent.addEventListener('pointermove', (event) => {
    if (!dragStart) return;
    if (Math.hypot(event.screenX - dragStart.x, event.screenY - dragStart.y) > 4) dragged = true;
    api.dragMove({ x: event.screenX, y: event.screenY });
  });
  agent.addEventListener('pointerup', (event) => {
    if (!dragStart) return;
    try { agent.releasePointerCapture(event.pointerId); } catch {}
    api.dragEnd();
    dragStart = null;
    if (!dragged) api.open();
  });
  agent.addEventListener('pointercancel', () => { dragStart = null; api.dragEnd(); });
  agent.addEventListener('contextmenu', (event) => { event.preventDefault(); api.menu(); });
  api.state().then(({ online }) => setOnline(Boolean(online))).catch(() => setOnline(false));
})();
