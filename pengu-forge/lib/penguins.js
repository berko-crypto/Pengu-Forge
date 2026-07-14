// lib/penguins.js — resolve a Pudgy Penguin / Lil Pudgy token ID to image bytes
const COLLECTIONS = {
  pudgy: {
    label: 'Pudgy Penguins',
    maxId: 8887,
    meta: (id) => `https://api.pudgypenguins.io/penguin/${id}`,
    image: (id) => `https://api.pudgypenguins.io/penguin/image/${id}`,
  },
  lil: {
    label: 'Lil Pudgys',
    maxId: 22221,
    meta: (id) => `https://api.pudgypenguins.io/lil/${id}`,
    image: (id) => `https://api.pudgypenguins.io/lil/image/${id}`,
  },
};

const IPFS_GATEWAYS = [
  'https://ipfs.io/ipfs/',
  'https://cloudflare-ipfs.com/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
];

function ipfsToHttp(url, gw = IPFS_GATEWAYS[0]) {
  return url.startsWith('ipfs://') ? gw + url.slice('ipfs://'.length) : url;
}

async function fetchBuffer(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'PenguForge/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    return { buf, type };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Returns { buf, contentType, label } or throws with a user-friendly message.
 */
async function getPenguinImage(collection, tokenId) {
  const col = COLLECTIONS[collection];
  if (!col) throw new Error('Unknown collection.');
  const id = Number(tokenId);
  if (!Number.isInteger(id) || id < 0 || id > col.maxId) {
    throw new Error(`${col.label} IDs run 0–${col.maxId}.`);
  }

  // 1) direct image endpoint
  try {
    const { buf, type } = await fetchBuffer(col.image(id));
    if (type.startsWith('image/')) return { buf, contentType: type, label: `${col.label} #${id}` };
  } catch (_) { /* fall through */ }

  // 2) metadata -> image field (handles ipfs://), rotating gateways
  const metaRes = await fetchBuffer(col.meta(id));
  let meta;
  try { meta = JSON.parse(metaRes.buf.toString('utf8')); }
  catch { throw new Error(`Couldn't read metadata for ${col.label} #${id}.`); }
  const imgField = meta.image || meta.image_url;
  if (!imgField) throw new Error(`No image found for ${col.label} #${id}.`);

  let lastErr;
  for (const gw of IPFS_GATEWAYS) {
    try {
      const { buf, type } = await fetchBuffer(ipfsToHttp(imgField, gw), 20000);
      if (type.startsWith('image/') || buf.length > 1000) {
        return { buf, contentType: type || 'image/png', label: `${col.label} #${id}` };
      }
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Couldn't fetch the image for ${col.label} #${id} (${lastErr?.message || 'gateway error'}). Try attaching the image instead.`);
}

module.exports = { getPenguinImage, COLLECTIONS };
