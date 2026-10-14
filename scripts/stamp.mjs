// Cache-busting: gives every JS/CSS file a content-hash version so browsers and the service
// worker always load the latest code after a deploy, while unchanged files stay cached.
//
//   node scripts/stamp.mjs        (or: npm run stamp)
//
// Updates, in place:
//   index.html  – ?v=<hash> on the CSS links and main script, the import map (so module
//                 imports like './util.js' also get versioned URLs), and <meta name="app-version">
//   sw.js       – VERSION (names the offline cache) and the precache list
//   version.json – the current version; the app polls it to offer "New version available"
//
// Safe to run repeatedly: output only changes when a JS/CSS file changes.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const write = (p, s) => writeFileSync(join(root, p), s);
const hash = (s, n = 10) => createHash('sha256').update(s).digest('hex').slice(0, n);

const files = [
  ...readdirSync(join(root, 'css')).filter((f) => f.endsWith('.css')).map((f) => `css/${f}`),
  ...readdirSync(join(root, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
].sort();
const versions = Object.fromEntries(files.map((f) => [f, hash(read(f).replace(/\r\n/g, '\n'))]));
const appVersion = hash(files.map((f) => `${f}:${versions[f]}`).join('|'), 8);
const v = (f) => `${f}?v=${versions[f]}`;

function replaceBlock(text, name, body, file) {
  const re = new RegExp(`(<!-- build:${name} -->|// build:${name})[\\s\\S]*?([ \\t]*)(<!-- /build:${name} -->|// /build:${name})`);
  if (!re.test(text)) throw new Error(`${file}: missing build:${name} markers`);
  return text.replace(re, (_, open, indent, close) => `${open}\n${body}\n${indent}${close}`);
}

/* ---------- index.html ---------- */
let html = read('index.html');
html = html.replace(/(href|src)="((?:css|js)\/[\w.-]+\.(?:css|js))(?:\?v=\w+)?"/g, (m, attr, f) => (versions[f] ? `${attr}="${v(f)}"` : m));
html = html.replace(/<meta name="app-version" content="[^"]*">/, `<meta name="app-version" content="${appVersion}">`);
const jsFiles = files.filter((f) => f.startsWith('js/'));
const importMap = { imports: Object.fromEntries(jsFiles.map((f) => [`./${f}`, `./${v(f)}`])) };
html = replaceBlock(html, 'importmap', `  <script type="importmap">\n${JSON.stringify(importMap, null, 2).replace(/^/gm, '  ')}\n  </script>`, 'index.html');
write('index.html', html);

/* ---------- sw.js ---------- */
let sw = read('sw.js');
sw = replaceBlock(sw, 'version', `const VERSION = '${appVersion}';`, 'sw.js');
const shell = ['./', './index.html', './manifest.webmanifest', './data/trips.json', './icons/favicon-64.png', './icons/logo.webp', ...files.map((f) => `./${v(f)}`)];
sw = replaceBlock(sw, 'shell', `const SHELL = ${JSON.stringify(shell, null, 2).replace(/"/g, "'")};`, 'sw.js');
write('sw.js', sw);

/* ---------- version.json ---------- */
write('version.json', `${JSON.stringify({ version: appVersion }, null, 2)}\n`);

console.log(`GoWander ${appVersion}`);
for (const f of files) console.log(`  ${f.padEnd(24)} ?v=${versions[f]}`);
