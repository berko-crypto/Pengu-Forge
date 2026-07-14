// deploy-commands.js — registers slash commands (run once, or on deploy)
require('dotenv/config');
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const generate = new SlashCommandBuilder()
  .setName('generate')
  .setDescription('Create an AI graphic featuring your penguin')
  .addStringOption(o => o.setName('collection').setDescription('Which collection your ID belongs to')
    .addChoices({ name: 'Pudgy Penguins', value: 'pudgy' }, { name: 'Lil Pudgys', value: 'lil' }))
  .addIntegerOption(o => o.setName('id').setDescription('Token ID (e.g. 6873)').setMinValue(0))
  .addAttachmentOption(o => o.setName('image').setDescription('...or attach your penguin image instead'))
  .addAttachmentOption(o => o.setName('example').setDescription('Example picture to replicate — bot recreates it with your penguin as the subject'))
  .addStringOption(o => o.setName('template').setDescription('Preset style (admin-curated)').setAutocomplete(true))
  .addStringOption(o => o.setName('prompt').setDescription('Custom prompt (used if no template, or appended to one)').setMaxLength(600))
  .addStringOption(o => o.setName('aspect').setDescription('Override the default square format')
    .addChoices({ name: 'Square (default)', value: 'square' }, { name: 'Portrait 2:3', value: 'portrait' }, { name: 'Landscape 3:2', value: 'landscape' }));

const campaign = new SlashCommandBuilder()
  .setName('campaign')
  .setDescription('Generate from an official campaign — your penguin swapped into a fixed scene')
  .addStringOption(o => o.setName('campaign').setDescription('Which campaign (defaults to the active one)').setAutocomplete(true))
  .addStringOption(o => o.setName('collection').setDescription('Which collection your ID belongs to')
    .addChoices({ name: 'Pudgy Penguins', value: 'pudgy' }, { name: 'Lil Pudgys', value: 'lil' }))
  .addIntegerOption(o => o.setName('id').setDescription('Token ID (e.g. 6873)').setMinValue(0))
  .addAttachmentOption(o => o.setName('image').setDescription('...or attach your penguin image instead'));

const quota = new SlashCommandBuilder()
  .setName('quota')
  .setDescription('Check how many generations you have left today');

const templates = new SlashCommandBuilder()
  .setName('templates')
  .setDescription('List available preset templates');

const admin = new SlashCommandBuilder()
  .setName('pengu-admin')
  .setDescription('PenguForge admin controls')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommandGroup(g => g.setName('template').setDescription('Manage preset templates')
    .addSubcommand(s => s.setName('add').setDescription('Add or update a template')
      .addStringOption(o => o.setName('name').setDescription('Short name (autocomplete key)').setRequired(true).setMaxLength(40))
      .addStringOption(o => o.setName('prompt').setDescription('The generation prompt').setRequired(true).setMaxLength(900)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a template')
      .addStringOption(o => o.setName('name').setDescription('Template name').setRequired(true).setAutocomplete(true))))
  .addSubcommandGroup(g => g.setName('campaign').setDescription('Manage fixed-asset campaigns')
    .addSubcommand(s => s.setName('add').setDescription('Create a campaign: base scene + prompt + optional mask & product refs')
      .addStringOption(o => o.setName('name').setDescription('Campaign name (autocomplete key)').setRequired(true).setMaxLength(40))
      .addStringOption(o => o.setName('prompt').setDescription('Swap instruction — reference images by order (see /pengu-admin campaign list footer)').setRequired(true).setMaxLength(900))
      .addAttachmentOption(o => o.setName('base').setDescription('Base scene image (the hero penguin to be replaced)').setRequired(true))
      .addAttachmentOption(o => o.setName('mask').setDescription('PNG, base-sized: TRANSPARENT over the penguin = regenerated; opaque = preserved pixel-exact'))
      .addAttachmentOption(o => o.setName('ref1').setDescription('Product/item reference photo'))
      .addAttachmentOption(o => o.setName('ref2').setDescription('Product/item reference photo'))
      .addAttachmentOption(o => o.setName('ref3').setDescription('Product/item reference photo')))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a campaign')
      .addStringOption(o => o.setName('campaign').setDescription('Campaign name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('list').setDescription('List campaigns')))
  .addSubcommandGroup(g => g.setName('rule').setDescription('Manage default generation rules')
    .addSubcommand(s => s.setName('add').setDescription('Add a default rule (applies to every generation)')
      .addStringOption(o => o.setName('text').setDescription('The rule, e.g. "always include the Pudgy logo bottom-right"').setRequired(true).setMaxLength(300)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a rule by its number')
      .addIntegerOption(o => o.setName('id').setDescription('Rule # (see /pengu-admin rule list)').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('list').setDescription('Show active default rules')))
  .addSubcommandGroup(g => g.setName('set').setDescription('Adjust settings')
    .addSubcommand(s => s.setName('limit').setDescription('Daily generations per user')
      .addIntegerOption(o => o.setName('value').setDescription('Per-user daily limit').setRequired(true).setMinValue(0).setMaxValue(100)))
    .addSubcommand(s => s.setName('quality').setDescription('Image quality (cost lever)')
      .addStringOption(o => o.setName('value').setDescription('low ≈ $0.01, medium ≈ $0.04, high ≈ $0.17 per image').setRequired(true)
        .addChoices({ name: 'low', value: 'low' }, { name: 'medium', value: 'medium' }, { name: 'high', value: 'high' })))
    .addSubcommand(s => s.setName('output-px').setDescription('Exact pixel size for square outputs')
      .addIntegerOption(o => o.setName('value').setDescription('e.g. 1000 (0 = keep native 1024)').setRequired(true).setMinValue(0).setMaxValue(1024)))
    .addSubcommand(s => s.setName('booster-bonus').setDescription('Extra daily gens for server boosters')
      .addIntegerOption(o => o.setName('value').setDescription('Bonus amount').setRequired(true).setMinValue(0).setMaxValue(50)))
    .addSubcommand(s => s.setName('cooldown').setDescription('Seconds between generations per user')
      .addIntegerOption(o => o.setName('value').setDescription('Seconds').setRequired(true).setMinValue(0).setMaxValue(3600)))
    .addSubcommand(s => s.setName('example-prompt').setDescription('Default instruction used when a user attaches an example image')
      .addStringOption(o => o.setName('value').setDescription('The default "replicate this" instruction').setRequired(true).setMaxLength(600)))
    .addSubcommand(s => s.setName('channel').setDescription('Restrict generation to one channel')
      .addChannelOption(o => o.setName('value').setDescription('Channel (leave empty to allow everywhere)')))
    .addSubcommand(s => s.setName('gallery').setDescription('Channel for auto-reposting every generation (the hype wall)')
      .addChannelOption(o => o.setName('value').setDescription('Gallery channel (leave empty to turn off)')))
    .addSubcommand(s => s.setName('default-campaign').setDescription('Campaign that a bare /generate runs (type "off" to disable)')
      .addStringOption(o => o.setName('value').setDescription('Campaign name, or "off"').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('winner-bonus').setDescription('Bonus gens for the daily 🔥-vote winner')
      .addIntegerOption(o => o.setName('value').setDescription('Bonus amount (0 = no reward)').setRequired(true).setMinValue(0).setMaxValue(50))))
  .addSubcommand(s => s.setName('toggle').setDescription('Enable/disable generation')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)))
  .addSubcommand(s => s.setName('grant').setDescription("Give a user extra generations for today")
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o => o.setName('amount').setDescription('Extra gens today').setRequired(true).setMinValue(1).setMaxValue(50)))
  .addSubcommand(s => s.setName('settings').setDescription('Show current settings'))
  .addSubcommand(s => s.setName('stats').setDescription('Usage stats (last 7 days)'));

const commands = [generate, campaign, quota, templates, admin].map(c => c.toJSON());

async function register() {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  const route = process.env.GUILD_ID
    ? Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
    : Routes.applicationCommands(process.env.CLIENT_ID);
  await rest.put(route, { body: commands });
  console.log(`Registered ${commands.length} commands ${process.env.GUILD_ID ? `to guild ${process.env.GUILD_ID}` : 'globally'}.`);
}

if (require.main === module) register().catch(e => { console.error(e); process.exit(1); });
module.exports = { register };
