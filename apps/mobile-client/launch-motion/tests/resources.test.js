import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

test('both native bundles carry the exact approved textures as origin-safe offline data',()=>{
  const roots=[new URL('../../ios/Astella/LaunchMotion/',import.meta.url),
    new URL('../../android/app/src/main/assets/launch-motion/',import.meta.url)];
  for(const root of roots){
    const manifest=JSON.parse(fs.readFileSync(new URL('artwork-manifest.json',root)));
    assert.equal(Object.keys(manifest).length,6);
    for(const [name,hash] of Object.entries(manifest)){
      const pack=fs.readFileSync(new URL('artwork/'+name+'.js',root),'utf8');
      const prefix='window.AstellaArtwork??={};window.AstellaArtwork['+JSON.stringify(name)+']=';
      assert.ok(pack.startsWith(prefix));
      const uri=JSON.parse(pack.slice(prefix.length,-1));
      assert.ok(uri.startsWith('data:image/png;base64,'));
      const bytes=Buffer.from(uri.slice('data:image/png;base64,'.length),'base64');
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),hash);
    }
    const html=fs.readFileSync(new URL('index.html',root),'utf8');
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(!html.includes('home-content'));
    assert.ok(!html.includes('<button'));
  }
  const stage=fs.readFileSync(new URL('../assets/companion-stage.png',import.meta.url));
  assert.deepEqual([stage.readUInt32BE(16),stage.readUInt32BE(20)],[440,534]);
  for(const path of ['../../ios/Astella/Assets.xcassets/CompanionStage.imageset/companion-stage.png',
    '../../android/app/src/main/res/drawable-nodpi/companion_stage.png']){
    assert.deepEqual(fs.readFileSync(new URL(path,import.meta.url)),stage);
  }
});
