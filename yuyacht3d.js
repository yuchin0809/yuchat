/* =========================================================
   🎲 ヨットの3Dサイコロ（three.js）：見た目だけ。サイコロの目・点数はすべて Worker が決める
   ・角の丸いサイコロを、光と影つきで描く。カップから転がり出る動き（弧を描いて跳ねながら回って止まる）は、
     決まった目に向かって落ち着くように作った動き（物理計算ではない）なので、必ずサーバーが決めた目で止まる。
   ・three.js（vendor/three.module.min.js）は、ヨットを開いたときに初めて読み込む。読めない端末は、これまでの CSS の立体サイコロで表示する。
   ・画面の並び（上の段・赤いフェルトのマス・カップ）は、yuyacht.js の DOM のまま。ここでは、そのマスの上に重ねる透明な canvas にサイコロを描くだけ。
========================================================= */
let T = null, RBG = null, loading = null;
export function load3D() {
  if (!loading) {
    loading = Promise.all([import("./vendor/three.module.min.js"), import("./vendor/RoundedBoxGeometry.js")])
      .then(([three, rb]) => { T = three; RBG = rb.RoundedBoxGeometry; return true; })
      .catch(() => false);
  }
  return loading;
}

/* 同じ three.js を、消しバトの消しゴムの表示でも使う */
export const three = () => ({ T, RBG });

const PIP = { 1: [[.5, .5]], 2: [[.27, .27], [.73, .73]], 3: [[.27, .27], [.5, .5], [.73, .73]], 4: [[.27, .27], [.73, .27], [.27, .73], [.73, .73]], 5: [[.27, .27], [.73, .27], [.5, .5], [.27, .73], [.73, .73]], 6: [[.27, .25], [.73, .25], [.27, .5], [.73, .5], [.27, .75], [.73, .75]] };
/* 立方体の面（BoxGeometry の面の順：+x, -x, +y, -y, +z, -z）に貼る目。向かい合う面の和が7になるように */
const FACE_VALUES = [3, 4, 2, 5, 1, 6];
function faceTexture(v) {
  const c = document.createElement("canvas"); c.width = c.height = 256;
  const g = c.getContext("2d");
  const bg = g.createRadialGradient(100, 90, 20, 128, 128, 210);
  bg.addColorStop(0, "#fffefa"); bg.addColorStop(1, "#e6e0d2");
  g.fillStyle = bg; g.fillRect(0, 0, 256, 256);
  for (const [x, y] of PIP[v]) {
    const r = v === 1 ? 40 : 25, px = x * 256, py = y * 256;
    const d = g.createRadialGradient(px - r * .3, py - r * .35, r * .1, px, py, r);   // くぼんだ目に見える陰影
    if (v === 1) { d.addColorStop(0, "#ff5a4d"); d.addColorStop(1, "#a50f0f"); } else { d.addColorStop(0, "#4a4a4d"); d.addColorStop(1, "#050506"); }
    g.fillStyle = d; g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(0,0,0,.25)"; g.lineWidth = 2; g.beginPath(); g.arc(px, py, r + 1, 0, Math.PI * 2); g.stroke();
  }
  const tex = new T.CanvasTexture(c);
  tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

const reduced = () => { try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; } };
const ease = (t) => 1 - Math.pow(1 - t, 3);

export class DiceStage {
  constructor() {
    this.canvas = document.createElement("canvas"); this.canvas.className = "yy-gl";
    this.renderer = new T.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.scene = new T.Scene();
    this.camera = new T.PerspectiveCamera(24, 1, 1, 60);
    const a = (58 * Math.PI) / 180;
    this.camera.position.set(0, 16 * Math.sin(a), 16 * Math.cos(a)); this.camera.lookAt(0, 0, 0);
    this.scene.add(new T.HemisphereLight(0xffffff, 0x8a3a3a, 1.0));
    const sun = new T.DirectionalLight(0xffffff, 2.1);
    sun.position.set(-3, 9, 4); sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.radius = 5; sun.shadow.bias = -0.0008;
    Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 1, far: 30 });
    this.scene.add(sun);
    const ground = new T.Mesh(new T.PlaneGeometry(60, 60), new T.ShadowMaterial({ opacity: .5 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground);
    this.plane = new T.Plane(new T.Vector3(0, 1, 0), 0);
    this.ray = new T.Raycaster();
    const geo = new RBG(1, 1, 1, 5, 0.14);
    this.textures = [1, 2, 3, 4, 5, 6].map(faceTexture);
    this.dice = [0, 1, 2, 3, 4].map(() => {
      const mats = FACE_VALUES.map((v) => new T.MeshStandardMaterial({ map: this.textures[v - 1], roughness: .34, metalness: 0, emissive: 0x000000 }));
      const mesh = new T.Mesh(geo, mats); mesh.castShadow = true; mesh.visible = false; this.scene.add(mesh);
      const ring = new T.Mesh(new T.RingGeometry(.66, .74, 48), new T.MeshBasicMaterial({ color: 0xffd400, transparent: true, opacity: .9, side: T.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.visible = false; this.scene.add(ring);
      return { mesh, ring, mats, value: 0, hold: false, vis: false, px: 0, py: 0, size: 0, anim: null, hit: false };
    });
    this.W = 0; this.H = 0; this.raf = 0; this.animKey = ""; this.container = null;
    this.ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { if (this.container && this.measure()) this.render(); }) : null;
  }
  mount(container) {
    if (this.container !== container) { if (this.ro && this.container) this.ro.unobserve(this.container); this.container = container; if (this.ro) this.ro.observe(container); }
    if (this.canvas.parentNode !== container) container.appendChild(this.canvas);
    this.measure();
  }
  measure() {
    const r = this.container.getBoundingClientRect();
    const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
    this.box = r;
    if (W === this.W && H === this.H) return false;
    this.W = W; this.H = H;
    this.renderer.setSize(W, H, false); this.canvas.style.width = W + "px"; this.canvas.style.height = H + "px";
    this.camera.aspect = W / H; this.camera.updateProjectionMatrix();
    return true;
  }
  /* 画面のピクセル位置 → フェルトの面（y=0）の上の位置 */
  s2w(px, py, out) {
    this.ray.setFromCamera({ x: (px / this.W) * 2 - 1, y: -((py / this.H) * 2 - 1) }, this.camera);
    return this.ray.ray.intersectPlane(this.plane, out) || out;
  }
  center(el) { const r = el.getBoundingClientRect(); return { x: r.left - this.box.left + r.width / 2, y: r.top - this.box.top + r.height / 2, w: r.width, h: r.height }; }
  qFor(v, yaw) {
    const q = new T.Quaternion(), e = new T.Euler();
    if (v === 5) e.set(Math.PI, 0, 0); else if (v === 3) e.set(0, 0, Math.PI / 2); else if (v === 4) e.set(0, 0, -Math.PI / 2); else if (v === 1) e.set(-Math.PI / 2, 0, 0); else if (v === 6) e.set(Math.PI / 2, 0, 0);
    q.setFromEuler(e);
    return new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), yaw).multiply(q);
  }
  /* o：{ dice, hold, phase, shown, hl, anim("pour"|"in"|""), animKey } 。マスの位置は、container の中の .yy-slot（上の段）・.yy-spot（赤いフェルト）・.yy-cup から読む */
  sync(o) {
    if (!this.container) return;
    this.measure();
    const slots = [...this.container.querySelectorAll(".yy-slot")], spots = [...this.container.querySelectorAll(".yy-spot")].slice(0, 5), cupEl = this.container.querySelector(".yy-cup");
    if (slots.length < 5 || spots.length < 5) return;
    const cup = cupEl ? this.center(cupEl) : { x: this.W * .8, y: this.H * .85, w: 40, h: 40 };
    const start = o.anim && o.animKey !== this.animKey;
    if (o.anim) this.animKey = o.animKey;
    const now = performance.now(), fast = reduced();
    const seeDice = o.phase === "pour" || o.phase === "in" || (o.phase === "idle" && o.shown);
    o.dice.forEach((v, i) => {
      const d = this.dice[i], held = !!o.hold[i];
      const base = held ? this.center(slots[i]) : this.center(spots[i]);
      const size = held ? Math.min(base.w, base.h) * .52 : Math.min(base.w, base.h * .82) * .6;
      const tx = base.x, ty = held ? base.y + Math.min(6, base.h * .06) : base.y - Math.min(10, base.h * .08);
      const vis = held || seeDice;
      d.hit = !!(o.hl && o.hl[i]);
      const changedValue = d.value !== v;
      const wasHeld = d.hold;
      d.hold = held; d.size = size;
      d.mats.forEach((m) => { m.emissive.setHex(d.hit ? 0x7a5a00 : 0x000000); m.emissiveIntensity = d.hit ? .55 : 0; });
      if (!vis) { if (!(d.anim && d.anim.kind === "in")) { d.vis = false; d.anim = null; } d.value = v; return; }
      if (start && o.anim === "pour" && !held) {
        d.vis = true; d.value = v;
        d.anim = { kind: "pour", t0: now + (fast ? 0 : i * 45), dur: fast ? 1 : 780, sx: cup.x, sy: cup.y, tx, ty, yaw: (i * 1.7 + v) % (Math.PI * 2), axis: new T.Vector3(Math.sin(i * 2.3 + 1), Math.cos(i * 1.9 + 2) * .7 + .2, Math.sin(i * 1.1 + v)).normalize(), turns: 2.2 + (i % 3) * .5, hop: .9 + (i % 2) * .25 };
        d.px = cup.x; d.py = cup.y; d.yaw = d.anim.yaw;
      } else if (start && o.anim === "in" && !held && d.vis) {
        d.anim = { kind: "in", t0: now + (fast ? 0 : i * 20), dur: fast ? 1 : 260, sx: d.px, sy: d.py, tx: cup.x, ty: cup.y, yaw: d.anim ? d.anim.yaw : 0 };
      } else if (d.anim && d.anim.kind === "pour") {
        d.anim.tx = tx; d.anim.ty = ty;   // 動いている最中に画面の大きさが変わっても、止まる位置はいまのマス
      } else if (!d.anim || d.anim.kind !== "in") {
        // 止まっている：キープの切り替え（上の段へ・フェルトへ）はそっと動かす。目が変わっただけ・描き直しだけなら、その場に置く
        if (d.vis && wasHeld !== held && !fast) d.anim = { kind: "move", t0: now, dur: 260, sx: d.px, sy: d.py, tx, ty, yaw: d.yaw || 0 };
        else { d.px = tx; d.py = ty; d.anim = null; }
        d.vis = true; d.value = v;
      }
      if (d.vis) d.yaw = d.yaw == null ? ((i * 1.7 + v) % (Math.PI * 2)) : d.yaw;
    });
    this.place(now);
    this.render();
    if (this.dice.some((d) => d.anim)) this.loop();
  }
  place(now) {
    const p = new T.Vector3(), p2 = new T.Vector3();
    this.dice.forEach((d) => {
      d.ring.visible = false;
      if (!d.vis) { d.mesh.visible = false; return; }
      let px = d.px, py = d.py, lift = 0, scale = 1, q = null;
      const an = d.anim;
      if (an) {
        const t = Math.min(1, Math.max(0, (now - an.t0) / an.dur));
        if (now < an.t0 && an.kind === "pour") { d.mesh.visible = false; return; }
        const e = ease(t);
        px = an.sx + (an.tx - an.sx) * e; py = an.sy + (an.ty - an.sy) * e;
        if (an.kind === "pour") {
          lift = an.hop * Math.abs(Math.sin(Math.PI * (2.2 * t))) * Math.pow(1 - t, 1.6) + .55 * Math.sin(Math.PI * Math.min(1, t * 1.6)) * (1 - t);   // 弧を描いて、跳ねながら小さくなる
          const spin = (1 - e) * an.turns * Math.PI * 2;
          q = new T.Quaternion().setFromAxisAngle(an.axis, spin).multiply(this.qFor(d.value, an.yaw));
          scale = .55 + .45 * Math.min(1, t * 3);
        } else if (an.kind === "in") { scale = 1 - .75 * e; lift = .5 * Math.sin(Math.PI * t); q = this.qFor(d.value, an.yaw || 0); }
        else { lift = .6 * Math.sin(Math.PI * t); q = this.qFor(d.value, an.yaw || 0); }
        d.px = px; d.py = py;
        if (t >= 1) { const kind = an.kind; d.anim = null; d.px = an.tx; d.py = an.ty; if (kind === "in") { d.vis = false; d.mesh.visible = false; return; } }
      }
      this.s2w(px, py, p); this.s2w(px + 1, py, p2);
      const wpp = Math.abs(p2.x - p.x) || .01, S = d.size * wpp * scale;
      d.mesh.visible = true; d.mesh.scale.setScalar(S);
      d.mesh.position.set(p.x, S / 2 + lift * S, p.z);
      d.mesh.quaternion.copy(q || this.qFor(d.value, d.yaw || 0));
      if (d.hit && !an) { d.ring.visible = true; d.ring.position.set(p.x, .005, p.z); d.ring.scale.setScalar(S * 1.25); }
    });
  }
  loop() {
    if (this.raf) return;
    const step = () => {
      this.raf = 0;
      if (!this.container || !this.container.isConnected) return;
      this.place(performance.now()); this.render();
      if (this.dice.some((d) => d.anim)) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }
  render() { this.renderer.render(this.scene, this.camera); }
}
