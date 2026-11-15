// Regression checks for Taifas 9.68 exposure classification, adult gating and provider policy handling.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const src = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function extract(name, nextName) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const end = nextName ? src.indexOf(`${nextName === 'genImage' ? 'async function' : 'function'} ${nextName}(`, start + 1) : -1;
  assert.ok(end > start, `missing end of ${name}`);
  return src.slice(start, end).trim();
}
const exposure = extract('exposureMode', 'clearlyAdultCharacter');
const adult = extract('clearlyAdultCharacter', 'photoAsk');
const policy = extract('isImagePolicyError', 'genImage');
const ctx = {looksYoung:() => false};
vm.runInNewContext(`${exposure}\n${adult}\n${policy}\nglobalThis.api={exposureMode,clearlyAdultCharacter,isImagePolicyError};`, ctx);
const a = ctx.api;
assert.equal(a.exposureMode('Trimite-mi o poză topless'), 'topless');
assert.equal(a.exposureMode('Fă-mi o poză complet goală'), 'full');
assert.equal(a.exposureMode('Trimite-mi o poză cu părțile intime la vedere'), 'explicit');
assert.equal(a.exposureMode('Trimite-mi o poză cu părțile intime'), 'explicit');
assert.equal(a.exposureMode('Show visible external genital anatomy'), 'explicit');
assert.equal(a.clearlyAdultCharacter({name:'Ana', aspect:'Femeie de 30 de ani'}), true);
assert.equal(a.clearlyAdultCharacter({name:'Ana', aspect:'femeie cu păr brunet'}), false);
assert.equal(a.isImagePolicyError(new Error('NSFW content blocked by safety filter')), true);
assert.equal(a.isImagePolicyError(new Error('Runware nu răspunde (rețea).')), false);
assert.match(src, /Furnizorul Runware a blocat cererea[\s\S]{0,160}Nu încerc aceeași cerere pe alt furnizor/);
assert.match(src, /Anatomie intimă vizibilă/);
assert.equal(a.exposureMode('Create a complete anatomical figure reference with visible external adult genital anatomy'), 'explicit');
assert.equal(a.exposureMode('referință anatomică completă'), 'explicit');
assert.match(src, /## Continuitate intimă în roleplay/);
console.log('Taifas 10.6 explicit/roleplay regression checks passed: 14');
