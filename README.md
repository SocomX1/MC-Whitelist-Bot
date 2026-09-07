# MC Whitelist Bot

A Discord DM bot for Minecraft whitelist requests. Currently only supports Linux due to reliance on tmux. Adding Windows support is doable via rcon, but I'm probably not going to bother because who runs Minecraft servers on Windows anyways.

The bot watches Minecraft `logs/latest.log` files for failed whitelist joins, sends a Discord DM with `Allow` and `Ignore` buttons, and uses tmux to run `whitelist add <player>` in the matching server console.


## Run

```sh
cd ~/MC-Whitelist-Bot
tmux new -s mc-whitelist-bot
npm install
npm start
```
Connect to the bot's tmux session with `tmux attach -t mc-whitelist-bot`. Use `CTRL+C` to terminate.
I might look into making the bot run as a systemd service in the future.

When making changes, validate JavaScript syntax via:

```sh
npm run check
npm test
```

Tests use temporary files and an isolated tmux socket. The integration test requires tmux and permission to create local Unix sockets; it does not use your running server sessions.

## Behavior

- Alerts have a global 60-second cooldown per username and IP address.
- `Allow` sends `whitelist add <username>` to the configured tmux session.
- `Ignore` suppresses future alerts for that server, player, and IP address.
- Any configured Discord user can handle a request, and the bot updates the request buttons in every recipient's DM.
- State is stored in `data/state.json`.
- Optional per-server automatic restarts include in-game countdown warnings.

## Requirements

- Node.js 20+
- Minecraft servers running in tmux sessions named the same as their server directory, unless overridden in config
- Discord bot token
- Numeric Discord user ID

## Configuration

Bot settings and credentials are configured in `config.json`:

```json
{
  "botToken": "your_bot_token",
  "discordUserIds": [
    "your_numeric_discord_user_id",
    "another_numeric_discord_user_id"
  ],
  "pollMs": 1000,
  "cooldownMs": 60000,
  "servers": [
    {
      "name": "atm11",
      "directory": "/home/opc/atm11",
      "autoRestartInterval": 6
    },
    {
      "name": "cobbleverse",
      "directory": "/home/opc/cobbleverse"
    }
  ]
}
```

Each `discordUserIds` entry must be a numeric account ID, not a username. To get it in Discord:

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

## Automatic Restarts

Add `autoRestartInterval` to each server you want to restart automatically:

```json
{
  "name": "atm11",
  "directory": "/home/opc/atm11",
  "autoRestartInterval": 6,
  "restartTimeoutSeconds": 600
}
```

- `autoRestartInterval` is a number of hours. Fractions are supported (minimum one second); omit it or set it to `0` to disable restarts.
- `restartTimeoutSeconds` is the maximum total time allowed for graceful shutdown and startup, including fallback launch and the 30-second process stability check. It defaults to 600 seconds; increase it for slow modpacks.
- The first deadline is bot activation time plus the interval, not existing Minecraft uptime. Deadlines and pending operations are saved in `data/state.json` and survive bot restarts.
- After a confirmed process restart, the next deadline is one interval from the replacement Java process's actual start time (not the end of the stability check). Manual Minecraft restarts do not reset the schedule.
- Changing the interval resets the deadline on the next bot startup; an already pending restart is still monitored. Disabling removes its schedule and stops monitoring it, without undoing a previously sent `stop`.
- The bot sends `say` warnings 10 minutes, 5 minutes, 3 minutes, 1 minute, and 30 seconds before the deadline, then sends `stop` once. Warnings longer than the interval are skipped. Missed warnings are not replayed after downtime, and at most one overdue restart is attempted.
- If the session is absent or its pane has already exited at the deadline, the occurrence is skipped and the next deadline is one full interval later. The bot does not start servers that were offline when their restart became due.

### Server launcher requirements

Each enabled server must have a readable `tmux.sh` in its top-level directory. Use detached mode, and ensure the session name matches `tmuxSession` (which defaults to the directory basename):

```sh
tmux new -d -s atm11 ./start.sh
```

Put `-d` before the start command, so it is interpreted by tmux. The bot runs `bash tmux.sh` with the server directory as its working directory. The script must return promptly; launcher and tmux commands have a 10-second timeout.

Use a dedicated session containing exactly one Minecraft pane and one Java server process, with a start script that remains in the foreground. The Java executable must be named `java`; it may be the pane process itself or a descendant of a shell wrapper. Run the bot as the same Linux user as the servers, with access to their `/proc` process metadata and executable links. The system `getconf` utility is used to read the Linux clock tick rate. The script must either restart Minecraft itself or exit after Minecraft stops. Multiple enabled server entries cannot share a tmux session. Run only one instance of this bot against the same servers/state file.

### Shutdown and recovery

The bot lets self-restarting launchers handle their own restart, including their 10-second delay. It does not launch another server while that pane remains alive. If the session disappears, the bot waits 20 seconds from the observed disappearance, checks again, and runs `tmux.sh` only if it is still absent. If tmux retains the original exited pane through `remain-on-exit`, the bot instead respawns that dead pane's original command after the same grace period.

Before sending `stop`, the bot identifies the Java process in the pane's process tree and saves its PID, Linux process start time, and boot ID. It waits for that original process to exit before accepting a replacement or attempting fallback startup. PID reuse or an unchanged shell wrapper cannot count as a successful restart. If no Java process is found at the deadline, the occurrence is skipped; multiple Java processes or inaccessible process metadata cause a logged failure rather than guessing.

A restart is confirmed when a new Java process under the server pane remains alive for 30 seconds after first being observed. A different replacement resets this stability window. This confirms process restart and short-term stability, not full world/mod initialization or player connectivity. No startup log message, network status check, or `enable-status` setting is required. Log watching for whitelist requests is unchanged.

Failures and timeouts are logged to the bot console, with the next attempt scheduled a full interval later. The bot never force-kills Minecraft or repeatedly launches a failed fallback. Pending operations are persisted before sending `stop` or launching, preventing those actions from being blindly repeated after a bot crash. A crash exactly between persistence and command execution can leave the action unperformed; it will time out instead of risking a duplicate. Process identities and stability progress also survive bot restarts. A pending operation saved by the older log-based implementation cannot be verified safely and is deferred to the next interval without repeating its commands.

Restart scheduling runs independently of Discord connectivity once the bot is running. Stopping the bot cancels future scheduler actions; any server shutdown or launch already issued continues normally.

## Discord DM Delivery

Discord may reject proactive bot DMs unless your account and the bot share a mutual server and your privacy settings allow DMs from that server. If startup logs show:

```text
Cannot send messages to this user due to having no mutual guilds
```

invite the bot to a small private server that your account is also in.
