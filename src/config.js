import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/*
 * Read the JSON config file and report config-specific parse or missing
 * file failures instead of exposing lower-level filesystem errors.
 */
function loadJsonConfig() {
  const configPath = path.join(PROJECT_ROOT, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Missing config file: config.json');
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config.json: ${error.message}`);
    }
    throw error;
  }
}

function requireString(config, name, source) {
  const raw = config[name];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    throw new Error(`Missing required value ${name} in ${source}`);
  }
  return value;
}

function optionalPositiveInt(config, name, fallback, source) {
  const raw = config[name];
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${name} in ${source} must be a positive integer`);
  }
  return raw;
}

/*
 * Normalize configured Minecraft servers into the fields the watcher and
 * tmux integration need, deriving conventional log paths and tmux session
 * names when they are not provided explicitly.
 */
function loadServers(config) {
  if (!Array.isArray(config.servers) || config.servers.length === 0) {
    throw new Error('config.json must contain at least one server');
  }

  return config.servers.map((server) => {
    if (!server.name || !server.directory) {
      throw new Error('Each server needs name and directory fields');
    }

    const directory = path.resolve(server.directory);
    return {
      name: server.name,
      directory,
      logPath: server.logPath ? path.resolve(server.logPath) : path.join(directory, 'logs', 'latest.log'),
      tmuxSession: server.tmuxSession || path.basename(directory),
    };
  });
}

export function loadConfig() {
  const config = loadJsonConfig();

  const discordToken = requireString(config, 'discordToken', 'config.json');
  const discordUserId = requireString(config, 'discordUserId', 'config.json');
  if (!/^\d{15,25}$/.test(discordUserId)) {
    throw new Error('discordUserId in config.json must be your numeric Discord user ID, not your username');
  }

  return {
    projectRoot: PROJECT_ROOT,
    discordToken,
    discordUserId,
    pollMs: optionalPositiveInt(config, 'pollMs', 1000, 'config.json'),
    cooldownMs: optionalPositiveInt(config, 'cooldownMs', 60000, 'config.json'),
    servers: loadServers(config),
  };
}
