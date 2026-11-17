/* 消しバト：消しゴムの3Dプレビュー（three.js）。見た目だけ。ゆうワールドの yuyacht3d.js と同じ three.js を使う。
   ・本体・ふち・そこ・おもりの種類と、カバーの色に合わせて、消しゴムを組み立てて、ゆっくり回して見せる（ドラッグで向きを変えられる）。
   ・three.js が読めない端末では、何も描かない（呼び出し側が絵文字を出す）。 */
import { load3D, three } from "./yuyacht3d.js?v=20261023-3d1";

/* 0〜7：ふつうの色／8〜11：ゆう番くじ F賞の限定カラー（ゴールド・シルバー・レインボー・ブラックゴールド。持っている人だけ選べる） */
export const SLEEVE_COLORS = ["#2f6fe0", "#e0412f", "#2fa85a", "#f0b400", "#ee6fa8", "#8a52d6", "#2b2b30", "#f07a20", "#d4a62a", "#b8c0c8", "rainbow", "#1b1a14", "legend"];   // 12：レジェンド（ラストワン賞の伝説セットだけ）
/* 色の見本（ボタンの背景）に使う CSS */
export const sleeveCss = (c) => (c === "rainbow" ? "linear-gradient(90deg,#ff2d78,#ff8a00,#ffe14a,#17e36a,#17b6ff,#b14cff)" : c === "legend" ? "linear-gradient(90deg,#1b1030,#7a2aff,#ff4aa0,#ffd34a)" : c);

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
    if (color === "rainbow" || color === "legend") { const gr = g.createLinearGradient(0, 0, 256, 0); (color === "legend" ? ["#1b1030", "#7a2aff", "#ff4aa0", "#ffd34a"] : ["#ff2d78", "#ff8a00", "#ffe14a", "#17e36a", "#17b6ff", "#b14cff"]).forEach((c, i, a) => gr.addColorStop(i / (a.length - 1), c)); g.fillStyle = gr; } else g.fillStyle = color;
    g.fillRect(0, 0, 256, 128); const ink = color === "#1b1a14" ? "#e8c25a" : "#fff"; g.fillStyle = ink; g.fillRect(0, 0, 256, 14); g.fillRect(0, 114, 256, 14);
    g.fillStyle = ink; g.font = "900 46px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("消しゴム", 128, 66);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
  };
  const std = (o) => new T.MeshStandardMaterial(o);
  const phys = (o) => new T.MeshPhysicalMaterial(o);

  /* only：その枠のパーツだけを作る（ベルトコンベアで、パーツ単体を見せるとき）。ふちは、中が空洞の枠だけになる */
  function build(eqIn, color, only) {
    const want = (s) => !only || only === s;
    const eq = Object.fromEntries(Object.entries(eqIn || {}).map(([k, v]) => [k, String(v).replace(/(~u|@[gdr])$/, "")]));   // 中古（~u）・ミューテーション（@g など）も、見た目は同じ（ミューテーションは、あとで色をつける）
    const mutKey = only ? (/@([gdr])$/.exec(String(eqIn?.[only] || "")) || [])[1] : null;
    const g = new T.Group();
    const add = (geo, mat, x = 0, y = 0, z = 0) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    const body = {
      plain: () => std({ color: 0xf4f1ea, roughness: .85 }),
      sponge: () => std({ map: speckle("#ffd84a", "#d9a900", 70, 5), roughness: 1 }),
      sand: () => std({ map: speckle("#b8b2a4", "#6e6a60", 160, 2.5), roughness: 1 }),
      pro: () => phys({ color: 0xfde7ee, roughness: .28, clearcoat: .7, clearcoatRoughness: .25 }),
      titan: () => std({ color: 0xd2d6dc, roughness: .28, metalness: .85 }),
      carbon: () => std({ color: 0x23262b, roughness: .35, metalness: .4 }),
      diamond: () => phys({ color: 0xcdf3ff, roughness: .05, metalness: .2, clearcoat: 1, emissive: 0x4a9ac0, emissiveIntensity: .3 }),
      meteor: () => std({ color: 0x4a3b36, roughness: .6, metalness: .7, emissive: 0xff5a1a, emissiveIntensity: .25 }),
      gel: () => phys({ color: 0x9fe8ff, transparent: true, opacity: .8, roughness: .1, clearcoat: 1 }),
      bamboo: () => std({ color: 0x2e3a33, roughness: .9 }),
      ruby: () => phys({ color: 0xc2203a, roughness: .1, clearcoat: 1, emissive: 0x4a0010, emissiveIntensity: .4 }),
      dragon: () => phys({ color: 0x2a6b3a, metalness: .85, roughness: .2, clearcoat: 1, emissive: 0x0a4a1a, emissiveIntensity: .5 }),
      ltd: () => phys({ color: 0x7fa3d6, roughness: .18, metalness: .95, clearcoat: 1, emissive: 0x16305a, emissiveIntensity: .35 })   // E賞の限定
    }[eq.body] || (() => std({ color: 0xf4f1ea }));
    if (want("body")) add(rbox(2.5, .72, 1.22, .1), body());
    if (!only) add(rbox(1.32, .8, 1.3, .06), std({ map: sleeveTex(SLEEVE_COLORS[color] || SLEEVE_COLORS[0]), roughness: .75 }));
    const ring = () => { const sh = new T.Shape(); sh.moveTo(-1.32, -.68); sh.lineTo(1.32, -.68); sh.lineTo(1.32, .68); sh.lineTo(-1.32, .68); sh.closePath(); const hole = new T.Path(); hole.moveTo(-1.06, -.44); hole.lineTo(-1.06, .44); hole.lineTo(1.06, .44); hole.lineTo(1.06, -.44); hole.closePath(); sh.holes.push(hole); const gg = new T.ExtrudeGeometry(sh, { depth: .26, bevelEnabled: true, bevelSize: .03, bevelThickness: .03, bevelSegments: 2 }); gg.rotateX(-Math.PI / 2); gg.translate(0, -.13, 0); return gg; };
    const addE = (geo, mat, x = 0, y = 0, z = 0) => (only === "edge" && eq.edge !== "band" ? add(ring(), mat, 0, 0, 0) : add(geo, mat, x, y, z));
    const edge = want("edge") ? eq.edge : null;
    if (edge === "plastic") addE(rbox(2.62, .26, 1.34, .08), phys({ color: 0x9fd8ff, transparent: true, opacity: .45, roughness: .1 }), 0, -.2, 0);
    else if (edge === "band") { [-.98, .98].forEach((x) => addE(rbox(.12, .8, 1.3, .05), std({ color: 0xd8262a, roughness: .55 }), x, 0, 0)); }
    else if (edge === "metal") addE(rbox(2.62, .28, 1.34, .06), std({ color: 0xb9c0c8, metalness: 1, roughness: .22 }), 0, -.2, 0);
    else if (edge === "ltd") addE(rbox(2.64, .3, 1.36, .08), phys({ color: 0xffc933, metalness: 1, roughness: .12, emissive: 0x7a5200, emissiveIntensity: .45 }), 0, -.2, 0);
    else if (edge === "titanf") addE(rbox(2.62, .28, 1.34, .06), std({ color: 0xc9ced6, metalness: 1, roughness: .12 }), 0, -.2, 0);
    else if (edge === "mithril") addE(rbox(2.64, .3, 1.36, .08), phys({ color: 0xcfe6ff, metalness: 1, roughness: .08, emissive: 0x3a6aff, emissiveIntensity: .4 }), 0, -.2, 0);
    else if (edge === "aurora") addE(rbox(2.66, .32, 1.38, .1), phys({ color: 0xb8ffe8, metalness: .6, roughness: .06, clearcoat: 1, emissive: 0xc04aff, emissiveIntensity: .55 }), 0, -.2, 0);
    else if (edge === "neon") addE(rbox(2.62, .28, 1.34, .08), phys({ color: 0x39ff88, roughness: .2, emissive: 0x18c060, emissiveIntensity: .9 }), 0, -.2, 0);
    else if (edge === "carbonf") addE(rbox(2.62, .28, 1.34, .06), std({ color: 0x1e2024, roughness: .35, metalness: .5 }), 0, -.2, 0);
    else if (edge === "rubyf") addE(rbox(2.64, .3, 1.36, .08), phys({ color: 0xc2203a, roughness: .1, clearcoat: 1, emissive: 0x6a0018, emissiveIntensity: .5 }), 0, -.2, 0);
    else if (edge === "blackhole") addE(rbox(2.66, .32, 1.38, .1), phys({ color: 0x120a22, metalness: .9, roughness: .15, emissive: 0x7a2aff, emissiveIntensity: .8 }), 0, -.2, 0);
    else if (edge === "crystal") addE(rbox(2.64, .3, 1.36, .1), phys({ color: 0x66d0ff, transparent: true, opacity: .72, roughness: .05, clearcoat: 1, emissive: 0x1a6a9a, emissiveIntensity: .35 }), 0, -.2, 0);
    const sole = want("sole") ? eq.sole : null;
    if (sole === "tape") add(rbox(2.3, .07, 1.0, .02), std({ color: 0xf4d20a, roughness: .5 }), 0, -.4, 0);
    else if (sole === "wax") add(rbox(2.3, .08, 1.0, .03), phys({ color: 0xfff1c9, roughness: .2, clearcoat: .8 }), 0, -.4, 0);
    else if (sole === "teflon") add(rbox(2.34, .08, 1.04, .03), phys({ color: 0x131316, roughness: .12, clearcoat: 1 }), 0, -.4, 0);
    else if (sole === "ltd") add(rbox(2.36, .1, 1.06, .05), phys({ color: 0xff7a45, roughness: .2, clearcoat: 1, emissive: 0xff3c00, emissiveIntensity: .5 }), 0, -.42, 0);
    else if (sole === "hover") add(rbox(2.34, .1, 1.04, .04), phys({ color: 0xdfffe8, transparent: true, opacity: .6, roughness: .08, emissive: 0x2aff8a, emissiveIntensity: .25 }), 0, -.42, 0);
    else if (sole === "linear") add(rbox(2.36, .1, 1.06, .05), phys({ color: 0x9ad0ff, roughness: .1, clearcoat: 1, emissive: 0x2a6aff, emissiveIntensity: .5 }), 0, -.42, 0);
    else if (sole === "zero") add(rbox(2.4, .12, 1.1, .06), phys({ color: 0xffffff, transparent: true, opacity: .5, roughness: .02, emissive: 0xaad0ff, emissiveIntensity: .6 }), 0, -.43, 0);
    else if (sole === "roller") add(rbox(2.34, .12, 1.04, .05), std({ color: 0x333840, metalness: .7, roughness: .3 }), 0, -.42, 0);
    else if (sole === "gelsole") add(rbox(2.34, .12, 1.04, .05), phys({ color: 0xaef0ff, transparent: true, opacity: .7, roughness: .08 }), 0, -.42, 0);
    else if (sole === "plasma") add(rbox(2.36, .1, 1.06, .05), phys({ color: 0xff6aff, roughness: .1, emissive: 0xc020ff, emissiveIntensity: .9 }), 0, -.42, 0);
    else if (sole === "antigrav") add(rbox(2.4, .12, 1.1, .06), phys({ color: 0xffffff, transparent: true, opacity: .55, roughness: .02, emissive: 0x6affff, emissiveIntensity: .9 }), 0, -.43, 0);
    else if (sole === "air") add(rbox(2.36, .13, 1.06, .06), phys({ color: 0xc4ecff, transparent: true, opacity: .6, roughness: .08 }), 0, -.42, 0);
    const weight = want("weight") ? eq.weight : null;
    if (weight === "coin") add(new T.CylinderGeometry(.3, .3, .06, 32), std({ color: 0xd9a233, metalness: 1, roughness: .3 }), .95, .39, .0);
    else if (weight === "bolt") add(new T.CylinderGeometry(.22, .22, .16, 6), std({ color: 0xaab0b8, metalness: 1, roughness: .3 }), .95, .44, 0);
    else if (weight === "lead") add(rbox(.62, .22, .5, .04), std({ color: 0x4a4d54, metalness: .6, roughness: .5 }), .95, .46, 0);
    else if (weight === "ltd") add(rbox(.66, .28, .52, .05), std({ color: 0x5fe6cf, metalness: 1, roughness: .15, emissive: 0x0a6a5a, emissiveIntensity: .5 }), .95, .49, 0);
    else if (weight === "tungsten") add(rbox(.62, .24, .5, .04), std({ color: 0x6b6f78, metalness: 1, roughness: .25 }), .95, .47, 0);
    else if (weight === "platinum") add(rbox(.66, .28, .52, .05), std({ color: 0xe6edf2, metalness: 1, roughness: .1 }), .95, .49, 0);
    else if (weight === "neutron") add(new T.SphereGeometry(.3, 24, 16), std({ color: 0x9ad0ff, metalness: .5, roughness: .1, emissive: 0x4aa0ff, emissiveIntensity: .9 }), .95, .55, 0);
    else if (weight === "mercury") add(new T.SphereGeometry(.27, 24, 16), std({ color: 0xc9d1d9, metalness: 1, roughness: .05 }), .95, .5, 0);
    else if (weight === "diamondw") add(new T.OctahedronGeometry(.32), phys({ color: 0xcdf3ff, roughness: .02, clearcoat: 1, emissive: 0x4a9ac0, emissiveIntensity: .35 }), .95, .55, 0);
    else if (weight === "osmium") add(rbox(.66, .28, .52, .05), std({ color: 0x3a4a6a, metalness: 1, roughness: .2, emissive: 0x0a1a3a, emissiveIntensity: .4 }), .95, .49, 0);
    else if (weight === "blackholew") add(new T.SphereGeometry(.3, 24, 16), std({ color: 0x050308, metalness: .3, roughness: .3, emissive: 0x7a2aff, emissiveIntensity: 1 }), .95, .55, 0);
    else if (weight === "gold") add(rbox(.66, .28, .52, .05), std({ color: 0xffc933, metalness: 1, roughness: .18 }), .95, .49, 0);
    if (mutKey) {   // ミューテーション：ゴールド・ダイヤ・レインボーの光をつける（レインボーは、色がだんだん変わる）
      const glow = { g: 0xc89000, d: 0x2ab0ff, r: 0xff40c0 }[mutKey];
      g.userData.mut = mutKey; g.userData.mats = [];
      g.traverse((o) => { if (o.material && o.material.emissive) { o.material.emissive.set(glow); o.material.emissiveIntensity = Math.max(o.material.emissiveIntensity || 0, mutKey === "r" ? .6 : .5); g.userData.mats.push(o.material); } });
    }
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

/* パーツ単体の3D表示（ベルトコンベアで流れるパーツ・買う前の確認画面）。1つの canvas に、いくつものパーツを置いて、ゆっくり回す。
   ・座標は画面のピクセル（x：左から、y：上から）。add(key, slot, id, rarity, size) で置き、move(key, x, y) で動かし、remove(key) で外す。
   ・three.js が読めない端末では null を返す（呼び出し側が、平らな絵を出す）。 */
export async function createPartsStage(container) {
  if (!(await load3D())) return null;
  const { T, RBG } = three();
  let renderer;
  try { renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" }); } catch (_) { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.outputColorSpace = T.SRGBColorSpace;
  const canvas = renderer.domElement; canvas.className = "yk2-gl"; canvas.style.pointerEvents = "none"; container.appendChild(canvas);
  const scene = new T.Scene(), cam = new T.OrthographicCamera(-100, 100, 100, -100, -2000, 2000); cam.position.z = 1000;
  scene.add(new T.HemisphereLight(0xffffff, 0x8a6a40, 1.1));
  const sun = new T.DirectionalLight(0xffffff, 2.2); sun.position.set(-3, 6, 4); scene.add(sun);
  const kit = eraserKit(T, RBG);
  { const env = kit.environment(renderer); if (env) scene.environment = env; }
  const items = new Map(); let W = 0, H = 0, alive = true;
  const reduced = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } })();
  const DEFAULT = { body: "plain", edge: "paper", sole: "bare", weight: "none" };
  function measure() {
    const r = container.getBoundingClientRect(), w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === W && h === H) return; W = w; H = h; renderer.setSize(w, h, false); canvas.style.width = w + "px"; canvas.style.height = h + "px";
    Object.assign(cam, { left: -w / 2, right: w / 2, top: h / 2, bottom: -h / 2 }); cam.updateProjectionMatrix();
  }
  return {
    add(key, slot, id, rarity, size) {
      if (items.has(key)) return;
      const g = kit.build({ ...DEFAULT, [slot]: id }, 0, slot);
      const box = new T.Box3().setFromObject(g), c = box.getCenter(new T.Vector3()), s = box.getSize(new T.Vector3());
      g.position.sub(c);
      const pivot = new T.Group(); pivot.add(g);
      const fit = (size || (slot === "weight" ? 46 : 86)) / Math.max(s.x, s.y, s.z, .01);
      pivot.scale.setScalar(fit);
      if (rarity && rarity !== "N") {   // レアは、足もとにやわらかい光の輪
        const col = { R: 0x4aa0e0, SR: 0xa56bff, UR: 0xffcf33, LR: 0xff7ae0 }[rarity];
        const halo = new T.Mesh(new T.CircleGeometry(Math.max(s.x, s.z) * .62, 32), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: .35, depthWrite: false }));
        halo.rotation.x = -Math.PI / 2; halo.position.y = -s.y / 2 - .05; pivot.add(halo);
      }
      scene.add(pivot);
      items.set(key, { pivot, spin: (items.size * 1.7) % 6, fit, rainbow: g.userData.mut === "r" ? g.userData.mats : null });
    },
    move(key, x, y) { const it = items.get(key); if (it) it.pivot.position.set(x - W / 2, H / 2 - y, 0); },
    remove(key) { const it = items.get(key); if (!it) return; scene.remove(it.pivot); kit.disposeGroup(it.pivot); items.delete(key); },
    has: (key) => items.has(key),
    render(t) {
      if (!alive) return; measure();
      items.forEach((it) => { it.pivot.rotation.set(.5, reduced ? .6 : it.spin + t / 1800, 0); if (it.rainbow) it.rainbow.forEach((m) => m.emissive.setHSL((t / 1500) % 1, 1, .5)); });
      renderer.render(scene, cam);
    },
    dispose() { alive = false; items.forEach((it) => kit.disposeGroup(it.pivot)); items.clear(); renderer.dispose(); canvas.remove(); }
  };
}
