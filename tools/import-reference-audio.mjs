import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import ts from 'typescript';

const directory = process.argv[2];
if (!directory) throw Error('Usage: node tools/import-reference-audio.mjs <unpacked-reference-directory>');
const root = path.resolve(new URL('..', import.meta.url).pathname);
const mapping = {
  Gem_pickup: ['pick'],
  Gem_store_place: ['store'],
  Gem_othregion_place_single: ['place'],
  Gem_othregion_place: ['group'],
  Gem_store_move: ['refill'],
  Gem_success: ['color', 'win'],
  Gem_Bgm_ingame_play: ['bgm'],
};
const hash = buffer => createHash('sha256').update(buffer).digest('hex');

function audioFiles(variant) {
  const html = fs.readFileSync(path.join(directory, `playable-${variant}.html`), 'utf8');
  const marker = 'window.__res=';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, 'Reference must contain its embedded resource table');
  const end = html.indexOf('</script>', start);
  assert.ok(end > start);
  // Parse the resource table as data; never execute the reference's scripts.
  const script = ts.createSourceFile('resources.js', html.slice(start, end), ts.ScriptTarget.Latest, true);
  const statement = script.statements[0];
  assert.ok(ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression));
  const resources = JSON.parse(statement.expression.right.getText(script));
  const clips = new Map();
  for (const [file, text] of Object.entries(resources)) {
    if (!file.includes('/import/') || !file.endsWith('.json')) continue;
    const data = JSON.parse(text);
    if (data[3]?.[0]?.[0] !== 'cc.AudioClip') continue;
    const [, name, extension, duration] = data[5][0];
    if (!(name in mapping)) continue;
    const native = file.replace('/import/', '/native/').replace(/\.json$/, extension);
    const encoded = resources[native] ?? fs.readFileSync(path.join(directory, `playable-${variant}`, native), 'utf8');
    const match = /^data:audio\/[^;,]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(encoded);
    assert.ok(match, `Missing audio data: ${name}`);
    const bytes = Buffer.from(match[1], 'base64');
    assert.ok(bytes.length > 100);
    clips.set(name, { bytes, duration, sha256: hash(bytes) });
  }
  assert.equal(clips.size, Object.keys(mapping).length);
  return clips;
}

const a = audioFiles('a'), b = audioFiles('b');
const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'jewel-reference-audio-'));
const originals = path.join(root, 'source-art/reference-audio');
const report = { conversion: 'Effects: PCM 16-bit WAV without filters; music: original MP3 bytes', sounds: [] };
try {
  for (const [name, destinations] of Object.entries(mapping)) {
    const clip = a.get(name);
    assert.equal(clip.sha256, b.get(name).sha256, `${name}: A/B audio must match`);
    const extension = name === 'Gem_Bgm_ingame_play' ? '.mp3' : '.wav';
    const file = path.join(staged, name + extension);
    if (extension === '.mp3') fs.writeFileSync(file, clip.bytes);
    else {
      const result = spawnSync(process.env.FFMPEG || 'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'pcm_s16le', '-y', file],
        { input: clip.bytes, encoding: 'buffer' });
      if (result.error) throw result.error;
      assert.equal(result.status, 0, result.stderr?.toString());
    }
    report.sounds.push({ source: name, destinations, extension, seconds: clip.duration,
      referenceSha256: clip.sha256, outputSha256: hash(fs.readFileSync(file)), identicalAcrossAB: true });
  }
  fs.mkdirSync(originals, { recursive: true });
  for (const item of report.sounds) {
    fs.writeFileSync(path.join(originals, item.source + '.mp3'), a.get(item.source).bytes);
    for (const destination of item.destinations) {
      fs.copyFileSync(path.join(staged, item.source + item.extension),
        path.join(root, 'assets/resources/audio', destination + item.extension));
    }
  }
  const output = path.join(root, 'docs/verification/reference-audio-import.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  fs.rmSync(staged, { recursive: true, force: true });
}
