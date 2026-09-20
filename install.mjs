/**
 * Install dsh-websearch-direct into the "web" profile.
 *
 * Copies the plugin into the profile's node_modules and registers it as the
 * LAST bundle so its cordis patch wins over dsh-web-search-free's repoint of
 * the web seam. Does NOT run pnpm install — the plugin is already on disk, so
 * dsh resolves it directly and no network/lockfile surgery is needed.
 *
 * A restart of DSH Desktop is required afterwards: bundle patches are composed
 * once at startup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const HOME = 'C:\\Users\\Administrator\\AppData\\Roaming\\dsh-desktop\\harness';
const PROFILE = path.join(HOME, 'profiles', 'web');
const DEST = path.join(PROFILE, 'node_modules', 'dsh-websearch-direct');
const PKG = path.join(PROFILE, 'package.json');

const log = (s) => console.log(s);

if (!fs.existsSync(PKG)) {
  console.error('profile package.json not found: ' + PKG);
  process.exit(1);
}

// 1. copy plugin (skip dev-only files)
fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.cpSync(SRC, DEST, {
  recursive: true,
  // Ship only what dsh loads: dev-only tests/docs are dropped.
  filter: (p) => !/\.(mjs|md)$/i.test(path.basename(p)),
});
log('[1/3] 插件已复制到 ' + DEST);

// 2. back up then patch package.json
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = PKG + '.bak-websearch-' + stamp;
fs.copyFileSync(PKG, backup);
log('[2/3] package.json 已备份 -> ' + path.basename(backup));

const raw = fs.readFileSync(PKG, 'utf8');
const pkg = JSON.parse(raw);

pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['dsh-websearch-direct'] = '0.1.0';

const dsh = (pkg.dsh = pkg.dsh || {});
const profile = (dsh.profile = dsh.profile || {});
const bundles = (profile.bundles = Array.isArray(profile.bundles) ? profile.bundles : []);
const without = bundles.filter((b) => b !== 'dsh-websearch-direct');
without.push('dsh-websearch-direct'); // last => its patch overrides earlier ones
profile.bundles = without;

fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
log('[3/3] package.json 已更新：dependencies + bundles(末尾)');

log('');
log('bundle 顺序（后者覆盖前者）:');
without.forEach((b, i) => log('  ' + (i + 1) + '. ' + b));
log('');
log('>>> 请重启 DSH Desktop 生效（bundle patch 仅在启动时组合）。');
log('>>> 回滚：把 ' + path.basename(backup) + ' 改回 package.json，并删除 ' + DEST);
