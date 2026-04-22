'use strict';

const axios = require('axios');

const version = '1.0.0';
const pluginName = 'swpl';

// Commands we listen to. Each one maps 1:1 to an `ingest` type on the Peace
// side (see lib/siege/battlesIngest.ts INGEST_TYPES).
const BATTLE_COMMANDS = [
  'GetGuildSiegeBattleLog',
  'GetGuildSiegeBattleLogByWizardId',
  'GetGuildSiegeMatchupInfo',
  'GetGuildSiegeMatchLog',
  'GetGuildSiegeContributeList',
  'GetGuildSiegeDefenseDeckByWizardId',
  'GetGuildSiegeParticipatedSiegeIdList',
  'GetGuildSiegeRankingInfo',
  'GetGuildSiegeStatusInfo',
];

// Strip every SW command name prefix to get the ingest `type` expected by
// the Peace API (e.g. "GetGuildSiegeBattleLog" → "GuildSiegeBattleLog").
function toIngestType(command) {
  return command.startsWith('Get') ? command.slice(3) : command;
}

// Short in-memory dedup to avoid hammering the API when SW refires the same
// payload within seconds (e.g. opening/closing the siege view). We keep the
// last-seen hash per command and skip identical reposts inside a small window.
const DEDUP_WINDOW_MS = 10_000;
const dedupCache = new Map(); // command → { hash, seenAt }

function hashPayload(resp) {
  // Remove volatile server-side fields before hashing so two logically
  // identical responses compare equal across network round-trips.
  const clean = { ...resp };
  delete clean.ts_val;
  delete clean.tvalue;
  delete clean.tvaluelocal;
  delete clean.tzone;
  delete clean.tzoffset;
  delete clean.reqid;
  delete clean.this_server_id;
  try {
    return JSON.stringify(clean);
  } catch {
    return String(Math.random());
  }
}

function isDuplicate(command, resp) {
  const hash = hashPayload(resp);
  const prev = dedupCache.get(command);
  const now = Date.now();
  if (prev && prev.hash === hash && now - prev.seenAt < DEDUP_WINDOW_MS) {
    return true;
  }
  dedupCache.set(command, { hash, seenAt: now });
  return false;
}

// Best-guess extraction of the "current match" id from whatever payload we
// just received. The Peace backend uses this to attach contribution / defense
// deck uploads to the right match when the SW response doesn't include one
// itself.
function extractMatchId(command, resp) {
  if (!resp || typeof resp !== 'object') return undefined;
  const mi = resp.match_info;
  if (mi && mi.match_id != null) return String(mi.match_id);
  const logList = resp.log_list;
  if (Array.isArray(logList)) {
    for (const block of logList) {
      const items = block && block.battle_log_list;
      if (Array.isArray(items) && items.length > 0 && items[0].match_id != null) {
        return String(items[0].match_id);
      }
    }
  }
  return undefined;
}

module.exports = {
  pluginName,
  pluginDescription: 'Streams guild siege data to Peace (peace-sigma-ten.vercel.app).',
  version,
  autoUpdate: {
    // GitHub serves raw files over HTTPS from raw.githubusercontent.com and
    // SWEX' updater requires the URL to end in .yml, which it does.
    versionURL:
      'https://raw.githubusercontent.com/RaspFR/peace-swex-plugin/main/dist/swpl.yml',
  },

  defaultConfig: {
    enabled: true,
    apiUrl: 'https://peace-sigma-ten.vercel.app/api/guild/siege/battles/import',
    apiToken: '',
    debugLog: false,
  },
  defaultConfigDetails: {
    apiUrl: { label: 'Peace ingest URL', type: 'input' },
    apiToken: { label: 'Peace API token (from /admin/tokens)', type: 'input' },
    debugLog: { label: 'Verbose log (every siege API call)' },
  },

  // Tracks the most recently seen siege match id, carried alongside
  // contribution / defense-deck payloads that don't self-identify the match.
  _contextMatchId: undefined,

  init(proxy, config) {
    const cfg = () => config.Config.Plugins[pluginName] || {};

    proxy.log({
      type: 'info',
      source: 'plugin',
      name: pluginName,
      message: `Loaded v${version}. Configure your API token in Settings.`,
    });

    for (const command of BATTLE_COMMANDS) {
      proxy.on(command, (req, resp) => {
        const c = cfg();
        if (!c.enabled) return;

        // Never swallow a bad response — a non-zero ret_code means the
        // server refused, there's nothing useful to persist.
        if (!resp || resp.ret_code !== 0) {
          if (c.debugLog) {
            proxy.log({
              type: 'warning',
              source: 'plugin',
              name: pluginName,
              message: `${command}: ret_code=${resp && resp.ret_code} — skipped.`,
            });
          }
          return;
        }

        // Clone because SWEX deep-freezes req/resp.
        const rawCopy = structuredClone(resp);

        // Update context from any payload that carries a match id,
        // so subsequent Contribute/DefenseDeck calls land on the right match.
        const observedMatchId = extractMatchId(command, rawCopy);
        if (observedMatchId) this._contextMatchId = observedMatchId;

        if (isDuplicate(command, rawCopy)) {
          if (c.debugLog) {
            proxy.log({
              type: 'debug',
              source: 'plugin',
              name: pluginName,
              message: `${command}: duplicate payload within ${DEDUP_WINDOW_MS}ms, skipped.`,
            });
          }
          return;
        }

        this.upload(proxy, config, req, command, rawCopy);
      });
    }
  },

  async upload(proxy, config, req, command, rawResp) {
    const c = config.Config.Plugins[pluginName] || {};
    if (!c.apiUrl || !c.apiToken) {
      proxy.log({
        type: 'warning',
        source: 'plugin',
        name: pluginName,
        message: `${command}: missing apiUrl or apiToken — open Plugins settings.`,
      });
      return;
    }

    const payload = {
      version: 1,
      type: toIngestType(command),
      wizardId: req && req.wizard_id,
      guildId: req && req.guild_id,
      capturedAt: Math.floor(Date.now() / 1000),
      contextMatchId: this._contextMatchId,
      raw: rawResp,
    };

    try {
      const res = await axios.post(c.apiUrl, payload, {
        headers: {
          Authorization: `Bearer ${c.apiToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
        // Accept any 2xx, surface 4xx/5xx as errors below.
        validateStatus: (s) => s >= 200 && s < 300,
      });

      const body = res.data || {};
      const summary = [
        body.matchesUpserted ? `matches=${body.matchesUpserted}` : null,
        body.battlesUpserted ? `battles=${body.battlesUpserted}` : null,
        body.contributionsUpserted ? `contribs=${body.contributionsUpserted}` : null,
        body.decksUpserted ? `decks=${body.decksUpserted}` : null,
      ]
        .filter(Boolean)
        .join(' ');

      proxy.log({
        type: 'success',
        source: 'plugin',
        name: pluginName,
        message: `${command} uploaded${summary ? ' · ' + summary : ''}`,
      });
    } catch (err) {
      const status = err.response && err.response.status;
      const body = err.response && err.response.data;
      const detail =
        (body && (body.message || body.error)) ||
        err.message ||
        'unknown error';

      if (status === 401) {
        proxy.log({
          type: 'error',
          source: 'plugin',
          name: pluginName,
          message: `Peace rejected the API token. Check /admin/tokens on Peace.`,
        });
        return;
      }

      proxy.log({
        type: 'error',
        source: 'plugin',
        name: pluginName,
        message: `${command} upload failed${status ? ` (HTTP ${status})` : ''}: ${detail}`,
      });
    }
  },
};
