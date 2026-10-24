/* 消しバト：消しゴムの3Dプレビュー（three.js）。見た目だけ。ゆうワールドの yuyacht3d.js と同じ three.js を使う。
   ・本体・ふち・そこ・おもりの種類と、カバーの色に合わせて、消しゴムを組み立てて、ゆっくり回して見せる（ドラッグで向きを変えられる）。
   ・three.js が読めない端末では、何も描かない（呼び出し側が絵文字を出す）。 */
import { load3D, three } from "./yuyacht3d.js?v=20261023-3d1";

export const SLEEVE_COLORS = ["#2f6fe0", "#e0412f", "#2fa85a", "#f0b400", "#ee6fa8", "#8a52d6", "#2b2b30", "#f07a20"];

/* 消しゴムの組み立て（1人用の画面と、2人対戦の画面で共通）。T：three.js、RBG：角丸の箱。
   ・build(eq, color)：本体・ふち・そこ・おもり・カバーの色から、消しゴムの3Dの形（Group）を作る。長い辺が x 方向、底が y=-0.4
   ・environment(renderer)：金属・つや出しの面が黒くならないように、まわりの景色（空と明かり）を作って返す
   ・disposeGroup(group)：作った形を片づける */
export function eraserKit(T, RBG) {
  const rbox = (w, h, d, r = .06) => new RBG(w, h, d, 4, Math.min(r, Math.min(w, h, d) / 2 - .001));
  const speckle = (base, dot, n, size) => {
    const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d"); g.fillStyle = base; g.fillRect(0, 0, 128, 128); g.fillStyle = dot;
    let r = 12345; const rnd = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };   // 決まった乱数（毎回同じ模様）
    for (let i = 0; i < n; i++) { g.beginPath(); g.arc(rnd() * 128, rnd() * 128, size * (0.5 + rnd()), 0, 7); g.fill(); }
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  };
  const sleeveTex = (color) => {
    const c = document.createElement("canvas"); c.width = 256; c.height = 128; const g = c.getContext("2d");
    g.fillStyle = color; g.fillRect(0, 0, 256, 128); g.fillStyle = "#fff"; g.fillRect(0, 0, 256, 14); g.fillRect(0, 114, 256, 14);
    g.fillStyle = "#fff"; g.font = "900 46px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("消しゴム", 128, 66);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  };
  const std = (o) => new T.MeshStandardMaterial(o);
  const phys = (o) => new T.MeshPhysicalMaterial(o);

  function build(eqIn, color) {
    const eq = Object.fromEntries(Object.entries(eqIn || {}).map(([k, v]) => [k, String(v).replace(/~u$/, "")]));   // 中古（~u）も、見た目は同じ
    const g = new T.Group();
    const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    const body = {
      plain: () => std({ color: 0xf4f1ea, roughness: .85 }),
      sponge: () => std({ map: speckle("#ffd84a", "#d9a900", 70, 5), roughness: 1 }),
      sand: () => std({ map: speckle("#b8b2a4", "#6e6a60", 160, 2.5), roughness: 1 }),
      pro: () => phys({ color: 0xfde7ee, roughness: .28, clearcoat: .7, clearcoatRoughness: .25 }),
      titan: () => std({ color: 0xd2d6dc, roughness: .28, metalness: .85 })
    }[eq.body] || (() => std({ color: 0xf4f1ea }));
    add(rbox(2.5, .72, 1.22, .1), body());
    add(rbox(1.32, .8, 1.3, .06), std({ map: sleeveTex(SLEEVE_COLORS[color] || SLEEVE_COLORS[0]), roughness: .75 }));
    const edge = eq.edge;
    if (edge === "plastic") add(rbox(2.62, .26, 1.34, .08), phys({ color: 0x9fd8ff, transparent: true, opacity: .45, roughness: .1 }), 0, -.2, 0);
    else if (edge === "band") { [-.98, .98].forEach((x) => add(rbox(.12, .8, 1.3, .05), std({ color: 0xd8262a, roughness: .55 }), x, 0, 0)); }
    else if (edge === "metal") add(rbox(2.62, .28, 1.34, .06), std({ color: 0xb9c0c8, metalness: 1, roughness: .22 }), 0, -.2, 0);
    else if (edge === "crystal") add(rbox(2.64, .3, 1.36, .1), phys({ color: 0x66d0ff, transparent: true, opacity: .72, roughness: .05, clearcoat: 1, emissive: 0x1a6a9a, emissiveIntensity: .35 }), 0, -.2, 0);
    const sole = eq.sole;
    if (sole === "tape") add(rbox(2.3, .07, 1.0, .02), std({ color: 0xf4d20a, roughness: .5 }), 0, -.4, 0);
    else if (sole === "wax") add(rbox(2.3, .08, 1.0, .03), phys({ color: 0xfff1c9, roughness: .2, clearcoat: .8 }), 0, -.4, 0);
    else if (sole === "teflon") add(rbox(2.34, .08, 1.04, .03), phys({ color: 0x131316, roughness: .12, clearcoat: 1 }), 0, -.4, 0);
    else if (sole === "air") add(rbox(2.36, .13, 1.06, .06), phys({ color: 0xc4ecff, transparent: true, opacity: .6, roughness: .08 }), 0, -.42, 0);
    const weight = eq.weight;
    if (weight === "coin") add(new T.CylinderGeometry(.3, .3, .06, 32), std({ color: 0xd9a233, metalness: 1, roughness: .3 }), .95, .39, .0);
    else if (weight === "bolt") add(new T.CylinderGeometry(.22, .22, .16, 6), std({ color: 0xaab0b8, metalness: 1, roughness: .3 }), .95, .44, 0);
    else if (weight === "lead") add(rbox(.62, .22, .5, .04), std({ color: 0x4a4d54, metalness: .6, roughness: .5 }), .95, .46, 0);
    else if (weight === "gold") add(rbox(.66, .28, .52, .05), std({ color: 0xffc933, metalness: 1, roughness: .18 }), .95, .49, 0);
    return g;
  }
  const disposeGroup = (g) => g && g.traverse((o) => { if (o.material) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map && m.map.dispose(); m.dispose(); }); } });
  function environment(renderer) {
    try {
      const envScene = new T.Scene();
      const sphere = new T.SphereGeometry(10, 32, 16), pos = sphere.attributes.position, cols = [];
      for (let i = 0; i < pos.count; i++) { const y = pos.getY(i) / 10, k = (y + 1) / 2; cols.push(.45 + .55 * k, .4 + .55 * k, .36 + .6 * k); }
      sphere.setAttribute("color", new T.Float32BufferAttribute(cols, 3));
      envScene.add(new T.Mesh(sphere, new T.MeshBasicMaterial({ side: T.BackSide, vertexColors: true })));
      [[-4, 6, 3, 5, 3], [5, 5, -2, 4, 2], [0, 7, -6, 6, 2]].forEach(([x, y, z, w, h]) => { const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); envScene.add(m); });
      const pm = new T.PMREMGenerator(renderer); const tex = pm.fromScene(envScene, 0.03).texture; pm.dispose();
      return tex;
    } catch (_) { return null; }   /* 映り込みなしでも表示はできる */
  }
  return { build, disposeGroup, environment, rbox };
}

export async function createEraserStage(container) {
  if (!(await load3D())) return null;
  const { T, RBG } = three();
  let renderer;
  try { renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" }); } catch (_) { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap; renderer.outputColorSpace = T.SRGBColorSpace;
  const canvas = renderer.domElement; canvas.className = "yk2-gl"; container.appendChild(canvas);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(28, 1, .1, 50); camera.position.set(0, 3.1, 6.2); camera.lookAt(0, -.05, 0);
  scene.add(new T.HemisphereLight(0xffffff, 0x8a6a40, 1.05));
  const sun = new T.DirectionalLight(0xffffff, 2.2); sun.position.set(-3, 6, 4); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.radius = 5; sun.shadow.bias = -0.0008;
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 }); scene.add(sun);
  const ground = new T.Mesh(new T.PlaneGeometry(30, 30), new T.ShadowMaterial({ opacity: .42 })); ground.rotation.x = -Math.PI / 2; ground.position.y = -.43; ground.receiveShadow = true; scene.add(ground);

  const kit = eraserKit(T, RBG);
  { const env = kit.environment(renderer); if (env) scene.environment = env; }
  let group = null, yaw = 0.6, pitch = 0, dragging = false, last = null, raf = 0, W = 0, H = 0, alive = true;
  const { build, disposeGroup } = kit;
  function measure() {
    const r = container.getBoundingClientRect(); const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === W && h === H) return; W = w; H = h; renderer.setSize(w, h, false); canvas.style.width = w + "px"; canvas.style.height = h + "px"; camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const reduced = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } })();
  function frame(t) {
    raf = 0;
    if (!alive || !container.isConnected) return;
    measure();
    if (group) { if (!dragging && !reduced) yaw += 0.006; group.rotation.set(pitch, yaw, 0); }
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => { dragging = true; last = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture?.(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => { if (!dragging) return; yaw += (e.clientX - last.x) * 0.012; pitch = Math.max(-.5, Math.min(.7, pitch + (e.clientY - last.y) * 0.008)); last = { x: e.clientX, y: e.clientY }; });
  const up = () => { dragging = false; };
  canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  return {
    set(eq, color) {
      if (group) { scene.remove(group); disposeGroup(group); }
      group = build(eq, color); scene.add(group); group.rotation.set(pitch, yaw, 0);
      if (!raf) raf = requestAnimationFrame(frame);
    },
    dispose() { alive = false; if (raf) cancelAnimationFrame(raf); disposeGroup(group); renderer.dispose(); canvas.remove(); }
  };
}
