#!/usr/bin/env node
/**
 * Build pipeline for the Peace SWEX plugin.
 *
 *   1. Read version from swpl/package.json
 *   2. Package swpl/ into dist/swpl.asar
 *   3. Generate dist/swpl.yml with the sha512 hash (required by SWEX' updater)
 *
 * The .yml is committed alongside the .asar so GitHub raw URLs can serve it
 * directly:
 *    https://raw.githubusercontent.com/RaspFR/peace-swex-plugin/main/dist/swpl.yml
 *    https://raw.githubusercontent.com/RaspFR/peace-swex-plugin/main/dist/swpl.asar
 *
 * Run:  node scripts/build.js
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'swpl');
const DIST = path.join(ROOT, 'dist');
const ASAR_OUT = path.join(DIST, 'swpl.asar');
const YML_OUT = path.join(DIST, 'swpl.yml');

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'));
  if (!pkg.version) throw new Error('swpl/package.json is missing a "version" field');
  return pkg.version;
}

async function main() {
  const version = readVersion();
  console.log(`[build] packaging swpl v${version}`);

  fs.mkdirSync(DIST, { recursive: true });

  // @electron/asar handles ignoring node_modules/.bin etc. by default; we
  // just pass the source dir.
  await asar.createPackage(SRC, ASAR_OUT);
  const buf = fs.readFileSync(ASAR_OUT);
  const sha512 = crypto.createHash('sha512').update(buf).digest('hex');
  const size = buf.length;
  console.log(`[build] wrote ${path.relative(ROOT, ASAR_OUT)} (${size} bytes)`);

  // SWEX schema (validated by yup on their side):
  //   version (semver), file, url (https, .asar), sha512 (hex), size (int), releaseDate
  const yml = [
    `version: ${version}`,
    `file: swpl.asar`,
    `url: https://github.com/RaspFR/peace-swex-plugin/releases/download/v${version}/swpl.asar`,
    `sha512: ${sha512}`,
    `size: ${size}`,
    `releaseDate: ${new Date().toISOString()}`,
    '',
  ].join('\n');

  fs.writeFileSync(YML_OUT, yml);
  console.log(`[build] wrote ${path.relative(ROOT, YML_OUT)}`);
  console.log('[build] done.');
}

main().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
