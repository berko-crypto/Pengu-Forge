// db.js — better-sqlite3 persistence (mount a Railway volume at ./data)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'penguforge.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  name TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  added_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS grants (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,          -- extra generations for a specific day
  extra INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL UNIQUE,
  added_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gallery_posts (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  template TEXT,
  custom_prompt TEXT,
  example_path TEXT,
  collection TEXT,
  token_id INTEGER,
  remixed_from TEXT,        -- original gallery message_id if this is a remix
  day TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  name TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  dir TEXT NOT NULL,
  base_file TEXT NOT NULL,
  mask_file TEXT,
  ref_files TEXT NOT NULL DEFAULT '[]',   -- JSON array of filenames
  added_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS winners (
  day TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  votes INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS gen_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  template TEXT,
  collection TEXT,
  token_id INTEGER,
  quality TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

const DEFAULTS = {
  daily_limit: '3',
  quality: 'low',          // low | medium | high  (gpt-image-1)
  size: '1024x1024',       // API size for square gens
  output_px: '1000',       // square outputs are resized to this exact px (0 = keep API size)
  booster_bonus: '1',      // extra daily gens for server boosters
  allowed_channel: '',     // channel ID; empty = anywhere
  enabled: '1',
  cooldown_seconds: '30',  // min seconds between gens per user
  example_prompt: 'Recreate the second image (the example) as closely as possible — same composition, pose, style, background, lighting, and mood — but replace its subject with the penguin character from the first image.',
  gallery_channel: '',     // channel ID for auto-reposts; empty = gallery off
  winner_bonus: '3',       // bonus gens for Gen of the Day winner
  winner_emoji: '🔥',      // vote emoji tallied for daily winner
  streak_every: '5',       // +1 daily limit per N consecutive days generating
  streak_cap: '3',         // max streak bonus
  default_campaign: '',    // if set, a bare /generate (no template/prompt/example) runs this campaign
};

// Seed default generation rules on first boot
const SEED_RULES = [
  'Square 1:1 composition unless the holder explicitly asks for a different aspect.',
  "Retain the penguin character's wearables, outfit, headwear, and skin color EXACTLY as they appear in the input image — do not restyle, recolor, or omit any trait unless the holder explicitly asks.",
];
if (db.prepare('SELECT COUNT(*) AS n FROM rules').get().n === 0) {
  const ins = db.prepare('INSERT OR IGNORE INTO rules (text, added_by) VALUES (?, ?)');
  for (const r of SEED_RULES) ins.run(r, 'default');
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULTS[key] ?? null);
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function allSettings() {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

// ---- templates ----
const addTemplate = (name, prompt, addedBy) =>
  db.prepare('INSERT INTO templates (name, prompt, added_by) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET prompt = excluded.prompt, added_by = excluded.added_by')
    .run(name.toLowerCase(), prompt, addedBy);
const removeTemplate = (name) => db.prepare('DELETE FROM templates WHERE name = ?').run(name.toLowerCase());
const getTemplate = (name) => db.prepare('SELECT * FROM templates WHERE name = ?').get(name.toLowerCase());
const listTemplates = () => db.prepare('SELECT * FROM templates ORDER BY name').all();

// ---- rules (default generation constraints) ----
const addRule = (text, addedBy) =>
  db.prepare('INSERT OR IGNORE INTO rules (text, added_by) VALUES (?, ?)').run(text.trim(), addedBy);
const removeRule = (id) => db.prepare('DELETE FROM rules WHERE id = ?').run(id);
const listRules = () => db.prepare('SELECT * FROM rules ORDER BY id').all();

// ---- gallery ----
function addGalleryPost(p) {
  db.prepare(`INSERT OR REPLACE INTO gallery_posts
    (message_id, channel_id, user_id, template, custom_prompt, example_path, collection, token_id, remixed_from, day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(p.messageId, p.channelId, p.userId, p.template ?? null, p.customPrompt ?? null,
         p.examplePath ?? null, p.collection ?? null, p.tokenId ?? null, p.remixedFrom ?? null, today());
}
const getGalleryPost = (messageId) => db.prepare('SELECT * FROM gallery_posts WHERE message_id = ?').get(messageId);
const postsForDay = (day) => db.prepare('SELECT * FROM gallery_posts WHERE day = ?').all(day);

// ---- campaigns (fixed-asset preset generations) ----
const addCampaign = (c) =>
  db.prepare(`INSERT OR REPLACE INTO campaigns (name, prompt, dir, base_file, mask_file, ref_files, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(c.name.toLowerCase(), c.prompt, c.dir, c.baseFile, c.maskFile ?? null, JSON.stringify(c.refFiles || []), c.addedBy);
const getCampaign = (name) => db.prepare('SELECT * FROM campaigns WHERE name = ?').get(name.toLowerCase());
const removeCampaign = (name) => db.prepare('DELETE FROM campaigns WHERE name = ?').run(name.toLowerCase());
const listCampaigns = () => db.prepare('SELECT * FROM campaigns ORDER BY name').all();

// ---- daily winner ----
const hasWinner = (day) => !!db.prepare('SELECT 1 FROM winners WHERE day = ?').get(day);
const saveWinner = (day, userId, messageId, votes) =>
  db.prepare('INSERT OR IGNORE INTO winners (day, user_id, message_id, votes) VALUES (?, ?, ?, ?)').run(day, userId, messageId, votes);

// ---- streaks ----
// Consecutive days with >=1 generation, ending today or yesterday (so the streak
// doesn't read as broken before the user has generated today).
function streakDays(userId) {
  const rows = db.prepare('SELECT day FROM usage WHERE user_id = ? AND count > 0 ORDER BY day DESC LIMIT 400').all(userId);
  if (!rows.length) return 0;
  const have = new Set(rows.map(r => r.day));
  const d = new Date();
  let cursor = d.toISOString().slice(0, 10);
  if (!have.has(cursor)) {           // allow streak anchored on yesterday
    d.setUTCDate(d.getUTCDate() - 1);
    cursor = d.toISOString().slice(0, 10);
    if (!have.has(cursor)) return 0;
  }
  let streak = 0;
  while (have.has(d.toISOString().slice(0, 10))) {
    streak++;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return streak;
}
function streakBonus(userId) {
  const every = parseInt(getSetting('streak_every'), 10) || 5;
  const cap = parseInt(getSetting('streak_cap'), 10) || 0;
  return Math.min(Math.floor(streakDays(userId) / every), cap);
}

// ---- usage / quota ----
const today = () => new Date().toISOString().slice(0, 10);

function usedToday(userId) {
  const row = db.prepare('SELECT count FROM usage WHERE user_id = ? AND day = ?').get(userId, today());
  return row ? row.count : 0;
}
function extraToday(userId) {
  const row = db.prepare('SELECT extra FROM grants WHERE user_id = ? AND day = ?').get(userId, today());
  return row ? row.extra : 0;
}
function recordUse(userId, meta = {}) {
  db.prepare('INSERT INTO usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1')
    .run(userId, today());
  db.prepare('INSERT INTO gen_log (user_id, template, collection, token_id, quality) VALUES (?, ?, ?, ?, ?)')
    .run(userId, meta.template ?? null, meta.collection ?? null, meta.tokenId ?? null, meta.quality ?? null);
}
function grantExtra(userId, n) {
  db.prepare('INSERT INTO grants (user_id, day, extra) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET extra = extra + ?')
    .run(userId, today(), n, n);
}
function stats(days = 7) {
  const total = db.prepare(`SELECT COUNT(*) AS n FROM gen_log WHERE created_at >= datetime('now', ?)`).get(`-${days} days`).n;
  const users = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM gen_log WHERE created_at >= datetime('now', ?)`).get(`-${days} days`).n;
  const topTemplates = db.prepare(`SELECT COALESCE(template,'(custom)') AS t, COUNT(*) AS n FROM gen_log WHERE created_at >= datetime('now', ?) GROUP BY t ORDER BY n DESC LIMIT 5`).all(`-${days} days`);
  return { total, users, topTemplates };
}

module.exports = {
  db, DATA_DIR, getSetting, setSetting, allSettings,
  addTemplate, removeTemplate, getTemplate, listTemplates,
  addRule, removeRule, listRules,
  addGalleryPost, getGalleryPost, postsForDay, hasWinner, saveWinner,
  addCampaign, getCampaign, removeCampaign, listCampaigns,
  streakDays, streakBonus,
  usedToday, extraToday, recordUse, grantExtra, stats, today,
};
