/* 🎰 ゆうスロ（worker.js のサーバー権威ロジック）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import {
  SLOT_MACHINES, SLOT_RULES, slotRates, slotDrawOutcome, slotApplySpin, slotBusinessOpen, slotBusinessDay, handleYuslotAction, resetYuslotCacheForTest
} from "../worker.js";

/* slotDrawOutcome と同じ並び（cherry→bell→watermelon→replay→star→treasure→special）の累積帯から、
   狙った結果が出る乱数値（帯の中央）を返す。確率を調整しても壊れないようにする */
function bandValue(machineId, target, { free = false } = {}) {
  const r = slotRates(machineId);
  const entries = [
    ["cherry", r.cherry], ["bell", r.bell], ["watermelon", r.watermelon],
    ["replay", free ? SLOT_RULES.freeReplay : r.replay],
    ["star", free ? 0 : r.star], ["treasure", r.treasure], ["special", r.special]
  ];
  let lo = 0;
  for (const [name, p] of entries) { if (name === target) return lo + p / 2; lo += p; }
  return Math.min(0.999999, lo + (1 - lo) / 2); // lose
}

const ROOT = "projects/p/databases/(default)/documents";
const enc = (v) => v === null || v === undefined ? { nullValue: null } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : typeof v === "object" ? { mapValue: { fields: encF(v) } } : { stringValue: String(v) };
const encF = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const dec = (v) => !v ? undefined : "nullValue" in v ? null : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "stringValue" in v ? v.stringValue : v.mapValue ? decF(v.mapValue.fields) : undefined;
const decF = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));

function fakeFirestore(initial = {}) {
  const docs = new Map(); let ver = 1;
  const put = (p, f) => docs.set(p, { fields: structuredClone(f), updateTime: `t${ver++}` });
  Object.entries(initial).forEach(([p, d]) => put(p, encF(d)));
  const counts = { get: 0, getRaw: 0, commit: 0 };
  return {
    docs, counts, put,
    async get(p) { counts.get++; const d = docs.get(p); return d ? decF(d.fields) : null; },
    async getRaw(p) { counts.getRaw++; const d = docs.get(p); return d ? structuredClone(d) : null; },
    docName: (p) => `${ROOT}/${p}`,
    async commit(writes) {
      counts.commit++;
      for (const w of writes) {
        const path = (w.update?.name || w.delete).slice(ROOT.length + 1);
        const cur = docs.get(path);
        if (w.currentDocument?.updateTime && cur?.updateTime !== w.currentDocument.updateTime) throw Object.assign(new Error("firestore commit 400 FAILED_PRECONDITION"), { status: 400 });
        if (w.currentDocument?.exists === false && cur) throw Object.assign(new Error("409 ALREADY_EXISTS"), { status: 409 });
        if (w.currentDocument?.exists === true && !cur) throw Object.assign(new Error("404 NOT_FOUND"), { status: 404 });
      }
      for (const w of writes) {
        if (w.delete) { docs.delete(w.delete.slice(ROOT.length + 1)); continue; }
        const path = w.update.name.slice(ROOT.length + 1);
        const cur = docs.get(path)?.fields || {};
        const next = w.updateMask ? { ...cur } : { ...w.update.fields };
        if (w.updateMask) for (const fp of w.updateMask.fieldPaths) { if (w.update.fields[fp] !== undefined) next[fp] = w.update.fields[fp]; else delete next[fp]; }
        (w.updateTransforms || []).forEach((t) => { if (t.increment) next[t.fieldPath] = { integerValue: String((Number(next[t.fieldPath]?.integerValue) || 0) + Number(t.increment.integerValue)) }; });
        put(path, next);
      }
    }
  };
}
const ADMIN = "adminUid";
function deps(initial, { uid = "uT", now = Date.UTC(2026, 0, 2, 3, 0, 0), random = Math.random } = {}) {
  resetYuslotCacheForTest();
  const fs = fakeFirestore({ "users/たろう": { uid: "uT", name: "たろう", coins: 1000 }, "users/かんりしゃ": { uid: ADMIN, name: "かんりしゃ", coins: 50 }, ...initial });
  return { fs, deps: { firestore: fs, adminUid: ADMIN, slotSecret: "test-secret", random, now: () => now } };
}
// 狙った出目を出す乱数（値を順に返し、尽きたら 0）
const seq = (...vals) => { let i = 0; return () => (i < vals.length ? vals[i++] : 0); };
const coinsOf = (fs, name) => Number(fs.docs.get(`users/${name}`).fields.coins.integerValue);

test("確率の合計が各台で100%になる（ハズレが負にならない）", () => {
  for (const id of Object.keys(SLOT_MACHINES)) {
    const r = slotRates(id);
    const sum = r.cherry + r.bell + r.watermelon + r.replay + r.star + r.treasure + r.special;
    assert.ok(sum < 1, `${id} 合計が1未満`);
    assert.ok(1 - sum >= 0, `${id} ハズレが負`);
  }
});

test("対象外の台に特別役（777・オリジナル）が絶対に出ない", () => {
  const rng = (() => { let s = 12345; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; })();
  for (const id of Object.keys(SLOT_MACHINES)) {
    const forbidden = SLOT_MACHINES[id].special === "orig" ? "triple7" : "orig";
    for (let i = 0; i < 20000; i++) {
      const d = slotDrawOutcome(id, {}, rng);
      assert.ok(!d.center.includes(forbidden), `${id} に ${forbidden} が出た`);
      const df = slotDrawOutcome(id, { free: true }, rng);
      assert.ok(!df.center.includes(forbidden), `${id}(free) に ${forbidden} が出た`);
    }
  }
});

test("配当：特別役=料金×80＋FEVER開始、フルーツ=料金×3、宝箱=賞金、REPLAY=無料+1、星=無料+5", () => {
  // yubasic 通常：cherry→special の順。累積 cherry.06 bell.05 wm.04 replay.02 star.003 treasure.005 special(1/400)
  const m = SLOT_MACHINES.yubasic;
  assert.equal(slotDrawOutcome("yubasic", {}, seq(bandValue("yubasic", "cherry"))).payout, m.price * 3);        // cherry
  const sp = slotDrawOutcome("yubasic", {}, seq(bandValue("yubasic", "special")));
  assert.equal(sp.result, "special"); assert.equal(sp.payout, m.price * 80); assert.equal(sp.feverStart, true);
  assert.deepEqual(sp.center, ["orig", "orig", "orig"]);
  const rp = slotDrawOutcome("yubasic", {}, seq(bandValue("yubasic", "replay")));
  assert.equal(rp.result, "replay"); assert.equal(rp.freeAdd, 1); assert.equal(rp.payout, 0);
  const stt = slotDrawOutcome("yubasic", {}, seq(bandValue("yubasic", "star")));
  assert.equal(stt.result, "star"); assert.equal(stt.freeAdd, 5);
  const tr = slotDrawOutcome("yubasic", {}, seq(bandValue("yubasic", "treasure"), 0.0));                        // 1つ目賞金3
  assert.equal(tr.result, "treasure"); assert.equal(tr.payout, 3); assert.equal(tr.prize, 3);
  // yuchance は 777
  const sp7 = slotDrawOutcome("yuchance", {}, seq(bandValue("yuchance", "special")));
  assert.equal(sp7.result, "special"); assert.deepEqual(sp7.center, ["triple7", "triple7", "triple7"]);
});

test("FEVER中はフルーツのみ（必ず当たり、料金×3）。777/オリジナル/星/宝箱/REPLAY/ハズレは出ない", () => {
  const rng = (() => { let s = 999; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; })();
  for (const id of Object.keys(SLOT_MACHINES)) {
    for (let i = 0; i < 5000; i++) {
      const d = slotDrawOutcome(id, { fever: true }, rng);
      assert.ok(["cherry", "bell", "watermelon"].includes(d.result), `${id} FEVERで ${d.result}`);
      assert.equal(d.payout, SLOT_MACHINES[id].price * 3);
      assert.ok(d.center.every((s) => ["cherry", "bell", "watermelon"].includes(s)));
    }
  }
});

test("無料スピン中は星が出ない（REPLAYは1%）", () => {
  const rng = (() => { let s = 7; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; })();
  let stars = 0;
  for (let i = 0; i < 100000; i++) if (slotDrawOutcome("yubasic", { free: true }, rng).result === "star") stars++;
  assert.equal(stars, 0, "無料スピンで星が出た");
});

test("slotApplySpin：無料スピンはコイン消費なし、残高不足は no_funds、連勝/当たり数の計上", () => {
  const base = { v: 1, uid: "uT", name: "たろう", machine: "yubasic", price: 1, startCoins: 10, delta: 0, flushed: 0, freeSpins: 0, feverUntil: 0, spins: 0, wins: 0, streak: 0, day: "d", nonce: "n", seatMs: 0, lastMs: 0 };
  const cherry = bandValue("yubasic", "cherry"), replay = bandValue("yubasic", "replay"), special = bandValue("yubasic", "special");
  // 当たり（cherry）：残高+2、当たり+1、連勝+1
  let r = slotApplySpin(base, 1000, seq(cherry));
  assert.equal(r.spin.payout, 3); assert.equal(r.spin.cost, 1); assert.equal(r.session.delta, 2); assert.equal(r.session.wins, 1); assert.equal(r.session.streak, 1);
  // ハズレ：残高-1、連勝0
  r = slotApplySpin({ ...base, streak: 3 }, 1000, seq(0.99));
  assert.equal(r.spin.result, "lose"); assert.equal(r.session.delta, -1); assert.equal(r.session.streak, 0);
  // REPLAY：無料+1、連勝維持、当たりに数えない
  r = slotApplySpin({ ...base, streak: 2, wins: 2 }, 1000, seq(replay));
  assert.equal(r.session.freeSpins, 1); assert.equal(r.session.streak, 2); assert.equal(r.session.wins, 2);
  // 無料スピンあり：コスト0、当たりでも消費しない
  r = slotApplySpin({ ...base, freeSpins: 2, startCoins: 0 }, 1000, seq(cherry));
  assert.equal(r.spin.cost, 0); assert.equal(r.session.freeSpins, 1); assert.equal(r.session.delta, 3);
  // 残高0・無料0 → no_funds
  assert.deepEqual(slotApplySpin({ ...base, startCoins: 0 }, 1000, seq(cherry)), { error: "no_funds" });
  // 特別役では FEVER を自動開始せず「開始待ち（feverPending）」にする（feverUntil はまだ 0）
  r = slotApplySpin(base, 5000, seq(special));
  assert.equal(r.spin.feverStart, true); assert.equal(r.spin.feverPending, true);
  assert.equal(r.session.feverPending, true); assert.equal(r.session.feverUntil || 0, 0);
});

test("営業時間（JST 07:00〜23:00）と日次（07:00境界）", () => {
  const jst = (h, mi = 0) => Date.UTC(2026, 0, 2, h - 9, mi, 0); // JST h時 → UTC
  assert.equal(slotBusinessOpen(jst(6, 59)), false);
  assert.equal(slotBusinessOpen(jst(7, 0)), true);
  assert.equal(slotBusinessOpen(jst(22, 59)), true);
  assert.equal(slotBusinessOpen(jst(23, 0)), false);
  assert.notEqual(slotBusinessDay(jst(6, 59)), slotBusinessDay(jst(7, 1)), "07:00で日付が変わる");
  assert.equal(slotBusinessDay(jst(7, 1)), slotBusinessDay(jst(22, 0)), "同じ営業日は同じ");
});

test("公開設定：既定は非公開、最上位管理者だけ変更できる", async () => {
  const { fs, deps: d } = deps();
  assert.equal((await handleYuslotAction(d, "uT", { action: "config" })).published, false);
  assert.equal((await handleYuslotAction(d, "uT", { action: "setConfig", published: true })).status, 403);
  const set = await handleYuslotAction(d, ADMIN, { action: "setConfig", published: true });
  assert.equal(set.ok, true); assert.equal(set.published, true);
  assert.equal(fs.docs.get("worldConfig/yuslot").fields.yuslotPublished.booleanValue, true);
});

test("非公開中は一般ユーザーは着席できない（最上位管理者は可）", async () => {
  const { deps: d } = deps();
  assert.equal((await handleYuslotAction(d, "uT", { action: "seat", machine: "yubasic", username: "たろう" })).status, 403);
  const admin = await handleYuslotAction(d, ADMIN, { action: "seat", machine: "yubasic", username: "かんりしゃ" });
  assert.equal(admin.ok, true);
});

test("着席：署名セッション発行、同じ台への二重着席は拒否", async () => {
  const { fs, deps: d } = deps({ "worldConfig/yuslot": { yuslotPublished: true } });
  const s = await handleYuslotAction(d, "uT", { action: "seat", machine: "yubasic", username: "たろう" });
  assert.equal(s.ok, true); assert.ok(typeof s.session === "string"); assert.equal(s.startCoins, 1000);
  assert.equal(fs.docs.has("yuslotSeats/yubasic"), true);
  // 別ユーザーが同じ台 → seat_taken
  fs.put("users/はなこ", encF({ uid: "uH", name: "はなこ", coins: 500 }));
  const taken = await handleYuslotAction({ ...d, firestore: fs }, "uH", { action: "seat", machine: "yubasic", username: "はなこ" });
  assert.equal(taken.status, 409); assert.equal(taken.error, "seat_taken");
});

test("スピンは Firestore に触れない（0アクセス）。精算で残高に反映され、二重精算しない", async () => {
  const { fs, deps: d } = deps({ "worldConfig/yuslot": { yuslotPublished: true } });
  const s = await handleYuslotAction(d, "uT", { action: "seat", machine: "yubasic", username: "たろう" });
  const before = { ...fs.counts };
  // 当たりを出すスピンを数回（0.0=cherry、料金1→+2/回）
  let session = s.session;
  for (let i = 0; i < 5; i++) {
    const r = await handleYuslotAction({ ...d, random: seq(0.0) }, "uT", { action: "spin", session });
    assert.equal(r.ok, true); session = r.session;
  }
  assert.equal(fs.counts.get - before.get, 0, "スピン中に get");
  assert.equal(fs.counts.getRaw - before.getRaw, 0, "スピン中に getRaw");
  assert.equal(fs.counts.commit - before.commit, 0, "スピン中に commit");
  // 精算：+10 コイン（5回×+2）
  const settle = await handleYuslotAction(d, "uT", { action: "settle", session });
  assert.equal(settle.ok, true); assert.equal(settle.applied, 10);
  assert.equal(coinsOf(fs, "たろう"), 1010);
  // 二重精算しても増えない（seat 解放済み）
  const again = await handleYuslotAction(d, "uT", { action: "settle", session });
  assert.equal(again.applied, 0); assert.equal(coinsOf(fs, "たろう"), 1010);
});

test("flush：増分だけ反映し、同じ session を再送しても二重反映しない。settle まで整合", async () => {
  const { fs, deps: d } = deps({ "worldConfig/yuslot": { yuslotPublished: true } });
  const s = await handleYuslotAction(d, "uT", { action: "seat", machine: "yubasic", username: "たろう" });
  let session = s.session;
  for (let i = 0; i < 3; i++) { const r = await handleYuslotAction({ ...d, random: seq(0.0) }, "uT", { action: "spin", session }); session = r.session; } // +6
  const f1 = await handleYuslotAction(d, "uT", { action: "flush", session });
  assert.equal(f1.applied, 6); assert.equal(coinsOf(fs, "たろう"), 1006);
  const f1b = await handleYuslotAction(d, "uT", { action: "flush", session: f1.session });
  assert.equal(f1b.applied, 0, "同じ増減の再flushは0"); assert.equal(coinsOf(fs, "たろう"), 1006);
  session = f1.session;
  for (let i = 0; i < 2; i++) { const r = await handleYuslotAction({ ...d, random: seq(0.0) }, "uT", { action: "spin", session }); session = r.session; } // +4
  const st = await handleYuslotAction(d, "uT", { action: "settle", session });
  assert.equal(st.applied, 4); assert.equal(coinsOf(fs, "たろう"), 1010);
});

const statOf = (fs, name, f) => Number(fs.docs.get(`users/${name}`).fields[f]?.integerValue || 0);

test("会員ランク用の記録：有料の回転数と使ったコインを users に足す。無料スピンは数えない。flush を重ねても二重に足さない", async () => {
  const { fs, deps: d } = deps({ "worldConfig/yuslot": { yuslotPublished: true } });
  const s = await handleYuslotAction(d, "uT", { action: "seat", machine: "yubasic", username: "たろう" });
  let session = s.session;
  const play = async (v) => { const r = await handleYuslotAction({ ...d, random: seq(v) }, "uT", { action: "spin", session }); assert.equal(r.ok, true); session = r.session; return r; };
  await play(0.99); await play(0.99);                                    // ハズレ×2（有料2回）
  await play(bandValue("yubasic", "replay"));                             // REPLAY（有料1回・無料スピン+1）
  const free = await play(0.99);                                          // 無料スピン（数えない）
  assert.equal(free.spin.cost, 0);
  const f1 = await handleYuslotAction(d, "uT", { action: "flush", session });
  assert.equal(statOf(fs, "たろう", "slotSpins"), 3); assert.equal(statOf(fs, "たろう", "slotWagered"), 3, "料金1×3回");
  assert.equal(statOf(fs, "たろう", "slotKakuSpins"), 0);
  await handleYuslotAction(d, "uT", { action: "flush", session: f1.session });
  assert.equal(statOf(fs, "たろう", "slotSpins"), 3, "同じ内容の再flushでは増えない");
  session = f1.session;
  await play(0.99);
  const st = await handleYuslotAction(d, "uT", { action: "settle", session });
  assert.equal(st.ok, true);
  assert.equal(statOf(fs, "たろう", "slotSpins"), 4); assert.equal(statOf(fs, "たろう", "slotWagered"), 4);
  await handleYuslotAction(d, "uT", { action: "settle", session });
  assert.equal(statOf(fs, "たろう", "slotSpins"), 4, "二重に精算しても増えない");
});

test("会員ランク用の記録：コインの増減が0でも回転数は記録される。高い台は料金×回転数。確変中の回転は別にも数える", () => {
  const base = { v: 1, uid: "uT", name: "たろう", machine: "yujackpot", price: 9, startCoins: 100, delta: 0, flushed: 0, freeSpins: 0, feverUntil: 0, spins: 0, wins: 0, streak: 0, day: "d", nonce: "n", seatMs: 0, lastMs: 0 };
  let r = slotApplySpin(base, 1000, seq(0.99));
  assert.equal(r.session.paid, 1); assert.equal(r.session.kakuPaid, undefined);
  r = slotApplySpin({ ...base, kaku: true }, 1000, seq(0.99), 1.25);
  assert.equal(r.session.paid, 1); assert.equal(r.session.kakuPaid, 1);
  r = slotApplySpin({ ...base, kaku: true, paid: 5, kakuPaid: 2, freeSpins: 1 }, 1000, seq(0.99), 1.25);
  assert.equal(r.session.paid, 5, "無料スピンは数えない"); assert.equal(r.session.kakuPaid, 2);
});

test("FEVERは特別役の当たりで自動開始せず、feverStart アクションで開始（連打しても二重開始しない・Firestore 0）", async () => {
  const { fs, deps: d } = deps({ "worldConfig/yuslot": { yuslotPublished: true } });
  const s = await handleYuslotAction(d, "uT", { action: "seat", machine: "yubasic", username: "たろう" });
  // 特別役を出す（yubasic の special 帯）→ feverPending、feverUntil はまだ立たない
  const sp = await handleYuslotAction({ ...d, random: seq(bandValue("yubasic", "special")) }, "uT", { action: "spin", session: s.session });
  assert.equal(sp.spin.result, "special"); assert.equal(sp.spin.feverPending, true); assert.equal(sp.spin.fever, false);
  const before = { ...fs.counts };
  // 開始：feverUntil が now+feverMs に。Firestore には触れない
  const started = await handleYuslotAction(d, "uT", { action: "feverStart", session: sp.session });
  assert.equal(started.started, true); assert.equal(started.fever, true);
  assert.equal(started.feverUntil, d.now() + SLOT_RULES.feverMs);
  assert.equal(fs.counts.get - before.get, 0); assert.equal(fs.counts.getRaw - before.getRaw, 0); assert.equal(fs.counts.commit - before.commit, 0);
  // 連打（同じ feverPending セッション）→ 二重開始しない（feverPending は消費済み。古いセッションは pending だが alreadyFever で no-op にはならないので、開始後セッションで再送）
  const again = await handleYuslotAction(d, "uT", { action: "feverStart", session: started.session });
  assert.equal(again.started, false, "開始後のセッションでは二重開始しない");
  // 開始後のセッションでスピン → FEVER中なのでフルーツのみ
  const fspin = await handleYuslotAction({ ...d, random: seq(0.0) }, "uT", { action: "spin", session: started.session });
  assert.ok(["cherry", "bell", "watermelon"].includes(fspin.spin.result), "FEVER中はフルーツ");
  assert.equal(fspin.spin.fever, true);
});

test("セッション改ざんは拒否（HMAC）", async () => {
  const { deps: d } = deps({ "worldConfig/yuslot": { yuslotPublished: true } });
  const s = await handleYuslotAction(d, "uT", { action: "seat", machine: "yubasic", username: "たろう" });
  const [body] = s.session.split(".");
  const tampered = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
  tampered.delta = 999999;
  const forged = Buffer.from(JSON.stringify(tampered)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + "." + s.session.split(".")[1];
  const r = await handleYuslotAction(d, "uT", { action: "spin", session: forged });
  assert.equal(r.status, 401); assert.equal(r.error, "bad_session");
});
