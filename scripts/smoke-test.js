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

    // Fire a fake event
    const req = { command: 'GetGuildSiegeBattleLog', wizard_id: 79141, guild_id: 121293 };
    const resp = fakeBattleLogResponse();
    proxy.emit('GetGuildSiegeBattleLog', Object.freeze(req), Object.freeze(resp));

    // Wait for axios to flush
    await new Promise((r) => setTimeout(r, 300));

    console.log(`[smoke] captured ${received.length} HTTP request(s)`);
    if (received.length !== 1) throw new Error('Expected exactly 1 upload');

    const hit = received[0];
    console.log(`[smoke] method=${hit.method} url=${hit.url}`);
    console.log(`[smoke] auth=${hit.auth}`);
    console.log('[smoke] payload keys:', Object.keys(hit.body));
    console.log('[smoke] payload.type:', hit.body.type);
    console.log('[smoke] payload.version:', hit.body.version);
    console.log('[smoke] payload.wizardId:', hit.body.wizardId);
    console.log('[smoke] payload.guildId:', hit.body.guildId);
    console.log('[smoke] payload.contextMatchId:', hit.body.contextMatchId);
    console.log('[smoke] raw.command:', hit.body.raw && hit.body.raw.command);

    const errors = [];
    if (hit.method !== 'POST') errors.push(`expected POST, got ${hit.method}`);
    if (hit.url !== '/api/guild/siege/battles/import') errors.push(`unexpected url ${hit.url}`);
    if (hit.auth !== 'Bearer test-token') errors.push(`bad auth header: ${hit.auth}`);
    if (hit.body.version !== 1) errors.push('missing version:1');
    if (hit.body.type !== 'GuildSiegeBattleLog') errors.push(`bad type: ${hit.body.type}`);
    if (hit.body.contextMatchId !== '2026040401000023') {
      errors.push(`bad contextMatchId: ${hit.body.contextMatchId}`);
    }
    if (!hit.body.raw || hit.body.raw.command !== 'GetGuildSiegeBattleLog') {
      errors.push('missing raw payload');
    }

    // Test dedup: second identical event within the window should NOT upload.
    proxy.emit('GetGuildSiegeBattleLog', Object.freeze(req), Object.freeze(resp));
    await new Promise((r) => setTimeout(r, 300));
    if (received.length !== 1) {
      errors.push(`dedup failed: got ${received.length} uploads, expected 1`);
    }

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
