// lib/generate.js — OpenAI gpt-image-1 image edit (penguin image + prompt -> new graphic)
// Cost control: quality "low" at 1024x1024 is ~$0.01/image; "medium" ~$0.04; "high" ~$0.17.
const sharp = require('sharp');

const OPENAI_KEY = process.env.OPENAI_API_KEY;

const HARD_GUARD = 'Family-friendly. No text or watermarks unless requested.';

/**
 * Build the final prompt: user/template prompt + server default rules.
 * Rules are framed as defaults the holder's explicit request can override.
 */
function buildPrompt(prompt, rules = []) {
  let out = prompt.trim();
  if (rules.length) {
    out += '\n\nDefault rules — follow each of these UNLESS the request above explicitly says otherwise:\n';
    out += rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  }
  out += `\n${HARD_GUARD}`;
  return out;
}

async function generateGraphic({ images, mask, prompt, rules = [], quality = 'low', size = '1024x1024', outputPx = 0 }) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY is not set.');

  const form = new FormData();
  form.append('model', 'gpt-image-1');
  // gpt-image-1 accepts multiple input images via image[]; order matters and is
  // referenced in the prompt (first = penguin, second = example to replicate).
  const key = images.length > 1 ? 'image[]' : 'image';
  images.forEach((img, i) => {
    const type = img.contentType || 'image/png';
    const ext = type.split('/')[1]?.split('+')[0] || 'png';
    form.append(key, new Blob([img.buf], { type }), `input-${i}.${ext}`);
  });
  // Mask applies to the FIRST image: transparent pixels = regenerated,
  // opaque pixels = preserved exactly. Must match the first image's dimensions.
  if (mask) form.append('mask', new Blob([mask.buf], { type: 'image/png' }), 'mask.png');
  form.append('prompt', buildPrompt(prompt, rules));
  form.append('size', size);
  form.append('quality', quality);
  form.append('n', '1');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });

  if (!res.ok) {
    let msg = `OpenAI error (HTTP ${res.status})`;
    try {
      const err = await res.json();
      if (err?.error?.message) msg = err.error.message;
    } catch (_) {}
    if (res.status === 403 && /verif/i.test(msg)) {
      msg += ' — verify your OpenAI org at platform.openai.com/settings/organization/general to unlock gpt-image-1.';
    }
    throw new Error(msg);
  }

  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image.');
  let out = Buffer.from(b64, 'base64');

  // Exact-pixel output: API squares are 1024x1024; resize to e.g. 1000x1000 if configured.
  // Only applies to square outputs — portrait/landscape keep their native size.
  const px = parseInt(outputPx, 10) || 0;
  if (px > 0 && size === '1024x1024' && px !== 1024) {
    out = await sharp(out).resize(px, px, { fit: 'fill' }).png().toBuffer();
  }
  return out;
}

module.exports = { generateGraphic };
