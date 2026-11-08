#!/usr/bin/env node
/**
 * 把「大肥鱼（DeepSeek-chan）免费公皮」原始包整理成桌面端与 iOS 共用的运行时资产。
 *
 * 原始包由用户提供（VTube Studio 目录结构：model3 + moc3 + 纹理 + physics/cdi3 +
 * Exp3/ 表情 + Animation/ 动作），文件名全是中文，且 model3.json 里没有声明表情组、
 * 动作组与口型组。这里只做**规范化**，不改模型内容：
 *
 * - 文件名改成 ASCII（纹理目录、moc3、physics、cdi3、表达式、动作），避免 URL 转义；
 * - model3.json 补 `Expressions`（ASCII 别名 → 中文文件）与 `Motions` 组；
 * - `Groups` 补 EyeBlink（ParamEyeLOpen/ParamEyeROpen）与 LipSync（ParamMouthOpenY）；
 * - `manifest.json` 记录许可、来源、运行时路径与每份文件的 SHA-256。
 *
 * 用法（在 apps/desktop-client 下）：
 *   node scripts/build-companion-fatfish.mjs --source "<原包目录>" [--check]
 *
 * `--check` 只比对本仓库里的资产与按当前规则重建的结果是否一致，不写盘。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src/renderer/public/assets/companion/live2d-v4/fatfish');
const check = process.argv.includes('--check');
const sourceArg = process.argv.indexOf('--source');
const source = sourceArg >= 0 ? resolve(process.argv[sourceArg + 1]) : null;
if (!check && !source) {
  console.error('usage: node scripts/build-companion-fatfish.mjs --source "<原包目录>" [--check]');
  process.exit(2);
}

/** 原包文件名 → 运行时文件名。表情保留语义别名，动作按用途命名。 */
const EXPRESSIONS = {
  '黑脸': 'black-face',
  '流泪': 'crying',
  '圈圈眼': 'dizzy-eyes',
  '爱心眼': 'heart-eyes',
  '＞＜': 'squeezed-eyes',
  '屑屑眼': 'smug-eyes',
  '脸红': 'blush',
  '加载': 'loading',
  '兔牙': 'buck-tooth',
  '钢盆': 'steel-bowl',
  '黑框眼镜': 'glasses-square',
  '单片眼镜': 'monocle',
  '流冷汗': 'cold-sweat',
  '裙子切换': 'skirt-long',
  '胸口衣服': 'chest-cover',
  '脱鞋': 'shoes-off',
  '尾巴开关': 'tail-off',
  '竖食指开': 'point-finger-on',
  '竖食指关': 'point-finger-off',
  '前倾': 'lean-forward',
};
const MOTIONS = {
  'IDLE': { group: 'Idle', file: 'idle.motion3.json', loop: true },
  '举手切默认手': { group: 'RaiseHand', file: 'raise-hand.motion3.json', loop: false },
  '默认手切举手': { group: 'RaiseHandBack', file: 'raise-hand-back.motion3.json', loop: false },
  '竖手指切出来动画': { group: 'PointFinger', file: 'point-finger.motion3.json', loop: false },
  '竖手指切回默认': { group: 'PointFingerBack', file: 'point-finger-back.motion3.json', loop: false },
  '狗尾草切换出来': { group: 'Grass', file: 'grass.motion3.json', loop: false },
  '狗尾草切回默认手': { group: 'GrassBack', file: 'grass-back.motion3.json', loop: false },
};

/** 三种体型节点（Clothes2 取值）。0=原尺寸、0.4=中间档、1=最小形态。 */
const BODY_FORMS = { large: 0, medium: 0.4, small: 1 };

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

const written = new Map();
function emit(relativePath, content) {
  written.set(relativePath, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
}

function normalizeExpression(path) {
  // 表情是「按键」开关式参数（key1…key13 / Clothes1…5 / Movement1…3），
  // 保持作者原样，只重命名文件，不重排参数。
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return `${JSON.stringify(raw, null, 2)}\n`;
}

function normalizeMotion(path, loop) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  // 作者原包里所有动作都标了 Loop:true；只有待机该循环，其余一次性动作
  // 必须交还给学习者，否则姿势与道具会一直挂着。
  if (typeof raw.Meta?.Loop === 'boolean') raw.Meta.Loop = loop;
  return `${JSON.stringify(raw, null, 2)}\n`;
}

if (!check) {
  mkdirSync(outDir, { recursive: true });
}

// 1. 二进制与结构文件：直接搬运，只换名字。
for (const [from, to] of [
  ['大肥鱼.moc3', 'fatfish.moc3'],
  ['大肥鱼.physics3.json', 'fatfish.physics3.json'],
  ['大肥鱼.cdi3.json', 'fatfish.cdi3.json'],
]) {
  if (check) {
    if (!existsSync(join(outDir, to))) throw new Error(`missing runtime asset: ${to}`);
    continue;
  }
  copyFileSync(join(source, from), join(outDir, to));
}

// 2. 纹理：目录名与文件名都改成 ASCII。
const textureDir = 'fatfish.4096';
const sourceTextures = readdirSync(join(source, '大肥鱼.4096')).filter((name) => name.endsWith('.png')).sort();
if (!check) mkdirSync(join(outDir, textureDir), { recursive: true });
for (const name of sourceTextures) {
  if (check) {
    if (!existsSync(join(outDir, textureDir, name))) throw new Error(`missing texture: ${name}`);
    continue;
  }
  copyFileSync(join(source, '大肥鱼.4096', name), join(outDir, textureDir, name));
}

// 3. 表情。
const expressionEntries = [];
for (const [chinese, alias] of Object.entries(EXPRESSIONS)) {
  const sourcePath = join(source, 'Exp3', `${chinese}.exp3.json`);
  if (!existsSync(sourcePath)) throw new Error(`missing expression in source: ${chinese}.exp3.json`);
  const relativePath = `expressions/${alias}.exp3.json`;
  emit(relativePath, normalizeExpression(sourcePath));
  expressionEntries.push({ Name: alias, File: relativePath, Source: `${chinese}.exp3.json` });
}

// 4. 动作。
const motionGroups = {};
for (const [chinese, { group, file, loop }] of Object.entries(MOTIONS)) {
  const sourcePath = join(source, 'Animation', `${chinese}.motion3.json`);
  if (!existsSync(sourcePath)) throw new Error(`missing motion in source: ${chinese}.motion3.json`);
  emit(`motions/${file}`, normalizeMotion(sourcePath, loop));
  (motionGroups[group] ??= []).push({ File: `motions/${file}`, FadeInTime: group === 'Idle' ? 0.5 : 0.3, FadeOutTime: group === 'Idle' ? 0.5 : 0.4 });
}

// 5. model3.json：唯一真话，客户端的模型注册表按它取表情与动作。
const model3 = {
  Version: 3,
  FileReferences: {
    Moc: 'fatfish.moc3',
    Textures: sourceTextures.map((name) => `${textureDir}/${name}`),
    Physics: 'fatfish.physics3.json',
    DisplayInfo: 'fatfish.cdi3.json',
    Expressions: expressionEntries.map(({ Name, File }) => ({ Name, File })),
    Motions: motionGroups,
  },
  Groups: [
    { Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] },
    { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
  ],
  HitAreas: [],
};
emit('fatfish.model3.json', `${JSON.stringify(model3, null, 2)}\n`);

// 6. manifest.json：许可与来源。许可按 Owner 2026-11-05 裁决登记为可商用，
//    与既有 DS鲸鱼娘 一致；作者《使用须知》没有禁止在应用内使用角色形象。
if (!check) {
  const fileSha256 = {};
  for (const [relativePath, bytes] of [...written.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    fileSha256[relativePath] = sha256(bytes);
  }
  for (const name of sourceTextures) {
    const relativePath = `${textureDir}/${name}`;
    fileSha256[relativePath] = sha256(readFileSync(join(outDir, relativePath)));
  }
  for (const name of ['fatfish.moc3', 'fatfish.physics3.json', 'fatfish.cdi3.json']) {
    fileSha256[name] = sha256(readFileSync(join(outDir, name)));
  }
  const manifest = {
    schemaVersion: 1,
    modelId: 'companion-live2d-fatfish-v4',
    displayName: '大肥鱼（DeepSeek-chan · 免费公皮）',
    status: 'production',
    ownerApproved: {
      by: 'Owner',
      date: '2026-11-05',
      note: '用户提供原包并要求接入为可切换形态；三种体型节点拆成三个可选形态，默认最小形态',
    },
    source: {
      origin: 'user-provided archive',
      sourcePath: 'DeepSeek免费公皮/DeepSeek',
      author: '原画及拆分：神宫凉子；Live2D 建模：霓虹猫_NeonNeko',
      usageNotesFile: '使用须知.txt（保存在用户原目录，未随仓库分发）',
    },
    modelLicense: {
      name: '作者免费公开配布许可：允许直播／视频创作与平台收益、允许调整模型参数，禁止重新分发与二次销售',
      acceptanceRequired: true,
      commercialReleaseAllowed: true,
      redistributionAllowed: false,
      usage:
        '作者《使用须知》允许个人直播、视频创作与平台收益、参数调整与个人二创，禁止重新分发模型文件、二次销售与冒充原作者；'
        + 'Owner 2026-11-05 裁决按可商用登记，与既有 DS鲸鱼娘 同一口径。公开署名：原画 神宫凉子 / 建模 霓虹猫_NeonNeko。',
    },
    runtime: {
      model3: '/assets/companion/live2d-v4/fatfish/fatfish.model3.json',
      moc3: '/assets/companion/live2d-v4/fatfish/fatfish.moc3',
      textures: sourceTextures.map((name) => `/assets/companion/live2d-v4/fatfish/${textureDir}/${name}`),
      physics: '/assets/companion/live2d-v4/fatfish/fatfish.physics3.json',
      displayInfo: '/assets/companion/live2d-v4/fatfish/fatfish.cdi3.json',
      motions: Object.fromEntries(Object.entries(motionGroups).map(([group, clips]) => [group, `/assets/companion/live2d-v4/fatfish/${clips[0].File}`])),
    },
    bodyForms: BODY_FORMS,
    fileSha256,
  };
  emit('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
}

// 7. 落盘或校验。
let updated = 0;
for (const [relativePath, bytes] of written) {
  const target = join(outDir, relativePath);
  if (check) {
    if (!existsSync(target)) throw new Error(`missing generated asset: ${relativePath}`);
    if (!readFileSync(target).equals(bytes)) throw new Error(`outdated generated asset: ${relativePath}`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  updated += 1;
}
console.log(
  `${check ? 'Verified' : 'Wrote'} companion fatfish assets: ${expressionEntries.length} expressions, `
  + `${Object.values(motionGroups).flat().length} motions across ${Object.keys(motionGroups).length} groups`
  + `${check ? '' : `, ${updated} regenerated files`}.`,
);
