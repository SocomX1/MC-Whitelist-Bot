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
const discordUserIds = new Set(config.discordUserIds);
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

function requestAlertMessages(request) {
  if (Array.isArray(request.alertMessages)) {
    return request.alertMessages;
  }

  if (request.channelId && request.messageId) {
    return [{ channelId: request.channelId, messageId: request.messageId }];
  }

  return [];
}

async function sendRequestMessage(userId, request) {
  const user = await client.users.fetch(userId);
  const message = await user.send({
    content: requestMessage(request),
    components: requestComponents(request),
  });

  return {
    userId,
    channelId: message.channelId,
    messageId: message.id,
  };
}

async function editStoredRequestMessage(alertMessage, request, content, disabled = true) {
  const channel = await client.channels.fetch(alertMessage.channelId);
  if (!channel?.messages) {
    throw new Error(`Unable to fetch DM channel ${alertMessage.channelId}`);
  }

  const message = await channel.messages.fetch(alertMessage.messageId);
  await message.edit({
    content,
    components: requestComponents(request, disabled),
  });
}

/*
 * Keep every recipient's DM in sync after one authorized user handles the
 * request. Missing/deleted DMs are logged and do not block the chosen action.
 */
async function editAllRequestMessages(request, content, disabled = true) {
  const alertMessages = requestAlertMessages(request);
  const results = await Promise.allSettled(
    alertMessages.map((alertMessage) => editStoredRequestMessage(alertMessage, request, content, disabled)),
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      const alertMessage = alertMessages[index];
      console.error(`[${request.serverName}] failed to update request DM ${alertMessage?.messageId}:`, result.reason.message);
    }
  });
}

/*
 * Turn a matched whitelist denial into one actionable Discord DM, while
 * respecting ignored identities and a process-local cooldown to avoid
 * repeated alerts for the same player/IP pair.
 */
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

  const results = await Promise.allSettled(
    config.discordUserIds.map((userId) => sendRequestMessage(userId, request)),
  );
  const alertMessages = results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`[${event.server.name}] alert DM to ${config.discordUserIds[index]} failed:`, result.reason.message);
    }
  });

  if (alertMessages.length === 0) {
    console.error(`[${event.server.name}] alert failed for every configured Discord user`);
    return;
  }

  state.updateRequest(request.id, {
    alertMessages,
  });

  console.log(`[${event.server.name}] alerted ${alertMessages.length} user(s) for ${event.username} from ${event.ip}`);
}

/*
 * Handle the Allow/Ignore buttons on request DMs. The request status is
 * checked again here because Discord interactions can arrive after another
 * action has already handled the same request.
 */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) {
    return;
  }

  const [action, requestId] = interaction.customId.split(':');
  if (!['allow', 'ignore'].includes(action)) {
    return;
  }

  if (!discordUserIds.has(interaction.user.id)) {
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
    await interaction.deferUpdate();
    state.addIgnored(request.serverName, request.username, request.ip);
    const updated = state.updateRequest(request.id, {
      status: 'ignored',
      handledBy: interaction.user.id,
      handledAt: new Date().toISOString(),
    });
    await editAllRequestMessages(updated, `${requestMessage(updated)}\n\nIgnored. Future alerts for this server/player/IP are muted.`);
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
    await editAllRequestMessages(updated, `${requestMessage(updated)}\n\nAllowed. Sent \`whitelist add ${request.username}\` to tmux session \`${server.tmuxSession}\`.`);
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
    const results = await Promise.allSettled(
      config.discordUserIds.map(async (userId) => {
        const user = await client.users.fetch(userId);
        await user.send(`MC Whitelist Bot started. Watching ${config.servers.length} server(s).`);
      }),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Startup DM to ${config.discordUserIds[index]} failed:`, result.reason.message);
      }
    });
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
