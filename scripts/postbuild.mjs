// After `vite build`: stamps the release so nobody runs stale code after a deploy.
//   dist/sw.js       – VERSION (names the offline cache) and SHELL (everything the app needs offline)
//   dist/version.json – the current version; the app polls it to offer "New version available"
//   dist/index.html  – <meta name="app-version"> so the running app knows which version it is
// The version is a hash of every built file, so it only changes when the app actually changes.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const read = (p) => readFileSync(join(root, p), 'utf8');
const write = (p, s) => writeFileSync(join(root, p), s);

// Every file in dist, as a ./relative path (source maps and the build manifest stay out).
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const files = walk(root)
  .map((f) => relative(root, f).split(sep).join('/'))
  .filter((f) => !f.endsWith('.map') && !f.startsWith('.vite/') && f !== 'sw.js' && f !== 'version.json')
  .sort();
// Fonts for other alphabets (Cyrillic, Greek, Vietnamese) download only if a page uses them, and
// are cached then; installing the offline copy skips them.
const OTHER_SCRIPTS = /-(cyrillic|cyrillic-ext|greek|greek-ext|vietnamese)-[a-z]+-normal-[^/]*\.woff2$/;

const hash = createHash('sha256');
for (const f of files) hash.update(`${f}\n`).update(readFileSync(join(root, f)));
const version = hash.digest('hex').slice(0, 8);

const shell = ['./', ...files.filter((f) => !OTHER_SCRIPTS.test(f)).map((f) => `./${f}`)];
const sw = read('sw.js')
  .replace(/(\/\/ build:version\n)[\s\S]*?(\n\/\/ \/build:version)/, `$1const VERSION = '${version}';$2`)
  .replace(/(\/\/ build:shell\n)[\s\S]*?(\n\/\/ \/build:shell)/, `$1const SHELL = [\n${shell.map((u) => `  '${u}'`).join(',\n')}\n];$2`);
if (!sw.includes(`const VERSION = '${version}'`)) throw new Error('postbuild: sw.js build markers not found');
write('sw.js', sw);

write('version.json', `${JSON.stringify({ version }, null, 2)}\n`);

const html = read('index.html').replace(/<meta name="app-version" content="[^"]*">/, `<meta name="app-version" content="${version}">`);
if (!html.includes(`content="${version}"`)) throw new Error('postbuild: <meta name="app-version"> not found in index.html');
write('index.html', html);

console.log(`postbuild: version ${version}, ${shell.length} files cached for offline use`);
