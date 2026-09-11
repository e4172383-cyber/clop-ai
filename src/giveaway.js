import crypto from 'node:crypto';
import { ADMIN_IDS, DAY } from './config.js';
import * as store from './store.js';

export const PRO_GIVEAWAY = Object.freeze({
  id: 'pro-month-2026-09-11',
  title: 'Розыгрыш Pro на 1 месяц',
  durationMs: 14 * 60 * 60_000,
  prizeDays: 30,
  initialParticipants: 71,
});

function participantOf(u, joinedAt) {
  return {
    userId: String(u.id),
    name: store.displayName(u).slice(0, 120),
    username: String(u.username || '').slice(0, 64),
    joinedAt,
  };
}

function ensureCampaign(now = Date.now()) {
  const db = store.raw();
  if (!db.campaigns || typeof db.campaigns !== 'object') db.campaigns = {};
  let campaign = db.campaigns[PRO_GIVEAWAY.id];
  if (campaign?.id === PRO_GIVEAWAY.id && Number(campaign.endsAt)) {
    if (!campaign.participants || typeof campaign.participants !== 'object') campaign.participants = {};
    let migrated = false;
    for (const [id, entry] of Object.entries(campaign.participants)) {
      if (entry.explicit === undefined) { entry.seeded = true; migrated = true; }
      if (ADMIN_IDS.map(String).includes(id) && !entry.explicit) { delete campaign.participants[id]; migrated = true; }
    }
    if (migrated) store.saveSoon();
    return campaign;
  }

  const adminIds = new Set(ADMIN_IDS.map(String));
  const seedUsers = store.allUsers()
    .filter((u) => /^\d{5,20}$/.test(String(u.id)) && !adminIds.has(String(u.id)))
    .sort((a, b) => Number(b.lastSeen || b.createdAt || 0) - Number(a.lastSeen || a.createdAt || 0))
    .slice(0, PRO_GIVEAWAY.initialParticipants);
  const participants = Object.fromEntries(seedUsers.map((u, index) => [
    String(u.id),
    { ...participantOf(u, now - (seedUsers.length - index) * 1000), seeded: true },
  ]));

  campaign = {
    id: PRO_GIVEAWAY.id,
    title: PRO_GIVEAWAY.title,
    startedAt: now,
    endsAt: now + PRO_GIVEAWAY.durationMs,
    prizePlan: 'pro',
    prizeDays: PRO_GIVEAWAY.prizeDays,
    participants,
    winner: null,
    drawnAt: 0,
    announcedAt: 0,
  };
  db.campaigns[PRO_GIVEAWAY.id] = campaign;
  store.saveSoon();
  return campaign;
}

function publicWinner(value) {
  if (!value) return null;
  return { name: value.name || 'Пользователь Clop', username: value.username || '' };
}

export function initializeGiveaway(now = Date.now()) {
  return ensureCampaign(now);
}

export function giveawayState(u, now = Date.now()) {
  const campaign = ensureCampaign(now);
  const participants = campaign.participants && typeof campaign.participants === 'object'
    ? campaign.participants
    : (campaign.participants = {});
  return {
    id: campaign.id,
    title: campaign.title,
    prize: 'Pro на 1 месяц',
    prizeDays: campaign.prizeDays,
    startedAt: campaign.startedAt,
    endsAt: campaign.endsAt,
    active: now < campaign.endsAt && !campaign.winner,
    ended: now >= campaign.endsAt || Boolean(campaign.winner),
    joined: Boolean(u && participants[String(u.id)]?.explicit),
    participants: PRO_GIVEAWAY.initialParticipants + Object.values(participants).filter((entry) => entry.explicit).length,
    winner: publicWinner(campaign.winner),
  };
}

export function joinGiveaway(u, now = Date.now()) {
  const campaign = ensureCampaign(now);
  if (now >= campaign.endsAt || campaign.winner) return { ok: false, reason: 'ended', state: giveawayState(u, now) };
  if (!campaign.participants || typeof campaign.participants !== 'object') campaign.participants = {};
  const id = String(u.id);
  if (campaign.participants[id]?.explicit) return { ok: true, alreadyJoined: true, state: giveawayState(u, now) };
  campaign.participants[id] = { ...participantOf(u, now), explicit: true };
  store.saveSoon();
  return { ok: true, alreadyJoined: false, state: giveawayState(u, now) };
}

export function drawGiveaway(now = Date.now(), chooseIndex = (length) => crypto.randomInt(length)) {
  const campaign = ensureCampaign(now);
  if (campaign.winner) return { ok: true, justDrawn: false, campaign, winner: campaign.winner };
  if (now < campaign.endsAt) return { ok: false, reason: 'active', campaign };
  const entrants = Object.values(campaign.participants || {}).filter((entry) => store.findUser(entry.userId));
  if (!entrants.length) return { ok: false, reason: 'no_participants', campaign };

  const picked = entrants[Math.max(0, Math.min(entrants.length - 1, Number(chooseIndex(entrants.length)) || 0))];
  const winner = store.findUser(picked.userId);
  const base = winner.plan === 'pro' && Number(winner.proUntil || 0) > now ? Number(winner.proUntil) : now;
  winner.plan = 'pro';
  winner.proUntil = base + PRO_GIVEAWAY.prizeDays * DAY;
  if (!Array.isArray(winner.planEvents)) winner.planEvents = [];
  winner.planEvents.push({
    type: 'giveaway_win',
    campaignId: campaign.id,
    plan: 'pro',
    days: PRO_GIVEAWAY.prizeDays,
    startedAt: now,
    endsAt: winner.proUntil,
  });
  campaign.winner = { ...participantOf(winner, picked.joinedAt), proUntil: winner.proUntil };
  campaign.drawnAt = now;
  store.saveSoon();
  return { ok: true, justDrawn: true, campaign, winner: campaign.winner };
}

export function participantIds() {
  return Object.keys(ensureCampaign().participants || {});
}

export function markGiveawayAnnounced(now = Date.now()) {
  const campaign = ensureCampaign(now);
  campaign.announcedAt = now;
  store.saveSoon();
  return campaign;
}

export function giveawayNeedsAnnouncement() {
  const campaign = ensureCampaign();
  return Boolean(campaign.winner && !campaign.announcedAt);
}
