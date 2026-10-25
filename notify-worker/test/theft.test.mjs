/* 🥷 スリ対策（防犯グッズの購入・通知の設定）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { handleEconomyAction, THEFT_GUARD_TABLE, THEFT_GUARD_SALE_START_MS, theftGuardPrice, theftWeekStart, THEFT_MIN_TOTAL, theftFreeWindows, theftTake, runTheftTick, theftRaid } from "../worker.js";
import { THEFT_GUARDS, THEFT_GUARD_SALE_START_MS as SALE_START, THEFT_MIN_TOTAL as UI_MIN_TOTAL, guardPriceOf, weekStartOf } from "../../yuu-theft.js";

console.warn = () => {};

const ROOT = "projects/p/databases/(default)/documents";
const enc = (v) => v === null || v === undefined ? { nullValue: null } : v instanceof Date ? { timestampValue: v.toISOString() } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : typeof v === "object" ? { mapValue: { fields: encF(v) } } : { stringValue: String(v) };
const encF = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const dec = (v) => !v ? undefined : "nullValue" in v ? null : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "timestampValue" in v ? v.timestampValue : "stringValue" in v ? v.stringValue : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? decF(v.mapValue.fields) : undefined;
const decF = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));

function fakeFs(initial = {}) {
  const docs = new Map(); let ver = 1;
  const put = (p, f) => docs.set(p, { fields: structuredClone(f), updateTime: `t${ver++}` });
  Object.entries(initial).forEach(([p, d]) => put(p, encF(d)));
  const counts = { get: 0, getRaw: 0, query: 0, batchGet: 0, commit: 0 };
  const plain = (p) => { const d = docs.get(p); return d ? decF(d.fields) : null; };
  const fs = {
    docs, counts, put, plain, putP: (p, d) => put(p, encF(d)),
    docName: (p) => `${ROOT}/${p}`,
    async get(p) { counts.get++; return plain(p); },
    async getRaw(p) { counts.getRaw++; const d = docs.get(p); return d ? structuredClone(d) : null; },
    async batchGet(paths) { counts.batchGet++; return paths.map(plain); },
    async query(collection, filters = []) {
      counts.query++;
      return [...docs.entries()].filter(([p]) => p.startsWith(collection + "/"))
        .map(([p, d]) => ({ id: p.split("/").slice(1).join("/"), path: p, updateTime: d.updateTime, data: decF(d.fields) }))
        .filter((r) => filters.every(([f, op, v]) => op === "EQUAL" && r.data[f] === v));
    },
    async set(p, data) { put(p, encF(data)); },
    async delete(p) { docs.delete(p); },
    async createIfAbsent(p, data) { if (docs.has(p)) return false; put(p, encF(data)); return true; },
    async update(p, data) { const cur = docs.get(p)?.fields || {}; put(p, { ...cur, ...encF(data) }); },
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
        (w.updateTransforms || []).forEach((t) => {
          if (t.appendMissingElements) { const cur2 = next[t.fieldPath]?.arrayValue?.values || []; const have = new Set(cur2.map((v) => JSON.stringify(v))); next[t.fieldPath] = { arrayValue: { values: [...cur2, ...t.appendMissingElements.values.filter((v) => !have.has(JSON.stringify(v)))] } }; }
          if (t.increment) next[t.fieldPath] = { integerValue: String((Number(next[t.fieldPath]?.integerValue) || 0) + Number(t.increment.integerValue)) }; 
        });
        put(path, next);
      }
    }
  };
  return fs;
}

const JST = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi, 0);
function setup({ now = JST(2026, 10, 27, 12), coins = 20000, extra = {} } = {}) {
  const fs = fakeFs({ "users/u0": { uid: "id0", name: "u0", coins, ...extra } });
  const state = { now };
  const deps = { firestore: fs, now: () => state.now, random: () => 0.5 };
  const act = (body) => handleEconomyAction(deps, "id0", { username: "u0", ...body });
  return { fs, state, act, user: () => fs.plain("users/u0") };
}

test("表：Worker の防犯グッズの値段・週の月曜は、yuu-theft.js（アプリ）と同じ", () => {
  assert.equal(THEFT_MIN_TOTAL, UI_MIN_TOTAL);
  assert.equal(THEFT_GUARD_TABLE.length, THEFT_GUARDS.length); assert.equal(THEFT_GUARD_SALE_START_MS, SALE_START);
  assert.equal(SALE_START, Date.UTC(2026, 9, 26, 0, 0) - 9 * 3600000, "2026-10-26（月）0:00 JST");
  for (let lv = 1; lv <= 5; lv++) {
    assert.deepEqual(THEFT_GUARD_TABLE[lv], { rate: THEFT_GUARDS[lv].rate, min: THEFT_GUARDS[lv].min, repel: THEFT_GUARDS[lv].repel, dmg: THEFT_GUARDS[lv].dmg });
    for (const total of [0, 100, 5000, 15000, 20958, 123456, 1e7]) assert.equal(theftGuardPrice(lv, total), guardPriceOf(lv, total), `lv${lv} ${total}`);
  }
  for (let i = 0; i < 400; i++) { const d = new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10); assert.equal(theftWeekStart(d), weekStartOf(d), d); }
});

test("防犯グッズを買う：総資産に応じた値段のコインが引かれ、今週の分が付く（コインは消える）。上のレベルへは差額だけ", async () => {
  const t = setup();   // 10/27（火）・総資産20,000
  const r = await t.act({ action: "guardBuy", lv: 3 });
  assert.equal(r.ok, true); assert.equal(r.price, 800); assert.equal(r.week, "2026-10-26"); assert.equal(r.lv, 3);
  assert.equal(t.user().coins, 19200);
  assert.deepEqual(t.user().guards, { "2026-10-26": { lv: 3, paid: 800 } });
  assert.equal((await t.act({ action: "guardBuy", lv: 3 })).error, "ALREADY_HAVE");
  assert.equal((await t.act({ action: "guardBuy", lv: 2 })).error, "ALREADY_HAVE", "下のレベルは買えない");
  const up = await t.act({ action: "guardBuy", lv: 5 });   // 総資産19,200 × 10% ＝ 1,920 から、払った800を引く
  assert.equal(up.price, 1120); assert.equal(t.user().coins, 18080);
  assert.deepEqual(t.user().guards, { "2026-10-26": { lv: 5, paid: 1920 } });
});

test("値段は、手持ち・預金・株を合わせた総資産（借入を引く）で決まる。コインが足りないと買えない。レベルの範囲外は不可", async () => {
  const t = setup({ coins: 700, extra: { bank: { deposit: 9000, interestBase: 9000, loan: 0 }, stocks: { YEN: { qty: 20, cost: 5000 } } } });   // 総資産 500＋9,000＋5,600＝15,100
  assert.equal((await t.act({ action: "guardBuy", lv: 5 })).error, "NOT_ENOUGH_COINS", "1,530 コイン必要（手持ちは700）");
  const ok = await t.act({ action: "guardBuy", lv: 3 });
  assert.equal(ok.price, 612); assert.equal(t.user().coins, 88);
  for (const lv of [0, 6, 1.5, "x", null]) assert.equal((await t.act({ action: "guardBuy", lv })).error, "invalid_lv");
  const loaned = setup({ coins: 20000, extra: { bank: { deposit: 0, interestBase: 0, loan: 10000 } } });
  assert.equal((await loaned.act({ action: "guardBuy", lv: 5 })).price, 1200, "借入を引いた総資産 10,000 × 10%＝1,000 だが、最低額は1,200");
  assert.equal((await setup({ coins: 20000, extra: { bank: { deposit: 0, interestBase: 0, loan: 2000 } } }).act({ action: "guardBuy", lv: 4 })).price, 1260, "18,000 × 7%");
});

test("来週の分は、金曜から買える（それ以前は買えない）。今週の分と別々に持てる。過ぎた週の分は、買うときに消える", async () => {
  const t = setup({ now: JST(2026, 10, 29, 12) });   // 木曜
  assert.equal((await t.act({ action: "guardBuy", lv: 2, which: "next" })).error, "TOO_EARLY");
  t.state.now = JST(2026, 10, 30, 12);   // 金曜
  const r = await t.act({ action: "guardBuy", lv: 2, which: "next" });
  assert.equal(r.ok, true); assert.equal(r.week, "2026-11-02");
  assert.equal((await t.act({ action: "guardBuy", lv: 1 })).week, "2026-10-26", "今週の分も買える");
  assert.deepEqual(Object.keys(t.user().guards).sort(), ["2026-10-26", "2026-11-02"]);
  t.state.now = JST(2026, 11, 3, 12);   // 次の週の火曜（先に買っていたレベル2が、今週の分になる）
  assert.equal((await t.act({ action: "guardBuy", lv: 2 })).error, "ALREADY_HAVE");
  assert.equal((await t.act({ action: "guardBuy", lv: 3 })).week, "2026-11-02");
  assert.deepEqual(Object.keys(t.user().guards), ["2026-11-02"], "過ぎた週（10/26）の分は消える");
});

test("スリの通知の入／切：初めは未設定（切）。本人が入にして、切にできる。値は真偽だけ", async () => {
  const t = setup();
  assert.equal(t.user().theftPush, undefined);
  assert.equal((await t.act({ action: "theftPush", on: true })).theftPush, true); assert.equal(t.user().theftPush, true);
  assert.equal((await t.act({ action: "theftPush", on: false })).theftPush, false); assert.equal(t.user().theftPush, false);
  assert.equal((await t.act({ action: "theftPush", on: "yes" })).error, "invalid_request");
});

test("防犯グッズは、2026-10-26（月）0:00（日本時間）から買える。それより前は、だれも買えない", async () => {
  const before = setup({ now: SALE_START - 60000 });   // 10/25（日）23:59
  assert.equal((await before.act({ action: "guardBuy", lv: 1 })).error, "NOT_YET");
  assert.equal(before.user().guards, undefined); assert.equal(before.user().coins, 20000);
  const at = setup({ now: SALE_START });
  assert.equal((await at.act({ action: "guardBuy", lv: 1 })).ok, true);
  assert.equal(at.user().guards["2026-10-26"].lv, 1);
});

/* ---- 🥷 スリの実行（平日・授業以外の時間・ランダムな時刻） ---- */
const PRICES_MARKET = { companies: { YGM: { price: 100 }, YMT: { price: 200 } } };
function raidSetup({ coins = 20000, extra = {}, rankingTotal = 20000 } = {}) {
  const fs = fakeFs({
    "users/u0": { uid: "id0", name: "u0", coins, ...extra },
    "rankings/assets": { date: "2026-10-26", users: [{ name: "u0", total: rankingTotal, rank: 1 }, { name: "u1", total: 3000, rank: 2 }] },
    "market/current": PRICES_MARKET
  });
  return { fs, deps: { firestore: fs, now: () => 0 }, user: () => fs.plain("users/u0") };
}
const seqRandom = (...xs) => { let i = 0; return () => xs[Math.min(i++, xs.length - 1)]; };

test("泥棒が動ける時間：7:00〜21:00 のうち、授業（Ⅰ〜Ⅶ時限）をのぞく。Ⅶ時限は月曜だけ", () => {
  assert.deepEqual(theftFreeWindows(2), [[420, 510], [555, 565], [610, 655], [700, 710], [755, 800], [845, 855], [900, 1260]]);
  assert.deepEqual(theftFreeWindows(1), [[420, 510], [555, 565], [610, 655], [700, 710], [755, 800], [845, 855], [900, 910], [955, 1260]]);
  const hm = (h, m) => h * 60 + m, inFree = (dow, h, m) => theftFreeWindows(dow).some(([a, b]) => hm(h, m) >= a && hm(h, m) < b);
  for (const [h, m] of [[8, 30], [9, 0], [9, 14], [9, 30], [10, 9], [11, 0], [11, 39], [11, 55], [12, 34], [13, 20], [14, 4], [14, 15], [14, 59]]) assert.equal(inFree(3, h, m), false, `${h}:${m} は授業中`);
  for (const [h, m] of [[7, 0], [8, 29], [9, 15], [9, 24], [10, 10], [10, 30], [10, 54], [11, 40], [11, 49], [12, 35], [13, 0], [13, 19], [14, 5], [14, 14], [15, 0], [18, 0], [20, 59]]) assert.equal(inFree(3, h, m), true, `${h}:${m} は授業ではない`);
  assert.equal(inFree(3, 15, 30), true, "水曜の15:30は終礼で、授業ではない"); assert.equal(inFree(1, 15, 30), false, "月曜の15:30はⅦ時限");
  assert.equal(inFree(3, 21, 0), false); assert.equal(inFree(3, 6, 59), false);
});

test("取られる順番：手持ち → 預金 → 株（時価で売った扱い）。借入は取られない。取られたものは消える", () => {
  const PRICES = { YGM: 100, YMT: 200 };
  const t = theftTake({ coins: 100, deposit: 300, stocks: { YGM: { qty: 10, cost: 900 }, YMT: { qty: 6, cost: 900 } } }, 250, PRICES);
  assert.deepEqual([t.coins, t.deposit, t.from.coins, t.from.deposit, t.from.stock], [0, 150, 100, 150, 0], "手持ちで足りなければ預金");
  const u = theftTake({ coins: 100, deposit: 300, stocks: { YGM: { qty: 10, cost: 900 }, YMT: { qty: 6, cost: 900 } } }, 1000, PRICES);
  assert.deepEqual([u.coins, u.deposit], [0, 0]);
  assert.equal(u.from.stock, 600, "残りの600を株から");
  assert.deepEqual(u.sold, [{ code: "YMT", qty: 3 }], "時価の高い会社（YMT 200×6=1,200）から、足りるだけ（200×3=600）");
  assert.equal(u.stocks.YMT.qty, 3); assert.equal(u.stocks.YMT.cost, 450, "取得額も、残った株数に合わせて減る"); assert.equal(u.stocks.YGM.qty, 10);
  const v = theftTake({ coins: 0, deposit: 0, stocks: { YGM: { qty: 10, cost: 900 } } }, 250, PRICES);
  assert.equal(v.from.stock, 250); assert.deepEqual(v.sold, [{ code: "YGM", qty: 3 }]);
  assert.equal(v.coins, 50, "売った300のうち、取られた250を超えた50は、手持ちに戻る");
  assert.equal(v.taken, 250);
  assert.equal(theftTake({ coins: 10, deposit: 0, stocks: {} }, 999, PRICES).taken, 10, "取れる分だけ");
});

test("泥棒が動かない分：土日・10/26より前・授業中・夜・ランダムで外れた分は、Firestore に何も読まない", async () => {
  const t = raidSetup();
  const tick = (y, mo, d, h, mi, rnd = () => 0) => runTheftTick({}, JST(y, mo, d, h, mi), t.deps, rnd);
  assert.deepEqual(await tick(2026, 10, 25, 16, 0), { skipped: "outside" }, "10/25（日）は、まだ始まっていない");
  assert.deepEqual(await tick(2026, 10, 24, 16, 0), { skipped: "outside" });
  assert.deepEqual(await tick(2026, 11, 1, 16, 0), { skipped: "weekend" }, "日曜");
  assert.deepEqual(await tick(2026, 10, 31, 16, 0), { skipped: "weekend" }, "土曜");
  assert.deepEqual(await tick(2026, 10, 27, 9, 0), { skipped: "class" }, "火曜の1時限");
  assert.deepEqual(await tick(2026, 10, 26, 15, 30), { skipped: "class" }, "月曜の7時限");
  assert.deepEqual(await tick(2026, 10, 27, 22, 0), { skipped: "class" }, "夜");
  assert.deepEqual(await tick(2026, 10, 27, 16, 0, () => 0.999), { skipped: "quiet" });
  assert.deepEqual(t.fs.counts, { get: 0, getRaw: 0, query: 0, batchGet: 0, commit: 0 });
});

test("泥棒が動いたら、総資産ランキングの対象（15,000以上）の人のところに来る：被害は総資産の5〜15%・1日に1回まで・記録が残る", async () => {
  const t = raidSetup();
  // random：動く(0)→u0に来る(0)→被害の割合 5+floor(0.5×11)＝10%
  const r = await runTheftTick({}, JST(2026, 10, 27, 16, 0), t.deps, seqRandom(0, 0, 0.5));
  assert.deepEqual([r.raid, r.targets, r.hit, r.repelled, r.lost], [true, 1, 1, 0, 2000], "ランキングで15,000以上は1人だけ");
  const u = t.user();
  assert.equal(u.coins, 18000);
  assert.deepEqual([u.theft.day, u.theft.week, u.theft.n, u.theft.last.lost, u.theft.last.kind, u.theft.last.fromCoins, u.theft.last.repelled], ["2026-10-27", "2026-10-26", 1, 2000, "pickpocket", 2000, false]);
  const again = await runTheftTick({}, JST(2026, 10, 27, 17, 0), t.deps, seqRandom(0, 0, 0.5));
  assert.equal(again.hit, 0, "同じ日には、もう来ない"); assert.equal(t.user().coins, 18000);
  const next = await runTheftTick({}, JST(2026, 10, 28, 17, 0), t.deps, seqRandom(0, 0, 0));
  assert.equal(next.lost, 900, "次の日は、そのときの総資産（18,000）の5%");
});

test("防犯グッズ：追い払えたら被害なし（来た回として数える）／追い払えなければ、被害が減る。週が違えば効かない", async () => {
  const week = "2026-10-26";
  const a = raidSetup({ extra: { guards: { [week]: { lv: 5, paid: 2000 } } } });
  // 動く(0)→来る(0)→追い払う（0.5 < 0.9）
  const r = await theftRaid(a.deps, "2026-10-27", seqRandom(0, 0.5));
  assert.deepEqual([r.hit, r.repelled, r.lost], [0, 1, 0]);
  assert.equal(a.user().coins, 20000); assert.deepEqual([a.user().theft.day, a.user().theft.n, a.user().theft.last.repelled, a.user().theft.last.lv], ["2026-10-27", 1, true, 5]);
  // 追い払えなかった（0.95 ≥ 0.9）：割合 5+floor(0.5×11)＝10% → 2,000 の 30% 引き（レベル5は 70% 減）＝ 600
  const b = raidSetup({ extra: { guards: { [week]: { lv: 5, paid: 2000 } } } });
  const r2 = await theftRaid(b.deps, "2026-10-27", seqRandom(0, 0.95, 0.5));
  assert.equal(r2.lost, 600); assert.equal(b.user().coins, 19400);
  // 先週の分・来週の分のグッズは、今週は効かない
  const c = raidSetup({ extra: { guards: { "2026-10-19": { lv: 5, paid: 2000 }, "2026-11-02": { lv: 5, paid: 2000 } } } });
  assert.equal((await theftRaid(c.deps, "2026-10-27", seqRandom(0, 0.5))).lost, 2000);
  // 被害の上限は 10,000
  const d = raidSetup({ coins: 300000, rankingTotal: 300000 });
  assert.equal((await theftRaid(d.deps, "2026-10-27", seqRandom(0, 0.999))).lost, 10000);
});

test("取られる順番（実際の書類）：手持ちで足りなければ預金（利息の対象も減る）→ 株。借入は取られない。実際の総資産が15,000に届かなければ来ない", async () => {
  const t = raidSetup({ coins: 100, rankingTotal: 23200, extra: { bank: { deposit: 700, interestBase: 700, loan: 0 }, stocks: { YMT: { qty: 110, cost: 20000 } } } });   // 100 + 700 + 22,000 ＝ 22,800
  const r = await theftRaid(t.deps, "2026-10-27", seqRandom(0, 0.999, 0.999));   // 15% ＝ 3,420
  assert.equal(r.lost, 3420);
  const u = t.user();
  assert.deepEqual([u.theft.last.kind, u.theft.last.fromCoins, u.theft.last.fromDeposit, u.theft.last.fromStock], ["stock", 100, 700, 2620]);
  assert.deepEqual([u.coins, u.bank.deposit, u.bank.interestBase], [180, 0, 0], "株を売ったぶんのおつりは手持ちに戻る（2,620 を取るのに 14株＝2,800 売って、おつり180）");
  assert.equal(u.stocks.YMT.qty, 96);
  // ランキングは古くて、実際の総資産は 14,000
  const poor = raidSetup({ coins: 14000, rankingTotal: 20000 });
  assert.equal((await theftRaid(poor.deps, "2026-10-27", seqRandom(0, 0))).hit, 0); assert.equal(poor.user().theft, undefined);
  // 借入は総資産から引かれる（20,000 − 6,000 ＝ 14,000 で対象外）
  const loan = raidSetup({ coins: 20000, extra: { bank: { deposit: 0, interestBase: 0, loan: 6000 } } });
  assert.equal((await theftRaid(loan.deps, "2026-10-27", seqRandom(0, 0))).hit, 0);
});

test("プッシュ通知：通知をオンにした本人にだけ届く（被害・撃退）。オフ（初めの状態）なら何も送らない", async () => {
  const sent = [];
  const on = raidSetup({ extra: { theftPush: true } });
  on.fs.putP("fcmTokens/tokA", { uid: "id0" }); on.fs.putP("fcmTokens/tokB", { uid: "other" });
  on.deps.sendFcm = async (token, data) => { sent.push({ token, ...data }); return { ok: true }; };
  await theftRaid(on.deps, "2026-10-27", seqRandom(0, 0.5));
  assert.equal(sent.length, 1); assert.equal(sent[0].token, "tokA");
  assert.match(sent[0].title, /スリ/); assert.match(sent[0].body, /2,000コイン盗まれました/);
  const off = raidSetup();
  off.fs.putP("fcmTokens/tokA", { uid: "id0" });
  off.deps.sendFcm = async (token, data) => { sent.push({ token, ...data }); return { ok: true }; };
  await theftRaid(off.deps, "2026-10-27", seqRandom(0, 0.5));
  assert.equal(sent.length, 1, "オフの人には送らない");
});

test("1週間の様子：月〜金は防犯なしでほぼ毎日（約9割）・土日は来ない・来る時刻はいつも授業中でない・時刻はばらける", async () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const hitDays = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, N = 120, minutes = [];
  for (let w = 0; w < N; w++) {
    for (let dow = 1; dow <= 7; dow++) {
      const t = raidSetup(), ms0 = JST(2026, 11, 2 + w * 7 + (dow - 1), 0);
      let hitAt = -1, ticks = 0;
      for (let m = 0; m < 1440; m++) {
        const r = await runTheftTick({}, ms0 + m * 60000, t.deps, rnd);
        if (r.hit > 0 && hitAt < 0) hitAt = m;
        if (r.raid) ticks++;
      }
      if (dow >= 6) { assert.equal(hitAt, -1, "土日は来ない"); assert.equal(t.fs.counts.getRaw, 0); continue; }
      if (hitAt >= 0) { hitDays[dow]++; minutes.push(hitAt); assert.ok(theftFreeWindows(dow).some(([a, b]) => hitAt >= a && hitAt < b), `曜日${dow} ${hitAt}分は授業中`); }
    }
  }
  const total = Object.values(hitDays).reduce((a, b) => a + b, 0) / (N * 5);
  assert.ok(total > 0.8 && total < 0.97, `平日に来る日の割合 ${total.toFixed(2)}（期待 約0.89）`);
  const early = minutes.filter((m) => m < 900).length / minutes.length;
  assert.ok(early > 0.2 && early < 0.7, `授業のある時間帯（15時前）の休み時間などにも来る ${early.toFixed(2)}`);
  assert.ok(new Set(minutes.map((m) => Math.floor(m / 30))).size >= 15, "時刻はばらける");
});
