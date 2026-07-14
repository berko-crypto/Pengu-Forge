// lib/penguins.js — resolve a Pudgy Penguin / Lil Pudgy token ID to image bytes.
//
// Strategy (most durable first):
//   1. Disk cache (DATA_DIR/pfp-cache) — art is immutable, so cache forever.
//   2. On-chain tokenURI via public Ethereum RPCs (no API key) — the same
//      source wallets/marketplaces use, immune to project API redesigns.
//   3. Resolve the URI (ipfs:// via gateway rotation, or plain https) to
//      metadata JSON, then fetch the image field the same way.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'pfp-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const COLLECTIONS = {
  pudgy: { label: 'Pudgy Penguins', maxId: 8887, contract: '0xBd3531dA5CF5857e7CfAA92426877b022e612cf8' },
  lil:   { label: 'Lil Pudgys',     maxId: 22221, contract: '0x524cAB2ec69124574082676e6F654a18df49A048' },
};

const RPC_ENDPOINTS = [
  'https://eth.llamarpc.com',
  'https://ethereum-rpc.publicnode.com',
  'https://cloudflare-eth.com',
  'https://1rpc.io/eth',
];

const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
];

const TOKEN_URI_SELECTOR = '0xc87b56dd'; // tokenURI(uint256)

function ipfsCandidates(url) {
  if (url.startsWith('ipfs://')) {
    const cidPath = url.slice('ipfs://'.length).replace(/^ipfs\//, '');
    return IPFS_GATEWAYS.map(gw => gw + cidPath);
  }
  return [url];
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'PenguForge/1.0', ...(opts.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

/** eth_call tokenURI(tokenId) on the collection contract, rotating public RPCs. */
async function fetchTokenURI(contract, tokenId) {
  const data = TOKEN_URI_SELECTOR + BigInt(tokenId).toString(16).padStart(64, '0');
  let lastErr;
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const res = await fetchWithTimeout(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }),
      }, 10000);
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || 'RPC error');
      const uri = decodeAbiString(json.result);
      if (uri) return uri;
      throw new Error('empty tokenURI');
    } catch (e) { lastErr = e; }
  }
  throw new Error(`All RPCs failed (${lastErr?.message}).`);
}

/** Decode an ABI-encoded string return value. */
function decodeAbiString(result) {
  if (!result || result === '0x') return null;
  const hex = result.slice(2);
  if (hex.length < 128) return null;
  const len = parseInt(hex.slice(64, 128), 16);
  return Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8');
}

/** Fetch a URL (rotating IPFS gateways when applicable), return { buf, type }. */
async function fetchResource(url, timeoutMs = 20000) {
  let lastErr;
  for (const candidate of ipfsCandidates(url)) {
    try {
      const res = await fetchWithTimeout(candidate, {}, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, type };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('fetch failed');
}

/**
 * Returns { buf, contentType, label } or throws a user-friendly error.
 */
async function getPenguinImage(collection, tokenId) {
  const col = COLLECTIONS[collection];
  if (!col) throw new Error('Unknown collection.');
  const id = Number(tokenId);
  if (!Number.isInteger(id) || id < 0 || id > col.maxId) {
    throw new Error(`${col.label} IDs run 0–${col.maxId}.`);
  }
  const label = `${col.label} #${id}`;

  // 1) permanent disk cache
  const cacheFile = path.join(CACHE_DIR, `${collection}-${id}.png`);
  if (fs.existsSync(cacheFile)) {
    return { buf: fs.readFileSync(cacheFile), contentType: 'image/png', label };
  }

  try {
    // 2) on-chain tokenURI -> metadata JSON
    const uri = await fetchTokenURI(col.contract, id);
    const metaRes = await fetchResource(uri);
    let meta;
    try { meta = JSON.parse(metaRes.buf.toString('utf8')); }
    catch { throw new Error('metadata was not valid JSON'); }
    const imgField = meta.image || meta.image_url;
    if (!imgField) throw new Error('metadata has no image field');

    // 3) image fetch (gateway rotation for ipfs://)
    const img = await fetchResource(imgField, 25000);
    if (!img.type.startsWith('image/') && img.buf.length < 1000) throw new Error('image fetch returned non-image');

    // cache forever — NFT art is immutable
    try { fs.writeFileSync(cacheFile, img.buf); } catch (_) {}
    return { buf: img.buf, contentType: img.type.startsWith('image/') ? img.type : 'image/png', label };
  } catch (e) {
    console.error(`penguin resolve failed for ${label}:`, e.message);
    throw new Error(`Couldn't fetch ${label}'s art right now (${e.message}). Try again in a minute, or attach your penguin image instead.`);
  }
}

module.exports = { getPenguinImage, COLLECTIONS };
