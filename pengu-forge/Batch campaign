#!/usr/bin/env node
// scripts/batch-campaign.js — batch-generate one output per penguin for a fixed scene.
//
// Standalone mode (no Discord, no DB — perfect for promo asset production):
//   node scripts/batch-campaign.js \
//     --base base.png --mask mask.png \
//     --refs ref1.png,ref2.png,ref3.png \
//     --prompt "Replace the penguin in the first image with..." \
//     --ids pudgy:6873,pudgy:100,lil:512 \
//     --quality medium --out ./out
//
// Campaign mode (reads a campaign saved via /pengu-admin campaign add):
//   DATA_DIR=./data node scripts/batch-campaign.js --campaign kakawow-phantom --ids pudgy:1,pudgy:2
//
// Also accepts local penguin images instead of IDs: --pics ./penguins/*.png (comma-separated paths)

require('dotenv/config');
const fs = require('fs');
const path = require('path');
const { generateGraphic } = require('../lib/generate');
const { getPenguinImage } = require('../lib/penguins');

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
}
const readImg = (p) => ({ buf: fs.readFileSync(p), contentType: `image/${path.extname(p).slice(1).replace('jpg', 'jpeg') || 'png'}` });

(async () => {
  const outDir = arg('out', './out');
  fs.mkdirSync(outDir, { recursive: true });
  const quality = arg('quality', 'medium'); // batch promo work: default medium for trait fidelity
  const outputPx = parseInt(arg('output-px', '1000'), 10);

  // ---- load scene assets ----
  let base, mask = null, refs = [], prompt;
  const campaignName = arg('campaign');
  if (campaignName) {
    const dbx = require('../db');
    const c = dbx.getCampaign(campaignName);
    if (!c) throw new Error(`No campaign "${campaignName}" in ${dbx.DATA_DIR}. Check DATA_DIR.`);
    base = readImg(path.join(c.dir, c.base_file));
    if (c.mask_file) mask = { buf: fs.readFileSync(path.join(c.dir, c.mask_file)) };
    refs = JSON.parse(c.ref_files).map(f => readImg(path.join(c.dir, f)));
    prompt = c.prompt;
  } else {
    const basePath = arg('base');
    if (!basePath) throw new Error('Provide --campaign <name> or --base <file>.');
    base = readImg(basePath);
    const maskPath = arg('mask');
    if (maskPath) {
      // normalize like the bot does: force alpha + resize to base dims
      const sharp = require('sharp');
      const bm = await sharp(base.buf).metadata();
      mask = { buf: await sharp(fs.readFileSync(maskPath)).ensureAlpha().resize(bm.width, bm.height, { fit: 'fill' }).png().toBuffer() };
    }
    refs = (arg('refs', '') || '').split(',').filter(Boolean).map(readImg);
    prompt = arg('prompt') || (arg('prompt-file') ? fs.readFileSync(arg('prompt-file'), 'utf8') : null);
    if (!prompt) throw new Error('Provide --prompt "..." or --prompt-file <file>.');
  }

  // ---- load penguins ----
  const jobs = [];
  for (const spec of (arg('ids', '') || '').split(',').filter(Boolean)) {
    const [collection, id] = spec.split(':');
    jobs.push({ label: `${collection}-${id}`, get: async () => { const p = await getPenguinImage(collection, Number(id)); return { buf: p.buf, contentType: p.contentType }; } });
  }
  for (const p of (arg('pics', '') || '').split(',').filter(Boolean)) {
    jobs.push({ label: path.basename(p, path.extname(p)), get: async () => readImg(p) });
  }
  if (!jobs.length) throw new Error('Provide --ids pudgy:123,lil:456 and/or --pics a.png,b.png');

  console.log(`Batch: ${jobs.length} penguin(s) | quality=${quality} | mask=${mask ? 'yes (items pixel-preserved)' : 'NO (ref-guided only)'} | refs=${refs.length}`);

  // ---- run sequentially (rate-limit friendly) ----
  let ok = 0, fail = 0;
  for (const job of jobs) {
    const t0 = Date.now();
    try {
      const penguin = await job.get();
      const out = await generateGraphic({
        images: [base, penguin, ...refs], mask, prompt,
        rules: [], quality, size: '1024x1024', outputPx,
      });
      const file = path.join(outDir, `${campaignName || 'scene'}-${job.label}.png`);
      fs.writeFileSync(file, out);
      ok++;
      console.log(`✅ ${job.label} → ${file} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e) {
      fail++;
      console.error(`❌ ${job.label}: ${e.message}`);
    }
  }
  console.log(`Done: ${ok} ok, ${fail} failed → ${path.resolve(outDir)}`);
})().catch(e => { console.error(e.message); process.exit(1); });
