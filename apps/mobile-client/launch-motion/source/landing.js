import { clamp, fade, travel } from './timeline.js';

export function validTarget(target) {
  return !!target && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(target[key]))
    && target.width > 0 && target.height > 0;
}

// Native sends its real image container in WebView CSS coordinates.
export function companionMatrix({ width, height, artwork, registration, target, progress, reduced }) {
  if (!validTarget(target)) return null;
  const scale = Math.min(width / artwork.w, height / artwork.h);
  const left = (width - artwork.w * scale) / 2, top = (height - artwork.h * scale) / 2;
  const a = registration;
  const from = [a[0][0]*scale, a[1][0]*scale, a[0][1]*scale, a[1][1]*scale,
    left+a[0][2]*scale, top+a[1][2]*scale];
  const fit = Math.min(target.width / 440, target.height / 534);
  const sx = fit * (target.scaleX ?? 1);
  const to = [sx, 0, 0, fit, target.x+target.width/2-440*sx/2,
    target.y+(target.height-534*fit)/2];
  const position = reduced ? 1 : travel((clamp(progress)-.08)/.86);
  return from.map((value, i) => value + (to[i]-value) * position);
}

export function presentCompanion(image, options) {
  const matrix = companionMatrix(options);
  image.style.display = matrix ? 'block' : 'none';
  if (!matrix) return;
  image.style.transform = `matrix(${matrix.join(',')})`;
  image.style.opacity = String(fade(options.progress/.12));
}
