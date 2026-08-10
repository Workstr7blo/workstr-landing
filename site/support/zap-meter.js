import { SimplePool, verifyEvent } from 'https://esm.sh/nostr-tools@2.17.0';
import { getSatoshisAmountFromBolt11 } from 'https://esm.sh/nostr-tools@2.17.0/nip57';

const OPERATOR_PUBKEY = 'ef24246321e47dd16cec960d4d374703af78505d0e59c532b054b5060e372bd6';
const ZAP_RECEIPT_SIGNER_PUBKEY = '72bdbc57bdd6dfc4e62685051de8041d148c3c68fe42bf301f71aa6cf53e52fb';
const MONTHLY_COST_SATS = 85_000;
const QUERY_TIMEOUT_MS = 7000;
const RECEIPT_LIMIT = 500;
const ZAP_RELAYS = [
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net'
];

const $ = (id) => document.getElementById(id);
const formatSats = (value) => `${Math.round(value).toLocaleString()} sats`;
const shortPubkey = (pubkey) => pubkey ? `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}` : 'anonymous zapper';

function monthStartUnix(now = new Date()) {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0) / 1000);
}

function tagValue(tags, key) {
  return (tags.find((tag) => tag[0] === key) || [])[1] || '';
}

function parseReceipt(event) {
  if (event.kind !== 9735) return null;
  if (event.pubkey !== ZAP_RECEIPT_SIGNER_PUBKEY) return null;
  if (tagValue(event.tags, 'p') !== OPERATOR_PUBKEY) return null;
  if (!verifyEvent(event)) return null;

  const bolt11 = tagValue(event.tags, 'bolt11');
  if (!bolt11) return null;

  let sats = 0;
  try {
    sats = getSatoshisAmountFromBolt11(bolt11);
  } catch {
    return null;
  }
  if (!Number.isFinite(sats) || sats <= 0) return null;

  let senderPubkey = '';
  try {
    const request = JSON.parse(tagValue(event.tags, 'description') || '{}');
    if (typeof request?.pubkey === 'string') senderPubkey = request.pubkey;
  } catch {
    senderPubkey = '';
  }

  return { id: event.id, sats, createdAt: event.created_at, senderPubkey };
}

function parseProfile(event) {
  try {
    const profile = JSON.parse(event.content || '{}');
    return {
      pubkey: event.pubkey,
      createdAt: event.created_at,
      name: profile.display_name || profile.displayName || profile.name || shortPubkey(event.pubkey),
      picture: typeof profile.picture === 'string' ? profile.picture : ''
    };
  } catch {
    return null;
  }
}

function withTimeout(promise, timeoutMs = QUERY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('zap relay query timed out')), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function fetchMonthlyReceipts() {
  const pool = new SimplePool();
  try {
    const filter = { kinds: [9735], '#p': [OPERATOR_PUBKEY], since: monthStartUnix(), limit: RECEIPT_LIMIT };
    const results = await Promise.allSettled(ZAP_RELAYS.map(async (relay) => {
      await withTimeout(pool.ensureRelay(relay));
      return withTimeout(pool.querySync([relay], filter));
    }));
    if (results.every((result) => result.status === 'rejected')) throw new Error('no zap relay reachable');

    const byId = new Map();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const event of result.value) {
        const receipt = parseReceipt(event);
        if (receipt && !byId.has(receipt.id)) byId.set(receipt.id, receipt);
      }
    }
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    pool.close(ZAP_RELAYS);
  }
}

async function fetchProfiles(pubkeys) {
  const authors = [...new Set(pubkeys.filter(Boolean))];
  if (!authors.length) return new Map();

  const pool = new SimplePool();
  try {
    const filter = { kinds: [0], authors, limit: Math.max(10, authors.length * 3) };
    const results = await Promise.allSettled(ZAP_RELAYS.map(async (relay) => {
      await withTimeout(pool.ensureRelay(relay));
      return withTimeout(pool.querySync([relay], filter));
    }));

    const profiles = new Map();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const event of result.value) {
        if (!verifyEvent(event)) continue;
        const profile = parseProfile(event);
        const previous = profile ? profiles.get(profile.pubkey) : null;
        if (profile && (!previous || profile.createdAt > previous.createdAt)) {
          profiles.set(profile.pubkey, profile);
        }
      }
    }
    return profiles;
  } finally {
    pool.close(ZAP_RELAYS);
  }
}

function relativeTime(unixSeconds) {
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (delta < 60) return delta < 10 ? 'just now' : `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function renderLatestReceipts(receipts, profiles = new Map()) {
  const list = $('latest-receipts-list');
  if (!list) return;

  const latest = receipts.slice(0, 5);
  if (!latest.length) {
    list.innerHTML = '<p class="latest-empty">No verified zaps counted yet this UTC month.</p>';
    return;
  }

  list.replaceChildren(...latest.map((receipt) => {
    const profile = profiles.get(receipt.senderPubkey) || {};
    const row = document.createElement('article');
    row.className = 'latest-receipt-row';

    const bolt = document.createElement('span');
    bolt.className = 'latest-bolt';
    bolt.setAttribute('aria-hidden', 'true');

    const avatar = document.createElement('span');
    avatar.className = 'latest-avatar';
    if (profile.picture) {
      const img = document.createElement('img');
      img.src = profile.picture;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => img.remove());
      avatar.append(img);
    }
    const fallback = document.createElement('span');
    fallback.textContent = (profile.name || receipt.senderPubkey || '?').slice(0, 1).toUpperCase();
    avatar.append(fallback);

    const who = document.createElement('div');
    who.className = 'latest-receipt-who';
    const name = document.createElement('strong');
    name.textContent = profile.name || shortPubkey(receipt.senderPubkey);
    const action = document.createElement('span');
    action.textContent = 'zapped Workstr';
    who.append(name, action);

    const amount = document.createElement('div');
    amount.className = 'latest-receipt-amount';
    const sats = document.createElement('strong');
    sats.textContent = formatSats(receipt.sats);
    const time = document.createElement('span');
    time.textContent = relativeTime(receipt.createdAt);
    amount.append(sats, time);

    row.append(bolt, avatar, who, amount);
    return row;
  }));
}

function renderReady(receipts, profiles = new Map()) {
  const sats = receipts.reduce((total, receipt) => total + receipt.sats, 0);
  const rawPercent = Math.round((sats / MONTHLY_COST_SATS) * 100);
  const barPercent = Math.min(100, rawPercent);
  const gap = sats - MONTHLY_COST_SATS;
  const supporters = new Set(receipts.map((receipt) => receipt.senderPubkey).filter(Boolean)).size;
  const meterPanel = $('meter-panel');
  const isCovered = gap >= 0;

  $('meter-status').textContent = isCovered ? 'Month covered' : 'Under target';
  $('meter-status').className = `meter-status ready ${isCovered ? 'covered' : 'under'}`;
  if (meterPanel) meterPanel.classList.toggle('covered', isCovered);
  if (meterPanel) meterPanel.classList.toggle('under', !isCovered);
  $('meter-received').textContent = formatSats(sats);
  $('meter-cost').textContent = formatSats(MONTHLY_COST_SATS);
  $('meter-percent').textContent = `${rawPercent}%`;
  $('meter-gap').textContent = gap >= 0 ? `+${formatSats(gap)}` : `-${formatSats(Math.abs(gap))}`;
  $('meter-receipts').textContent = receipts.length.toLocaleString();
  $('meter-supporters').textContent = supporters ? supporters.toLocaleString() : 'unknown';
  $('meter-bar').style.width = `${Math.max(barPercent, receipts.length ? 3 : 0)}%`;
  $('meter-copy').textContent = isCovered
    ? 'This UTC month is covered. Extra verified zaps become Workstr runway for future development and infrastructure.'
    : 'Verified zaps are under the 85,000 sats monthly operating target. The remaining gap is founder-funded.';
  renderLatestReceipts(receipts, profiles);
}

function renderOffline() {
  const meterPanel = $('meter-panel');
  $('meter-status').textContent = 'Relays unreachable';
  $('meter-status').className = 'meter-status offline';
  if (meterPanel) meterPanel.classList.remove('covered', 'under');
  $('meter-received').textContent = 'unknown';
  $('meter-cost').textContent = formatSats(MONTHLY_COST_SATS);
  $('meter-percent').textContent = 'unknown';
  $('meter-gap').textContent = 'unknown';
  $('meter-receipts').textContent = 'unknown';
  $('meter-supporters').textContent = 'unknown';
  $('meter-bar').style.width = '0%';
  $('meter-copy').textContent = 'Could not reach zap relays. The honest state is unknown, not zero.';
  const list = $('latest-receipts-list');
  if (list) list.innerHTML = '<p class="latest-empty">Latest receipts unavailable while relays are unreachable.</p>';
}

async function initMeter() {
  const receipts = await fetchMonthlyReceipts();
  let profiles = new Map();
  try {
    profiles = await fetchProfiles(receipts.slice(0, 5).map((receipt) => receipt.senderPubkey));
  } catch {
    profiles = new Map();
  }
  renderReady(receipts, profiles);
}

initMeter().catch(renderOffline);
