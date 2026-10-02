import { AmbientLight, DirectionalLight, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PCFSoftShadowMap, PerspectiveCamera, PlaneGeometry, Scene, ShadowMaterial, Vector3, WebGLRenderer } from "three";
import { CARD_FACE_WIDTH, CARD_WIDTH, cardFaceProjection, createCardGeometry } from "./candidate-card-geometry";

export type CardSceneMode = "full" | "lite" | "off";
export type CandidateSceneController = {
  setBack(back: boolean): void;
  setMode(mode: CardSceneMode): void;
  arrive(): void;
  tilt(x: number, y: number, dragging?: boolean): void;
  resetTilt(): void;
  depart(decision: "keep" | "reject", target: DOMRect | undefined): void;
  destroy(): void;
};

export function createCandidateCardScene(host: HTMLElement, canvas: HTMLCanvasElement,
  front: HTMLElement, back: HTMLElement, onFailure: () => void): CandidateSceneController {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, .1, 100);
  const held = new Group();
  scene.add(held, new AmbientLight(0xfff4d9, 2.0));
  const sun = new DirectionalLight(0xffffff, 3.5);
  sun.position.set(-7, 10, 12); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12; sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 10; sun.shadow.camera.bottom = -10;
  sun.shadow.normalBias = .025; sun.shadow.bias = -.0001;
  scene.add(sun);
  const rim = new DirectionalLight(0xb9d3ad, 1.4); rim.position.set(8, -2, 6); scene.add(rim);
  const paper = new MeshPhysicalMaterial({ color: 0xfff2cf, roughness: .54, metalness: .02, clearcoat: .25, clearcoatRoughness: .55 });
  const edge = new MeshStandardMaterial({ color: 0xb98c59, roughness: .72 });
  const mint = new MeshStandardMaterial({ color: 0xb9d3ad, roughness: .7 });
  let cardHeight = 5;
  let geometry = createCardGeometry(cardHeight);
  const card = new Mesh(geometry, [paper, edge]); card.castShadow = true; card.receiveShadow = true; held.add(card);
  const deck = new Group(); scene.add(deck);
  const under = [-1, 1].map((side, index) => {
    const sheet = new Mesh(geometry, [index === 0 ? mint : paper, edge]);
    sheet.position.set(side * .16, -.12 - index * .05, -.28 - index * .28);
    sheet.rotation.set(.06, -.10, side * .06); sheet.castShadow = true; sheet.receiveShadow = true;
    deck.add(sheet); return sheet;
  });
  const shadow = new Mesh(new PlaneGeometry(28, 20), new ShadowMaterial({ opacity: .28 }));
  shadow.position.z = -1.2; shadow.receiveShadow = true; scene.add(shadow);
  let mode: CardSceneMode = "full";
  let targetBack = false, flip = 0, tiltX = 0, tiltY = 0, targetX = 0, targetY = 0;
  let arrivalAt = performance.now(), frame = 0, disposed = false, width = 1, height = 1;
  let ghost: Mesh | null = null;
  let departure: { at: number; target: Vector3; reject: boolean } | null = null;
  const bounds = new Vector3();

  const resize = () => {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    const aspect = Math.max(1.25, Math.min(2.5, width / height));
    cardHeight = CARD_WIDTH / aspect;
    const next = createCardGeometry(cardHeight);
    card.geometry = next; under.forEach(sheet => { sheet.geometry = next; });
    ghost && (ghost.geometry = next); geometry.dispose(); geometry = next;
    front.style.width = back.style.width = `${CARD_FACE_WIDTH}px`;
    front.style.height = back.style.height = `${CARD_FACE_WIDTH / aspect}px`;
    front.style.setProperty("--card-aspect", `${aspect}`); back.style.setProperty("--card-aspect", `${aspect}`);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const tan = Math.tan(camera.fov * Math.PI / 360);
    camera.position.z = Math.max(cardHeight / (2 * tan), CARD_WIDTH / (2 * tan * camera.aspect)) * 1.12 + .35;
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    requestDraw();
  };

  const project = (face: HTMLElement, isBack: boolean) => {
    const matrix = cardFaceProjection(camera.projectionMatrix, camera.matrixWorldInverse, held.matrixWorld, width, height, cardHeight, isBack);
    face.style.transform = `matrix3d(${matrix.elements.join(",")})`;
    bounds.set(0, 0, isBack ? -1 : 1).transformDirection(held.matrixWorld);
    face.style.visibility = bounds.z > 0 ? "visible" : "hidden";
  };
  const removeGhost = () => { if (ghost) { scene.remove(ghost); ghost = null; } departure = null; };
  let last = performance.now();
  const draw = (now: number) => {
    frame = 0;
    if (disposed) return;
    const dt = Math.min(.05, Math.max(.001, (now - last) / 1000)); last = now;
    const rate = mode === "off" ? 1 : 1 - Math.exp(-12 * dt);
    const goal = targetBack ? Math.PI : 0;
    flip += (goal - flip) * rate; tiltX += (targetX - tiltX) * rate; tiltY += (targetY - tiltY) * rate;
    const t = mode === "full" ? Math.min(1, (now - arrivalAt) / 850) : 1;
    const lift = (1 - t) * Math.cos(t * Math.PI * 2.3);
    held.position.set(0, lift * .8, (1 - t) * 1.5);
    held.rotation.set(.075 + tiltX + lift * .28, flip - .12 + tiltY, -.015 + lift * -.14);
    held.scale.setScalar(1 - lift * .06);
    held.updateMatrixWorld(true);
    project(front, false); project(back, true);
    if (ghost && departure) {
      const p = Math.min(1, (now - departure.at) / 950), ease = p * p;
      ghost.position.lerpVectors(new Vector3(0, 0, .25), departure.target, ease);
      ghost.position.y += Math.sin(p * Math.PI) * 2.4;
      ghost.rotation.set(p * 1.4, p * Math.PI * 3, p * (departure.reject ? -2 : 1.1));
      ghost.scale.setScalar(Math.max(.05, 1 - p * .95));
      if (p === 1) removeGhost();
    }
    try { renderer.render(scene, camera); } catch { onFailure(); return; }
    if (t < 1 || Math.abs(goal - flip) > .0002 || Math.abs(targetX - tiltX) + Math.abs(targetY - tiltY) > .0002 || ghost) requestDraw();
  };
  function requestDraw() { if (!frame && !disposed) frame = requestAnimationFrame(draw); }
  const observer = new ResizeObserver(resize); observer.observe(host);
  const lost = (event: Event) => { event.preventDefault(); onFailure(); };
  canvas.addEventListener("webglcontextlost", lost);
  resize();
  return {
    setBack(value) { targetBack = value; requestDraw(); },
    setMode(value) { mode = value; if (mode !== "full") targetX = targetY = 0; if (mode === "off") removeGhost(); requestDraw(); },
    arrive() { arrivalAt = performance.now(); requestDraw(); },
    tilt(x, y, dragging = false) { if (mode !== "full") return; const amount = dragging ? .85 : .12; targetX = (y - .5) * amount; targetY = (x - .5) * amount * 1.6; requestDraw(); },
    resetTilt() { targetX = targetY = 0; requestDraw(); },
    depart(decision, target) {
      if (mode !== "full") return;
      removeGhost(); ghost = new Mesh(geometry, [mint, edge]); ghost.castShadow = true; scene.add(ghost);
      const rect = host.getBoundingClientRect();
      const point = target && decision === "keep"
        ? new Vector3(((target.left + target.width / 2 - rect.left) / rect.width) * 2 - 1, 1 - ((target.top + target.height / 2 - rect.top) / rect.height) * 2, .5).unproject(camera)
        : new Vector3(-CARD_WIDTH * 1.4, -2, 0);
      if (decision === "keep") { const direction = point.sub(camera.position); direction.multiplyScalar(-camera.position.z / direction.z).add(camera.position); point.z = 0; }
      departure = { at: performance.now(), target: point, reject: decision === "reject" }; requestDraw();
    },
    destroy() {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); canvas.removeEventListener("webglcontextlost", lost);
      geometry.dispose(); paper.dispose(); edge.dispose(); mint.dispose(); shadow.geometry.dispose(); (shadow.material as ShadowMaterial).dispose();
      renderer.dispose(); renderer.forceContextLoss(); front.style.removeProperty("transform"); back.style.removeProperty("transform");
      front.style.removeProperty("visibility"); back.style.removeProperty("visibility");
      front.style.removeProperty("width"); front.style.removeProperty("height"); back.style.removeProperty("width"); back.style.removeProperty("height");
    },
  };
}
