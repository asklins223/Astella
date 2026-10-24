import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Both renderers consume these ordinary Cubism files. Dependencies belong in
// the assets, so native and desktop cannot disagree about which props to show.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../src/renderer/public/assets/companion/live2d-v3/whale');
const check = process.argv.includes('--check');
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
function save(path, value) {
  saveText(path, JSON.stringify(value, null, 2) + '\n');
}
function saveText(path, text) {
  const target = resolve(root, path);
  if (check) {
    if (readFileSync(target, 'utf8') !== text) throw new Error(`Outdated companion asset: ${path}`);
  } else {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}
const expressionFiles = {
  'side-ponytail': '单边马尾', 'headband-off': '头箍', 'parfait-hidden': '巴菲',
  'phone-pink': '手机换色', 'ketchup-squeeze': '挤', 'board-undo': '撤回',
  'board-eraser': '橡皮', 'dark-tablecloth': '深色桌布', 'board-press': '点菜按下',
  'board-pen': '画笔', omelet: '蛋包饭', drink: '魔爪',
  'drink-white': '魔爪换色', 'whale-on-desk': '鲸鱼放桌上',
};
const dependencies = {
  'phone-pink': [{ Id: 'phone', Value: 1, Blend: 'Add' }],
  'ketchup-squeeze': read('expressions/蛋包饭.exp3.json').Parameters,
  'drink-white': read('expressions/魔爪.exp3.json').Parameters,
  'whale-on-desk': read('expressions/鲸鱼.exp3.json').Parameters,
};
const model = read('c_0120.model3.json');
for (const [name, file] of Object.entries(expressionFiles)) {
  const original = `expressions/${file}.exp3.json`;
  let path = original;
  if (dependencies[name]) {
    path = `presets/${name}.exp3.json`;
    save(path, { ...read(original), Parameters: [...dependencies[name], ...read(original).Parameters] });
  }
  const existing = model.FileReferences.Expressions.find(entry => entry.Name === name);
  if (existing) existing.File = path;
  else model.FileReferences.Expressions.push({ Name: name, File: path });
}

// The author's complete two missing clips. Loop is the runtime choice: only
// Idle repeats; all performances must give the character back to the learner.
for (const [group, file] of [['PhoneOpen', 'phone-open'], ['Ketchup', 'ketchup']]) {
  model.FileReferences.Motions[group] = [{ File: `motions/${file}.motion3.json`, FadeInTime: 0.3, FadeOutTime: 0.4 }];
}
for (const [group, clips] of Object.entries(model.FileReferences.Motions)) {
  if (group === 'TakingNotes') continue;
  for (const clip of clips) {
    const source = readFileSync(resolve(root, clip.File), 'utf8');
    saveText(clip.File, source.replace(/("Loop"\s*:\s*)(true|false)/, `$1${group === 'Idle'}`));
  }
}

// The board's hand controls were previously driven only by VTube mouse input.
// Short, bounded paths let the same authored rig write on either client.
const duration = 6;
function curve(id, points) {
  return { Target: 'Parameter', Id: id, Segments: [points[0][0], points[0][1], ...points.slice(1).flatMap(([time, value]) => [0, time, value])] };
}
function noteMotion(expressions, whaleOnDesk, happy) {
  const constants = new Map([['point', 1], ['danbaofan', 0], ['phone', 0], ['phone7', 0], ['maoshou', 0], ['jingyu', 1], ['fangzhuoshang', whaleOnDesk ? 1 : 0], ['ParamMouthOpenY', happy ? 0.2 : 0]]);
  if (happy) {
    constants.set('ParamEyeLOpen', 0); constants.set('ParamEyeROpen', 0); constants.set('ParamMouthForm', 1);
  }
  for (const name of expressions) {
    for (const write of read(`expressions/${name}.exp3.json`).Parameters) {
      if (write.Blend === 'Add' && write.Value !== 0) constants.set(write.Id, write.Value);
    }
  }
  const curves = [...constants].map(([id, value]) => curve(id, [[0, value], [duration, value]]));
  curves.push(
    curve('pointX', [[0, 0], [0.4, -3], [1.1, 3], [1.5, -2], [2.1, 3], [2.5, -3], [3.2, 3], [3.6, -2], [4.3, 2], [5.3, 0], [6, 0]]),
    curve('pointY', [[0, 0], [0.4, -2], [1.1, 1], [1.5, -1], [2.1, 2], [2.5, 0], [3.2, 2], [3.6, -1], [4.3, 1], [5.3, 0], [6, 0]]),
    curve('pointZ', [[0, 0], [0.4, 1], [1.1, 1], [1.4, 0], [1.7, 1], [2.1, 1], [2.4, 0], [2.7, 1], [3.2, 1], [3.5, 0], [3.8, 1], [4.3, 1], [4.6, 0], [6, 0]]),
  );
  const segments = curves.reduce((sum, item) => sum + (item.Segments.length - 2) / 3, 0);
  return { Version: 3, Meta: { Duration: duration, Fps: 30, Loop: false, AreBeziersRestricted: true,
    CurveCount: curves.length, TotalSegmentCount: segments, TotalPointCount: segments + curves.length, UserDataCount: 0, TotalUserDataSize: 0 }, Curves: curves };
}
const noteVariants = [
  ['taking-notes', [], true, false],
  ['taking-notes-happy', ['单边马尾', '头箍'], false, true],
  ['taking-notes-glasses', ['单边马尾', '头箍', '方眼镜'], false, false],
];
model.FileReferences.Motions.TakingNotes = noteVariants.map(([name, expressions, onDesk, happy]) => {
  const file = `motions/${name}.motion3.json`;
  save(file, noteMotion(expressions, onDesk, happy));
  return { File: file, FadeInTime: 0.3, FadeOutTime: 0.4 };
});
save('c_0120.model3.json', model);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
const manifest = read('manifest.json');
manifest.runtime.motions = Object.fromEntries(Object.entries(model.FileReferences.Motions).map(([group, clips]) =>
  [group, `/assets/companion/live2d-v3/whale/${clips[0].File}`]));
manifest.fileSha256 = Object.fromEntries(walk(root).map(path => relative(root, path)).filter(path =>
  !['manifest.json', 'README.md'].includes(path) && !path.startsWith('.')).sort().map(path =>
  [path, createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')]));
save('manifest.json', manifest);
console.log(`${check ? 'Verified' : 'Updated'} shared companion assets: ${model.FileReferences.Expressions.length} expressions, ${Object.values(model.FileReferences.Motions).flat().length} motions.`);
