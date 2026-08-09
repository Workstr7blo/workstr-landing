import { SimplePool, verifyEvent } from 'https://esm.sh/nostr-tools@2.17.0';
import { getSatoshisAmountFromBolt11 } from 'https://esm.sh/nostr-tools@2.17.0/nip57';

const OPERATOR_PUBKEY = 'ef24246321e47dd16cec960d4d374703af78505d0e59c532b054b5060e372bd6';
const ZAP_RECEIPT_SIGNER_PUBKEY = '72bdbc57bdd6dfc4e62685051de8041d148c3c68fe42bf301f71aa6cf53e52fb';
const MONTHLY_COST_SATS = 50_000;
const QUERY_TIMEOUT_MS = 7000;
const RECEIPT_LIMIT = 500;
const ZAP_RELAYS = [
  'wss://nos.lol',
  'wss://relay.nostr.band',
  'wss://relay.primal.net'
];

const $ = (id) => document.getElementById(id);
const formatSats = (value) => `${Math.round(value).toLocaleString()} sats`;

function monthStartUnix(now = new Date()) {
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime() / 1000);
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

function renderReady(receipts) {
  const sats = receipts.reduce((total, receipt) => total + receipt.sats, 0);
  const percent = Math.min(100, Math.round((sats / MONTHLY_COST_SATS) * 100));
  const supporters = new Set(receipts.map((receipt) => receipt.senderPubkey).filter(Boolean)).size;

  $('meter-status').textContent = 'Verified this month';
  $('meter-status').className = 'meter-status ready';
  $('meter-received').textContent = formatSats(sats);
  $('meter-cost').textContent = formatSats(MONTHLY_COST_SATS);
  $('meter-percent').textContent = `${percent}%`;
  $('meter-receipts').textContent = receipts.length.toLocaleString();
  $('meter-supporters').textContent = supporters ? supporters.toLocaleString() : 'unknown';
  $('meter-bar').style.width = `${Math.max(percent, receipts.length ? 3 : 0)}%`;
  $('meter-copy').textContent = receipts.length
    ? 'Only receipts signed by the Workstr wallet provider and tagged to the Workstr operator key are included.'
    : 'No verified zap receipts found for this month yet.';
}

function renderOffline() {
  $('meter-status').textContent = 'Relays unreachable';
  $('meter-status').className = 'meter-status offline';
  $('meter-received').textContent = 'unknown';
  $('meter-cost').textContent = formatSats(MONTHLY_COST_SATS);
  $('meter-percent').textContent = 'unknown';
  $('meter-receipts').textContent = 'unknown';
  $('meter-supporters').textContent = 'unknown';
  $('meter-bar').style.width = '0%';
  $('meter-copy').textContent = 'Could not reach zap relays. The honest state is unknown, not zero.';
}

fetchMonthlyReceipts().then(renderReady).catch(renderOffline);
