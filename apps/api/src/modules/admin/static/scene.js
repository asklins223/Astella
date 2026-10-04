/* ============================================================
   运维控制台 · 服务之心（three.js 仪器）
   ------------------------------------------------------------
   这不是背景动画。场景是**可挂载的仪器**：它挂进具体视图的舞台容器，
   承担那些只有它能表达、且**不再在别处以卡片重复**的读数——

     元素        读数                  为什么是它
     ─────────────────────────────────────────────────────────
     核心        健康状态 / p95 心跳    "活着吗、有多沉"是一眼问题，不是一行数字
     粒子盘      请求速率              流量是连续、有方向的；「132 次/分」只是快照
     队列环/柱场  每类任务积压          位置+高度同时表达"有多少类、哪类最堵"
     红色粒子    5xx 速率              错误在流里闪现，比一个红字更早被注意到

   挂载契约：
   - `createScene()` 建 canvas，但不进 DOM；canvas 是场景自己的，可以在
     视图之间搬（同一个 WebGL 上下文，不重建）。
   - `mount(stageEl, mode)` 把 canvas 挂进某个视图的舞台，按**舞台尺寸**渲染；
     `unmount()` 摘下来并停 rAF——扁平视图（指标/日志/配置）不挂场景，不烧 GPU。
   - `setMode` 让同一批物体在「环形总览」「柱场队列」「门厅」之间重新排布，
     相机推拉过去：切视图看到的是**仪表在重组**，不是换一张页面。
   - `setLabels` 把 DOM 读数**投影到 3D 物体上**（标签跟着核心/柱子走）。
     数字只有这一处：环上有多少积压，页面上就不再有一张卡片重复它。
   - `onBarSelect` 提供射线拾取：柱场里点一根柱 = 选中一类任务。
   ============================================================ */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  FogExp2,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  ShaderMaterial,
  TorusGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  EffectComposer,
  RenderPass,
  UnrealBloomPass,
  OutputPass,
  BoxGeometry,
} from "./vendor/three.bundle.js";

const HEALTH_COLORS = {
  ok: new Color("#54f2c4"),
  warn: new Color("#ffb454"),
  bad: new Color("#ff5f7e"),
  block: new Color("#ff5f7e"),
};

const COLORS = {
  near: new Color("#7ef3ff"),
  far: new Color("#5f7dff"),
  error: new Color("#ff4d6d"),
  star: new Color("#9fc4ff"),
  grid: new Color("#2e6dff"),
};

const BAR_COLORS = {
  ok: new Color("#3fd8c2"),
  busy: new Color("#5f9dff"),
  dead: new Color("#ff5f7e"),
  failed: new Color("#ffb454"),
};

const MAX_BARS = 18;

/**
 * 三种构图。相机与物体排布的目标值都在这里；切换模式只是换一组目标，
 * 逐帧趋近的过程就是"仪表重组"的动画。
 */
const MODES = {
  gate: {
    cam: [0, 0.5, 6.8], look: [0, -0.25, 0],
    core: { x: 0, y: -0.45, z: 0, scale: 1 },
    ringMix: 0, ringBaseY: -1.75, ringRadius: 2.95, barScale: 0,
    diskScale: 1, gridOpacity: 0.9, starOpacity: 0.9, intensity: 1,
  },
  overview: {
    cam: [0, 0.75, 7.6], look: [0, -0.12, 0],
    core: { x: 0, y: -0.55, z: 0, scale: 1 },
    ringMix: 0, ringBaseY: -1.6, ringRadius: 2.95, barScale: 1,
    diskScale: 1, gridOpacity: 0.8, starOpacity: 0.85, intensity: 0.9,
  },
  queues: {
    cam: [0, 1.2, 7.8], look: [0, -0.55, 0],
    core: { x: -2.9, y: -1.15, z: -1.4, scale: 0.42 },
    ringMix: 1, ringBaseY: -1.5, ringRadius: 2.95, barScale: 1.5,
    diskScale: 0.45, gridOpacity: 0.45, starOpacity: 0.6, intensity: 0.75,
  },
};

/** 把 NaN/undefined 收成 0，场景不该因为一个坏读数整个黑掉。 */
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 指数趋近：帧率无关的平滑（数据跳变时画面滑过去，而不是瞬移）。 */
function approach(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function approach3(current, target, lambda, dt) {
  current[0] = approach(current[0], target[0], lambda, dt);
  current[1] = approach(current[1], target[1], lambda, dt);
  current[2] = approach(current[2], target[2], lambda, dt);
}

/* ── 着色器 ────────────────────────────────────────────── */

const CORE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPulse;
  uniform float uBeat;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  void main() {
    vec3 p = position;
    float n = sin(p.x * 3.1 + uTime * 1.25) * sin(p.y * 2.7 - uTime * 1.05) * sin(p.z * 3.5 + uTime * 0.85);
    p += normal * (n * 0.06 + uPulse * 0.16 + uBeat * 0.035);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    vNoise = n;
    gl_Position = projectionMatrix * mv;
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;
  void main() {
    float fresnel = pow(1.0 - abs(dot(vNormal, vView)), 2.1);
    vec3 color = uColor * (0.42 + fresnel * 1.55) + vec3(vNoise * 0.05);
    gl_FragColor = vec4(color, uOpacity * (0.55 + fresnel * 0.35));
  }
`;

const HALO_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HALO_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float falloff = pow(clamp(1.0 - d, 0.0, 1.0), 2.6);
    gl_FragColor = vec4(uColor, falloff * uOpacity);
  }
`;

const DISK_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform float uPixelRatio;
  uniform float uErrorMix;
  attribute float aRadius;
  attribute float aAngle;
  attribute float aSeed;
  attribute float aError;
  varying float vRadius;
  varying float vError;
  void main() {
    float orbital = uSpeed / pow(aRadius, 1.5);
    float angle = aAngle + uTime * orbital * 0.5;
    float wobble = sin(angle * 2.0 + aSeed * 6.2831) * 0.1 * (aRadius - 1.3);
    wobble += sin(aSeed * 12.0 + uTime * 0.35) * 0.05;
    vec3 pos = vec3(cos(angle) * aRadius, wobble, sin(angle) * aRadius);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = (3.4 - aRadius * 0.6) * uPixelRatio * (7.5 / max(0.6, -mv.z));
    vRadius = aRadius;
    // 错误粒：aError 是候选位（一半粒子），uErrorMix 决定这一帧点亮的比例。
    vError = aError * (1.0 - step(uErrorMix, aSeed));
  }
`;

const DISK_FRAGMENT = /* glsl */ `
  uniform vec3 uNear;
  uniform vec3 uFar;
  uniform vec3 uError;
  uniform float uOpacity;
  varying float vRadius;
  varying float vError;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.08, d);
    vec3 base = mix(uNear, uFar, clamp((vRadius - 1.4) / 2.4, 0.0, 1.0));
    vec3 color = mix(base, uError, vError);
    gl_FragColor = vec4(color, alpha * uOpacity);
  }
`;

const GRID_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GRID_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSpeed;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vWorld;
  float gridLine(vec2 coord, float scale) {
    vec2 g = abs(fract(coord * scale - 0.5) - 0.5) / fwidth(coord * scale);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }
  void main() {
    vec2 coord = vWorld.xz;
    coord.y -= uTime * (0.35 + uSpeed * 0.25);
    float grid = gridLine(coord, 0.5) * 0.5 + gridLine(coord, 0.1) * 0.22;
    float dist = length(vWorld.xz);
    float fade = smoothstep(30.0, 5.0, dist);
    float pulse = 0.75 + 0.25 * sin(uTime * 0.8 + dist * 0.35);
    gl_FragColor = vec4(uColor, grid * fade * uOpacity * pulse);
  }
`;

/* ── 场景 ──────────────────────────────────────────────── */

/**
 * @returns 控制器；WebGL 不可用时返回 null（调用方回退 CSS 背景）。
 */
export function createScene() {
  let renderer;
  try {
    renderer = new WebGLRenderer({
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
    });
  } catch {
    return null;
  }
  const canvas = renderer.domElement;
  canvas.className = "scene-canvas";
  canvas.setAttribute("aria-hidden", "true");

  const scene = new Scene();
  scene.fog = new FogExp2(0x04060d, 0.026);

  const camera = new PerspectiveCamera(42, 1, 0.1, 120);
  camera.position.set(...MODES.overview.cam);

  /* 状态：目标值（来自数据/模式）+ 当前值（逐帧趋近） */
  const state = {
    mode: "overview",
    health: "ok",
    rate: 0,
    errors: 0,
    latency: 0.2,
    reducedMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  };
  const smooth = {
    rate: 0,
    errors: 0,
    pulse: 0,
    beat: 0,
    color: HEALTH_COLORS.ok.clone(),
    cam: [...MODES.overview.cam],
    look: [...MODES.overview.look],
    core: { x: 0, y: -0.55, z: 0, scale: 1 },
    ringMix: 0,
    ringRadius: MODES.overview.ringRadius,
    ringBaseY: -1.8,
    barScale: 1,
    diskScale: 1,
    gridOpacity: 0.8,
    starOpacity: 0.85,
    intensity: 0.9,
  };
  const pointer = { nx: 0, ny: 0, tx: 0, ty: 0 };
  let container = null;
  let mounted = false;
  /** 上一次挂载的模式：决定这次是"落位"还是"迁移过去"。 */
  let lastSceneMode = null;

  /* ── 星野 ── */
  const starCount = 1000;
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i += 1) {
    const radius = 16 + Math.random() * 22;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starPositions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = radius * Math.cos(phi) * 0.6;
    starPositions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta) - 6;
    const color = COLORS.star.clone().lerp(new Color("#ffffff"), Math.random() * 0.7);
    starColors[i * 3] = color.r;
    starColors[i * 3 + 1] = color.g;
    starColors[i * 3 + 2] = color.b;
  }
  const starGeometry = new BufferGeometry();
  starGeometry.setAttribute("position", new BufferAttribute(starPositions, 3));
  starGeometry.setAttribute("color", new BufferAttribute(starColors, 3));
  const stars = new Points(starGeometry, new PointsMaterial({
    size: 0.09,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: true,
    blending: AdditiveBlending,
    depthWrite: false,
  }));
  scene.add(stars);

  /* ── 全息地面 ── */
  const grid = new Mesh(
    new PlaneGeometry(64, 64, 1, 1),
    new ShaderMaterial({
      vertexShader: GRID_VERTEX,
      fragmentShader: GRID_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: 0.4 },
        uColor: { value: COLORS.grid.clone() },
        uOpacity: { value: 0.5 },
      },
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: 2,
    }),
  );
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -2.6;
  scene.add(grid);

  /* ── 核心（含外壳、光晕、粒子盘、冲击波；都随核心一起移动/缩放）── */
  const coreGroup = new Group();
  coreGroup.position.set(MODES.overview.core.x, MODES.overview.core.y, MODES.overview.core.z);
  scene.add(coreGroup);

  const coreMaterial = new ShaderMaterial({
    vertexShader: CORE_VERTEX,
    fragmentShader: CORE_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uBeat: { value: 0 },
      uColor: { value: HEALTH_COLORS.ok.clone() },
      uOpacity: { value: 0.92 },
    },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const core = new Mesh(new IcosahedronGeometry(0.82, 5), coreMaterial);
  coreGroup.add(core);

  const shellMaterial = new MeshBasicMaterial({
    color: 0x54f2c4,
    wireframe: true,
    transparent: true,
    opacity: 0.15,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const shell = new Mesh(new IcosahedronGeometry(1.28, 1), shellMaterial);
  coreGroup.add(shell);

  const haloMaterial = new ShaderMaterial({
    vertexShader: HALO_VERTEX,
    fragmentShader: HALO_FRAGMENT,
    uniforms: {
      uColor: { value: HEALTH_COLORS.ok.clone() },
      uOpacity: { value: 0.4 },
    },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const halo = new Mesh(new PlaneGeometry(7.0, 7.0), haloMaterial);
  coreGroup.add(halo);

  const diskCount = 2400;
  const diskGeometry = new BufferGeometry();
  {
    const positions = new Float32Array(diskCount * 3);
    const radii = new Float32Array(diskCount);
    const angles = new Float32Array(diskCount);
    const seeds = new Float32Array(diskCount);
    const errors = new Float32Array(diskCount);
    for (let i = 0; i < diskCount; i += 1) {
      const t = Math.random();
      radii[i] = 1.45 + Math.pow(t, 0.72) * 2.3;
      angles[i] = Math.random() * Math.PI * 2;
      seeds[i] = Math.random();
      errors[i] = Math.random() < 0.5 ? 1 : 0;
    }
    diskGeometry.setAttribute("position", new BufferAttribute(positions, 3));
    diskGeometry.setAttribute("aRadius", new BufferAttribute(radii, 1));
    diskGeometry.setAttribute("aAngle", new BufferAttribute(angles, 1));
    diskGeometry.setAttribute("aSeed", new BufferAttribute(seeds, 1));
    diskGeometry.setAttribute("aError", new BufferAttribute(errors, 1));
  }
  const diskMaterial = new ShaderMaterial({
    vertexShader: DISK_VERTEX,
    fragmentShader: DISK_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: 0.5 },
      uPixelRatio: { value: 1 },
      uNear: { value: COLORS.near.clone() },
      uFar: { value: COLORS.far.clone() },
      uError: { value: COLORS.error.clone() },
      uOpacity: { value: 0.6 },
      uErrorMix: { value: 0 },
    },
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const disk = new Points(diskGeometry, diskMaterial);
  disk.frustumCulled = false;
  coreGroup.add(disk);

  const WAVES = 8;
  const waves = [];
  for (let i = 0; i < WAVES; i += 1) {
    const material = new MeshBasicMaterial({
      color: 0x54f2c4,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new Mesh(new TorusGeometry(1, 0.012, 8, 96), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.visible = false;
    coreGroup.add(mesh);
    waves.push({ mesh, material, life: 0, duration: 1, color: new Color(0x54f2c4) });
  }
  let waveCursor = 0;

  /* ── 队列柱（环形排布 ↔ 柱场排布）── */
  const barMesh = new InstancedMesh(
    new BoxGeometry(0.1, 1, 0.1),
    new MeshBasicMaterial({ transparent: true, opacity: 0.92, blending: AdditiveBlending, depthWrite: false }),
    MAX_BARS,
  );
  barMesh.frustumCulled = false;
  const barDummy = new Object3D();
  const barTargets = new Array(MAX_BARS).fill(0);
  const barCurrent = new Array(MAX_BARS).fill(0);
  const barColors = new Array(MAX_BARS).fill(null);
  /** 柱场拾取用的行数据（由调用方排序后传入，索引与实例一一对应）。 */
  let barRows = [];
  let hoveredBar = -1;
  let selectedBar = -1;

  function barPos(i, count, mix) {
    const angle = (i / Math.max(1, count)) * Math.PI * 2 + 0.15;
    const circleX = Math.cos(angle) * smooth.ringRadius;
    const circleZ = Math.sin(angle) * smooth.ringRadius;
    const t = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
    const lineX = t * 3.15;
    const lineZ = -0.35;
    return {
      x: circleX * (1 - mix) + lineX * mix,
      z: circleZ * (1 - mix) + lineZ * mix,
    };
  }

  function refreshBars() {
    for (let i = 0; i < MAX_BARS; i += 1) {
      const { x, z } = barPos(i, barRows.length || MAX_BARS, smooth.ringMix);
      const height = Math.max(0.04, barCurrent[i]) * smooth.barScale;
      const hovered = i === hoveredBar;
      const selected = i === selectedBar;
      barDummy.position.set(x, smooth.ringBaseY + height / 2, z);
      barDummy.scale.set(hovered || selected ? 1.9 : 1, height, hovered || selected ? 1.9 : 1);
      barDummy.rotation.y = Math.atan2(x, z);
      barDummy.updateMatrix();
      barMesh.setMatrixAt(i, barDummy.matrix);
      const base = barColors[i] ?? BAR_COLORS.ok;
      const color = hovered || selected ? base.clone().lerp(new Color("#ffffff"), 0.45) : base;
      barMesh.setColorAt(i, color);
    }
    barMesh.instanceMatrix.needsUpdate = true;
    if (barMesh.instanceColor) barMesh.instanceColor.needsUpdate = true;
  }
  barMesh.setColorAt(0, BAR_COLORS.ok);
  scene.add(barMesh);
  refreshBars();

  /* ── 后处理 ── */
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(1, 1), 0.5, 0.6, 0.22);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  /* ── 尺寸 ── */
  let quality = 0; // 0 全效 / 1 关 bloom / 2 减粒子
  let dpr = 1;
  let viewWidth = 1;
  let viewHeight = 1;

  function resize() {
    if (!container) return;
    viewWidth = Math.max(1, container.clientWidth);
    viewHeight = Math.max(1, container.clientHeight);
    dpr = Math.min(window.devicePixelRatio || 1, quality === 0 ? 1.5 : 1.15);
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewWidth, viewHeight, false);
    composer.setPixelRatio(dpr);
    composer.setSize(viewWidth, viewHeight);
    camera.aspect = viewWidth / viewHeight;
    camera.updateProjectionMatrix();
    diskMaterial.uniforms.uPixelRatio.value = dpr;
    // 静态路径（减少动态）没有 rAF 在跑：尺寸变化会清掉画布，
    // 不在这里补画一帧的话，窗口缩放或重新挂载后会看到一块空白。
    if (!running && mounted) renderFrame(0);
  }
  const resizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => resize())
    : null;

  /* ── HUD 标签（DOM 读数投影到 3D 物体上）── */
  const labels = new Map(); // key → { el }
  const projected = new Vector3();
  let labelTick = 0;

  function anchorPosition(key) {
    coreGroup.getWorldPosition(projected); // 借 projected 暂存
    const coreX = projected.x;
    const coreY = projected.y;
    const coreZ = projected.z;
    const coreScale = smooth.core.scale;
    switch (key) {
      // 请求读数挂核心正上方：环的左右两侧是柱标签的地盘，上方是干净空间。
      case "rate": return [coreX, coreY + 2.1 * coreScale, coreZ];
      case "latency": return [coreX, coreY - 1.85 * coreScale, coreZ];
      case "errors": return [coreX - 3.2 * coreScale, coreY + 0.6 * coreScale, coreZ];
      default: {
        if (key.startsWith("bar:")) {
          const index = Number(key.slice(4));
          if (!Number.isFinite(index) || index >= barRows.length) return null;
          const { x, z } = barPos(index, barRows.length || MAX_BARS, smooth.ringMix);
          const height = Math.max(0.04, barCurrent[index]) * smooth.barScale;
          // 相邻柱的标签错开半档高度：柱场里前几根挤在一起时，标签不叠字。
          const stagger = 0.34 + (index % 2) * 0.5;
          return [x, smooth.ringBaseY + height + stagger, z];
        }
        return null;
      }
    }
  }

  function updateLabels() {
    // 每两帧更新一次就够：DOM 写比 GL 贵，而读数不需要 120Hz 的跟随。
    labelTick += 1;
    if (labelTick % 2 !== 0) return;
    for (const [key, entry] of labels) {
      const anchor = anchorPosition(key);
      if (!anchor) {
        entry.el.dataset.visible = "false";
        continue;
      }
      projected.set(anchor[0], anchor[1], anchor[2]).project(camera);
      const behind = projected.z > 1;
      const inView = Math.abs(projected.x) < 1.25 && Math.abs(projected.y) < 1.25;
      const visible = !behind && inView;
      if (!visible) {
        entry.el.dataset.visible = "false";
        continue;
      }
      const x = (projected.x * 0.5 + 0.5) * viewWidth;
      const y = (-projected.y * 0.5 + 0.5) * viewHeight;
      entry.el.dataset.visible = "true";
      entry.el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  /* ── 拾取（柱场选择器）── */
  const raycaster = new Raycaster();
  const pointerNdc = new Vector2();
  const barSelectListeners = new Set();

  function pickBar(event) {
    if (state.mode !== "queues" || !container) return -1;
    const rect = container.getBoundingClientRect();
    pointerNdc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const hits = raycaster.intersectObject(barMesh, false);
    return hits.length > 0 && hits[0].instanceId !== undefined ? hits[0].instanceId : -1;
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    const index = pickBar(event);
    if (index >= 0 && index < barRows.length) {
      selectedBar = index;
      refreshBars();
      for (const listener of barSelectListeners) listener(barRows[index], index);
    }
  }

  let hoverCheckAt = 0;
  function onPointerMove(event) {
    pointer.tx = (event.clientX / Math.max(1, viewWidth)) * 2 - 1;
    pointer.ty = (event.clientY / Math.max(1, viewHeight)) * 2 - 1;
    if (state.mode !== "queues") return;
    const now = performance.now();
    if (now - hoverCheckAt < 70) return;
    hoverCheckAt = now;
    const index = pickBar(event);
    const next = index >= 0 && index < barRows.length ? index : -1;
    if (next !== hoveredBar) {
      hoveredBar = next;
      canvas.style.cursor = next >= 0 ? "pointer" : "";
      refreshBars();
    }
  }

  /* ── 主循环 ── */
  let time = 0;
  let lastFrame = 0;
  let beatPhase = 0;
  let frameAccum = 0;
  let frameCount = 0;
  let running = false;
  let rafId = 0;

  function stepMaterialColors(dt) {
    const wanted = HEALTH_COLORS[state.health] ?? HEALTH_COLORS.ok;
    smooth.color.lerp(wanted, 1 - Math.exp(-3 * dt));
    coreMaterial.uniforms.uColor.value.copy(smooth.color);
    haloMaterial.uniforms.uColor.value.copy(smooth.color);
    shellMaterial.color.copy(smooth.color);
  }

  function updateBarsSmooth(dt) {
    let changed = false;
    for (let i = 0; i < MAX_BARS; i += 1) {
      const next = approach(barCurrent[i], barTargets[i], 5, dt);
      if (Math.abs(next - barCurrent[i]) > 0.0005) changed = true;
      barCurrent[i] = next;
    }
    // 环 ↔ 柱场的迁移也要每帧重排。
    if (changed || smooth.ringMix !== barMesh.userData.mixCache) {
      barMesh.userData.mixCache = smooth.ringMix;
      refreshBars();
    }
  }

  function updateWaves(dt) {
    for (const wave of waves) {
      if (wave.life <= 0) continue;
      wave.life -= dt / wave.duration;
      if (wave.life <= 0) {
        wave.mesh.visible = false;
        continue;
      }
      const progress = 1 - wave.life;
      const scale = 0.9 + progress * 2.6;
      wave.mesh.scale.set(scale, scale, scale);
      wave.mesh.position.y = -0.15 + progress * 0.35;
      wave.material.opacity = Math.sin(Math.min(1, wave.life) * Math.PI) * 0.36;
      wave.material.color.lerp(wave.color, 1 - Math.exp(-8 * dt));
    }
  }

  function renderFrame(dt) {
    time += dt;
    const mode = MODES[state.mode] ?? MODES.overview;

    smooth.rate = approach(smooth.rate, state.rate, 1.6, dt);
    smooth.errors = approach(smooth.errors, state.errors, 2.2, dt);
    smooth.pulse = Math.max(0, smooth.pulse - dt * 1.8);
    smooth.ringMix = approach(smooth.ringMix, mode.ringMix, 2.6, dt);
    smooth.ringRadius = approach(smooth.ringRadius, mode.ringRadius, 2.6, dt);
    smooth.ringBaseY = approach(smooth.ringBaseY, mode.ringBaseY, 2.6, dt);
    smooth.barScale = approach(smooth.barScale, mode.barScale, 2.6, dt);
    smooth.diskScale = approach(smooth.diskScale, mode.diskScale, 2.6, dt);
    smooth.gridOpacity = approach(smooth.gridOpacity, mode.gridOpacity, 2.6, dt);
    smooth.starOpacity = approach(smooth.starOpacity, mode.starOpacity, 2.6, dt);
    smooth.intensity = approach(smooth.intensity, mode.intensity, 2.6, dt);
    smooth.core.x = approach(smooth.core.x, mode.core.x, 2.6, dt);
    smooth.core.y = approach(smooth.core.y, mode.core.y, 2.6, dt);
    smooth.core.z = approach(smooth.core.z, mode.core.z, 2.6, dt);
    smooth.core.scale = approach(smooth.core.scale, mode.core.scale, 2.6, dt);
    stepMaterialColors(dt);
    updateBarsSmooth(dt);
    updateWaves(dt);

    // 心跳：周期随 p95 变慢（延迟越高，心跳越沉）。
    const period = clamp(1.1 + num(state.latency, 0.2) * 2.4, 1.1, 5.2);
    beatPhase = (beatPhase + dt / period) % 1;
    const beat = Math.pow(Math.sin(beatPhase * Math.PI), 6);
    smooth.beat = approach(smooth.beat, beat, 10, dt);

    pointer.nx = approach(pointer.nx, pointer.tx, 3.2, dt);
    pointer.ny = approach(pointer.ny, pointer.ty, 3.2, dt);
    approach3(smooth.cam, mode.cam, 2.4, dt);
    approach3(smooth.look, mode.look, 2.4, dt);
    camera.position.set(smooth.cam[0] + pointer.nx * 0.4, smooth.cam[1] + pointer.ny * -0.25, smooth.cam[2]);
    camera.lookAt(smooth.look[0] + pointer.nx * 0.2, smooth.look[1] + pointer.ny * 0.12, smooth.look[2]);

    const t = time;
    coreGroup.position.set(smooth.core.x, smooth.core.y, smooth.core.z);
    coreGroup.scale.setScalar(smooth.core.scale);
    coreMaterial.uniforms.uTime.value = t;
    coreMaterial.uniforms.uPulse.value = smooth.pulse * 0.5;
    coreMaterial.uniforms.uBeat.value = smooth.beat;
    shell.rotation.y = t * 0.12;
    shell.rotation.x = Math.sin(t * 0.16) * 0.18;
    halo.quaternion.copy(camera.quaternion);
    haloMaterial.uniforms.uOpacity.value = (0.14 + smooth.beat * 0.1 + smooth.pulse * 0.16) * smooth.intensity;
    disk.scale.setScalar(smooth.diskScale);
    disk.rotation.y = t * 0.03;

    const speed = clamp(smooth.rate / 90, 0.25, 2.6);
    diskMaterial.uniforms.uTime.value = t;
    diskMaterial.uniforms.uSpeed.value = speed;
    diskMaterial.uniforms.uErrorMix.value = clamp(smooth.errors * 0.08, 0, 0.5);
    diskMaterial.uniforms.uOpacity.value = (0.16 + Math.min(0.34, smooth.rate / 400)) * smooth.intensity * (state.mode === "queues" ? 1.4 : 1);

    grid.material.uniforms.uTime.value = t;
    grid.material.uniforms.uSpeed.value = speed;
    grid.material.uniforms.uOpacity.value = 0.3 * smooth.gridOpacity;

    stars.rotation.y = t * 0.008;
    stars.material.opacity = 0.3 + 0.25 * smooth.starOpacity;

    bloom.strength = (state.health === "ok" ? 0.42 : 0.62) * (0.5 + 0.5 * smooth.intensity);

    if (quality < 1) composer.render();
    else renderer.render(scene, camera);
    updateLabels();
  }

  function loop() {
    if (!running) return;
    rafId = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrame) / 1000) || 0.016;
    lastFrame = now;

    frameAccum += dt;
    frameCount += 1;
    if (frameCount >= 90) {
      const average = frameAccum / frameCount;
      frameAccum = 0;
      frameCount = 0;
      if (average > 0.03 && quality < 2) {
        quality += 1;
        if (quality === 2) {
          diskGeometry.setDrawRange(0, Math.floor(diskCount * 0.55));
        }
        resize();
      }
    }
    renderFrame(dt);
  }

  /** 静态路径的重绘合并：一帧最多画一次（数据更新常常成串到达）。 */
  let staticRaf = 0;
  function scheduleStaticRender() {
    if (!mounted || running || staticRaf) return;
    staticRaf = requestAnimationFrame(() => {
      staticRaf = 0;
      renderOnce();
    });
  }

  function renderOnce() {
    smooth.rate = state.rate;
    smooth.errors = state.errors;
    smooth.color.copy(HEALTH_COLORS[state.health] ?? HEALTH_COLORS.ok);
    smooth.pulse = 0;
    const mode = MODES[state.mode] ?? MODES.overview;
    Object.assign(smooth, {
      ringMix: mode.ringMix, ringRadius: mode.ringRadius, ringBaseY: mode.ringBaseY, barScale: mode.barScale,
      diskScale: mode.diskScale, gridOpacity: mode.gridOpacity, starOpacity: mode.starOpacity,
      intensity: mode.intensity,
    });
    smooth.cam.splice(0, 3, ...mode.cam);
    smooth.look.splice(0, 3, ...mode.look);
    Object.assign(smooth.core, { x: mode.core.x, y: mode.core.y, z: mode.core.z, scale: mode.core.scale });
    for (let i = 0; i < MAX_BARS; i += 1) barCurrent[i] = barTargets[i];
    refreshBars();
    renderFrame(0);
  }

  function start() {
    if (running || state.reducedMotion || !mounted) return;
    running = true;
    lastFrame = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
  }

  function syncVisibility() {
    if (document.hidden) stop();
    else start();
  }
  document.addEventListener("visibilitychange", syncVisibility);

  // 初始尺寸：放在所有声明之后调用（resize 里会读 running/mounted 并可能补画一帧）。
  resize();

  return {
    canvas,

    /**
     * 把 canvas 挂进舞台容器。同一实例在视图之间搬家（上下文不重建）。
     *
     * 从另一个**仪器视图**（overview/queues）过来时不落位，让它逐帧迁移过去：
     * 同一批物体重新排布、相机推拉，切视图读作「仪表在重组」。从门厅或扁平
     * 视图过来时直接落位——那里没有可延续的构图。
     */
    mount(stageEl, mode = "overview") {
      const animateIn = lastSceneMode === "overview" || lastSceneMode === "queues";
      container = stageEl;
      container.append(canvas);
      mounted = true;
      resizeObserver?.disconnect();
      resizeObserver?.observe(container);
      state.mode = mode;
      hoveredBar = -1;
      selectedBar = -1;
      canvas.style.cursor = "";
      if (!animateIn) {
        const target = MODES[mode] ?? MODES.overview;
        smooth.cam.splice(0, 3, ...target.cam);
        smooth.look.splice(0, 3, ...target.look);
        Object.assign(smooth.core, { x: target.core.x, y: target.core.y, z: target.core.z, scale: target.core.scale });
        smooth.ringMix = target.ringMix;
        smooth.ringRadius = target.ringRadius;
        smooth.ringBaseY = target.ringBaseY;
        smooth.barScale = target.barScale;
        smooth.diskScale = target.diskScale;
        smooth.gridOpacity = target.gridOpacity;
        smooth.starOpacity = target.starOpacity;
        smooth.intensity = target.intensity;
      }
      lastSceneMode = mode;
      resize();
      if (state.reducedMotion) scheduleStaticRender();
      else start();
    },

    unmount() {
      stop();
      resizeObserver?.disconnect();
      canvas.remove();
      mounted = false;
      container = null;
      // 标签元素随视图 DOM 一起销毁，这里只清引用（下一挂载由 setLabels 重建）。
      labels.clear();
      hoveredBar = -1;
      selectedBar = -1;
    },

    setMode(mode) {
      if (!MODES[mode]) return;
      state.mode = mode;
      selectedBar = -1;
      hoveredBar = -1;
      canvas.style.cursor = "";
      if (state.reducedMotion) scheduleStaticRender();
    },

    setHealth(health) {
      state.health = HEALTH_COLORS[health] ? health : "ok";
      if (state.reducedMotion) scheduleStaticRender();
    },

    setMetrics(metrics) {
      state.rate = num(metrics.requestsPerMinute, state.rate);
      state.errors = num(metrics.errorsPerMinute, 0);
      state.latency = num(metrics.p95Seconds, state.latency);
      if (state.reducedMotion) scheduleStaticRender();
    },

    /**
     * 队列数据。rows 由调用方**排序后**传入（索引与柱一一对应，标签/拾取
     * 都按这个顺序对齐），最多 MAX_BARS 根。
     */
    setQueue(rows) {
      barRows = (rows ?? []).slice(0, MAX_BARS);
      const maxWeight = Math.max(1, ...barRows.map((row) =>
        row.pending + row.deadTotal * 1.5 + row.failedRecent * 2));
      for (let i = 0; i < MAX_BARS; i += 1) {
        const row = barRows[i];
        if (!row) {
          barTargets[i] = 0;
          barColors[i] = BAR_COLORS.ok;
          continue;
        }
        const weight = row.pending + row.deadTotal * 1.5 + row.failedRecent * 2;
        // 对数压缩：一条 400 的积压不该让其余全看不见。
        barTargets[i] = 0.25 + (Math.log1p(weight) / Math.log1p(maxWeight)) * 1.05;
        barColors[i] = row.deadTotal > 0 ? BAR_COLORS.dead
          : row.failedRecent > 0 ? BAR_COLORS.failed
            : row.running > 0 ? BAR_COLORS.busy
              : BAR_COLORS.ok;
      }
      if (state.reducedMotion) scheduleStaticRender();
    },

    /** 选中某根柱（外部列表点击时同步高亮）。 */
    selectBar(index) {
      selectedBar = Number.isInteger(index) ? index : -1;
      refreshBars();
    },

    /** 点柱回调：`(row, index) => void`。 */
    onBarSelect(callback) {
      barSelectListeners.add(callback);
      if (barSelectListeners.size === 1) {
        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointermove", onPointerMove, { passive: true });
        canvas.addEventListener("pointerleave", () => {
          if (hoveredBar !== -1) {
            hoveredBar = -1;
            canvas.style.cursor = "";
            refreshBars();
          }
        });
      }
      return () => barSelectListeners.delete(callback);
    },

    /** 日志事件 → 冲击波。level 决定颜色。 */
    pulse(level = "info") {
      const wave = waves[waveCursor % WAVES];
      waveCursor += 1;
      wave.color.set(level === "error" || level === "fatal" ? 0xff5f7e
        : level === "warn" ? 0xffb454
          : 0x54f2c4);
      wave.life = 1;
      wave.duration = level === "error" || level === "fatal" ? 1.25 : 0.9;
      wave.mesh.visible = true;
      wave.mesh.position.set(0, -0.15, 0);
      wave.mesh.scale.set(0.9, 0.9, 0.9);
      smooth.pulse = clamp(smooth.pulse + (level === "error" || level === "fatal" ? 1 : 0.5), 0, 1.4);
      if (state.reducedMotion) scheduleStaticRender();
    },

    /**
     * 注册 DOM 读数（HUD 标签）。key：
     *   "rate" | "latency" | "errors"（挂在核心旁）
     *   `bar:<index>`（挂在对应对队列柱顶上）
     */
    setLabels(list) {
      for (const [, entry] of labels) entry.el.dataset.visible = "false";
      labels.clear();
      for (const item of list ?? []) {
        labels.set(item.key, { el: item.el });
        item.el.dataset.visible = "false";
      }
      if (state.reducedMotion) updateLabels();
    },

    dispose() {
      stop();
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", syncVisibility);
      canvas.remove();
      composer.dispose?.();
      renderer.dispose();
    },
  };
}
