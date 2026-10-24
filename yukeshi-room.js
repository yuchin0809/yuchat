/* =========================================================
   消しバト 2人対戦（ゲームルーム）：script.js の renderCurrentGame から、ルームが更新されるたびに呼ばれる
   ・消しゴムの位置・勝ち負け・手番は、Worker が gameRooms/{roomId} の keshi に書く（ブラウザは「どの向きに、どれだけの強さで弾くか」を頼むだけ）。
   ・弾いたあとの動きは、サーバーと同じ計算（yukeshi-core.js の keshiSimStepper）で、画面で1コマずつ再生する。相手の画面には、ルームの監視で届く。
   ・弾き方：自分の番に、画面を指で後ろへ引っ張って、はなす（弱く引くと弱く、強く引くと強く弾く）。引いた向きと反対へ飛ぶ。
   ・3Dの机と消しゴムは three.js（ヨットと同じもの）。3D が使えない端末では、対戦できない（メッセージを出す）。
========================================================= */
import { load3D, three } from "./yuyacht3d.js?v=20261023-3d1";
import { eraserKit } from "./yukeshi3d.js?v=20261024-mart1";
import { keshiSimStepper, KESHI_DESK, KESHI_DT, eraserIcon } from "./yukeshi-core.js?v=20261024-mart1";

const TOP_Y = -0.4;   // 机の上の面の高さ
const ERASER_SCALE = 0.57;   // 机の上の消しゴムの大きさ（1人用の改造の画面の消しゴムを、この倍率に小さくする）
const START_YAW = [Math.PI / 2, -Math.PI / 2];   // はじめは、おたがいに向かい合う
const yawOf = (dx, dz) => Math.atan2(-dz, dx);   // 消しゴムの長い辺（x）を、(dx,dz) の向きにそろえる回転

let stylesDone = false;
const kr = { roomId: "", gid: "", y: null, offset: 0, tm: null, sentKey: "", started: "", error: "", stage: null, stageFail: false, stageBuilding: false, seenN: -1, anim: false, hold: false, busy: false, poses: null, banner: "", lastKey: "" };

/* ---------------------------------------------------------
   3Dの机と消しゴム
--------------------------------------------------------- */
export async function createBattleStage(container, { me, eq, color }) {
  if (!(await load3D())) return null;
  const { T, RBG } = three();
  let renderer;
  try { renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" }); } catch (_) { return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = T.PCFSoftShadowMap; renderer.outputColorSpace = T.SRGBColorSpace;
  const canvas = renderer.domElement; canvas.className = "kb-gl"; container.appendChild(canvas);
  const scene = new T.Scene(), kit = eraserKit(T, RBG);
  const camera = new T.PerspectiveCamera(32, 1, .5, 80);
  scene.add(new T.HemisphereLight(0xffffff, 0x9a7a52, 1.0));
  const sun = new T.DirectionalLight(0xffffff, 2.3); sun.position.set(-4, 11, 5); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 4; sun.shadow.bias = -0.0006;
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 13, bottom: -13, near: 2, far: 60 }); scene.add(sun);
  { const env = kit.environment(renderer); if (env) scene.environment = env; }

  /* 机：木目 */
  const wood = (() => {
    const c = document.createElement("canvas"); c.width = 256; c.height = 512; const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 256, 0); grad.addColorStop(0, "#c9944f"); grad.addColorStop(.5, "#d6a560"); grad.addColorStop(1, "#c28b47"); g.fillStyle = grad; g.fillRect(0, 0, 256, 512);
    let r = 777; const rnd = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
    for (let i = 0; i < 70; i++) { g.strokeStyle = `rgba(${90 + rnd() * 40 | 0},${52 + rnd() * 30 | 0},20,${.08 + rnd() * .12})`; g.lineWidth = .6 + rnd() * 1.6; const x = rnd() * 256; g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + (rnd() - .5) * 24, 170, x + (rnd() - .5) * 24, 340, x + (rnd() - .5) * 10, 512); g.stroke(); }
    g.fillStyle = "rgba(255,255,255,.22)"; g.fillRect(0, 254, 256, 3);   // まんなかの線
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return t;
  })();
  const { hw, hd } = KESHI_DESK;
  const desk = new T.Mesh(new RBG(hw * 2, .5, hd * 2, 4, .08), new T.MeshStandardMaterial({ map: wood, roughness: .62 }));
  desk.position.y = TOP_Y - .25; desk.receiveShadow = true; desk.castShadow = true; scene.add(desk);
  const floor = new T.Mesh(new T.PlaneGeometry(60, 60), new T.ShadowMaterial({ opacity: .3 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -3.4; floor.receiveShadow = true; scene.add(floor);

  /* 消しゴム2個（それぞれ、位置・向き・落ちる動きを自由に決められる） */
  const items = [0, 1].map((i) => {
    const holder = new T.Group(), model = kit.build(eq[i], color[i]); model.scale.setScalar(ERASER_SCALE); model.position.y = TOP_Y * (1 - ERASER_SCALE); holder.add(model); scene.add(holder);   // 消しゴムは小さめ（机の上の面に、底がつくように下げる）
    const ring = new T.Mesh(new T.RingGeometry(.92, 1.1, 40), new T.MeshBasicMaterial({ color: 0xffc933, transparent: true, opacity: .85, side: T.DoubleSide })); ring.rotation.x = -Math.PI / 2; ring.position.y = TOP_Y + .01; ring.visible = false; scene.add(ring);
    return { holder, model, ring };
  });
  /* 狙いの矢印（弾く向きと強さ） */
  const arrow = new T.Group(), shaftMat = new T.MeshBasicMaterial({ color: 0x33cc55 });
  const shaft = new T.Mesh(new T.BoxGeometry(1, .07, .2), shaftMat), head = new T.Mesh(new T.ConeGeometry(.32, .6, 16), shaftMat); head.rotation.z = -Math.PI / 2;
  arrow.add(shaft, head); arrow.visible = false; arrow.position.y = TOP_Y + .05; scene.add(arrow);

  const hooks = { canAim: () => false, onAim: () => {}, onFire: () => {}, ticker: null };
  const poseState = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
  const pops = [];
  let W = 0, H = 0, raf = 0, last = 0, alive = true, aim = null, drag = null, dirty = true;

  function fit() {
    const r = container.getBoundingClientRect(), w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (w === W && h === H) return; W = w; H = h; renderer.setSize(w, h, false); canvas.style.width = w + "px"; canvas.style.height = h + "px";
    const aspect = w / h; camera.aspect = aspect; camera.fov = 32;
    const half = Math.tan(16 * Math.PI / 180), dist = Math.max(KESHI_DESK.hd * 1.86 / (2 * half), KESHI_DESK.hw * 2.39 / (2 * half * aspect)), el = 54 * Math.PI / 180, side = me === 1 ? -1 : 1;
    camera.position.set(0, TOP_Y + Math.sin(el) * dist, side * Math.cos(el) * dist + side * .4); camera.lookAt(0, TOP_Y, side * .35);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld(); dirty = true;
  }
  const ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 1, 0), -TOP_Y), hit = new T.Vector3();
  function toWorld(cx, cy) {
    const r = canvas.getBoundingClientRect(); ray.setFromCamera({ x: ((cx - r.left) / r.width) * 2 - 1, y: -((cy - r.top) / r.height) * 2 + 1 }, camera);
    return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
  }
  function applyPose(i, p) {
    const it = items[i]; poseState[i].x = p.x; poseState[i].z = p.z;
    it.holder.visible = p.visible !== false;
    it.holder.position.set(p.x + (p.ox || 0), (p.y || 0), p.z + (p.oz || 0));
    it.model.rotation.set(0, p.yaw || 0, 0); it.holder.rotation.set(p.tx || 0, 0, p.tz || 0);
    const s = p.scale == null ? 1 : p.scale; it.holder.scale.set(s, s, s);
    dirty = true;
  }
  function setAim(a, yaw) {
    aim = a;
    if (!a) { arrow.visible = false; dirty = true; return; }
    const o = poseState[me < 0 ? 0 : me], len = .5 + a.p * 3.4, n = Math.hypot(a.dx, a.dz) || 1, dx = a.dx / n, dz = a.dz / n;
    arrow.position.set(o.x, TOP_Y + .05, o.z); arrow.rotation.y = yawOf(dx, dz);
    shaft.scale.x = len; shaft.position.x = .85 + len / 2; head.position.x = .85 + len + .3;
    shaftMat.color.setHSL(.33 * (1 - Math.min(1, a.p)), .9, .5); arrow.visible = true; dirty = true;
  }
  function frame(t) {
    raf = 0;
    if (!alive) return;
    if (!container.isConnected) { api.dispose(); return; }
    const dt = last ? Math.min(.1, (t - last) / 1000) : 0; last = t;
    fit();
    let more = false;
    if (hooks.ticker) { if (hooks.ticker(dt)) more = true; else hooks.ticker = null; dirty = true; }
    for (let k = pops.length - 1; k >= 0; k--) { const p = pops[k]; p.t += dt; const u = Math.min(1, p.t / .35), s = u < 1 ? 1 - Math.pow(1 - u, 3) * Math.cos(u * 9) : 1; items[p.i].holder.scale.set(s, s, s); if (u >= 1) pops.splice(k, 1); else more = true; dirty = true; }
    if (dirty) { renderer.render(scene, camera); dirty = false; }
    if (more || drag) raf = requestAnimationFrame(frame); else last = 0;
  }
  const wake = () => { if (!raf && alive) raf = requestAnimationFrame(frame); };

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    if (!hooks.canAim()) return;
    const w0 = toWorld(e.clientX, e.clientY); if (!w0) return;
    drag = { sx: e.clientX, sy: e.clientY, w0, a: null }; canvas.setPointerCapture?.(e.pointerId); wake();
  });
  const pull = (e) => {
    if (!drag) return null;
    const rect = canvas.getBoundingClientRect(), px = Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy), max = Math.max(60, .3 * Math.min(rect.width, rect.height));
    if (px < 10) return null;
    const w1 = toWorld(e.clientX, e.clientY); if (!w1) return null;
    const dx = drag.w0.x - w1.x, dz = drag.w0.z - w1.z;   // 引いた向きと反対へ飛ぶ
    if (Math.hypot(dx, dz) < 1e-4) return null;
    return { dx, dz, p: Math.min(1, px / max) };
  };
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const a = pull(e); drag.a = a; hooks.onAim(a); setAim(a);
    if (a) hooks.pose && hooks.pose(a, a.p * .7); else hooks.onCancel && hooks.onCancel();   // 引いた分だけ、消しゴムが後ろへ下がる
  });
  const end = (e, fire) => {
    if (!drag) return; const a = fire ? pull(e) : null; drag = null; setAim(null); hooks.onAim(null);
    if (a && a.p >= .05) hooks.onFire(a); else hooks.onCancel && hooks.onCancel();
    wake();
  };
  canvas.addEventListener("pointerup", (e) => end(e, true)); canvas.addEventListener("pointercancel", (e) => end(e, false));
  fit(); renderer.render(scene, camera);

  const api = {
    hooks, container, pose: applyPose, aim: setAim, wake, ringOn(i) { items.forEach((it, k) => { it.ring.visible = k === i; }); dirty = true; wake(); },
    ringAt(i, x, z) { items[i].ring.position.set(x, TOP_Y + .01, z); dirty = true; wake(); },
    pop(i) { items[i].holder.scale.set(.01, .01, .01); pops.push({ i, t: 0 }); dirty = true; wake(); },
    setTicker(fn) { hooks.ticker = fn; wake(); },
    render() { dirty = true; wake(); },
    dispose() { alive = false; if (raf) cancelAnimationFrame(raf); items.forEach((it) => kit.disposeGroup(it.holder)); wood.dispose(); renderer.dispose(); canvas.remove(); if (kr.stage === api) kr.stage = null; }
  };
  return api;
}

/* ---------------------------------------------------------
   画面
--------------------------------------------------------- */
export function renderKeshiRoom(boardEl, room, c) {
  injectStyles();
  kr.api = c.api; kr.uid = c.uid; kr.esc = c.esc; kr.boardEl = boardEl;
  if (kr.roomId !== room.id) { disposeStage(); Object.assign(kr, { roomId: room.id, gid: "", y: null, sentKey: "", started: "", error: "", seenN: -1, anim: false, hold: false, busy: false, banner: "", lastKey: "", stageFail: false }); }
  const uids = Array.isArray(room.memberUids) ? room.memberUids : [];
  if (room.status !== "playing" || uids.length < 2) {
    stopTimer(); disposeStage(); kr.y = null;
    boardEl.innerHTML = `<div class="kb-card kb-msg">${eraserIcon("kb-ico")}<b>対戦相手を待っています…</b><p>2人そろうと、自動でゲームが始まります。上の「友達を招待」から誘うか、ルーム一覧から参加してもらおう。</p></div>`;
    return;
  }
  const y = room.keshi, sameOrder = y && Array.isArray(y.order) && y.order[0] === uids[0] && y.order[1] === uids[1];
  if (!sameOrder) {
    stopTimer(); disposeStage(); kr.y = null;
    const k = uids.join(",");
    if (kr.started !== k) { kr.started = k; start(false); }
    boardEl.innerHTML = kr.error ? errorHtml() : `<div class="kb-card kb-msg">ゲームを準備しています…</div>`;
    return;
  }
  accept(y);
}
function errorHtml() {
  const msg = kr.error === "not_published" ? "消しバトは準備中のため、まだ遊べません。" : "ゲームを始められませんでした。通信環境をご確認のうえ、ルームを開き直してください。";
  return `<div class="kb-card kb-msg"><b>${kr.esc(msg)}</b></div>`;
}
async function start(rematch) {
  try { const r = await kr.api("keshiRoomStart", { roomId: kr.roomId, ...(rematch ? { rematch: true } : {}) }); kr.error = ""; if (r.keshi) accept(r.keshi); }
  catch (e) { kr.error = (e && e.code) || "error"; if (kr.boardEl && !kr.y) kr.boardEl.innerHTML = errorHtml(); }
}
const $ = (s) => kr.boardEl && kr.boardEl.querySelector(s);
const roomNow = () => Date.now() + kr.offset;
const myIdx = () => (kr.y ? kr.y.order.indexOf(kr.uid) : -1);
function stopTimer() { if (kr.tm) { clearInterval(kr.tm); kr.tm = null; } }
function disposeStage() { if (kr.stage) { try { kr.stage.dispose(); } catch (_) {} kr.stage = null; } kr.stageBuilding = false; }

/* ルームの更新（監視・自分の操作の返事）を受け取る */
function accept(y) {
  if (kr.y && y.gid === kr.y.gid && y.at < kr.y.at) return;   // 古い知らせは捨てる
  const fresh = !kr.y || y.gid !== kr.y.gid;
  kr.y = y; kr.offset = y.at - Date.now();
  if (fresh) { kr.gid = y.gid; kr.seenN = y.last ? y.last.n : 0; kr.sentKey = ""; kr.busy = false; kr.anim = false; kr.hold = false; kr.banner = ""; kr.lastKey = ""; disposeStage(); }
  ensureShell();
  sync();
}
function ensureShell() {
  const el = kr.boardEl;
  if (el.querySelector(".kb-root") && kr.stage && kr.stage.container.isConnected) return;
  if (!el.querySelector(".kb-root")) {
    el.innerHTML = `<div class="kb-root"><div class="kb-top" id="kbTop"></div><div class="kb-turn" id="kbTurn"></div>
      <div class="kb-stage" id="kbStage"><div class="kb-loading">${eraserIcon("kb-ico")}<span>机を準備しています…</span></div><div class="kb-banner" id="kbBanner"></div><div class="kb-power" id="kbPower"><i></i></div></div>
      <p class="kb-hint" id="kbHint"></p><div id="kbResult"></div></div>`;
    disposeStage();
  }
  sizeStage();
  if (!kr.stage && !kr.stageBuilding && !kr.stageFail) buildStage();
}
/* 机の画面の大きさは、いっぱいまで大きく、そのうえで固定する（px で決めて、あとから勝手に変えない）。
   ・横は、ルームの幅いっぱい。縦横の比は 5:7。ただし、高さは、画面の高さの 92% までにおさめる。
   ・以前は「幅 100%・高さ 80vh まで」だったので、スクロールでアドレスバーが出入りする・スクロールバーが出る・下の結果の欄が増える、などで、
     そのたびに大きさが変わっていた。いまは、画面の幅が変わったとき（向きを変えたとき）だけ、決め直す。 */
function sizeStage() {
  const host = $("#kbStage");
  if (!host) return;
  const avail = Math.floor((host.parentElement && host.parentElement.clientWidth) || host.clientWidth || 0);
  if (avail < 100) return;   // まだ画面に出ていない：出てから決める
  const w = Math.max(220, Math.min(avail, Math.floor(window.innerHeight * 0.92 * 5 / 7)));
  host.style.width = w + "px"; host.style.height = Math.round(w * 7 / 5) + "px";
  kr.sizedFor = window.innerWidth;
  if (kr.stage) kr.stage.render();
  if (!kr.onResize) {
    let tm = null;
    kr.onResize = () => {
      clearTimeout(tm);
      tm = setTimeout(() => { if (window.innerWidth !== kr.sizedFor && document.body.contains(kr.boardEl)) sizeStage(); }, 200);   // 高さだけの変化（アドレスバーの出入りなど）では、決め直さない
    };
    window.addEventListener("resize", kr.onResize);
    window.addEventListener("orientationchange", kr.onResize);
  }
}
async function buildStage() {
  kr.stageBuilding = true;
  const y = kr.y, me = myIdx(), my = kr.gid, host = $("#kbStage");
  try {
    const st = await createBattleStage(host, { me, eq: y.eq, color: y.color });
    if (!st || kr.gid !== my || !host.isConnected) { if (st) st.dispose(); if (!st) { kr.stageFail = true; host.querySelector(".kb-loading")?.replaceChildren(document.createTextNode("この端末では3Dが使えないため、対戦できません。")); } kr.stageBuilding = false; return; }
    host.querySelector(".kb-loading")?.remove();
    kr.stage = st; kr.stageBuilding = false; kr.poses = null; wireStage(); sync();
  } catch (_) { kr.stageFail = true; kr.stageBuilding = false; host.querySelector(".kb-loading")?.replaceChildren(document.createTextNode("3Dの準備に失敗しました。開き直してください。")); }
}
function wireStage() {
  const st = kr.stage, power = $("#kbPower");
  st.hooks.canAim = () => canAim();
  st.hooks.onAim = (a) => { if (power) { power.classList.toggle("on", !!a); const i = power.querySelector("i"); if (i && a) i.style.width = Math.round(a.p * 100) + "%"; } };
  st.hooks.onCancel = () => { restPose(myIdx()); };
  st.hooks.pose = (a, back) => { const i = myIdx(), n = Math.hypot(a.dx, a.dz) || 1; if (!kr.poses || i < 0) return; kr.poses[i].yaw = yawOf(a.dx, a.dz); st.pose(i, { ...kr.poses[i], ox: -a.dx / n * back, oz: -a.dz / n * back }); };
  st.hooks.onFire = (a) => fire(a);
}
const canAim = () => { const y = kr.y; return !!(y && !y.done && y.order[y.cur] === kr.uid && !kr.anim && !kr.hold && !kr.busy && kr.stage); };
const onDesk = (p) => Math.abs(p[0]) <= KESHI_DESK.hw && Math.abs(p[1]) <= KESHI_DESK.hd;   // 机から落ちた消しゴムは、描かない
function restPose(i) { if (kr.stage && kr.poses && i >= 0) kr.stage.pose(i, kr.poses[i]); }
function setPoses(pos, { pop = false } = {}) {
  const st = kr.stage; if (!st) return;
  if (!kr.poses) kr.poses = [{ x: 0, z: 0, yaw: START_YAW[0] }, { x: 0, z: 0, yaw: START_YAW[1] }];
  [0, 1].forEach((i) => { kr.poses[i] = { x: pos[i][0], z: pos[i][1], yaw: pop || kr.poses[i].yaw == null ? START_YAW[i] : kr.poses[i].yaw }; st.pose(i, { ...kr.poses[i], visible: onDesk(pos[i]) }); if (pop) st.pop(i); });
  st.render();
}

/* いまの状態を、画面に合わせる（再生中は、終わってから） */
function sync() {
  const y = kr.y, st = kr.stage;
  if (!y) return;
  drawHud();
  if (!st) return;
  if (kr.anim || kr.hold) return;   // 再生のあとで、もう一度ここに来る
  if (y.last && y.last.n > kr.seenN && y.last.from) { kr.seenN = y.last.n; play(y); return; }
  if (!kr.poses || kr.lastKey !== `${y.gid}:${y.bout}:${y.flicks}:${y.last ? y.last.n : 0}`) { kr.lastKey = `${y.gid}:${y.bout}:${y.flicks}:${y.last ? y.last.n : 0}`; setPoses(y.pos); }
  st.ringOn(y.done ? -1 : y.cur); st.ringAt(y.cur, kr.poses[y.cur].x, kr.poses[y.cur].z);
  startTimer();
}
/* サーバーが決めた動きを、同じ計算で再生する */
function play(y) {
  const st = kr.stage, L = y.last, from = L.from;
  kr.anim = true; stopTimer(); st.ringOn(-1);
  if (!kr.poses) kr.poses = [{ x: from[0][0], z: from[0][1], yaw: START_YAW[0] }, { x: from[1][0], z: from[1][1], yaw: START_YAW[1] }];
  [0, 1].forEach((i) => { kr.poses[i] = { ...kr.poses[i], x: from[i][0], z: from[i][1] }; });
  kr.poses[L.by].yaw = yawOf(L.vx, L.vz);
  const s = keshiSimStepper(y.par, from, L.by, L.vx, L.vz);
  let acc = 0, more = true, fallT = [-1, -1];
  st.setTicker((dt) => {
    acc += dt;
    while (more && acc >= KESHI_DT) { more = s.step(); acc -= KESHI_DT; [0, 1].forEach((i) => { if (s.out[i] && fallT[i] < 0) fallT[i] = 0; }); }
    let falling = false;
    [0, 1].forEach((i) => {
      if (fallT[i] >= 0) {
        fallT[i] += dt; const t = fallT[i], sp = Math.hypot(s.vx[i], s.vz[i]) || 1, ux = s.vx[i] / sp, uz = s.vz[i] / sp;
        const ex = s.x[i] + s.vx[i] * t * .6, ez = s.z[i] + s.vz[i] * t * .6;
        st.pose(i, { x: ex, z: ez, y: -9 * t * t, yaw: kr.poses[i].yaw - s.th[i], tx: uz * Math.min(t * 3.2, 1.7), tz: -ux * Math.min(t * 3.2, 1.7), visible: -9 * t * t > -8 });
        if (t < 1) falling = true;
      } else st.pose(i, { x: s.x[i], z: s.z[i], yaw: kr.poses[i].yaw - s.th[i] });   // 当てられたら回る（th＝回った角度。画面の回転は、向きの反対）
    });
    if (more || falling) return true;
    [0, 1].forEach((i) => { kr.poses[i].yaw -= s.th[i]; });   // 回ったままの向きで止まる
    finishPlay(y); return false;
  });
}
function finishPlay(y) {
  const st = kr.stage, L = y.last;
  kr.anim = false;
  if (!st) return;
  const ended = JSON.stringify(L.to) !== JSON.stringify(y.pos) || (y.done && y.reason === "finished");   // 1本が終わった（机の上の位置が元に戻る／3本勝負が決まった）
  [0, 1].forEach((i) => { kr.poses[i] = { ...kr.poses[i], x: L.to[i][0], z: L.to[i][1] }; });
  if (!ended) { [0, 1].forEach((i) => st.pose(i, { ...kr.poses[i], visible: !(L.first === i) && onDesk(L.to[i]) })); st.render(); kr.lastKey = ""; sync(); return; }
  [0, 1].forEach((i) => st.pose(i, { ...kr.poses[i], visible: L.first !== i && onDesk(L.to[i]) }));
  st.render();
  kr.hold = true; showBanner(boutText(y));
  setTimeout(() => { kr.hold = false; showBanner(""); if (!kr.y || kr.y.gid !== y.gid) return; if (kr.y.done) { drawHud(); return; } setPoses(kr.y.pos, { pop: true }); kr.lastKey = ""; sync(); }, 1700);
}
function boutText(y) {
  const me = myIdx(), h = y.hist[y.hist.length - 1];
  if (!h) return "";
  const who = h.w === me ? "あなたの勝ち！" : `${String(y.names[h.w] || "相手").slice(0, 8)}さんの勝ち`;
  const how = h.how === "ko" ? "机から落とした！" : h.how === "self" ? "相手が自分で落ちた！" : "10回弾いて、ふちから遠いほうの勝ち";
  const n = y.hist.length;
  return `${n}本目：${who}\n${how}`;
}
function showBanner(text) { const b = $("#kbBanner"); if (!b) return; b.textContent = text; b.classList.toggle("on", !!text); kr.banner = text; }

async function fire(a) {
  const y = kr.y; if (!y || kr.busy) return;
  kr.busy = true; stopTimer();
  try {
    const r = await kr.api("keshiRoomFlick", { roomId: kr.roomId, gid: y.gid, dx: a.dx, dz: a.dz, p: a.p });
    kr.busy = false; if (r.keshi) accept(r.keshi);
  } catch (e) { kr.busy = false; restPose(myIdx()); roomError(e); sync(); }
}
function roomError(e) {
  const code = e && e.code;
  if (code === "timeout" || code === "not_your_turn" || code === "stale" || code === "no_game") return;   // 手番が進んでいた：ルームの更新で画面が直る
  if (code === "busy") { alert("通信が重なりました。もう一度お試しください。"); return; }
  alert("うまくいきませんでした（" + (code || "エラー") + "）。もう一度お試しください。");
}

function drawHud() {
  const y = kr.y, me = myIdx(), esc = kr.esc; if (!y) return;
  const pips = (w) => [0, 1].map((k) => `<i class="${k < w ? "on" : ""}"></i>`).join("");
  const side = (i) => `<div class="kb-p${me === i ? " me" : ""}${!y.done && y.cur === i ? " turn" : ""}"><span class="n">${esc(String(y.names[i] || "").slice(0, 8))}</span><span class="pips">${pips(y.wins[i])}</span><span class="rt">総合力 ${y.rt[i]}</span></div>`;
  const top = $("#kbTop"); if (top) top.innerHTML = side(me === 1 ? 1 : 0) + `<div class="kb-mid">${y.done ? "終了" : `第${y.bout}本<small>${y.flicks}/10回</small>`}</div>` + side(me === 1 ? 0 : 1);
  const turn = $("#kbTurn"), mine = !y.done && y.cur === me;
  if (turn) { turn.classList.toggle("mine", mine); turn.innerHTML = y.done ? "対戦が終わりました" : mine ? `あなたの番です <span id="kbTimer" class="kb-timer"></span>` : `${esc(String(y.names[y.cur] || ""))}さんの番です <span id="kbTimer" class="kb-timer"></span>`; }
  const hint = $("#kbHint");
  if (hint) hint.textContent = y.done || me < 0 ? "" : mine ? "画面を指で後ろに引っ張って、はなして弾こう（弱く引くと弱く、強く引くと強く弾く）。相手を机から落とせば1本！" : "相手の番です";
  const res = $("#kbResult");
  if (res) {
    if (y.done && !kr.anim && !kr.hold && !(y.last && y.last.n > kr.seenN)) {   // 最後の弾きの再生と、1本の結果の表示が終わってから、結果を出す
      const title = y.winner === me ? "あなたの勝ち！🎉" : me < 0 ? `${esc(String(y.names[y.winner] || ""))}さんの勝ち` : "あなたの負け…";
      const sub = y.reason === "timeout" ? `<p class="kb-sub">${esc(String(y.names[1 - y.winner] || "相手"))}さんが続けて時間切れになったため、ゲームを終了しました。</p>` : "";
      res.innerHTML = `<div class="kb-card kb-result"><div class="kb-result-title">${title}</div><div class="kb-vs"><span>${esc(String(y.names[0]))}<b>${y.wins[0]}</b></span><span>${esc(String(y.names[1]))}<b>${y.wins[1]}</b></span></div>${sub}<button type="button" class="yw-btn kb-go" id="kbAgain">もう一度対戦する</button></div>`;
      $("#kbAgain")?.addEventListener("click", (ev) => { ev.currentTarget.disabled = true; start(true); });
    } else if (!y.done) res.innerHTML = "";
  }
}
function startTimer() {
  stopTimer();
  const y = kr.y;
  if (!y || y.done) return;
  const tick = () => {
    if (!kr.boardEl || !document.body.contains(kr.boardEl) || !kr.y || kr.y.done) { stopTimer(); return; }
    if (kr.anim || kr.hold) return;
    const left = Math.max(0, Math.ceil((kr.y.deadline - roomNow()) / 1000)), t = $("#kbTimer");
    if (t) { t.textContent = `残り ${left}秒`; t.classList.toggle("warn", left <= 10); }
    // 時間切れ：番の人の画面がすぐ、相手の画面は少し待ってから Worker に頼む（Worker が時刻を確かめて、二重には処理しない）
    const over = roomNow() - kr.y.deadline, mine = kr.y.order[kr.y.cur] === kr.uid, key = `${kr.y.gid}:${kr.y.bout}:${kr.y.flicks}:${kr.y.cur}`;
    if (over >= (mine ? 600 : 3500) && kr.sentKey !== key) {
      kr.sentKey = key;
      kr.api("keshiRoomTimeout", { roomId: kr.roomId, gid: kr.y.gid, bout: kr.y.bout, flicks: kr.y.flicks, turn: kr.y.cur }).then((r) => { if (r && r.keshi) accept(r.keshi); }).catch(() => { kr.sentKey = ""; });
    }
  };
  tick(); kr.tm = setInterval(tick, 1000);
}

function injectStyles() {
  if (stylesDone) return; stylesDone = true;
  const css = `
  .kb-root, .kb-root * { -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; touch-action: manipulation; }   /* ダブルタップでの拡大を止める */
  .kb-card { background: #fff; border-radius: 14px; padding: 14px 16px; margin: 12px 0; box-shadow: 0 4px 16px rgba(0,0,0,.07); }
  .kb-msg { text-align: center; padding: 26px 16px; } .kb-msg p { color: #777; font-size: 12px; line-height: 1.7; margin: 8px 0 0; } .kb-ico { width: 74px; height: 52px; display: block; margin: 0 auto 6px; }
  .kb-top { display: grid; grid-template-columns: 1fr auto 1fr; gap: 6px; align-items: stretch; margin-bottom: 6px; }
  .kb-p { background: #fff; border-radius: 12px; padding: 6px 10px; box-shadow: 0 2px 8px rgba(0,0,0,.07); display: flex; flex-direction: column; gap: 2px; min-width: 0; border: 2px solid transparent; }
  .kb-p.turn { border-color: #ffc933; } .kb-p.me .n { color: #14507a; }
  .kb-p .n { font-weight: 800; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .kb-p .rt { font-size: 11px; color: #777; }
  .kb-p .pips { display: flex; gap: 4px; } .kb-p .pips i { width: 14px; height: 14px; border-radius: 50%; border: 2px solid #d3a421; background: #fff; } .kb-p .pips i.on { background: #ffc933; }
  .kb-mid { display: flex; flex-direction: column; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; padding: 0 4px; } .kb-mid small { font-weight: 600; color: #888; font-size: 10.5px; }
  .kb-turn { text-align: center; background: #3b3f46; color: #fff; border-radius: 10px; padding: 8px; font-weight: 800; margin-bottom: 8px; font-size: 14px; } .kb-turn.mine { background: #e0902f; }
  .kb-timer { margin-left: 8px; font-weight: 700; font-size: 13px; } .kb-timer.warn { color: #ff6b6b; }
  .kb-stage { position: relative; width: 100%; margin: 0 auto; aspect-ratio: 5 / 7; flex: none;   /* 実際の大きさは、sizeStage() が px で決める */ border-radius: 16px; overflow: hidden; background: radial-gradient(ellipse at 50% 40%, #b9cde0 0%, #8aa3bd 60%, #6a8099 100%); box-shadow: inset 0 0 30px rgba(0,0,0,.25); touch-action: none; }
  .kb-gl { position: absolute; left: 0; top: 0; touch-action: none; }
  .kb-loading { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #fff; font-weight: 700; font-size: 13px; text-align: center; padding: 0 16px; }
  .kb-banner { position: absolute; left: 8%; right: 8%; top: 38%; background: rgba(20,20,28,.86); color: #fff; border-radius: 14px; padding: 14px 10px; text-align: center; font-weight: 900; font-size: 17px; line-height: 1.6; white-space: pre-line; opacity: 0; transform: scale(.85); transition: opacity .2s, transform .2s; pointer-events: none; z-index: 3; }
  .kb-banner.on { opacity: 1; transform: scale(1); }
  .kb-power { position: absolute; left: 14%; right: 14%; bottom: 10px; height: 12px; border-radius: 999px; background: rgba(0,0,0,.35); opacity: 0; transition: opacity .15s; pointer-events: none; overflow: hidden; } .kb-power.on { opacity: 1; }
  .kb-power i { display: block; height: 100%; width: 0; background: linear-gradient(90deg, #33cc55, #f5d02b, #e0412f); background-size: 560px 100%; }
  .kb-hint { text-align: center; color: #555; font-size: 11.5px; line-height: 1.6; margin: 8px 4px 0; }
  .kb-result { text-align: center; } .kb-result-title { font-size: 18px; font-weight: 800; }
  .kb-vs { display: flex; justify-content: space-around; gap: 8px; margin: 12px 0; font-size: 13px; } .kb-vs span { display: flex; flex-direction: column; align-items: center; } .kb-vs b { font-size: 34px; color: #14507a; }
  .kb-sub { color: #777; font-size: 12px; line-height: 1.7; margin: 6px 0; } .kb-go { display: block; width: 100%; margin-top: 10px; padding: 12px; font-size: 15px; }
  `;
  const el = document.createElement("style"); el.id = "kb-style"; el.textContent = css; document.head.appendChild(el);
}
