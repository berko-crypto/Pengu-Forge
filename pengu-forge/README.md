# 🐧 PenguForge

Discord bot that lets Pudgy Penguins holders generate AI graphics of their penguin — attach an image or just give a Pudgy Penguins / Lil Pudgys token ID. Daily quotas, admin-managed preset templates, and cost levers built in.

## Commands

**Everyone**
- `/generate collection:<Pudgy|Lil> id:<n>` or `/generate image:<attachment>` + `template:` (autocomplete) and/or `prompt:`
- `/quota` — generations left today
- `/templates` — list presets

**Admins** (`Manage Server`)
- `/pengu-admin template add|remove` — curate preset prompts
- `/pengu-admin rule add|remove|list` — default generation rules (applied to every prompt unless the holder overrides)
- `/pengu-admin set limit|quality|output-px|booster-bonus|cooldown|channel`
- `/pengu-admin toggle` — pause/resume
- `/pengu-admin grant` — give a user bonus gens today (contests, mods, etc.)
- `/pengu-admin settings` / `stats`

## Cost control

gpt-image-1 per image (1024×1024): **low ≈ $0.011**, medium ≈ $0.042, high ≈ $0.167.
Defaults: `quality=low`, `limit=3/day`, `booster_bonus=1`, `cooldown=30s`.
Worst case at defaults: 100 active users/day ≈ **$3.30/day**. Bump quality for events, drop it after.

> Note: `gpt-image-1` requires a **verified OpenAI organization** (Settings → Organization → Verify). One-time, takes a minute.

## Setup

1. **Discord app**: discord.com/developers → New Application → Bot → copy token. Invite with scopes `bot applications.commands`, permission `Send Messages`, `Embed Links`, `Attach Files`.
2. **Env vars** (`.env` locally, or Railway variables):
   ```
   DISCORD_TOKEN=...
   CLIENT_ID=...           # application ID
   GUILD_ID=...            # optional: instant guild-scoped commands
   OPENAI_API_KEY=sk-...
   AUTO_DEPLOY_COMMANDS=1  # registers slash commands on boot
   DATA_DIR=/data          # on Railway, mount a volume at /data
   ```
3. **Run**: `npm install && npm start`

## Railway

- New service from repo, add the env vars above.
- **Add a Volume mounted at `/data`** and set `DATA_DIR=/data` — otherwise quotas/templates reset on every deploy.
- Start command: `npm start`.

## Starter templates

```
/pengu-admin template add name:trading-card prompt:Turn this penguin into a holographic collectible trading card with a foil border, stat bar, and its name plate at the bottom, dramatic studio lighting
/pengu-admin template add name:astronaut prompt:This penguin as an astronaut floating outside a space station, Earth in the background, cinematic, keep the outfit and traits visible through the helmet visor
/pengu-admin template add name:pixel prompt:Recreate this penguin as crisp 32-bit pixel art on a retro arcade background
/pengu-admin template add name:banner prompt:A wide X/Twitter banner featuring this penguin in an icy landscape with soft aurora lighting, space on the right for text
```

## Notes

- Token images resolve via the official Pudgy API (`api.pudgypenguins.io`) with IPFS gateway fallback; if both fail, users can always attach the image.
- Quota is only consumed on **successful** generation.
- Usage resets at 00:00 UTC; `grant` bonuses apply to the current day only.

## Example replication

Users can attach an **example** image on `/generate` — e.g. a meme, an ad layout, another PFP scene — and the bot recreates it with their penguin as the subject. No prompt needed (an example alone is enough), but template/prompt can be combined with it for tweaks. The default replication instruction is adjustable via `/pengu-admin set example-prompt`.

## Default rules

Two rules ship out of the box (editable via `/pengu-admin rule`):
1. Square 1:1 composition — outputs are generated at 1024² and resized to exactly **1000×1000** (`output_px` setting). Users can override per-generation with the `aspect` option (portrait/landscape), which skips the square rule and resize.
2. Retain wearables, outfit, headwear, and skin color **exactly** as in the input image — no restyling unless the holder explicitly asks.

Rules are appended to every prompt as "follow unless the request explicitly says otherwise," so "make my penguin a robot with chrome skin" still works.

## Community features

**Gallery** — set with `/pengu-admin set gallery #pengu-gallery`. Every generation is auto-reposted there with the creator, a 🎲 **Remix** button, and a seeded 🔥 reaction. Generations made inside the gallery itself just get the button (no double post).

**Remix** — anyone can hit the button under a gallery post, enter their collection + token ID in a popup, and rerun the exact same recipe (template/prompt/example) with their penguin. Consumes their own quota; result posts to the gallery with "remixed from" attribution. Example images are persisted to `DATA_DIR/examples` (30-day cleanup) so remixes work after Discord CDN links expire.

**Gen of the Day** — at 00:01 UTC the bot tallies 🔥 reactions on yesterday's gallery posts (its own seed reaction excluded), crowns the winner with a gold embed, and grants them bonus gens (`winner_bonus`, default 3). Missed crownings are caught up on boot. Requires at least 1 human vote.

**Streaks** — generating on consecutive days builds a streak: every 5 days (`streak_every`) = +1 daily limit, capped at +3 (`streak_cap`). Break the streak, lose the bonus — computed live from usage history, no state to corrupt. `/quota` shows streak progress.

## Campaigns (fixed-asset generations)

For official drops (e.g. KAKAWOW Phantom): admins lock in a base scene, prompt, product reference shots, and optionally a **mask** — holders just run `/campaign campaign:<name> id:<their penguin>` and get themselves swapped into the scene.

```
/pengu-admin campaign add
  name: kakawow-phantom
  base: <the hero-penguin-holding-products image>
  mask: <base-sized PNG, penguin area erased/transparent>
  ref1..ref3: <clean product shots>
  prompt: Replace the penguin character in the first image with the penguin from the
    second image — keep ONLY the new penguin's skin color and wearables (pose matches
    the original hero). The held products must remain EXACTLY as in the first image;
    do not alter their artwork, text, colors, or proportions. Additional product
    reference photos are provided — match them precisely. Square composition.
```

**Why the mask matters:** with a mask, every pixel *outside* the transparent region is preserved **byte-for-byte** from the base image — the products, background, and lighting are literally untouched; only the penguin region is regenerated (guided by the refs where products overlap flippers). Without a mask it falls back to reference-guided regeneration: close, but not pixel-exact. Make the mask in Photopea/Photoshop: open the base, erase the penguin (leave held items opaque!), export PNG.

Image order in campaign prompts: **1st = base scene, 2nd = holder's penguin, 3rd+ = refs.** Campaign posts go to the gallery and are remixable like everything else.
