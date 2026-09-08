(() => {
  'use strict';
  const cursor = document.getElementById('remoteCursor');
  const action = document.getElementById('remoteAction');
  const time = document.getElementById('remoteTime');
  let expiresAt = 0;
  let actionTimer = null;
  let cursorTimer = null;

  function updateTime() {
    if (!expiresAt) return;
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const minutes = Math.floor(left / 60);
    const seconds = String(left % 60).padStart(2, '0');
    time.textContent = `активен · ${minutes}:${seconds}`;
  }

  window.clopAgent.onRemoteOverlay((state) => {
    if (!state?.active) return;
    expiresAt = Number(state.session?.expiresAt || expiresAt);
    if (state.cursor && Number.isFinite(state.cursor.x) && Number.isFinite(state.cursor.y)) {
      cursor.style.left = `${state.cursor.x - 5}px`;
      cursor.style.top = `${state.cursor.y - 4}px`;
      cursor.classList.add('show');
      clearTimeout(cursorTimer);
      cursorTimer = setTimeout(() => cursor.classList.remove('show'), 2400);
    }
    if (state.action) {
      action.textContent = `ИИ: ${state.action}`;
      action.classList.add('show');
      clearTimeout(actionTimer);
      actionTimer = setTimeout(() => action.classList.remove('show'), 2200);
    }
    updateTime();
  });
  setInterval(updateTime, 1000);
})();
