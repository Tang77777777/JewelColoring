import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import JSZip from './vendor/jszip.cjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const input = path.resolve(project, process.argv[2] || 'build/web-mobile');
const output = path.resolve(project, process.argv[3] || 'build/standalone/JewelColoring.html');
const mimeTypes = {
    '.js': 'application/javascript', '.json': 'application/json', '.bin': 'application/octet-stream',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
    '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

async function listFiles(directory, prefix = '') {
    const files = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
        else if (entry.isFile()) files.push(relative);
        else throw new Error(`Unsupported build entry: ${relative}`);
    }
    return files.sort();
}

const files = await listFiles(input);
function one(pattern) {
    const matches = files.filter(file => pattern.test(file));
    if (matches.length !== 1) throw new Error(`Expected one ${pattern}, found ${matches.length}. Rebuild web-mobile first.`);
    return matches[0];
}
const entry = one(/^index(?:\.[a-f\d]+)?\.js$/);
const polyfills = one(/^src\/polyfills\.bundle(?:\.[a-f\d]+)?\.js$/);
const system = one(/^src\/system\.bundle(?:\.[a-f\d]+)?\.js$/);
const importMapPath = one(/^src\/import-map(?:\.[a-f\d]+)?\.json$/);
const settingsPath = one(/^src\/settings(?:\.[a-f\d]+)?\.json$/);
const style = one(/^style(?:\.[a-f\d]+)?\.css$/);
const readJSON = async file => JSON.parse(await fs.readFile(path.join(input, file), 'utf8'));
const settings = await readJSON(settingsPath);
if (settings.engine?.platform !== 'web-mobile' || settings.engine?.debug !== false) {
    throw new Error('Export a release web-mobile build from Cocos Creator first.');
}
if (settings.assets?.server || settings.assets?.remoteBundles?.length || settings.assets?.subpackages?.length) {
    throw new Error('A standalone export requires all bundles to be included locally.');
}
const importMap = await readJSON(importMapPath);
if (Object.keys(importMap).some(key => key !== 'imports')) {
    throw new Error('This exporter expects the standard Cocos import map without scopes or external modules.');
}
for (const [name, target] of Object.entries(importMap.imports)) {
    if (!target.startsWith('.')) throw new Error(`External module is not bundled: ${name}`);
    const relative = path.posix.normalize(path.posix.join(path.posix.dirname(importMapPath), target));
    if (!files.includes(relative)) throw new Error(`Missing module: ${relative}`);
    importMap.imports[name] = './' + relative;
}
const css = await fs.readFile(path.join(input, style), 'utf8');
if (/@import|url\s*\(/i.test(css)) throw new Error('Embed stylesheet dependencies before exporting a single HTML.');
const assets = {};
const contents = [];
const contentIds = new Map();
const archive = new JSZip();
const zipOptions = { date: new Date('2000-01-01T00:00:00Z'), createFolders: false };
const hash = createHash('sha256');
let resourceBytes = 0;
let deduplicatedBytes = 0;
for (const file of files) {
    if (file === 'index.html' || file === style) continue;
    const mime = mimeTypes[path.extname(file)];
    if (!mime) throw new Error(`Unsupported resource type: ${file}`);
    const bytes = await fs.readFile(path.join(input, file));
    const contentKey = mime + ':' + createHash('sha256').update(bytes).digest('hex');
    if (!contentIds.has(contentKey)) {
        const id = contents.length;
        const entry = 'data/' + id;
        contentIds.set(contentKey, id);
        contents.push({ mime, entry });
        archive.file(entry, bytes, zipOptions);
    } else {
        deduplicatedBytes += bytes.length;
    }
    assets[file] = contentIds.get(contentKey);
    resourceBytes += bytes.length;
    hash.update(file).update('\0').update(bytes);
}
hash.update(css);
const manifest = {
    version: 2, engine: settings.CocosEngine, buildHash: hash.digest('hex'),
    entry, polyfills, system, importMap, assets, contents,
};
archive.file('bundle.json', JSON.stringify(manifest), zipOptions);
const compressed = await archive.generateAsync({
    type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 },
});
const payload = compressed.toString('base64');
const runtime = await fs.readFile(new URL('./standalone-runtime.js', import.meta.url), 'utf8');
const zipLibrary = await fs.readFile(new URL('./vendor/jszip.cjs', import.meta.url), 'utf8');
const notices = await fs.readFile(new URL('./vendor/jszip-notices.js', import.meta.url), 'utf8');
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>JewelColoring</title>
  <meta name="viewport" content="width=device-width,user-scalable=no,initial-scale=1,minimum-scale=1,maximum-scale=1">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="format-detection" content="telephone=no">
  <meta name="full-screen" content="yes">
  <meta name="x5-fullscreen" content="true">
  <meta name="360-fullscreen" content="true">
  <meta name="x5-page-mode" content="app">
  <link rel="icon" href="data:,">
  <style>${css.replace(/<\/style/gi, '<\\/style')}</style>
</head>
<body>
  <div id="GameDiv" cc_exact_fit_screen="true">
    <div id="Cocos3dGameContainer">
      <canvas id="GameCanvas" oncontextmenu="event.preventDefault()" tabindex="99"></canvas>
    </div>
  </div>
  <script>${notices}${zipLibrary.replace(/<\/script/gi, '<\\/script')}</script>
  <script id="jewel-bundle" type="application/zip">${payload}</script>
  <script>${runtime.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>
`;
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, html);
console.log(JSON.stringify({
    output, assets: Object.keys(assets).length, uniqueAssets: contents.length,
    resourceBytes, deduplicatedBytes, compressedBytes: compressed.length, bytes: Buffer.byteLength(html),
    sha256: createHash('sha256').update(html).digest('hex'),
}, null, 2));
