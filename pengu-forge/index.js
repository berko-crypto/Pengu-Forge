// index.js — PenguForge: AI graphics for Pudgy Penguins holders
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const dbx = require('./db');
const { getPenguinImage } = require('./lib/penguins');
const { generateGraphic } = require('./lib/generate');
const { register } = require('./deploy-commands');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const lastGenAt = new Map();   // userId -> timestamp (cooldown)
const inFlight = new Set();    // userId (prevent double-spend while generating)

const PENGU_BLUE = 0x00a5e0;
const EXAMPLES_DIR = path.join(dbx.DATA_DIR, 'examples');
fs.mkdirSync(EXAMPLES_DIR, { recursive: true });

// ---------------- quota helpers ----------------
function userLimit(member) {
  let limit = parseInt(dbx.getSetting('daily_limit'), 10) || 0;
  const bonus = parseInt(dbx.getSetting('booster_bonus'), 10) || 0;
  if (member?.premiumSince) limit += bonus;
  limit += dbx.extraToday(member?.id ?? '');
  limit += dbx.streakBonus(member?.id ?? '');
  return limit;
}
const remaining = (member) => Math.max(0, userLimit(member) - dbx.usedToday(member.id));

/** Returns an error string if the user can't generate right now, else null. */
function gateCheck(interaction) {
  if (dbx.getSetting('enabled') !== '1') return 'Generation is currently paused by the admins. 🧊';
  const allowedChannel = dbx.getSetting('allowed_channel');
  const galleryChannel = dbx.getSetting('gallery_channel');
  if (allowedChannel && interaction.channelId !== allowedChannel && interaction.channelId !== galleryChannel) {
    return `Head over to <#${allowedChannel}> to generate!`;
  }
  const userId = interaction.user.id;
  if (inFlight.has(userId)) return 'Easy, one at a time — your previous generation is still cooking. 🐧';
  const cooldown = (parseInt(dbx.getSetting('cooldown_seconds'), 10) || 0) * 1000;
  const last = lastGenAt.get(userId) || 0;
  if (Date.now() - last < cooldown) {
    return `Cooldown — try again in ${Math.ceil((cooldown - (Date.now() - last)) / 1000)}s.`;
  }
  if (remaining(interaction.member) <= 0) {
    return `You've used all your generations for today (resets 00:00 UTC). Keep your streak going tomorrow — or win Gen of the Day for bonus gens! 🔥`;
  }
  return null;
}

async function downloadAttachment(att, what) {
  if (!att.contentType?.startsWith('image/')) throw new Error(`That ${what} attachment is not an image.`);
  if (att.size > 8 * 1024 * 1024) throw new Error(`Your ${what} is too large (max 8 MB).`);
  const res = await fetch(att.url);
  if (!res.ok) throw new Error(`Could not download your ${what}.`);
  return { buf: Buffer.from(await res.arrayBuffer()), contentType: att.contentType };
}

// ---------------- campaigns ----------------
const sharp = require('sharp');
const CAMPAIGNS_DIR = path.join(dbx.DATA_DIR, 'campaigns');
fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });

const extFor = (ct) => (ct || 'image/png').split('/')[1]?.split('+')[0] || 'png';

/** Loads campaign assets from disk. Returns { prompt, base, mask, refs[] }. */
function loadCampaign(name) {
  const c = dbx.getCampaign(name);
  if (!c) return null;
  const read = (f) => ({ buf: fs.readFileSync(path.join(c.dir, f)), contentType: `image/${path.extname(f).slice(1) || 'png'}` });
  return {
    row: c,
    prompt: c.prompt,
    base: read(c.base_file),
    mask: c.mask_file ? { buf: fs.readFileSync(path.join(c.dir, c.mask_file)) } : null,
    refs: JSON.parse(c.ref_files).map(read),
  };
}

/**
 * Shared campaign generation: swaps the user's penguin into the campaign scene.
 * Image order sent to the model: [base scene, user penguin, ...product refs].
 */
async function runCampaignGeneration(interaction, campaignName, penguin, meta) {
  const c = loadCampaign(campaignName);
  if (!c) throw new Error(`Campaign "${campaignName}" no longer exists.`);
  const images = [c.base, { buf: penguin.buf, contentType: penguin.contentType }, ...c.refs];
  await runGeneration(interaction, {
    images, mask: c.mask, prompt: c.prompt, aspect: 'square',
    meta: {
      ...meta,
      template: `campaign:${c.row.name}`,
      sourceLabel: `${meta.sourceLabel} → ${c.row.name}`,
    },
  });
}

/**
 * Seed campaigns from the repo's ./assets folder on boot.
 * Each subfolder = one campaign: base.* (required), prompt.txt (required),
 * mask.png (optional), ref-*.* (optional). Skipped if the campaign already
 * exists in the DB, so admin edits made via Discord are never overwritten.
 * The first seeded campaign becomes default_campaign if none is set.
 */
async function seedCampaignsFromAssets() {
  const assetsRoot = path.join(__dirname, 'assets');
  if (!fs.existsSync(assetsRoot)) return;
  for (const name of fs.readdirSync(assetsRoot)) {
    const src = path.join(assetsRoot, name);
    if (!fs.statSync(src).isDirectory() || dbx.getCampaign(name)) continue;
    try {
      const files = fs.readdirSync(src);
      const baseFile = files.find(f => f.startsWith('base.'));
      const promptFile = files.find(f => f === 'prompt.txt');
      if (!baseFile || !promptFile) { console.warn(`assets/${name}: needs base.* and prompt.txt — skipped`); continue; }

      const dir = path.join(CAMPAIGNS_DIR, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(path.join(src, baseFile), path.join(dir, baseFile));

      let maskFile = null;
      if (files.includes('mask.png')) {
        const bm = await sharp(path.join(src, baseFile)).metadata();
        const normalized = await sharp(path.join(src, 'mask.png')).ensureAlpha().resize(bm.width, bm.height, { fit: 'fill' }).png().toBuffer();
        if (!(await sharp(normalized).stats()).isOpaque) {
          maskFile = 'mask.png';
          fs.writeFileSync(path.join(dir, maskFile), normalized);
        } else console.warn(`assets/${name}/mask.png has no transparency — ignored`);
      }

      const refFiles = files.filter(f => f.startsWith('ref-')).sort();
      for (const f of refFiles) fs.copyFileSync(path.join(src, f), path.join(dir, f));

      const prompt = fs.readFileSync(path.join(src, promptFile), 'utf8').trim();
      dbx.addCampaign({ name, prompt, dir, baseFile, maskFile, refFiles, addedBy: 'assets-seed' });
      if (!dbx.getSetting('default_campaign')) dbx.setSetting('default_campaign', name);
      console.log(`📣 seeded campaign "${name}" from assets (${maskFile ? 'masked' : 'ref-guided'}, ${refFiles.length} refs)${dbx.getSetting('default_campaign') === name ? ' — set as default' : ''}`);
    } catch (e) {
      console.error(`campaign seed failed for ${name}:`, e.message);
    }
  }
}

async function handleSuplay(interaction) {
  const gateErr = gateCheck(interaction);
  if (gateErr) return interaction.reply({ content: gateErr, flags: MessageFlags.Ephemeral });

  const name = dbx.getSetting('default_campaign');
  if (!name || !dbx.getCampaign(name)) {
    return interaction.reply({ content: 'No drop is live right now — check back soon! 🐧', flags: MessageFlags.Ephemeral });
  }
  const collection = interaction.options.getString('collection');
  const id = interaction.options.getInteger('id');

  await interaction.deferReply();
  try {
    const p = await getPenguinImage(collection, id);
    await runCampaignGeneration(interaction, name, { buf: p.buf, contentType: p.contentType }, {
      collection, tokenId: id, sourceLabel: p.label,
    });
  } catch (err) {
    console.error('suplay failed:', err);
    inFlight.delete(interaction.user.id);
    await interaction.editReply({ content: `❌ ${err.message || 'Something went wrong.'} (Your quota was not used.)` }).catch(() => {});
  }
}

// ---------------- shared generation core ----------------
/**
 * Runs a generation for an already-deferred interaction.
 * spec: { images, prompt, aspect, meta: { template, customPrompt, collection, tokenId, examplePath, remixedFrom, sourceLabel } }
 */
async function runGeneration(interaction, spec) {
  const userId = interaction.user.id;
  inFlight.add(userId);
  try {
    const quality = dbx.getSetting('quality');
    const size = { square: '1024x1024', portrait: '1024x1536', landscape: '1536x1024' }[spec.aspect || 'square'];
    let rules = dbx.listRules().map(r => r.text);
    if (spec.aspect && spec.aspect !== 'square') rules = rules.filter(r => !/square|1:1/i.test(r));
    const outputPx = dbx.getSetting('output_px');

    const out = await generateGraphic({ images: spec.images, mask: spec.mask, prompt: spec.prompt, rules, quality, size, outputPx });

    dbx.recordUse(userId, {
      template: spec.meta.template ?? null,
      collection: spec.meta.collection ?? null,
      tokenId: spec.meta.tokenId ?? null,
      quality,
    });
    lastGenAt.set(userId, Date.now());

    const file = new AttachmentBuilder(out, { name: 'penguforge.png' });
    const streak = dbx.streakDays(userId);
    const embed = new EmbedBuilder()
      .setColor(PENGU_BLUE)
      .setTitle(spec.meta.template ? `🎨 ${spec.meta.template}` : '🎨 Custom generation')
      .setDescription([
        `**Source:** ${spec.meta.sourceLabel}`,
        spec.meta.remixedFrom ? `**Remixed from:** [this gen](https://discord.com/channels/${interaction.guildId}/${dbx.getSetting('gallery_channel')}/${spec.meta.remixedFrom})` : null,
        `**By:** <@${userId}> · ${remaining(interaction.member)} left today${streak >= 2 ? ` · 🔥 ${streak}-day streak` : ''}`,
      ].filter(Boolean).join('\n'))
      .setImage('attachment://penguforge.png');

    const replyMsg = await interaction.editReply({ embeds: [embed], files: [file] });
    await publishToGallery(interaction, { imageBuf: out, embed, meta: spec.meta, replyMsg });
  } finally {
    inFlight.delete(userId);
  }
}

// ---------------- gallery ----------------
function remixRow(messageId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`remix:${messageId}`).setLabel('Remix with MY penguin').setEmoji('🎲').setStyle(ButtonStyle.Primary),
  );
}

async function publishToGallery(interaction, { imageBuf, embed, meta, replyMsg }) {
  const galleryId = dbx.getSetting('gallery_channel');
  if (!galleryId) return;
  try {
    let galleryMsg;
    if (interaction.channelId === galleryId && replyMsg) {
      galleryMsg = replyMsg; // generated inside the gallery — no double post
      await replyMsg.edit({ components: [remixRow(replyMsg.id)] });
    } else {
      const channel = await client.channels.fetch(galleryId);
      const file = new AttachmentBuilder(imageBuf, { name: 'penguforge.png' });
      galleryMsg = await channel.send({ embeds: [embed], files: [file] });
      await galleryMsg.edit({ components: [remixRow(galleryMsg.id)] });
    }
    dbx.addGalleryPost({
      messageId: galleryMsg.id, channelId: galleryMsg.channelId, userId: interaction.user.id,
      template: meta.template, customPrompt: meta.customPrompt, examplePath: meta.examplePath,
      collection: meta.collection, tokenId: meta.tokenId, remixedFrom: meta.remixedFrom,
    });
    const emoji = dbx.getSetting('winner_emoji') || '🔥';
    await galleryMsg.react(emoji).catch(() => {});
  } catch (e) {
    console.error('gallery publish failed:', e.message);
  }
}

// ---------------- /generate ----------------
async function handleGenerate(interaction) {
  const gateErr = gateCheck(interaction);
  if (gateErr) return interaction.reply({ content: gateErr, flags: MessageFlags.Ephemeral });

  const attachment = interaction.options.getAttachment('image');
  const example = interaction.options.getAttachment('example');
  const collection = interaction.options.getString('collection');
  const id = interaction.options.getInteger('id');
  const templateName = interaction.options.getString('template');
  const customPrompt = interaction.options.getString('prompt');
  const aspect = interaction.options.getString('aspect') || 'square';

  if (!attachment && (collection == null || id == null)) {
    return interaction.reply({
      content: 'Give me a penguin: either attach an **image**, or pick a **collection** + **id** (e.g. Pudgy Penguins #6873).',
      flags: MessageFlags.Ephemeral,
    });
  }

  let prompt = '';
  let usedTemplate = null;
  if (templateName) {
    const t = dbx.getTemplate(templateName);
    if (!t) return interaction.reply({ content: `No template called \`${templateName}\`. Try /templates.`, flags: MessageFlags.Ephemeral });
    usedTemplate = t.name;
    prompt = t.prompt;
    if (customPrompt) prompt += `\nAdditional request from the holder: ${customPrompt}`;
  } else if (customPrompt) {
    prompt = customPrompt;
  } else if (!example) {
    // No template, prompt, or example: if a default campaign is live, run that.
    const defCampaign = dbx.getSetting('default_campaign');
    if (defCampaign && dbx.getCampaign(defCampaign)) {
      await interaction.deferReply();
      try {
        let penguin, sourceLabel;
        if (attachment) {
          penguin = await downloadAttachment(attachment, 'penguin image');
          sourceLabel = 'your penguin';
        } else {
          const p = await getPenguinImage(collection, id);
          penguin = { buf: p.buf, contentType: p.contentType };
          sourceLabel = p.label;
        }
        await runCampaignGeneration(interaction, defCampaign, penguin, { collection, tokenId: id, sourceLabel });
      } catch (err) {
        console.error('default campaign failed:', err);
        inFlight.delete(interaction.user.id);
        await interaction.editReply({ content: `❌ ${err.message || 'Something went wrong.'} (Your quota was not used.)` }).catch(() => {});
      }
      return;
    }
    return interaction.reply({ content: 'Pick a **template**, write a **prompt**, or attach an **example** image to replicate (or combine them).', flags: MessageFlags.Ephemeral });
  }
  if (example) {
    const instruction = dbx.getSetting('example_prompt');
    prompt = prompt ? `${instruction}\nAdditionally: ${prompt}` : instruction;
  }

  await interaction.deferReply();
  try {
    const images = [];
    let sourceLabel, examplePath = null;
    if (attachment) {
      images.push(await downloadAttachment(attachment, 'penguin image'));
      sourceLabel = 'your penguin';
    } else {
      const p = await getPenguinImage(collection, id);
      images.push({ buf: p.buf, contentType: p.contentType });
      sourceLabel = p.label;
    }
    if (example) {
      const ex = await downloadAttachment(example, 'example image');
      images.push(ex);
      sourceLabel += ' + example';
      // persist the example so remixes can reuse it (Discord CDN links expire)
      examplePath = path.join(EXAMPLES_DIR, `${Date.now()}-${interaction.user.id}.png`);
      fs.writeFileSync(examplePath, ex.buf);
    }

    await runGeneration(interaction, {
      images, prompt, aspect,
      meta: { template: usedTemplate, customPrompt, collection, tokenId: id, examplePath, sourceLabel },
    });
  } catch (err) {
    console.error('generate failed:', err);
    inFlight.delete(interaction.user.id);
    await interaction.editReply({ content: `❌ ${err.message || 'Something went wrong.'} (Your quota was not used.)` }).catch(() => {});
  }
}

// ---------------- remix (button + modal) ----------------
async function handleRemixButton(interaction) {
  const originId = interaction.customId.split(':')[1];
  const post = dbx.getGalleryPost(originId);
  if (!post) return interaction.reply({ content: 'This gen is too old to remix — start a fresh /generate!', flags: MessageFlags.Ephemeral });

  const gateErr = gateCheck(interaction);
  if (gateErr) return interaction.reply({ content: gateErr, flags: MessageFlags.Ephemeral });

  const modal = new ModalBuilder().setCustomId(`remixm:${originId}`).setTitle('Remix with your penguin')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rcol').setLabel('Collection: "pudgy" or "lil"').setStyle(TextInputStyle.Short)
          .setValue('pudgy').setRequired(true).setMaxLength(10)),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rid').setLabel('Your penguin token ID').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 6873').setRequired(true).setMaxLength(6)),
    );
  await interaction.showModal(modal);
}

async function handleRemixModal(interaction) {
  const originId = interaction.customId.split(':')[1];
  const post = dbx.getGalleryPost(originId);
  if (!post) return interaction.reply({ content: 'This gen is too old to remix.', flags: MessageFlags.Ephemeral });

  const gateErr = gateCheck(interaction); // re-check: quota may have changed while modal was open
  if (gateErr) return interaction.reply({ content: gateErr, flags: MessageFlags.Ephemeral });

  const colRaw = interaction.fields.getTextInputValue('rcol').trim().toLowerCase();
  const collection = colRaw.startsWith('l') ? 'lil' : 'pudgy';
  const tokenId = parseInt(interaction.fields.getTextInputValue('rid').trim().replace(/^#/, ''), 10);
  if (!Number.isInteger(tokenId)) {
    return interaction.reply({ content: 'That ID doesn\'t look right — digits only, e.g. `6873`.', flags: MessageFlags.Ephemeral });
  }

  // Campaign remix: rerun the campaign with the remixer's penguin
  if (post.template?.startsWith('campaign:')) {
    const cname = post.template.slice('campaign:'.length);
    if (!dbx.getCampaign(cname)) return interaction.reply({ content: 'That campaign has ended — try a current one with /campaign!', flags: MessageFlags.Ephemeral });
    await interaction.deferReply();
    try {
      const p = await getPenguinImage(collection, tokenId);
      await runCampaignGeneration(interaction, cname, { buf: p.buf, contentType: p.contentType }, {
        collection, tokenId, remixedFrom: originId, sourceLabel: `${p.label} (remix)`,
      });
    } catch (err) {
      console.error('campaign remix failed:', err);
      inFlight.delete(interaction.user.id);
      await interaction.editReply({ content: `❌ ${err.message || 'Something went wrong.'} (Your quota was not used.)` }).catch(() => {});
    }
    return;
  }

  // Rebuild the original recipe
  let prompt = '';
  if (post.template) {
    const t = dbx.getTemplate(post.template);
    prompt = t ? t.prompt : (post.custom_prompt || '');
    if (t && post.custom_prompt) prompt += `\nAdditional request from the holder: ${post.custom_prompt}`;
  } else if (post.custom_prompt) {
    prompt = post.custom_prompt;
  }
  let exampleBuf = null;
  if (post.example_path && fs.existsSync(post.example_path)) exampleBuf = fs.readFileSync(post.example_path);
  if (exampleBuf) {
    const instruction = dbx.getSetting('example_prompt');
    prompt = prompt ? `${instruction}\nAdditionally: ${prompt}` : instruction;
  }
  if (!prompt) return interaction.reply({ content: 'The original recipe is missing — start a fresh /generate!', flags: MessageFlags.Ephemeral });

  await interaction.deferReply();
  try {
    const p = await getPenguinImage(collection, tokenId);
    const images = [{ buf: p.buf, contentType: p.contentType }];
    if (exampleBuf) images.push({ buf: exampleBuf, contentType: 'image/png' });

    await runGeneration(interaction, {
      images, prompt, aspect: 'square',
      meta: {
        template: post.template, customPrompt: post.custom_prompt, collection, tokenId,
        examplePath: post.example_path, remixedFrom: originId,
        sourceLabel: `${p.label} (remix)`,
      },
    });
  } catch (err) {
    console.error('remix failed:', err);
    inFlight.delete(interaction.user.id);
    await interaction.editReply({ content: `❌ ${err.message || 'Something went wrong.'} (Your quota was not used.)` }).catch(() => {});
  }
}

// ---------------- daily winner ----------------
function yesterdayStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function crownDailyWinner() {
  const day = yesterdayStr();
  if (dbx.hasWinner(day)) return;
  const galleryId = dbx.getSetting('gallery_channel');
  if (!galleryId) return;
  const posts = dbx.postsForDay(day);
  if (!posts.length) return;

  const emojiName = dbx.getSetting('winner_emoji') || '🔥';
  let best = null;
  let channel;
  try { channel = await client.channels.fetch(galleryId); } catch { return; }

  for (const post of posts) {
    try {
      const msg = await channel.messages.fetch(post.message_id);
      const reaction = msg.reactions.cache.find(r => r.emoji.name === emojiName);
      if (!reaction) continue;
      const votes = reaction.count - (reaction.me ? 1 : 0); // don't count the bot's seed reaction
      if (votes > 0 && (!best || votes > best.votes)) best = { post, votes, msg };
    } catch { /* message deleted */ }
  }
  if (!best) return;

  const bonus = parseInt(dbx.getSetting('winner_bonus'), 10) || 0;
  dbx.saveWinner(day, best.post.user_id, best.post.message_id, best.votes);
  if (bonus > 0) dbx.grantExtra(best.post.user_id, bonus);

  const embed = new EmbedBuilder()
    .setColor(0xffd700)
    .setTitle(`👑 Gen of the Day — ${day}`)
    .setDescription(`Congrats <@${best.post.user_id}>! **${best.votes}** ${emojiName} votes.\nReward: **+${bonus} generations** today.\n\n[Jump to the winning gen](${best.msg.url})`);
  await channel.send({ embeds: [embed] }).catch(() => {});
  console.log(`crowned ${best.post.user_id} for ${day} (${best.votes} votes)`);
}

function scheduleWinner() {
  crownDailyWinner().catch(console.error); // catch up on boot if yesterday wasn't crowned
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1, 0)); // 00:01 UTC
  setTimeout(() => {
    crownDailyWinner().catch(console.error);
    setInterval(() => crownDailyWinner().catch(console.error), 24 * 60 * 60 * 1000);
  }, next - now);
}

function cleanupExamples(maxAgeDays = 30) {
  const cutoff = Date.now() - maxAgeDays * 86400e3;
  for (const f of fs.readdirSync(EXAMPLES_DIR)) {
    const fp = path.join(EXAMPLES_DIR, f);
    try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
  }
}

// ---------------- /quota, /templates ----------------
async function handleQuota(interaction) {
  const limit = userLimit(interaction.member);
  const used = dbx.usedToday(interaction.user.id);
  const streak = dbx.streakDays(interaction.user.id);
  const bonus = dbx.streakBonus(interaction.user.id);
  const every = parseInt(dbx.getSetting('streak_every'), 10) || 5;
  const lines = [`You've used **${used}/${limit}** generations today. Resets at 00:00 UTC.`];
  if (streak >= 2) {
    lines.push(`🔥 **${streak}-day streak**${bonus ? ` (+${bonus} daily limit)` : ''} — ${every - (streak % every)} more day(s) to your next bonus!`);
  } else {
    lines.push(`Generate ${every} days in a row for +1 daily limit. 🔥`);
  }
  await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
}

// ---------------- /pengu-admin ----------------
async function handleAdmin(interaction) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group === 'template') {
    if (sub === 'add') {
      const name = interaction.options.getString('name').trim();
      const prompt = interaction.options.getString('prompt').trim();
      dbx.addTemplate(name, prompt, interaction.user.id);
      return interaction.reply({ content: `✅ Template **${name.toLowerCase()}** saved.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'remove') {
      const name = interaction.options.getString('name');
      const r = dbx.removeTemplate(name);
      return interaction.reply({ content: r.changes ? `🗑️ Removed **${name}**.` : `No template called **${name}**.`, flags: MessageFlags.Ephemeral });
    }
  }

  if (group === 'campaign') {
    if (sub === 'add') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const name = interaction.options.getString('name').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      const prompt = interaction.options.getString('prompt').trim();
      const baseAtt = interaction.options.getAttachment('base');
      const maskAtt = interaction.options.getAttachment('mask');
      const refAtts = ['ref1', 'ref2', 'ref3'].map(k => interaction.options.getAttachment(k)).filter(Boolean);

      const base = await downloadAttachment(baseAtt, 'base image');
      const dir = path.join(CAMPAIGNS_DIR, name);
      fs.mkdirSync(dir, { recursive: true });

      const baseFile = `base.${extFor(base.contentType)}`;
      fs.writeFileSync(path.join(dir, baseFile), base.buf);

      let maskFile = null;
      if (maskAtt) {
        const mask = await downloadAttachment(maskAtt, 'mask image');
        // Normalize: force PNG with alpha, resized to exactly match the base dimensions
        const bm = await sharp(base.buf).metadata();
        const normalized = await sharp(mask.buf).ensureAlpha().resize(bm.width, bm.height, { fit: 'fill' }).png().toBuffer();
        const mm = await sharp(normalized).stats();
        if (mm.isOpaque) {
          return interaction.editReply('⚠️ That mask has no transparent pixels — nothing would be regenerated. Make the penguin area **transparent** (erase it) and re-add.');
        }
        maskFile = 'mask.png';
        fs.writeFileSync(path.join(dir, maskFile), normalized);
      }

      const refFiles = [];
      for (let i = 0; i < refAtts.length; i++) {
        const r = await downloadAttachment(refAtts[i], `reference image ${i + 1}`);
        const f = `ref-${i}.${extFor(r.contentType)}`;
        fs.writeFileSync(path.join(dir, f), r.buf);
        refFiles.push(f);
      }

      dbx.addCampaign({ name, prompt, dir, baseFile, maskFile, refFiles, addedBy: interaction.user.id });
      return interaction.editReply(
        `✅ Campaign **${name}** saved — base${maskFile ? ' + mask (held items outside the mask are preserved pixel-exact)' : ' (no mask: items matched by reference, not pixel-exact)'}${refFiles.length ? ` + ${refFiles.length} product ref(s)` : ''}.\nHolders can run it with \`/campaign campaign:${name} id:<their penguin>\`.`
      );
    }
    if (sub === 'remove') {
      const name = interaction.options.getString('campaign');
      const c = dbx.getCampaign(name);
      const r = dbx.removeCampaign(name);
      if (c?.dir) fs.rmSync(c.dir, { recursive: true, force: true });
      return interaction.reply({ content: r.changes ? `🗑️ Campaign **${name}** removed.` : `No campaign called **${name}**.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'list') {
      const list = dbx.listCampaigns();
      const desc = list.length
        ? list.map(c => `**${c.name}** — ${c.mask_file ? '🎭 masked' : 'ref-guided'}, ${JSON.parse(c.ref_files).length} ref(s)\n> ${c.prompt.slice(0, 100)}${c.prompt.length > 100 ? '…' : ''}`).join('\n')
        : 'No campaigns yet.';
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(PENGU_BLUE).setTitle('📣 Campaigns').setDescription(desc)
          .setFooter({ text: 'Image order in prompts: 1st = base scene, 2nd = holder\'s penguin, 3rd+ = product refs.' })],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  if (group === 'rule') {
    if (sub === 'add') {
      dbx.addRule(interaction.options.getString('text').trim(), interaction.user.id);
      return interaction.reply({ content: `✅ Rule added. It now applies to every generation by default.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'remove') {
      const id = interaction.options.getInteger('id');
      const r = dbx.removeRule(id);
      return interaction.reply({ content: r.changes ? `🗑️ Rule #${id} removed.` : `No rule #${id} — check \`/pengu-admin rule list\`.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'list') {
      const rules = dbx.listRules();
      const desc = rules.length ? rules.map(r => `**#${r.id}** — ${r.text}`).join('\n') : 'No rules set.';
      return interaction.reply({
        embeds: [new EmbedBuilder().setColor(PENGU_BLUE).setTitle('📏 Default generation rules')
          .setDescription(desc).setFooter({ text: 'Applied to every prompt unless the holder explicitly overrides one.' })],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  if (group === 'set') {
    if (sub === 'default-campaign') {
      const v = interaction.options.getString('value').trim().toLowerCase();
      if (v === 'off' || v === 'none' || v === '') {
        dbx.setSetting('default_campaign', '');
        return interaction.reply({ content: '📣 Default campaign turned off — bare `/generate` requires a template/prompt/example again.', flags: MessageFlags.Ephemeral });
      }
      if (!dbx.getCampaign(v)) return interaction.reply({ content: `No campaign called \`${v}\`.`, flags: MessageFlags.Ephemeral });
      dbx.setSetting('default_campaign', v);
      return interaction.reply({ content: `📣 Default campaign → **${v}**. A bare \`/generate id:<penguin>\` now runs it.`, flags: MessageFlags.Ephemeral });
    }
    if (sub === 'channel' || sub === 'gallery') {
      const ch = interaction.options.getChannel('value');
      const key = sub === 'channel' ? 'allowed_channel' : 'gallery_channel';
      dbx.setSetting(key, ch ? ch.id : '');
      const what = sub === 'channel' ? 'Generation' : 'Gallery reposts';
      return interaction.reply({ content: ch ? `📍 ${what} → <#${ch.id}>.` : `📍 ${what} turned off / unrestricted.`, flags: MessageFlags.Ephemeral });
    }
    const map = {
      limit: 'daily_limit', quality: 'quality', 'output-px': 'output_px',
      'booster-bonus': 'booster_bonus', cooldown: 'cooldown_seconds',
      'example-prompt': 'example_prompt', 'winner-bonus': 'winner_bonus',
    };
    const key = map[sub];
    const value = interaction.options.getInteger('value') ?? interaction.options.getString('value');
    dbx.setSetting(key, value);
    return interaction.reply({ content: `⚙️ **${key}** → \`${value}\``, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'toggle') {
    const enabled = interaction.options.getBoolean('enabled');
    dbx.setSetting('enabled', enabled ? '1' : '0');
    return interaction.reply({ content: enabled ? '🟢 Generation enabled.' : '🔴 Generation paused.', flags: MessageFlags.Ephemeral });
  }

  if (sub === 'grant') {
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    dbx.grantExtra(user.id, amount);
    return interaction.reply({ content: `🎁 Granted <@${user.id}> **+${amount}** generations for today.`, flags: MessageFlags.Ephemeral });
  }

  if (sub === 'settings') {
    const s = dbx.allSettings();
    const desc = Object.entries(s).map(([k, v]) => `**${k}**: \`${String(v).slice(0, 60) || '(none)'}\``).join('\n');
    return interaction.reply({ embeds: [new EmbedBuilder().setColor(PENGU_BLUE).setTitle('⚙️ PenguForge settings').setDescription(desc)], flags: MessageFlags.Ephemeral });
  }

  if (sub === 'stats') {
    const s = dbx.stats(7);
    const top = s.topTemplates.map(t => `• ${t.t}: ${t.n}`).join('\n') || '—';
    return interaction.reply({
      embeds: [new EmbedBuilder().setColor(PENGU_BLUE).setTitle('📊 Last 7 days')
        .setDescription(`**Generations:** ${s.total}\n**Unique users:** ${s.users}\n**Top templates:**\n${top}`)],
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ---------------- wiring ----------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      const focused = interaction.options.getFocused(true);
      const q = focused.value.toLowerCase();
      if (focused.name === 'campaign' || (interaction.commandName === 'pengu-admin' && focused.name === 'value' && interaction.options.getSubcommand(false) === 'default-campaign')) {
        const choices = dbx.listCampaigns().filter(c => c.name.includes(q)).slice(0, 24)
          .map(c => ({ name: c.name, value: c.name }));
        if (focused.name === 'value') choices.push({ name: 'off (disable default)', value: 'off' });
        return interaction.respond(choices);
      }
      if (focused.name === 'template' || focused.name === 'name') {
        const choices = dbx.listTemplates().filter(t => t.name.includes(q)).slice(0, 25)
          .map(t => ({ name: t.name, value: t.name }));
        return interaction.respond(choices);
      }
      return interaction.respond([]);
    }
    if (interaction.isButton() && interaction.customId.startsWith('remix:')) return await handleRemixButton(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('remixm:')) return await handleRemixModal(interaction);
    if (!interaction.isChatInputCommand()) return;

    switch (interaction.commandName) {
      case 'suplay': return await handleSuplay(interaction);
      case 'generate': return await handleGenerate(interaction);
      case 'quota': return await handleQuota(interaction);
      case 'pengu-admin': return await handleAdmin(interaction);
    }
  } catch (err) {
    console.error('interaction error:', err);
    const payload = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

client.once('ready', () => {
  console.log(`🐧 PenguForge online as ${client.user.tag}`);
  cleanupExamples();
  seedCampaignsFromAssets().catch(e => console.error('campaign seeding error:', e));
  scheduleWinner();
});

(async () => {
  if (process.env.AUTO_DEPLOY_COMMANDS === '1') {
    try { await register(); } catch (e) { console.error('command registration failed:', e); }
  }
  await client.login(process.env.DISCORD_TOKEN);
})();
