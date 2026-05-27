# MC Whitelist Bot

A Discord DM bot for Minecraft whitelist requests. Currently only supports Linux due to reliance on tmux. Adding Windows support is doable via rcon, but I'm probably not going to bother because who runs Minecraft servers on Windows anyways.

The bot watches Minecraft `logs/latest.log` files for failed whitelist joins, sends a Discord DM with `Allow` and `Ignore` buttons, and uses tmux to run `whitelist add <player>` in the matching server console.


## Run

```sh
cd ~/MC-Whitelist-Bot
npm install
npm start
```

I might look into making the bot run as a systemd service in the future.
Use `CTRL + C` to terminate the bot.

When making changes, validate JavaScript syntax via:

```sh
npm run check
```

## Behavior

- Alerts have a global 60-second cooldown per username and IP address.
- `Allow` sends `whitelist add <username>` to the configured tmux session.
- `Ignore` suppresses future alerts for that server, player, and IP address.
- State is stored in `data/state.json`.

## Requirements

- Node.js 20+
- Minecraft servers running in tmux sessions named the same as their server directory, unless overridden in config
- Discord bot token
- Numeric Discord user ID

## Configuration

Bot settings are configured in `config.json` with Discord credentials first, bot timing values next, and server definitions last:

```json
{
  "discordToken": "your_bot_token",
  "discordUserId": "your_numeric_discord_user_id",
  "pollMs": 1000,
  "cooldownMs": 60000,
  "servers": [
    {
      "name": "atm11",
      "directory": "/home/opc/atm11"
    },
    {
      "name": "cobbleverse",
      "directory": "/home/opc/cobbleverse"
    }
  ]
}
```

`discordUserId` must be the numeric account ID, not a username. To get it in Discord:

1. User Settings -> Advanced -> enable Developer Mode.
2. Right-click your user/profile.
3. Copy User ID.

Replace the placeholder values locally before starting the bot. If you fork/clone this repo, DO NOT ACCIDENTALLY COMMIT YOUR BOT TOKEN.

### Default Server Config Values

- `logPath`: `<directory>/logs/latest.log`
- `tmuxSession`: basename of `directory`

Override either when needed:

```json
{
  "name": "atm11",
  "directory": "/home/opc/atm11",
  "logPath": "/home/opc/atm11/logs/latest.log",
  "tmuxSession": "atm11"
}
```

## Discord DM Delivery

Discord may reject proactive bot DMs unless your account and the bot share a mutual server and your privacy settings allow DMs from that server. If startup logs show:

```text
Cannot send messages to this user due to having no mutual guilds
```

invite the bot to a small private server that your account is also in.
