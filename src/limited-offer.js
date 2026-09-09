import { LIMITED_OFFER } from './config.js';
import * as store from './store.js';

function campaign(now = Date.now()) {
  const db = store.raw();
  if (!db.campaigns || typeof db.campaigns !== 'object') db.campaigns = {};
  let value = db.campaigns[LIMITED_OFFER.id];
  if (!value || !Number(value.claimUntil)) {
    value = {
      id: LIMITED_OFFER.id,
      startedAt: now,
      claimUntil: now + LIMITED_OFFER.claimDurationMs,
    };
    db.campaigns[LIMITED_OFFER.id] = value;
    store.saveSoon();
  }
  return value;
}

export function initializeLimitedOffer(now = Date.now()) {
  return campaign(now);
}

function budget(modelKey) {
  return Math.max(0, Number(LIMITED_OFFER.budgets[modelKey]) || 0);
}

function usedByModel(current) {
  const source = current?.usedByModel && typeof current.usedByModel === 'object'
    ? current.usedByModel
    : {};
  return Object.fromEntries(LIMITED_OFFER.models.map((key) => [
    key,
    Math.min(budget(key), Math.max(0, Number(source[key]) || 0)),
  ]));
}

function record(u) {
  const value = u?.limitedOffer;
  return value && value.id === LIMITED_OFFER.id ? value : null;
}

export function offerState(u, now = Date.now()) {
  const current = record(u);
  const window = campaign(now);
  const budgets = { ...LIMITED_OFFER.budgets };
  const tokens = Object.values(budgets).reduce((sum, value) => sum + Number(value || 0), 0);
  if (current) {
    const usage = usedByModel(current);
    const leftByModel = Object.fromEntries(LIMITED_OFFER.models.map((key) => [key, Math.max(0, budget(key) - usage[key])]));
    const used = Object.values(usage).reduce((sum, value) => sum + value, 0);
    const left = Object.values(leftByModel).reduce((sum, value) => sum + value, 0);
    const active = now < Number(current.until || 0) && left > 0;
    return {
      id: LIMITED_OFFER.id,
      title: LIMITED_OFFER.title,
      models: [...LIMITED_OFFER.models],
      budgets,
      tokens,
      claimUntil: window.claimUntil,
      claimed: true,
      active,
      until: Number(current.until || 0),
      usedByModel: usage,
      leftByModel,
      used,
      left,
    };
  }
  if (now >= window.claimUntil) return null;
  return {
    id: LIMITED_OFFER.id,
    title: LIMITED_OFFER.title,
    models: [...LIMITED_OFFER.models],
    budgets,
    tokens,
    claimUntil: window.claimUntil,
    claimed: false,
    active: false,
    until: 0,
    usedByModel: Object.fromEntries(LIMITED_OFFER.models.map((key) => [key, 0])),
    leftByModel: budgets,
    used: 0,
    left: tokens,
  };
}

export function claimOffer(u, now = Date.now()) {
  const existing = record(u);
  if (existing) return offerState(u, now);
  if (now >= campaign(now).claimUntil) return null;
  return grantOffer(u, now);
}

// Административная выдача запускает личные пять часов независимо от общего
// часового окна акции. Это нужно для ручной компенсации и точечной выдачи.
export function grantOffer(u, now = Date.now()) {
  u.limitedOffer = {
    id: LIMITED_OFFER.id,
    claimedAt: now,
    until: now + LIMITED_OFFER.durationMs,
    usedByModel: Object.fromEntries(LIMITED_OFFER.models.map((key) => [key, 0])),
  };
  return offerState(u, now);
}

export function offerActiveFor(u, modelKey, now = Date.now()) {
  const state = offerState(u, now);
  return Boolean(state?.active && Number(state.leftByModel?.[modelKey] || 0) > 0);
}

export function addOfferUsage(u, modelKey, tokens, now = Date.now()) {
  const state = offerState(u, now);
  if (!state?.active) return 0;
  const amount = Math.max(0, Math.round(Number(tokens) || 0));
  const covered = Math.min(amount, Math.max(0, Number(state.leftByModel?.[modelKey]) || 0));
  if (!covered) return 0;
  if (!u.limitedOffer.usedByModel || typeof u.limitedOffer.usedByModel !== 'object') u.limitedOffer.usedByModel = {};
  u.limitedOffer.usedByModel[modelKey] = Math.min(
    budget(modelKey),
    Math.max(0, Number(u.limitedOffer.usedByModel[modelKey]) || 0) + covered,
  );
  return covered;
}
