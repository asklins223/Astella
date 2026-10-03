import { describe, expect, it } from "vitest";
import { Matrix4, PerspectiveCamera, Vector3, Vector4 } from "three";
import { CARD_DEPTH, CARD_FACE_WIDTH, CARD_WIDTH, cardFaceProjection, createCardGeometry } from "../candidate-card-geometry";

describe("physical candidate card", () => {
  it("has rounded geometry with real thickness and bevelled edges", () => {
    const geometry = createCardGeometry(5);
    geometry.computeBoundingBox();
    const size = geometry.boundingBox!.getSize(new Vector3());
    expect(size.x).toBeGreaterThan(CARD_WIDTH);
    expect(size.y).toBeGreaterThan(5);
    expect(size.z).toBeGreaterThan(CARD_DEPTH);
    expect(geometry.attributes.normal.count).toBeGreaterThan(100);
    geometry.dispose();
  });

  it.each([[960, 520], [640, 360], [360, 150]])("keeps the DOM face on the GPU plane at viewport %s × %s", (width, height) => {
    const camera = new PerspectiveCamera(32, width / height, .1, 100);
    camera.position.z = 15; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const world = new Matrix4().makeRotationY(-.25);
    for (const faceWidth of [CARD_FACE_WIDTH, width * .82]) for (const back of [false, true]) {
      const projection = cardFaceProjection(camera.projectionMatrix, camera.matrixWorldInverse, world, width, height, 5, back, faceWidth);
      for (const [x, y] of [[0, 0], [faceWidth, 0], [faceWidth / 2, faceWidth * 5 / 8 / 2]]) {
        const projected = new Vector4(x, y, 0, 1).applyMatrix4(projection);
        const unit = CARD_WIDTH / faceWidth;
        const point = new Vector3((back ? -1 : 1) * (x * unit - CARD_WIDTH / 2), 2.5 - y * unit,
          (back ? -1 : 1) * (CARD_DEPTH / 2 + .06)).applyMatrix4(world).project(camera);
        expect(projected.x / projected.w).toBeCloseTo((point.x + 1) * width / 2, 7);
        expect(projected.y / projected.w).toBeCloseTo((1 - point.y) * height / 2, 7);
      }
    }
  });
});
