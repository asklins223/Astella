import { ExtrudeGeometry, Matrix4, Shape } from "three";

export const CARD_WIDTH = 8;
export const CARD_DEPTH = .18;
export const CARD_FACE_WIDTH = 760;

/** An actual rounded, bevelled solid, shared by the held card and the deck. */
export function createCardGeometry(height: number) {
  const w = CARD_WIDTH / 2, h = height / 2, r = .27;
  const shape = new Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h); shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r); shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h); shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r); shape.quadraticCurveTo(-w, -h, -w + r, -h);
  const geometry = new ExtrudeGeometry(shape, { depth: CARD_DEPTH, bevelEnabled: true, bevelThickness: .055, bevelSize: .055, bevelSegments: 3, curveSegments: 12 });
  geometry.translate(0, 0, -CARD_DEPTH / 2);
  return geometry;
}

/** Project the semantic face with the same camera as WebGL, in CSS pixels.
 * Unlike a separate CSS3D camera, this stays registered at browser zoom levels. */
export function cardFaceProjection(projection: Matrix4, view: Matrix4, world: Matrix4,
  width: number, height: number, faceHeight: number, back: boolean) {
  const unit = CARD_WIDTH / CARD_FACE_WIDTH;
  const local = new Matrix4().set(
    back ? -unit : unit, 0, 0, back ? CARD_WIDTH / 2 : -CARD_WIDTH / 2,
    0, -unit, 0, faceHeight / 2,
    0, 0, unit, (back ? -1 : 1) * (CARD_DEPTH / 2 + .06),
    0, 0, 0, 1,
  );
  const screen = new Matrix4().set(width / 2, 0, 0, width / 2, 0, -height / 2, 0, height / 2, 0, 0, 1, 0, 0, 0, 0, 1);
  return screen.multiply(projection).multiply(view).multiply(world).multiply(local);
}
