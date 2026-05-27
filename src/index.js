import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { loadConfig } from './config.js';
import { StateStore } from './state.js';
import { addToWhitelist } from './tmux.js';
import { LogWatcher } from './watcher.js';

const config = loadConfig();
const state = new StateStore(config.projectRoot);
state.load();

const serversByName = new Map(config.servers.map((server) => [server.name, server]));
const cooldowns = new Map();

const client = new Client({
  intents: [GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

function requestComponents(request, disabled = false) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`allow:${request.id}`)
        .setLabel('Allow')
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`ignore:${request.id}`)
        .setLabel('Ignore')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  ];
}

function requestMessage(request) {
  return [
    `Whitelist request for **${request.serverName}**`,
    `Player: \`${request.username}\``,
    `IP: \`${request.ip}\``,
    `Detected: ${request.createdAt}`,
  ].join('\n');
}

async function sendAlert(event) {
  if (state.isIgnored(event.server.name, event.username, event.ip)) {
    return;
  }

  const cooldownKey = state.cooldownKey(event.username, event.ip);
  const now = Date.now();
  const lastSent = cooldowns.get(cooldownKey) || 0;
  if (now - lastSent < config.cooldownMs) {
    return;
  }
  cooldowns.set(cooldownKey, now);

  const request = state.createRequest({
    serverName: event.server.name,
    username: event.username,
    ip: event.ip,
    line: event.line,
  });

  const user = await client.users.fetch(config.discordUserId);
  const message = await user.send({
    content: requestMessage(request),
    components: requestComponents(request),
  });

  state.updateRequest(request.id, {
    channelId: message.channelId,
    messageId: message.id,
  });

  console.log(`[${event.server.name}] alerted for ${event.username} from ${event.ip}`);
}

async function editRequestMessage(interaction, request, content) {
  await interaction.update({
    content,
    components: requestComponents(request, true),
  });
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) {
    return;
  }

  const [action, requestId] = interaction.customId.split(':');
  if (!['allow', 'ignore'].includes(action)) {
    return;
  }

  if (interaction.user.id !== config.discordUserId) {
    await interaction.reply({
      content: 'You are not authorized to manage this whitelist request.',
      ephemeral: true,
    });
    return;
  }

  const request = state.getRequest(requestId);
  if (!request) {
    await interaction.reply({ content: 'That whitelist request no longer exists.', ephemeral: true });
    return;
  }

  if (request.status !== 'pending') {
    await interaction.reply({ content: `That request is already ${request.status}.`, ephemeral: true });
    return;
  }

  const server = serversByName.get(request.serverName);
  if (!server) {
    await interaction.reply({ content: `Unknown server: ${request.serverName}`, ephemeral: true });
    return;
  }

  if (action === 'ignore') {
    state.addIgnored(request.serverName, request.username, request.ip);
    const updated = state.updateRequest(request.id, {
      status: 'ignored',
      handledBy: interaction.user.id,
      handledAt: new Date().toISOString(),
    });
    await editRequestMessage(interaction, updated, `${requestMessage(updated)}\n\nIgnored. Future alerts for this server/player/IP are muted.`);
    return;
  }

  await interaction.deferUpdate();
  try {
    await addToWhitelist(server, request.username);
    const updated = state.updateRequest(request.id, {
      status: 'allowed',
      handledBy: interaction.user.id,
      handledAt: new Date().toISOString(),
    });
    await interaction.editReply({
      content: `${requestMessage(updated)}\n\nAllowed. Sent \`whitelist add ${request.username}\` to tmux session \`${server.tmuxSession}\`.`,
      components: requestComponents(updated, true),
    });
  } catch (error) {
    console.error(`[${request.serverName}] allow failed:`, error.message);
    await interaction.editReply({
      content: `${requestMessage(request)}\n\nAllow failed: ${error.message}`,
      components: requestComponents(request),
    });
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const user = await client.users.fetch(config.discordUserId);
    await user.send(`MC Whitelist Bot started. Watching ${config.servers.length} server(s).`);
  } catch (error) {
    console.error('Startup DM failed:', error.message);
  }

  for (const server of config.servers) {
    const watcher = new LogWatcher({
      server,
      pollMs: config.pollMs,
      onMatch: (event) => {
        sendAlert(event).catch((error) => {
          console.error(`[${event.server.name}] alert failed:`, error.message);
        });
      },
    });
    await watcher.start();
  }

  if (process.env.TEST_ALERT === '1') {
    const server = config.servers[0];
    await sendAlert({
      server,
      username: 'TestPlayer',
      ip: '203.0.113.10',
      line: 'Synthetic whitelist test event',
    });
  }
});

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error.message);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, exiting.');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, exiting.');
  client.destroy();
  process.exit(0);
});

await client.login(config.discordToken);
