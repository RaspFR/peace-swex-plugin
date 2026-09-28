# swpl — Peace SWEX plugin

Streams Summoners War **Guild Siege** data (battle logs, match-ups, defense decks, member contributions) from your game client to [Peace](https://www.swpeace.fr), so guild leaders can review offense/defense results, win rates, and opponent strategies from a web dashboard.

Runs as a plugin for [sw-exporter (SWEX)](https://github.com/Xzandro/sw-exporter).

## What it captures

The plugin listens to the game's API responses while SWEX runs as a proxy and relays the ones below to Peace. Nothing is sent until you open the matching screen in game.

**Guild siege** (sent to `/api/guild/siege/battles/import`):

| SW API command                          | When it fires                  | What Peace does with it                                         |
| --------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| `GetGuildSiegeMatchupInfo`              | Siege map of the current match | Match snapshot: guilds, scores, bases, defense decks, live map  |
| `GetGuildSiegeMatchupInfoForFinished`   | Siege map of a finished match  | Same, and marks the match complete                              |
| `GetGuildSiegeBaseDefenseUnitList`      | Opening a tower (any guild's)  | Trio of every defense on that tower, for the live map (v1.4.0+) |
| `GetGuildSiegeBattleLog`                | Offense / defense battle log   | Every battle of the match, with both trios                      |
| `GetGuildSiegeBattleLogByWizardId`      | One member's battle log        | Same, scoped to that member                                     |
| `getGuildSiegeMatchBattleLogSummary_v2` | Battle summary of a match      | Roster of the 3 guilds and battles without trios                |
| `GetGuildSiegeMatchLog`                 | Match history                  | Past matches: scores and final standings                        |
| `GetGuildSiegeContributeList`           | Contribution ranking           | Per-member attack / defense points                              |
| `GetGuildSiegeDefenseDeckByWizardId`    | One member's defense decks     | That member's decks and trios                                   |
| `GetGuildSiegeMemberStatSeasonList`     | Season member stats            | Per-member season win / loss and attacks used                   |
| `GetGuildSiegeRankingInfo`              | Siege ranking                  | Season rank and score snapshot                                  |
| `GetGuildSiegeStatusInfo`               | Siege screen                   | Current season, attached to the other uploads                   |
| `GetGuildSiegeParticipatedSiegeIdList`  | Siege screen                   | Context only                                                    |

**Your own account** (needs a personal token, see [Installation](#installation)):

| SW API command                     | Sent to                        | What Peace does with it                                           |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `GetServerGuildWarDefenseDeckList` | `/api/user/wgb-defense/import` | Your World Guild Battle defense (v1.2.0+)                         |
| `getUnitStorageList`               | `/api/user/storage/import`     | Your monster count per species, Sealed Shrines included (v1.3.0+) |

Both user endpoints are derived from the configured ingest URL, so a self-hosted Peace only needs that one setting.

## Installation

1. **Install SWEX** if you don't have it yet: <https://github.com/Xzandro/sw-exporter/releases>
2. **Generate your API token** on [swpeace.fr](https://www.swpeace.fr): open your profile, section **SWEX plugin token**, and click **Generate token**. Copy it: it is shown once. Your Peace account must belong to a guild, and generating a new token revokes the previous one.
   - Guild admins can also create a shared guild token at `/admin/tokens`. It covers the siege data only: the World Guild Battle defense and monster storage uploads need a personal token.
3. **Download `swpl.asar`** from the [latest release](https://github.com/RaspFR/peace-swex-plugin/releases/latest)
4. **Drop** `swpl.asar` into the SWEX plugins folder:
   - Default: `%USERPROFILE%\Desktop\SW Exporter Files\plugins\` on Windows
   - Or open SWEX and check `Settings → File path` to confirm
5. **Restart SWEX**
6. **Configure** the plugin under `Settings → Plugins → swpl`:
   - `Peace API token` — paste the token you generated in step 2
   - `Peace ingest URL` — leave the default unless your Peace deployment is self-hosted
7. Open Summoners War and go to the siege screen: SWEX logs each upload in its console (`swpl … uploaded`).

You're done. Siege data shows up on Peace under **Siege → Battles**.

## Configuration

| Setting                              | Default                                                 | Description                                                                                    |
| ------------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `enabled`                            | `true`                                                  | Toggle the plugin without uninstalling it                                                      |
| `Peace ingest URL`                   | `https://www.swpeace.fr/api/guild/siege/battles/import` | The Peace endpoint to post to                                                                  |
| `Peace API token`                    | _(empty)_                                               | Your personal token (Peace profile → SWEX plugin token), or a guild token from `/admin/tokens` |
| `Verbose log (every siege API call)` | `false`                                                 | Also logs skipped duplicates and refused game responses                                        |

## Updating

This plugin supports SWEX' built-in auto-update. As long as `Auto update plugins` is enabled in your SWEX settings, SWEX picks up a new release on its own: accept the restart and you're on the latest build. The `Loaded vX.Y.Z` line in the SWEX console tells you which version runs.

If you prefer to update manually, grab the latest `swpl.asar` from [Releases](https://github.com/RaspFR/peace-swex-plugin/releases) and replace the old file.

## Privacy

- **What leaves your machine**: only the JSON responses of the commands listed above, plus your wizard id and guild id for context. The plugin never uploads your runes, artifacts or full account export: the World Guild Battle defense and the monster storage are the only account data it sends, and only with a personal token.
- **Where it goes**: only the Peace URL you configured. No third-party analytics, no tracking.
- **Authentication**: every upload carries your API token. Revoking it (from your Peace profile, or `/admin/tokens` for admins) stops the plugin from posting, immediately.

## Troubleshooting

| Problem                                                       | Fix                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SWEX logs `Peace rejected the API token`                      | Your token was revoked (a newer one was generated, or your guild changed in Peace) or mistyped. Generate a new one from your Peace profile and paste it back in Settings.                                                                                         |
| SWEX logs `missing apiUrl or apiToken`                        | Open `Settings → Plugins → swpl` and fill both fields.                                                                                                                                                                                                            |
| SWEX logs `upload failed (HTTP 400): Unknown or missing type` | This plugin version sends a command your Peace deployment does not know yet. Harmless: it is ignored until Peace is updated.                                                                                                                                      |
| Nothing gets uploaded                                         | Confirm SWEX is running as proxy (`Start Proxy` button green) and you've actually opened the siege screen in-game.                                                                                                                                                |
| SWEX does not offer the new version                           | Check `Auto update plugins` is on. Enable `Show Debug Messages` in SWEX settings to see why an update was skipped (for example `file hash does not match`), or install the `.asar` from [Releases](https://github.com/RaspFR/peace-swex-plugin/releases) by hand. |
| I see a lot of `duplicate payload … skipped` in logs          | That's the dedup cache, working as intended. It silences the small 10-second burst SWEX emits when you re-open a screen.                                                                                                                                          |

## Development

```bash
# Clone
git clone https://github.com/RaspFR/peace-swex-plugin.git
cd peace-swex-plugin

# Install build tooling
npm install

# Load the plugin, fire fake SW responses at it, check what it posts
npm run smoke-test

# Build swpl.asar + swpl.yml into dist/
npm run build
```

The build script:

1. Runs `npm install --omit=dev` in `swpl/` so the bundled `node_modules/` only contains runtime deps.
2. Packs `swpl/` into `dist/swpl.asar` using `@electron/asar`.
3. Generates `dist/swpl.yml` with the semver, sha512, size and download URL that SWEX needs to verify updates.

CI (`.github/workflows/ci.yml`) runs the smoke test and the build on every push to `main` and every pull request.

### Adding a command

Add it to `BATTLE_COMMANDS` (guild siege) in `swpl/index.js`, or to `USER_COMMANDS` / `STORAGE_COMMANDS` for per-user data. The ingest `type` is the command without its `Get`/`get` prefix and `_vN` suffix (`GetGuildSiegeBaseDefenseUnitList` → `GuildSiegeBaseDefenseUnitList`).

**Deploy Peace first.** Peace must accept the new type (`INGEST_TYPES` in `lib/siege/battlesIngest.ts`) before the plugin ships; otherwise every upload of it gets a 400 until Peace catches up.

### Releasing a new version

SWEX auto-update reads `dist/swpl.yml` on `main` (the `versionURL` in `swpl/index.js`), downloads the `.asar` from the GitHub release `vX.Y.Z`, and checks it against the sha512 in that `.yml`. The `.asar` is **not byte-identical across platforms**: a local Windows build and the release's Ubuntu build have different hashes. The `.yml` on `main` must therefore come from the release itself, or SWEX silently rejects the update.

1. **Bump the version in 3 places**: `swpl/package.json`, `const version` in `swpl/index.js`, and the root `package.json` (`swpl/package-lock.json` follows on the next install). Grep for the old version to be sure.
2. `npm run smoke-test`: check the log says `Loaded vX.Y.Z` with the new version.
3. `npm run build`, then commit and push to `main`.
4. **Tag and push**: `git tag vX.Y.Z && git push origin vX.Y.Z`. The `Release` workflow (`.github/workflows/release.yml`) rebuilds on Ubuntu, checks that the tag matches `swpl/package.json`, and publishes the release with `swpl.asar` and `swpl.yml`. Wait for it (`gh run watch`).
5. **Align `dist/` with the release**, then commit and push:

   ```bash
   curl -sL https://github.com/RaspFR/peace-swex-plugin/releases/download/vX.Y.Z/swpl.asar -o dist/swpl.asar
   curl -sL https://github.com/RaspFR/peace-swex-plugin/releases/download/vX.Y.Z/swpl.yml -o dist/swpl.yml
   git add dist/ swpl/package-lock.json
   git commit -m "chore: align dist/ with vX.Y.Z release artefacts"
   git push
   ```

6. **Verify** that the sha512 in the published `.yml` equals the release `.asar`'s (raw.githubusercontent.com can serve the old `.yml` for a few minutes after the push):

   ```bash
   curl -s https://raw.githubusercontent.com/RaspFR/peace-swex-plugin/main/dist/swpl.yml | grep sha512
   curl -sL https://github.com/RaspFR/peace-swex-plugin/releases/download/vX.Y.Z/swpl.asar | sha512sum
   ```

If the workflow ever fails, publish the release by hand from a local build (`gh release create vX.Y.Z dist/swpl.asar dist/swpl.yml`) and skip step 5: `dist/` already matches.

## Credits

- Inspired by [SWGTLogger](https://github.com/Cerusa/swgt-swex-plugin) by Cerusa.
- Built on top of [sw-exporter](https://github.com/Xzandro/sw-exporter) by Xzandro.

## License

MIT — see [LICENSE](./LICENSE).
