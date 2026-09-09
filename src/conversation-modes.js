export const SUPPORT_MODE_TTL_MS = 30 * 60_000;

export function enterSupportMode(user, now = Date.now()) {
  user.supportMode = true;
  user.supportModeAt = now;
}

export function leaveSupportMode(user) {
  const changed = Boolean(user.supportMode || user.supportModeAt);
  user.supportMode = false;
  delete user.supportModeAt;
  return changed;
}

export function isSupportModeActive(user, now = Date.now()) {
  if (!user.supportMode) return false;
  const enteredAt = Number(user.supportModeAt || 0);
  if (!enteredAt || now - enteredAt > SUPPORT_MODE_TTL_MS) {
    leaveSupportMode(user);
    return false;
  }
  return true;
}

export function leaveTransientModes(user, { keepSupport = false, keepBug = false } = {}) {
  let changed = false;
  if (!keepSupport) changed = leaveSupportMode(user) || changed;
  if (!keepBug && user.bugReportMode) {
    user.bugReportMode = false;
    changed = true;
  }
  return changed;
}
