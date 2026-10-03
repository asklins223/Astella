import { AmbientLight, DirectionalLight, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, Scene, ShadowMaterial, Vector3, WebGLRenderer } from "three";
import { CARD_WIDTH, cardFaceProjection, createCardGeometry } from "./candidate-card-geometry";
import { cardSpringAtRest, stepCardSpring, type CardSpring } from "../../motion/card-spring";
import type { CandidateSceneController, CardSceneMode } from "./candidate-card-spring";

/** A bevelled solid and readable DOM share one camera and one interruptible pose. */
export function createCandidateCardScene(host: HTMLElement, canvas: HTMLCanvasElement,
  front: HTMLElement, back: HTMLElement, onFailure: () => void): CandidateSceneController {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = PCFSoftShadowMap;
  const scene = new Scene(), camera = new PerspectiveCamera(32, 1, .1, 100), held = new Group();
  scene.add(held, new AmbientLight(0xfff4d9, 2));
  const sun = new DirectionalLight(0xffffff, 3.5);
  sun.position.set(-7, 10, 12); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12; sun.shadow.camera.right = 12; sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
  sun.shadow.normalBias = .025; sun.shadow.bias = -.0001; scene.add(sun);
  const rim = new DirectionalLight(0xb9d3ad, 1.4); rim.position.set(8, -2, 6); scene.add(rim);
  const paper = new MeshPhysicalMaterial({ color: 0xfff2cf, roughness: .54, metalness: .02, clearcoat: .25, clearcoatRoughness: .55 });
  const edge = new MeshStandardMaterial({ color: 0xb98c59, roughness: .72 });
  const mint = new MeshStandardMaterial({ color: 0xb9d3ad, roughness: .7 });
  let cardHeight = 5, faceWidth = 760, geometry = createCardGeometry(cardHeight);
  const card = new Mesh(geometry, [paper, edge]); card.castShadow = true; card.receiveShadow = true; held.add(card);
  const under = [-1, 1].map((side, index) => {
    const sheet = new Mesh(geometry, [index === 0 ? mint : paper, edge]);
    sheet.position.set(side * .16, -.12 - index * .05, -.28 - index * .28);
    sheet.rotation.set(.06, -.1, side * .06); sheet.castShadow = true; sheet.receiveShadow = true;
    scene.add(sheet); return sheet;
  });
  const shadow = new Mesh(new PlaneGeometry(28, 20), new ShadowMaterial({ opacity: .28 }));
  shadow.position.z = -1.2; shadow.receiveShadow = true; scene.add(shadow);
  const normal = new Vector3();
  const tracks: CardSpring[] = [0, 0, 0, 0].map(position => ({ position, velocity: 0 }));
  const targets = [0, 0, 0, 0]; // flip, tilt X, tilt Y, arrival lift (world coordinates)
  let mode: CardSceneMode = "full", frame = 0, lastTime = 0, disposed = false, width = 1, height = 1;

  const project = (face: HTMLElement, isBack: boolean) => {
    const matrix = cardFaceProjection(camera.projectionMatrix, camera.matrixWorldInverse, held.matrixWorld, width, height, cardHeight, isBack, faceWidth);
    face.style.transform = `matrix3d(${matrix.elements.join(",")})`;
    normal.set(0, 0, isBack ? -1 : 1).transformDirection(held.matrixWorld);
    face.style.visibility = normal.z > 0 ? "visible" : "hidden";
  };
  const draw = (time: number) => {
    frame = 0;
    if (disposed) return;
    const dt = Math.min(.032, Math.max(.001, (time - lastTime) / 1000)); lastTime = time;
    tracks.forEach((track, index) => {
      tracks[index] = mode === "full" ? stepCardSpring(track, targets[index], dt, index === 0 ? 370 : 460, index === 0 ? 36 : 34) : { position: targets[index], velocity: 0 };
      if (cardSpringAtRest(tracks[index], targets[index])) tracks[index] = { position: targets[index], velocity: 0 };
    });
    held.position.set(0, tracks[3].position, Math.abs(tracks[3].position) * .45);
    held.rotation.set((mode === "full" ? .075 : 0) + tracks[1].position, tracks[0].position + (mode === "full" ? -.12 : 0) + tracks[2].position, mode === "full" ? -.015 : 0);
    held.updateMatrixWorld(true); project(front, false); project(back, true);
    try { renderer.render(scene, camera); } catch { onFailure(); return; }
    if (tracks.some((track, index) => !cardSpringAtRest(track, targets[index]))) requestDraw();
  };
  function requestDraw() { if (!frame && !disposed) { lastTime = performance.now(); frame = requestAnimationFrame(draw); } }
  const resize = () => {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    const aspect = Math.max(1.25, Math.min(2.5, width / height)); cardHeight = CARD_WIDTH / aspect;
    const next = createCardGeometry(cardHeight); card.geometry = next; under.forEach(sheet => { sheet.geometry = next; }); geometry.dispose(); geometry = next;
    renderer.setSize(width, height, false); camera.aspect = width / height;
    const tan = Math.tan(camera.fov * Math.PI / 360);
    camera.position.z = Math.max(cardHeight / (2 * tan), CARD_WIDTH / (2 * tan * camera.aspect)) * 1.12 + .35;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    // Keep one DOM pixel approximately one visible pixel at every window size
    // and zoom. Long content scrolls; fitting the card never shrinks its text.
    faceWidth = CARD_WIDTH * height / (2 * tan * camera.position.z);
    front.style.width = back.style.width = `${faceWidth}px`;
    front.style.height = back.style.height = `${faceWidth / aspect}px`;
    requestDraw();
  };
  const observer = new ResizeObserver(resize); observer.observe(host);
  const lost = (event: Event) => { event.preventDefault(); onFailure(); };
  canvas.addEventListener("webglcontextlost", lost); resize();
  return {
    setBack(back) { targets[0] = back ? Math.PI : 0; requestDraw(); },
    setMode(next) { mode = next; if (next !== "full") targets[1] = targets[2] = targets[3] = 0; requestDraw(); },
    arrive() { if (mode === "full") tracks[3].position = .3; requestDraw(); },
    tilt(x, y, dragging = false) { if (mode !== "full") return; const amount = dragging ? .65 : .12; targets[1] = (y - .5) * amount; targets[2] = (x - .5) * amount * 1.6; requestDraw(); },
    resetTilt() { targets[1] = targets[2] = 0; requestDraw(); },
    depart(decision) { if (mode === "full") tracks[3].velocity += decision === "keep" ? -.6 : .4; requestDraw(); },
    destroy() {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); canvas.removeEventListener("webglcontextlost", lost);
      geometry.dispose(); paper.dispose(); edge.dispose(); mint.dispose(); shadow.geometry.dispose(); (shadow.material as ShadowMaterial).dispose();
      renderer.dispose(); renderer.forceContextLoss();
      for (const face of [front, back]) for (const name of ["transform", "visibility", "width", "height"]) face.style.removeProperty(name);
    },
  };
}
