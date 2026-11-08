import { useEffect, useRef, type RefObject } from "react";

/**
 * 烟球内部：移植自 adithyavis/awesome-mobile-app-animations 的
 * `ChatGPTVoiceProfiles/FluidOrb.tsx`（Skia SKSL 片元着色器，2026-11-07 用户指定），
 * 逐句译成 GLSL 跑在 WebGL 上。
 *
 * 音量只通过"CPU 积分速度→相位"推动云：着色器里若拿累积时间乘实时音量，
 * 音量每跳一次整片噪声场就瞬移一次（伴星振幅走口形通道，是音素级高频信号，
 * 曾因此高频颤动）。速度包络稍快、形变包络很慢，声音读出来是流动而不是抖动。
 */
const VERTEX = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_swell;

float hash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbm3(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  for (int i = 0; i < 3; i++) {
    value += amplitude * noise(p * frequency);
    amplitude *= 0.5;
    frequency *= 2.0;
  }
  return value;
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  for (int i = 0; i < 5; i++) {
    value += amplitude * noise(p * frequency);
    amplitude *= 0.5;
    frequency *= 2.1;
  }
  return value;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv = uv * 2.0 - 1.0;

  // 相位已在 CPU 按速度积分，音量变化只改流速，不瞬移噪声场。
  float t = u_time;
  float warpMul = 1.0 + u_swell;

  // 大尺度平流场：缓慢、巨大的漂移。
  vec2 flow = vec2(
    fbm3(uv * 0.5 + vec2(t * 0.3, t * 0.1)),
    fbm3(uv * 0.5 + vec2(-t * 0.15, t * 0.25) + 5.3)
  );
  vec2 wuv = uv + (flow - 0.5) * 0.9 * warpMul;

  // 主流体形：两层去相关的低倍噪声，连成大的蓝白团块。
  float shape = fbm3(wuv * 0.6 + vec2(t * 0.08, -t * 0.05));
  float shape2 = fbm3(wuv * 0.45 + vec2(-t * 0.1, t * 0.07) + 11.4);
  float n = shape * 0.55 + shape2 * 0.45;

  // 稀疏、快速、高扭曲的细丝层（速度收敛，只做点缀）。
  float fastT = t * 1.6;
  vec2 fastFlow = vec2(
    fbm3(uv * 0.3 + vec2(fastT * 0.5, fastT * 0.2)),
    fbm3(uv * 0.3 + vec2(-fastT * 0.3, fastT * 0.4) + 9.1)
  );
  vec2 fastWuv = uv + (fastFlow - 0.5) * 1.8 * warpMul;
  float sparse = fbm3(fastWuv * 0.3 + vec2(fastT * 0.15, -fastT * 0.1) + 7.7);
  n += smoothstep(0.65, 0.8, sparse) * 0.12;

  // 只在蓝白过渡带出现的细细节。
  float detail = fbm(wuv * 1.4 + vec2(t * 0.12, -t * 0.08) + flow * 0.5);
  float boundary = clamp(1.0 - abs(n - 0.5) * 4.0, 0.0, 1.0);
  n += (detail - 0.5) * 0.15 * boundary;

  n += (1.0 - uv.y) * 0.025;
  float val = smoothstep(0.25, 0.75, n);

  // 深蓝 -> 青 -> 白，最亮处带一点暖。
  vec3 color = mix(vec3(0.0, 0.35, 0.9), vec3(0.1, 0.65, 1.0), smoothstep(0.0, 0.45, val));
  color = mix(color, vec3(0.95, 0.97, 1.0), smoothstep(0.35, 0.9, val));
  color = mix(color, vec3(1.0, 0.97, 0.92), smoothstep(0.85, 1.0, val) * 0.2);

  float dist = length(uv);
  float alpha = smoothstep(1.0, 0.985, dist);
  gl_FragColor = vec4(color * alpha, alpha);
}`;

const compile = (gl: WebGLRenderingContext, type: number, source: string) => {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
};

export type CompanionVoiceOrbMode = "input" | "output" | "idle";

/**
 * 两路信号性格不同：麦克风 RMS 经开方后是干净的"说/没说"能量，可以跟得紧、
 * 推得大（人说话时云要明显流起来）；播放振幅是口形包络，音素级跳动，只能
 * 慢包络取其大势。形变（swell）永远比流速（drive）更慢，避免任何一路把
 * 扭曲变成抖动。
 */
const MODE_TUNING: Record<CompanionVoiceOrbMode, {
  readonly attack: number; readonly release: number;
  readonly swellAttack: number; readonly swellRelease: number;
  readonly speedGain: number; readonly warpGain: number;
}> = {
  input: { attack: 0.1, release: 0.35, swellAttack: 0.15, swellRelease: 0.5, speedGain: 3.0, warpGain: 0.9 },
  output: { attack: 0.25, release: 0.6, swellAttack: 0.35, swellRelease: 0.9, speedGain: 2.0, warpGain: 0.5 },
  idle: { attack: 0.2, release: 0.5, swellAttack: 0.4, swellRelease: 0.9, speedGain: 1.2, warpGain: 0.5 },
};
// 平滑≠慢：相位连续的前提下流速要给够，否则肉眼看不到动静（2026-11-08 用户反馈）。
const BASE_SPEED = 1.2;

export function CompanionVoiceOrb({ level, mode }: { readonly level: RefObject<number>; readonly mode: CompanionVoiceOrbMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas?.getContext("webgl", { alpha: true, antialias: false, powerPreference: "low-power" });
    const vertex = gl ? compile(gl, gl.VERTEX_SHADER, VERTEX) : null;
    const fragment = gl ? compile(gl, gl.FRAGMENT_SHADER, FRAGMENT) : null;
    const program = gl && vertex && fragment ? gl.createProgram() : null;
    if (!canvas || !gl || !vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    const resolution = gl.getUniformLocation(program, "u_resolution");
    const time = gl.getUniformLocation(program, "u_time");
    const swellUniform = gl.getUniformLocation(program, "u_swell");
    const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let phase = 0;
    let drive = 0;
    let swell = 0;
    let last = 0;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(bounds.width * dpr);
      canvas.height = Math.round(bounds.height * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(resolution, canvas.width, canvas.height);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      const delta = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      const reduced = motionQuery.matches || canvas.closest<HTMLElement>("[data-motion]")?.dataset.motion === "off";
      const lite = !reduced && canvas.closest<HTMLElement>("[data-motion]")?.dataset.motion === "lite";
      const motion = reduced ? 0 : lite ? 0.45 : 1;
      const tuning = MODE_TUNING[modeRef.current];
      const target = Math.min(1, Math.max(0, level.current ?? 0));
      drive += (target - drive) * (1 - Math.exp(-delta / (target > drive ? tuning.attack : tuning.release)));
      swell += (target - swell) * (1 - Math.exp(-delta / (target > swell ? tuning.swellAttack : tuning.swellRelease)));
      phase += delta * motion * (BASE_SPEED + drive * tuning.speedGain);
      gl.uniform1f(time, phase);
      gl.uniform1f(swellUniform, swell * tuning.warpGain);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reduced) frame = requestAnimationFrame(draw);
    };

    const sync = () => {
      cancelAnimationFrame(frame);
      last = 0;
      frame = requestAnimationFrame(draw);
    };
    sync();
    motionQuery.addEventListener("change", sync);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      motionQuery.removeEventListener("change", sync);
    };
  }, []);

  return <canvas ref={canvasRef} className="companion-voice__canvas" aria-hidden="true" />;
}
