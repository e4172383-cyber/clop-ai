import { LIMITED_OFFER } from './config.js';

function record(u) {
  const value = u?.limitedOffer;
  return value && value.id === LIMITED_OFFER.id ? value : null;
}

export function offerState(u, now = Date.now()) {
  const current = record(u);
  if (current) {
    const active = now < Number(current.until || 0) && Number(current.used || 0) < LIMITED_OFFER.tokens;
    return {
      id: LIMITED_OFFER.id,
      title: LIMITED_OFFER.title,
      models: [...LIMITED_OFFER.models],
      tokens: LIMITED_OFFER.tokens,
      claimUntil: LIMITED_OFFER.claimUntil,
      claimed: true,
      active,
      until: Number(current.until || 0),
      used: Math.max(0, Number(current.used || 0)),
      left: Math.max(0, LIMITED_OFFER.tokens - Number(current.used || 0)),
    };
  }
  if (now >= LIMITED_OFFER.claimUntil) return null;
  return {
    id: LIMITED_OFFER.id,
    title: LIMITED_OFFER.title,
    models: [...LIMITED_OFFER.models],
    tokens: LIMITED_OFFER.tokens,
    claimUntil: LIMITED_OFFER.claimUntil,
    claimed: false,
    active: false,
    until: 0,
    used: 0,
    left: LIMITED_OFFER.tokens,
  };
}

export function claimOffer(u, now = Date.now()) {
  const existing = record(u);
  if (existing) return offerState(u, now);
  if (now >= LIMITED_OFFER.claimUntil) return null;
  u.limitedOffer = { id: LIMITED_OFFER.id, claimedAt: now, until: now + LIMITED_OFFER.durationMs, used: 0 };
  return offerState(u, now);
}

export function offerActiveFor(u, modelKey, now = Date.now()) {
  const state = offerState(u, now);
  return Boolean(state?.active && LIMITED_OFFER.models.includes(modelKey));
}

export function addOfferUsage(u, modelKey, tokens, now = Date.now()) {
  if (!offerActiveFor(u, modelKey, now)) return false;
  const amount = Math.max(0, Math.round(Number(tokens) || 0));
  u.limitedOffer.used = Math.min(LIMITED_OFFER.tokens, Number(u.limitedOffer.used || 0) + amount);
  return true;
}
