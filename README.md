# swpl — Peace SWEX plugin

Streams Summoners War **Guild Siege** data (battle logs, match-ups, defense decks, member contributions) from your game client to [Peace](https://www.swpeace.fr), so guild leaders can review offense/defense results, win rates, and opponent strategies from a web dashboard.

Runs as a plugin for [sw-exporter (SWEX)](https://github.com/Xzandro/sw-exporter).

## What it captures

Every time you open the siege screen in Summoners War, the game fetches fresh data from Com2uS. The plugin intercepts those API responses and relays them to Peace. Captured commands:

| SW API command                          | What it contains                                   |
| --------------------------------------- | -------------------------------------------------- |
| `GetGuildSiegeBattleLog`                | All offense/defense battles of the current match   |
| `GetGuildSiegeBattleLogByWizardId`      | Battle log scoped to one guild member              |
| `GetGuildSiegeMatchupInfo`              | Match snapshot: guilds, bases, defense decks       |
| `GetGuildSiegeMatchLog`                 | History of past matches (scores, final standings)  |
| `GetGuildSiegeContributeList`           | Per-member attack/defense points                   |
| `GetGuildSiegeDefenseDeckByWizardId`    | Detailed defense deck of one member                |
| `GetGuildSiegeParticipatedSiegeIdList`  | List of sieges the guild took part in              |
| `GetGuildSiegeRankingInfo`              | Current siege ranking                              |
| `GetGuildSiegeStatusInfo`               | Current siege status                               |

The plugin **never uploads raw character data, runes, or artifacts** — it only forwards siege-scoped responses.

## Installation

1. **Install SWEX** if you don't have it yet: <https://github.com/Xzandro/sw-exporter/releases>
2. **Generate an API token**
   - Ask your guild's Peace administrator to visit `https://www.swpeace.fr/admin/tokens`
   - Create a new token for your guild, copy the token (shown once)
3. **Download `swpl.asar`** from the [latest release](https://github.com/RaspFR/peace-swex-plugin/releases/latest)
4. **Drop** `swpl.asar` into the SWEX plugins folder:
   - Default: `%USERPROFILE%\Desktop\SW Exporter Files\plugins\` on Windows
   - Or open SWEX and check `Settings → File path` to confirm
5. **Restart SWEX**
6. **Configure** the plugin under `Settings → Plugins → swpl`:
   - `Peace API token` — paste the token you generated in step 2
   - `Peace ingest URL` — leave the default unless your Peace deployment is self-hosted
7. Open Summoners War, go to the siege screen — SWEX will log each upload in its console.

You're done. Siege data shows up at `www.swpeace.fr/guild-management → Siege → Battles`.

## Configuration

| Setting                                       | Default                                                                        | Description                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `enabled`                                     | `true`                                                                         | Toggle the plugin without uninstalling it                                                     |
| `Peace ingest URL`                            | `https://www.swpeace.fr/api/guild/siege/battles/import`                        | The Peace endpoint to post to                                                                 |
| `Peace API token`                             | _(empty)_                                                                      | Your guild's API token — generated via `/admin/tokens` on Peace                               |
| `Verbose log (every siege API call)`          | `false`                                                                        | Enables debug-level logs for skipped duplicates                                               |

## Updating

This plugin supports SWEX' built-in auto-update mechanism. As long as `Auto update plugins` is enabled in your SWEX settings, you'll be prompted when a new version is released — accept the restart and you're on the latest build.

If you prefer to update manually, grab the latest `swpl.asar` from [Releases](https://github.com/RaspFR/peace-swex-plugin/releases) and replace the old file.

## Privacy

- **What leaves your machine**: only the JSON responses of the siege API commands listed above, plus your wizard id and guild id for context.
- **Where it goes**: only the Peace URL you configured. No third-party analytics, no tracking.
- **Authentication**: every upload is signed with your guild's API token. Revoking the token on `/admin/tokens` stops the plugin from posting, immediately.

## Troubleshooting

| Problem                                              | Fix                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| SWEX logs `Peace rejected the API token`             | Your token was revoked or you typed it wrong. Regenerate one at `/admin/tokens` and paste it back in Settings.    |
| SWEX logs `missing apiUrl or apiToken`               | Open `Settings → Plugins → swpl` and fill both fields.                                                            |
| Nothing gets uploaded                                | Confirm SWEX is running as proxy (`Start Proxy` button green) and you've actually opened the siege screen in-game. |
| I see a lot of `duplicate payload … skipped` in logs | That's the dedup cache, working as intended. It silences the small 10-second burst SWEX emits when you re-open a screen. |

## Development

```bash
# Clone
git clone https://github.com/RaspFR/peace-swex-plugin.git
cd peace-swex-plugin

# Install build tooling
npm install

# Build swpl.asar + swpl.yml into dist/
npm run build
```

The build script:

1. Runs `npm install --omit=dev` in `swpl/` so the bundled `node_modules/` only contains runtime deps.
2. Packs `swpl/` into `dist/swpl.asar` using `@electron/asar`.
3. Generates `dist/swpl.yml` with the semver, sha512, size and download URL that SWEX needs to verify updates.

To release a new version:

1. Bump `swpl/package.json`'s `version`.
2. `npm run build`
3. Commit `swpl/package.json` + `dist/swpl.asar` + `dist/swpl.yml`.
4. Create a GitHub release tagged `v<version>` and attach `dist/swpl.asar` as a release asset — the `versionURL` in `index.js` points at `dist/swpl.yml` on `main`, and the `.yml` points at the release asset for the download itself.

## Credits

- Inspired by [SWGTLogger](https://github.com/Cerusa/swgt-swex-plugin) by Cerusa.
- Built on top of [sw-exporter](https://github.com/Xzandro/sw-exporter) by Xzandro.

## License

MIT — see [LICENSE](./LICENSE).
