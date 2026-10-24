import { WindowLive2DDriver } from '../src/renderer/src/components/companion/live2d/WindowLive2DDriver';
import { WindowLive2DPerformanceRotation, type WindowLive2DPerformanceCue } from '../src/renderer/src/components/companion/live2d/window-live2d-contract';

const status = document.querySelector<HTMLOutputElement>('#status')!;
const driver = new WindowLive2DDriver({ canvas: document.querySelector<HTMLCanvasElement>('#live2d')!,
  container: document.querySelector<HTMLDivElement>('#stage')!, onStatus: value => { status.textContent = value; } });
// Review-only access to the real driver's catalogue. All button actions still
// enter through its production tap path, including interruption and cleanup.
const review = driver as unknown as {
  performanceRotation: WindowLive2DPerformanceRotation;
  model?: { internalModel?: { coreModel?: { getParameterValueById?: (id: string) => number } } };
};
await driver.init();
const rotation = review.performanceRotation;
const motion = (group: string, index = 0): WindowLive2DPerformanceCue => ({ kind: 'motion', cue: { group, index } });
const expression = (name: string): WindowLive2DPerformanceCue => ({ kind: 'expression', name });
const scenes: Array<[string, WindowLive2DPerformanceCue]> = [
  ['蛋包饭 · 挤番茄酱', motion('Ketchup')],
  ['记笔记 · 鲸鱼在桌上', motion('TakingNotes', 0)],
  ['记笔记 · 笑脸与头顶鲸鱼', motion('TakingNotes', 1)],
  ['记笔记 · 眼镜与头顶鲸鱼', motion('TakingNotes', 2)],
  ['开手机盖', motion('PhoneOpen')], ['粉色手机', expression('phone-pink')],
  ['白色饮料', expression('drink-white')], ['蛋包饭静态场景', expression('omelet')],
];
for (const [label, cue] of scenes) {
  const button = document.createElement('button'); button.textContent = label;
  button.onclick = () => { review.performanceRotation = new WindowLive2DPerformanceRotation([cue]); driver.playInviteOnce(); status.textContent = label; };
  document.querySelector('#scenes')!.append(button);
}
document.querySelector<HTMLButtonElement>('#next')!.onclick = () => { review.performanceRotation = rotation; driver.playInviteOnce(); };
let voice = false, paused = false, bust = false;
document.querySelector<HTMLButtonElement>('#voice')!.onclick = () => { voice = !voice; driver.setVoiceLevel(voice ? 0.7 : 0); };
document.querySelector<HTMLButtonElement>('#pause')!.onclick = () => { paused = !paused; driver.setPaused(paused); };
document.querySelector<HTMLButtonElement>('#framing')!.onclick = () => { bust = !bust; driver.setFraming(bust ? 'bust' : 'full'); };
setInterval(() => {
  const core = review.model?.internalModel?.coreModel;
  document.querySelector('#diagnostics')!.textContent = ['point', 'danbaofan', 'ji', 'jingyu', 'fangzhuoshang', 'ParamCheek72', 'ParamEyeLOpen', 'ParamMouthOpenY']
    .map(id => `${id}: ${core?.getParameterValueById?.(id)?.toFixed(2) ?? '?'}`).join('\n');
}, 250);
window.addEventListener('pagehide', () => driver.destroy(), { once: true });
