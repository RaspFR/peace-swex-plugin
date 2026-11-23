#!/usr/bin/env node
/**
 * Smoke test — loads the plugin, fires a fake SW response at it and checks
 * that it posts a well-formed payload to a local mock server.
 *
 *   node scripts/smoke-test.js
 */
const http = require('node:http');
const { EventEmitter } = require('node:events');

const plugin = require('../swpl/index.js');

async function withMockServer(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      const result = handler(req, parsed);
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function makeProxy() {
  const emitter = new EventEmitter();
  const logs = [];
  return {
    on: (event, fn) => emitter.on(event, fn),
    emit: (event, ...args) => emitter.emit(event, ...args),
    log: (entry) => logs.push(entry),
    logs,
  };
}

function fakeStatusInfoResponse() {
  return {
    command: 'GetGuildSiegeStatusInfo',
    ret_code: 0,
    season_number: 21,
    season_id: 25,
    season_type: 0,
    season_begin_time: 1774861200,
    season_end_time: 1782507599,
    season_contest_begin_time: 1782723600,
    season_contest_end_time: 1784411999,
  };
}

function fakeBattleLogResponse() {
  return {
    command: 'GetGuildSiegeBattleLog',
    ret_code: 0,
    log_type: 1,
    log_list: [
      {
        guild_info_list: [
          { guild_id: 121293, guild_name: '=PEACE 2=', pos_id: 2, match_score: 17837 },
          { guild_id: 82153, guild_name: 'Quiquik', pos_id: 1, match_score: 9313 },
          { guild_id: 266138, guild_name: 'Reisfarmer', pos_id: 3, match_score: 11127 },
        ],
        battle_log_list: [
          {
            log_type: 1,
            siege_id: 2026040401,
            match_id: 2026040401000023,
            base_number: 8,
            guild_id: 121293,
            guild_name: '=PEACE 2=',
            wizard_id: 104398,
            wizard_name: 'smoke-test-wizard',
            opp_guild_id: 82153,
            opp_guild_name: 'Quiquik',
            opp_wizard_id: 32162,
            opp_wizard_name: 'Rgkr',
            win_lose: 1,
            match_score_var: 15,
            replay_rid_ref: 13439102,
            log_id: 505183,
            log_timestamp: 1776721847,
            view_battle_deck_info: [
              [30315, 28314, 25613],
              [17411, 22213, 16614],
            ],
          },
        ],
        season_type: 1,
      },
    ],
    ts_val: 1234567890,
    tvalue: 1234567890,
    reqid: 'abc-123',
  };
}

async function main() {
  const received = [];
  const { server, url } = await withMockServer((req, body) => {
    received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (req.url === '/api/guild/members/live-sync') {
      return {
        status: 200,
        body: { ok: true, synced: true, joined: ['Newbie'], left: [], renamed: 0, members: 2 },
      };
    }
    return { status: 200, body: { ok: true, matchesUpserted: 1, battlesUpserted: 1 } };
  });

  try {
    const config = {
      Config: {
        Plugins: {
          [plugin.pluginName]: {
            enabled: true,
            apiUrl: `${url}/api/guild/siege/battles/import`,
            apiToken: 'test-token',
            debugLog: true,
          },
        },
      },
    };

    const proxy = makeProxy();
    plugin.init(proxy, config);

    // Feed a Status payload first so the plugin captures the season context.
    // In production the game client always fetches GetGuildSiegeStatusInfo
    // when entering the siege menu, before any BattleLog call, so this
    // mirrors the real ordering.
    const statusReq = {
      command: 'GetGuildSiegeStatusInfo',
      wizard_id: 79141,
      guild_id: 121293,
    };
    proxy.emit(
      'GetGuildSiegeStatusInfo',
      Object.freeze(statusReq),
      Object.freeze(fakeStatusInfoResponse())
    );
    await new Promise((r) => setTimeout(r, 50));

    // Fire a fake event
    const req = { command: 'GetGuildSiegeBattleLog', wizard_id: 79141, guild_id: 121293 };
    const resp = fakeBattleLogResponse();
    proxy.emit('GetGuildSiegeBattleLog', Object.freeze(req), Object.freeze(resp));

    // Wait for axios to flush
    await new Promise((r) => setTimeout(r, 300));

    console.log(`[smoke] captured ${received.length} HTTP request(s)`);
    if (received.length !== 2) throw new Error('Expected 2 uploads (Status + BattleLog)');

    const statusHit = received[0];
    const hit = received[1];
    console.log(`[smoke] method=${hit.method} url=${hit.url}`);
    console.log(`[smoke] auth=${hit.auth}`);
    console.log('[smoke] payload keys:', Object.keys(hit.body));
    console.log('[smoke] payload.type:', hit.body.type);
    console.log('[smoke] payload.version:', hit.body.version);
    console.log('[smoke] payload.wizardId:', hit.body.wizardId);
    console.log('[smoke] payload.guildId:', hit.body.guildId);
    console.log('[smoke] payload.contextMatchId:', hit.body.contextMatchId);
    console.log('[smoke] payload.contextSeason:', JSON.stringify(hit.body.contextSeason));
    console.log('[smoke] raw.command:', hit.body.raw && hit.body.raw.command);

    const errors = [];
    if (hit.method !== 'POST') errors.push(`expected POST, got ${hit.method}`);
    if (hit.url !== '/api/guild/siege/battles/import') errors.push(`unexpected url ${hit.url}`);
    if (hit.auth !== 'Bearer test-token') errors.push(`bad auth header: ${hit.auth}`);
    if (hit.body.version !== 1) errors.push('missing version:1');
    if (statusHit.body.type !== 'GuildSiegeStatusInfo') {
      errors.push(`first upload type should be GuildSiegeStatusInfo, got ${statusHit.body.type}`);
    }
    if (hit.body.type !== 'GuildSiegeBattleLog') errors.push(`bad type: ${hit.body.type}`);
    if (hit.body.contextMatchId !== '2026040401000023') {
      errors.push(`bad contextMatchId: ${hit.body.contextMatchId}`);
    }
    if (!hit.body.raw || hit.body.raw.command !== 'GetGuildSiegeBattleLog') {
      errors.push('missing raw payload');
    }
    // Season context must have been stamped from the earlier Status call and
    // attached to the BattleLog upload.
    const season = hit.body.contextSeason;
    if (!season) {
      errors.push('contextSeason missing on BattleLog upload');
    } else {
      if (season.seasonNumber !== 21) errors.push(`bad seasonNumber: ${season.seasonNumber}`);
      if (season.seasonId !== 25) errors.push(`bad seasonId: ${season.seasonId}`);
      if (season.seasonType !== 0) errors.push(`bad seasonType: ${season.seasonType}`);
      if (season.seasonBeginTime !== 1774861200) {
        errors.push(`bad seasonBeginTime: ${season.seasonBeginTime}`);
      }
      if (season.seasonEndTime !== 1782507599) {
        errors.push(`bad seasonEndTime: ${season.seasonEndTime}`);
      }
    }

    // Test dedup: second identical event within the window should NOT upload.
    proxy.emit('GetGuildSiegeBattleLog', Object.freeze(req), Object.freeze(resp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== 2) {
      errors.push(`dedup failed: got ${received.length} uploads, expected 2`);
    }

    // WGB defense (user-scoped) should route to /api/user/wgb-defense/import,
    // derived from the configured siege URL.
    const wgbReq = { command: 'GetServerGuildWarDefenseDeckList', wizard_id: 79141 };
    const wgbResp = {
      command: 'GetServerGuildWarDefenseDeckList',
      ret_code: 0,
      deck_list: [{ round: 1, unit_id_list: [1, 2, 3], deck_id: 99 }],
      round_unit_list: [[{ pos_id: 1, unit_info: { unit_id: 1, runes: [], artifacts: [] } }]],
    };
    proxy.emit('GetServerGuildWarDefenseDeckList', Object.freeze(wgbReq), Object.freeze(wgbResp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== 3) {
      errors.push(`WGB upload missing: got ${received.length} uploads, expected 3`);
    } else {
      const wgbHit = received[2];
      console.log(`[smoke] WGB url=${wgbHit.url} type=${wgbHit.body.type}`);
      if (wgbHit.url !== '/api/user/wgb-defense/import') {
        errors.push(`WGB url wrong: ${wgbHit.url}`);
      }
      if (wgbHit.body.type !== 'ServerGuildWarDefenseDeckList') {
        errors.push(`WGB type wrong: ${wgbHit.body.type}`);
      }
    }

    // Inventory snapshot (user-scoped) should route to /api/user/storage/import.
    // The Com2uS command uses a lowercase prefix (`getUnitStorageList`); the
    // plugin must still strip it and capitalize for the ingest type.
    const storageReq = { command: 'getUnitStorageList', wizard_id: 79141 };
    const storageResp = {
      command: 'getUnitStorageList',
      ret_code: 0,
      unit_storage_list: [
        { unit_master_id: 10101, class: 3, quantity: 50 },
        { unit_master_id: 11001, class: 3, quantity: 406 },
      ],
    };
    proxy.emit('getUnitStorageList', Object.freeze(storageReq), Object.freeze(storageResp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== 4) {
      errors.push(`Storage upload missing: got ${received.length} uploads, expected 4`);
    } else {
      const storageHit = received[3];
      console.log(`[smoke] storage url=${storageHit.url} type=${storageHit.body.type}`);
      if (storageHit.url !== '/api/user/storage/import') {
        errors.push(`Storage url wrong: ${storageHit.url}`);
      }
      if (storageHit.body.type !== 'UnitStorageList') {
        errors.push(`Storage type wrong: ${storageHit.body.type}`);
      }
      if (!Array.isArray(storageHit.body.raw && storageHit.body.raw.unit_storage_list)) {
        errors.push('Storage payload missing raw.unit_storage_list[]');
      }
    }

    // Dimension Arena season (user-scoped) should route to
    // /api/user/dimension-arena/import with the type Peace expects.
    const arenaReq = { command: 'dimensionarena_getSeasonInfo', wizard_id: 79141, session_key: 'secret' };
    const arenaResp = {
      command: 'dimensionarena_getSeasonInfo',
      ret_code: 0,
      wizard_id: 79141,
      schedule_info: { season_id: 1 },
      default_unit_list: [],
      unit_list: [],
      rune_list: [],
    };
    const before = received.length;
    proxy.emit('dimensionarena_getSeasonInfo', Object.freeze(arenaReq), Object.freeze(arenaResp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== before + 1) {
      errors.push(`Arena upload missing: got ${received.length - before} uploads, expected 1`);
    } else {
      const arenaHit = received[received.length - 1];
      console.log(`[smoke] arena url=${arenaHit.url} type=${arenaHit.body.type}`);
      if (arenaHit.url !== '/api/user/dimension-arena/import') {
        errors.push(`Arena url wrong: ${arenaHit.url}`);
      }
      if (arenaHit.body.type !== 'Dimensionarena_getSeasonInfo') {
        errors.push(`Arena type wrong: ${arenaHit.body.type}`);
      }
      if (JSON.stringify(arenaHit.body).includes('secret')) {
        errors.push('Arena payload leaks the request session key');
      }
    }

    // Account auto-sync: OFF by default, so a login must not upload anything.
    const loginResp = {
      command: 'HubUserLogin',
      ret_code: 0,
      tvalue: 1795207636,
      session_key: 'secret-session',
      session_key_node: 'secret-node',
      account_info: { channel_uid: 1, did: 2 },
      friend_list: [{ wizard_id: 2 }],
      shop_info: { big: true },
      wizard_info: { wizard_id: 79141, wizard_name: 'smoke-test-wizard' },
      unit_list: [{ unit_id: 1, runes: [{ rune_id: 1 }] }],
      runes: [{ rune_id: 2 }],
      artifacts: [],
      building_list: [{ building_master_id: 25 }],
      guild: {
        guild_info: { guild_id: 121293, name: '=PEACE 2=', master_channel_uid: 9 },
        guild_members: { 79141: { wizard_id: 79141, wizard_name: 'x', channel_uid: 9 } },
      },
    };
    const loginReq = { command: 'HubUserLogin' };
    let beforeLogin = received.length;
    proxy.emit('HubUserLogin', Object.freeze(loginReq), Object.freeze(loginResp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== beforeLogin) {
      errors.push('HubUserLogin uploaded while autoSyncAccount is off');
    }

    // Opted in: one upload to /api/user/account/sync, trimmed and gzipped.
    config.Config.Plugins[plugin.pluginName].autoSyncAccount = true;
    proxy.emit('HubUserLogin', Object.freeze(loginReq), Object.freeze(loginResp));
    await new Promise((r) => setTimeout(r, 500));
    if (received.length !== beforeLogin + 1) {
      errors.push(`Account sync missing: got ${received.length - beforeLogin} uploads, expected 1`);
    } else {
      const syncHit = received[received.length - 1];
      console.log(`[smoke] account url=${syncHit.url} type=${syncHit.body.type}`);
      if (syncHit.url !== '/api/user/account/sync') errors.push(`Account url wrong: ${syncHit.url}`);
      if (syncHit.body.type !== 'HubUserLogin') errors.push(`Account type wrong: ${syncHit.body.type}`);
      if (syncHit.body.wizardId !== 79141) errors.push(`Account wizardId wrong: ${syncHit.body.wizardId}`);
      if (syncHit.auth !== 'Bearer test-token') errors.push(`Account auth wrong: ${syncHit.auth}`);
      let login = null;
      try {
        login = JSON.parse(
          require('node:zlib').gunzipSync(Buffer.from(syncHit.body.rawGz, 'base64')).toString('utf-8')
        );
      } catch (e) {
        errors.push(`Account rawGz unreadable: ${e.message}`);
      }
      if (login) {
        for (const k of ['session_key', 'session_key_node', 'account_info', 'friend_list', 'shop_info']) {
          if (k in login) errors.push(`Account payload still carries ${k}`);
        }
        for (const k of ['wizard_info', 'unit_list', 'runes', 'building_list', 'tvalue']) {
          if (!(k in login)) errors.push(`Account payload lost ${k}`);
        }
      }
      if (login && JSON.stringify(login).includes('channel_uid')) {
        errors.push('Account payload still carries a Hive channel_uid');
      }
      if (login && !(login.guild && login.guild.guild_members && login.guild.guild_members['79141'])) {
        errors.push('Account payload lost the guild members');
      }
      if (JSON.stringify(syncHit.body).includes('secret-session')) {
        errors.push('Account payload leaks the session key');
      }
    }

    // A reconnection right after must not upload again.
    beforeLogin = received.length;
    proxy.emit('HubUserLogin', Object.freeze(loginReq), Object.freeze(loginResp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== beforeLogin) {
      errors.push('Account sync re-sent within the 30-minute window');
    }

    // An incomplete login (no building_list) is never sent.
    const { building_list: _drop, ...incomplete } = loginResp;
    const otherWizard = { ...incomplete, wizard_info: { wizard_id: 5, wizard_name: 'x' } };
    proxy.emit('HubUserLogin', Object.freeze(loginReq), Object.freeze(otherWizard));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== beforeLogin) {
      errors.push('Incomplete login was uploaded');
    }

    // A non-local http URL never receives the account (nor the token).
    const savedUrl = config.Config.Plugins[plugin.pluginName].apiUrl;
    config.Config.Plugins[plugin.pluginName].apiUrl = 'http://peace.example/api/guild/siege/battles/import';
    const plainLogin = { ...loginResp, wizard_info: { wizard_id: 777, wizard_name: 'y' } };
    const beforePlain = received.length;
    proxy.emit('HubUserLogin', Object.freeze(loginReq), Object.freeze(plainLogin));
    await new Promise((r) => setTimeout(r, 300));
    config.Config.Plugins[plugin.pluginName].apiUrl = savedUrl;
    if (received.length !== beforePlain) errors.push('Account sent over plain http');
    if (!proxy.logs.some((l) => /must use https/.test(l.message))) {
      errors.push('No log for the refused http URL');
    }

    // Live guild roster: GetGuildSiegeParticipationInfo goes to
    // /api/guild/members/live-sync, reduced to the member list, without Hive ids
    // or the response's defense decks.
    const rosterReq = { command: 'GetGuildSiegeParticipationInfo', wizard_id: 79141, session_key: 'secret-roster' };
    const rosterResp = {
      command: 'GetGuildSiegeParticipationInfo',
      ret_code: 0,
      tvalue: 1795437395,
      participation_info: { guild_id: 121293, siege_id: 1 },
      defense_deck_list: [{ deck_id: 1 }],
      member_info_list: [
        { guild_id: 121293, wizard_id: 79141, grade: 2, channel_uid: 111, country: 'FR', wizard_name: 'smoke-test-wizard', join_timestamp: 1755537950 },
        { guild_id: 121293, wizard_id: 77145, grade: 1, channel_uid: 222, country: 'CI', wizard_name: 'Newbie', join_timestamp: 1795435478 },
      ],
    };
    const beforeRoster = received.length;
    proxy.emit('GetGuildSiegeParticipationInfo', Object.freeze(rosterReq), Object.freeze(rosterResp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== beforeRoster + 1) {
      errors.push(`Roster upload missing: got ${received.length - beforeRoster} uploads, expected 1`);
    } else {
      const rosterHit = received[received.length - 1];
      console.log(`[smoke] roster url=${rosterHit.url} type=${rosterHit.body.type}`);
      if (rosterHit.url !== '/api/guild/members/live-sync') errors.push(`Roster url wrong: ${rosterHit.url}`);
      if (rosterHit.body.type !== 'GuildSiegeParticipationInfo') {
        errors.push(`Roster type wrong: ${rosterHit.body.type}`);
      }
      if (rosterHit.body.wizardId !== 79141) errors.push(`Roster wizardId wrong: ${rosterHit.body.wizardId}`);
      const sent = JSON.stringify(rosterHit.body);
      for (const leak of ['channel_uid', 'secret-roster', 'defense_deck_list', 'country']) {
        if (sent.includes(leak)) errors.push(`Roster payload still carries ${leak}`);
      }
      const members = rosterHit.body.raw && rosterHit.body.raw.member_info_list;
      if (!Array.isArray(members) || members.length !== 2 || members[1].wizard_name !== 'Newbie') {
        errors.push('Roster payload lost the member list');
      }
      if (!rosterHit.body.raw || rosterHit.body.raw.participation_info.guild_id !== 121293) {
        errors.push('Roster payload lost the guild id');
      }
    }
    if (!proxy.logs.some((l) => /Guild roster updated on Peace · \+1 joined \(Newbie\)/.test(l.message))) {
      errors.push('No log line for the roster sync');
    }
    // Opening the siege menu again right after does not send it again.
    const beforeRosterAgain = received.length;
    proxy.emit('GetGuildSiegeParticipationInfo', Object.freeze(rosterReq), Object.freeze(rosterResp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== beforeRosterAgain) errors.push('Roster re-sent within 2 minutes');

    if (errors.length > 0) {
      console.error('[smoke] FAILED:');
      for (const e of errors) console.error('  -', e);
      process.exit(1);
    }

    console.log('[smoke] OK');
    console.log('[smoke] plugin logs:');
    for (const l of proxy.logs) console.log(`  ${l.type}: ${l.message}`);
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
