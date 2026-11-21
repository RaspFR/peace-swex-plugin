'use strict';

const axios = require('axios');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);

const version = '1.6.1';
const pluginName = 'swpl';

// Commands we listen to. Each one maps 1:1 to an `ingest` type on the Peace
// side (see lib/siege/battlesIngest.ts INGEST_TYPES).
//
// Some SW commands use a lowercase first letter (e.g. `getGuildSiege...`) and
// a `_vN` suffix (e.g. `getGuildSiegeMatchBattleLogSummary_v2`). We normalize
// both away in `toIngestType` so the matching ingest type stays clean.
const BATTLE_COMMANDS = [
  'GetGuildSiegeBattleLog',
  'GetGuildSiegeBattleLogByWizardId',
  'GetGuildSiegeMatchupInfo',
  'GetGuildSiegeMatchupInfoForFinished',
  'GetGuildSiegeMatchLog',
  'getGuildSiegeMatchBattleLogSummary_v2',
  'GetGuildSiegeContributeList',
  'GetGuildSiegeDefenseDeckByWizardId',
  'GetGuildSiegeParticipatedSiegeIdList',
  'GetGuildSiegeRankingInfo',
  'GetGuildSiegeMemberStatSeasonList',
  'GetGuildSiegeStatusInfo',
  // Fires when a member opens a tower in game (any guild's): the trio of
  // every defense on it. Feeds the defenses panel of the live map.
  'GetGuildSiegeBaseDefenseUnitList',
];

// Per-user commands routed to a different endpoint than the guild-siege
// ingest. The plugin uses the same Bearer token (verifyApiToken accepts
// both guild and user tokens) but writes to a user-scoped table on the
// Peace side. Today only WGB defense uses this channel.
const USER_COMMANDS = ['GetServerGuildWarDefenseDeckList'];

// Per-user inventory commands. Same auth + same dedup as USER_COMMANDS,
// just a different ingest endpoint. We isolate them because the route
// computation diverges (different path on the Peace side).
//
// `getUnitStorageList` is the one Com2uS call that returns the full
// inventory aggregated by unit_master_id across every collection slot
// (active roster + Monster Storage + Summoned/Normal Sealed Shrines).
// SWEX' own export only ships the first two, so this stream is the only
// way to see what's locked away in the shrines.
const STORAGE_COMMANDS = ['getUnitStorageList'];

// Dimension Arena season (Peace › Arena › Dimensional Arena). Fires every time
// the player opens the arena lobby: the season's 190-monster pool with its
// preset builds, the player's summons, earned runes and defense. Per-user,
// same token and dedup as the storage stream, its own endpoint. The response
// carries no session key (that lives in the request, which is never sent).
const ARENA_COMMANDS = ['dimensionarena_getSeasonInfo'];

// Account auto-sync (Peace › your account, kept up to date). Off until the
// player ticks "Auto-sync my account": `HubUserLogin` is the game's login
// response, i.e. exactly what a SWEX JSON export contains, so every game login
// refreshes the player's account on Peace without a manual upload.
const ACCOUNT_COMMANDS = ['HubUserLogin'];

// Keys dropped before the login response leaves the machine: the game session,
// the account/device block, other players' data and heavy blocks Peace never
// reads. Mirrors Peace's lib/swex/sanitizeSwex.ts (which applies them again on
// arrival, so this list only has to be a subset of it).
const ACCOUNT_STRIPPED_KEYS = new Set([
  // secrets
  'session_key',
  'session_key_node',
  'account_info',
  // other players / payments
  'friend_list',
  'invite_buddy',
  'webcash_info',
  'push_noti_status_list',
  // unused by Peace
  'shop_info',
  'obstacle_list',
  'draft_unit_list',
  'rtpvp_season_npc_list',
  'deck_recent_list',
  'scenario_list',
  'quest_rewarded',
  'quest_active',
  'event_id_list',
  'notice_info',
  'notice_popup_info_list',
  'daily_reward_list',
  'homunculus_skill_select_ratio_info',
  'inventory_open_info',
  'mob_costume_part_list',
  'battle_option_list',
]);

// At most one account sync every 30 minutes per wizard. Game reconnections
// fire a login each, and every request that reaches Peace wakes its database
// (billed by the time it is awake), so the plugin holds back longer than
// Peace's own 10-minute guard: a skipped login here costs nothing at all.
const ACCOUNT_MIN_INTERVAL_MS = 30 * 60 * 1000;
const lastAccountSync = new Map(); // wizard_id -> ms of the last stored sync

function withoutChannelUid(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !('channel_uid' in obj)) return obj;
  const { channel_uid: _drop, ...rest } = obj;
  return rest;
}

// The guild block without the Hive account ids (`channel_uid` on every member,
// `master_channel_uid` on the guild).
function trimGuild(guild) {
  if (!guild || typeof guild !== 'object') return guild;
  const out = { ...guild };
  if (guild.guild_info && typeof guild.guild_info === 'object') {
    const { master_channel_uid: _drop, ...info } = guild.guild_info;
    out.guild_info = info;
  }
  const members = guild.guild_members;
  if (Array.isArray(members)) {
    out.guild_members = members.map(withoutChannelUid);
  } else if (members && typeof members === 'object') {
    out.guild_members = {};
    for (const id of Object.keys(members)) out.guild_members[id] = withoutChannelUid(members[id]);
  }
  return out;
}

// Shallow copy of the login response without the stripped keys and Hive ids.
// No deep clone: it is only serialized, and SWEX' frozen objects serialize fine.
function trimLogin(resp) {
  const out = {};
  for (const key of Object.keys(resp)) {
    if (ACCOUNT_STRIPPED_KEYS.has(key)) continue;
    if (key === 'guild') out.guild = trimGuild(resp.guild);
    else if (key === 'dimension_arena_user_info') out[key] = withoutChannelUid(resp[key]);
    else out[key] = resp[key];
  }
  return out;
}

// A whole account and the token only ever travel over https (plain http is
// accepted for a local Peace only).
function isSafeTarget(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

// Build the base origin from the configured ingest URL. Accepts either a
// fully-qualified guild ingest URL (the legacy default) or just an origin —
// both are common in user configs.
function deriveOrigin(apiUrl) {
  if (!apiUrl || typeof apiUrl !== 'string') return null;
  const stripped = apiUrl.replace(/\/api\/guild\/siege\/battles\/import\/?$/, '');
  return stripped.replace(/\/+$/, '');
}

// Derive the per-user WGB ingest URL.
function deriveUserApiUrl(apiUrl) {
  const base = deriveOrigin(apiUrl);
  return base ? `${base}/api/user/wgb-defense/import` : null;
}

// Derive the per-user unit-storage ingest URL.
function deriveStorageApiUrl(apiUrl) {
  const base = deriveOrigin(apiUrl);
  return base ? `${base}/api/user/storage/import` : null;
}

// Derive the per-user Dimension Arena ingest URL.
function deriveArenaApiUrl(apiUrl) {
  const base = deriveOrigin(apiUrl);
  return base ? `${base}/api/user/dimension-arena/import` : null;
}

// Derive the per-user account auto-sync URL.
function deriveAccountSyncUrl(apiUrl) {
  const base = deriveOrigin(apiUrl);
  return base ? `${base}/api/user/account/sync` : null;
}

// Strip the `get`/`Get` prefix and any trailing `_vN` version tag to get the
// ingest `type` expected by the Peace API.
//   "GetGuildSiegeBattleLog"                 → "GuildSiegeBattleLog"
//   "getGuildSiegeMatchBattleLogSummary_v2"  → "GuildSiegeMatchBattleLogSummary"
function toIngestType(command) {
  let s = command;
  if (s.startsWith('Get') || s.startsWith('get')) s = s.slice(3);
  // Capitalize first letter so lowercase-prefix commands match the casing of
  // the others ("guild..." → "Guild...").
  if (s.length > 0) s = s[0].toUpperCase() + s.slice(1);
  // Drop a trailing _vN (e.g. "_v2"), if any.
  s = s.replace(/_v\d+$/, '');
  return s;
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

// Pull the Com2uS season block out of a GetGuildSiegeStatusInfo response.
// Returns null if the fields aren't present (so the caller can decide not to
// overwrite a freshly captured season with an empty one).
function extractSeason(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const seasonNumber = n(resp.season_number);
  const seasonId = n(resp.season_id);
  const seasonType = n(resp.season_type);
  const seasonBeginTime = n(resp.season_begin_time);
  const seasonEndTime = n(resp.season_end_time);
  // If no field is usable, don't manufacture a context object.
  if (
    seasonNumber == null &&
    seasonId == null &&
    seasonType == null &&
    seasonBeginTime == null &&
    seasonEndTime == null
  ) {
    return null;
  }
  return { seasonNumber, seasonId, seasonType, seasonBeginTime, seasonEndTime };
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
  // A base defense list carries it on its beaten decks, when there are any.
  const statusList = resp.defense_deck_status_list;
  if (Array.isArray(statusList)) {
    const withId = statusList.find((st) => st && st.match_id != null);
    if (withId) return String(withId.match_id);
  }
  // Summary_v2 ships the match id only inside guild_list[].match_id.
  const guildList = resp.guild_list;
  if (Array.isArray(guildList) && guildList.length > 0 && guildList[0].match_id != null) {
    return String(guildList[0].match_id);
  }
  return undefined;
}

module.exports = {
  pluginName,
  pluginDescription:
    'Streams guild siege data to Peace (www.swpeace.fr). Optionally keeps your Peace account up to date at every game login.',
  version,
  autoUpdate: {
    // GitHub serves raw files over HTTPS from raw.githubusercontent.com and
    // SWEX' updater requires the URL to end in .yml, which it does.
    versionURL:
      'https://raw.githubusercontent.com/RaspFR/peace-swex-plugin/main/dist/swpl.yml',
  },

  defaultConfig: {
    enabled: true,
    apiUrl: 'https://www.swpeace.fr/api/guild/siege/battles/import',
    apiToken: '',
    autoSyncAccount: false,
    debugLog: false,
  },
  defaultConfigDetails: {
    apiUrl: { label: 'Peace ingest URL', type: 'input' },
    apiToken: { label: 'Peace API token (Peace › Profile › SWEX plugin token)', type: 'input' },
    autoSyncAccount: {
      label:
        'Auto-sync my account: update my monsters, runes and artifacts on Peace at every game login (personal token required)',
    },
    debugLog: { label: 'Verbose log (every siege API call)' },
  },

  // Tracks the most recently seen siege match id, carried alongside
  // contribution / defense-deck payloads that don't self-identify the match.
  _contextMatchId: undefined,

  // Com2uS siege season snapshot, pulled from the latest
  // GetGuildSiegeStatusInfo we saw. Attached to every non-Status upload so
  // the Peace backend can stamp each match with the season it belongs to.
  // Seasons span ~3 months and can't be derived from siege_id / match_id.
  _contextSeason: undefined,

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
        // The base defense list names its base only in the request.
        if (req && req.base_number != null && rawCopy.base_number == null) {
          rawCopy.base_number = req.base_number;
        }

        // Update context from any payload that carries a match id,
        // so subsequent Contribute/DefenseDeck calls land on the right match.
        const observedMatchId = extractMatchId(command, rawCopy);
        if (observedMatchId) this._contextMatchId = observedMatchId;

        // Refresh the season snapshot from Status calls only. Other commands
        // don't carry the season block, so we must not overwrite with null.
        if (command === 'GetGuildSiegeStatusInfo') {
          const observedSeason = extractSeason(rawCopy);
          if (observedSeason) this._contextSeason = observedSeason;
        }

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

        this.upload(proxy, config, req, command, rawCopy, c.apiUrl);
      });
    }

    // User-scoped commands route to a different endpoint derived from the
    // configured siege ingest URL. Same token, same dedup, just a
    // different destination.
    for (const command of USER_COMMANDS) {
      proxy.on(command, (req, resp) => {
        const c = cfg();
        if (!c.enabled) return;
        if (!resp || resp.ret_code !== 0) return;

        const rawCopy = structuredClone(resp);
        if (isDuplicate(command, rawCopy)) return;

        const userUrl = deriveUserApiUrl(c.apiUrl);
        if (!userUrl) {
          proxy.log({
            type: 'warning',
            source: 'plugin',
            name: pluginName,
            message: `${command}: cannot derive user ingest URL from apiUrl — skipped.`,
          });
          return;
        }
        this.upload(proxy, config, req, command, rawCopy, userUrl);
      });
    }

    // Inventory snapshot. Routed to /api/user/storage/import. We listen on
    // the same Com2uS hook surface; this one fires every time the player
    // opens the monster collection screen, so dedup matters more here than
    // on the WGB channel.
    for (const command of STORAGE_COMMANDS) {
      proxy.on(command, (req, resp) => {
        const c = cfg();
        if (!c.enabled) return;
        if (!resp || resp.ret_code !== 0) return;

        const rawCopy = structuredClone(resp);
        if (isDuplicate(command, rawCopy)) return;

        const storageUrl = deriveStorageApiUrl(c.apiUrl);
        if (!storageUrl) {
          proxy.log({
            type: 'warning',
            source: 'plugin',
            name: pluginName,
            message: `${command}: cannot derive storage ingest URL from apiUrl — skipped.`,
          });
          return;
        }
        this.upload(proxy, config, req, command, rawCopy, storageUrl);
      });
    }

    // Account auto-sync, opt-in. Routed to /api/user/account/sync.
    for (const command of ACCOUNT_COMMANDS) {
      proxy.on(command, (req, resp) => {
        const c = cfg();
        if (!c.enabled || !c.autoSyncAccount) return;
        if (!resp || resp.ret_code !== 0) return;
        this.uploadAccount(proxy, config, resp);
      });
    }

    // Dimension Arena season. Routed to /api/user/dimension-arena/import.
    // Peace keeps only the latest capture per wizard, so dedup is enough to
    // stop the lobby's re-fires from re-posting the same 580 KB.
    for (const command of ARENA_COMMANDS) {
      proxy.on(command, (req, resp) => {
        const c = cfg();
        if (!c.enabled) return;
        if (!resp || resp.ret_code !== 0) return;

        const rawCopy = structuredClone(resp);
        if (isDuplicate(command, rawCopy)) return;

        const arenaUrl = deriveArenaApiUrl(c.apiUrl);
        if (!arenaUrl) {
          proxy.log({
            type: 'warning',
            source: 'plugin',
            name: pluginName,
            message: `${command}: cannot derive arena ingest URL from apiUrl — skipped.`,
          });
          return;
        }
        this.upload(proxy, config, req, command, rawCopy, arenaUrl);
      });
    }
  },

  // Account auto-sync: the login response, trimmed and gzipped, to
  // /api/user/account/sync. Peace answers 200 with `skipped` when it already
  // has a newer or very recent export, 409 when this game account is not the
  // one linked to the Peace account, 422 when the login came back incomplete.
  async uploadAccount(proxy, config, resp) {
    const c = config.Config.Plugins[pluginName] || {};
    const log = (type, message) => proxy.log({ type, source: 'plugin', name: pluginName, message });
    const targetUrl = deriveAccountSyncUrl(c.apiUrl);
    if (!targetUrl || !c.apiToken) {
      log('warning', 'Account auto-sync: missing apiUrl or apiToken — open Plugins settings.');
      return;
    }
    if (!isSafeTarget(targetUrl)) {
      log('error', 'Account auto-sync: the Peace ingest URL must use https, nothing was sent.');
      return;
    }
    const wizardId = resp.wizard_info && resp.wizard_info.wizard_id;
    // SWEX' own export check: Com2uS sometimes answers a login without part of
    // the account. Peace would refuse it anyway; don't send 400 KB for that.
    if (!wizardId || !resp.building_list || !Array.isArray(resp.unit_list)) {
      log(
        'warning',
        'Account auto-sync: incomplete login data, skipped (it fixes itself on the next login).'
      );
      return;
    }
    const last = lastAccountSync.get(wizardId);
    if (last && Date.now() - last < ACCOUNT_MIN_INTERVAL_MS) {
      if (c.debugLog) log('debug', 'Account auto-sync: synced less than 30 minutes ago, skipped.');
      return;
    }

    let rawGz;
    try {
      const json = JSON.stringify(trimLogin(resp));
      rawGz = (await gzip(Buffer.from(json, 'utf-8'))).toString('base64');
    } catch (err) {
      log('error', `Account auto-sync: could not pack the login data (${err.message}).`);
      return;
    }

    try {
      const res = await axios.post(
        targetUrl,
        {
          version: 1,
          type: 'HubUserLogin',
          wizardId,
          capturedAt: Math.floor(Date.now() / 1000),
          rawGz,
        },
        {
          headers: { Authorization: `Bearer ${c.apiToken}`, 'Content-Type': 'application/json' },
          timeout: 60000,
          maxBodyLength: 8 * 1024 * 1024,
          validateStatus: (s) => s >= 200 && s < 300,
        }
      );
      const body = res.data || {};
      if (body.skipped === 'too_soon') {
        lastAccountSync.set(wizardId, Date.now());
        log('info', 'Account auto-sync: Peace already has a recent copy, skipped.');
        return;
      }
      if (body.skipped === 'stale') {
        log('info', 'Account auto-sync: Peace already has a newer copy, skipped.');
        return;
      }
      lastAccountSync.set(wizardId, Date.now());
      const counts = [
        body.units != null ? `monsters=${body.units}` : null,
        body.runes != null ? `runes=${body.runes}` : null,
        body.artifacts != null ? `artifacts=${body.artifacts}` : null,
      ]
        .filter(Boolean)
        .join(' ');
      log('success', `Account synced to Peace${counts ? ' · ' + counts : ''}`);
      if (body.foreignGuild) {
        log(
          'warning',
          'Account auto-sync: this account is in a guild Peace does not track, your guild roster was not updated.'
        );
      }
    } catch (err) {
      const status = err.response && err.response.status;
      const data = (err.response && err.response.data) || {};
      // A refusal will not change on the next reconnection: wait the same
      // 30 minutes before sending 400 KB again.
      if (status === 401 || status === 403 || status === 409) {
        lastAccountSync.set(wizardId, Date.now());
      }
      if (status === 403 && data.error === 'account_inactive') {
        log(
          'error',
          'Account auto-sync: your Peace account is no longer active in your guild, not synced.'
        );
      } else if (status === 401) {
        log(
          'error',
          'Peace rejected the API token. Generate a new one in Peace › Profile › SWEX plugin token.'
        );
      } else if (status === 403) {
        log(
          'error',
          'Account auto-sync needs a personal token (Peace › Profile › SWEX plugin token), not a guild token.'
        );
      } else if (status === 409 && data.error === 'wizard_unknown') {
        log(
          'warning',
          'Account auto-sync: upload your JSON once on Peace to link this game account, then auto-sync takes over.'
        );
      } else if (status === 409 && data.error === 'wizard_mismatch') {
        log(
          'warning',
          'Account auto-sync: this game account is not the one linked to your Peace account, not synced.'
        );
      } else if (status === 422) {
        log(
          'warning',
          'Account auto-sync: incomplete login data, Peace kept your previous copy (it fixes itself on the next login).'
        );
      } else {
        const detail = data.message || data.error || err.message || 'unknown error';
        log('error', `Account auto-sync failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
      }
    }
  },

  async upload(proxy, config, req, command, rawResp, targetUrl) {
    const c = config.Config.Plugins[pluginName] || {};
    if (!targetUrl || !c.apiToken) {
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
      contextSeason: this._contextSeason,
      raw: rawResp,
    };

    try {
      const res = await axios.post(targetUrl, payload, {
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
        body.seasonId ? `arena season ${body.seasonId}` : null,
        body.monsters != null && body.seasonId ? `monsters=${body.monsters}` : null,
        body.runes != null && body.seasonId ? `runes=${body.runes}` : null,
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
          message: `Peace rejected the API token. Generate a new one in Peace › Profile › SWEX plugin token.`,
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
