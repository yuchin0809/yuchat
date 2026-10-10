/* 💰 ゆう経済・🏇 ゆうダービー（worker.js の /economy）のテスト
   Firestore はメモリ上の偽物（更新時刻の条件・まとめて書き込み・「a.b」の項目指定・サーバー時刻・加算を本物と同じように扱う）
   実行：node --test "notify-worker/test/*.test.mjs" */

import test from "node:test";
import assert from "node:assert/strict";
import {
  handleEconomyAction, handleRequest, nextAutoRaceId, autoRaceTimeMs, jstDateString, validBetShape, betRejectReason, isTrustedRaceResult,
  derbyOddsTable, derbyRaceOddsRecord, derbyRaceOrder, derbyTicketOddsTenths, derbyFixedPayout, derbyBetWins
} from "../worker.js";
import * as odds from "../../derby-odds.js";

const ROOT = "projects/p/databases/(default)/documents";
const enc = (v) => v === null || v === undefined ? { nullValue: null } : v instanceof Date ? { timestampValue: v.toISOString() } : typeof v === "boolean" ? { booleanValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }) : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } } : typeof v === "object" ? { mapValue: { fields: encF(v) } } : { stringValue: String(v) };
const encF = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, enc(v)]));
const dec = (v) => !v ? undefined : "nullValue" in v ? null : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "stringValue" in v ? v.stringValue : "timestampValue" in v ? v.timestampValue : v.arrayValue ? (v.arrayValue.values || []).map(dec) : v.mapValue ? decF(v.mapValue.fields || {}) : undefined;
const decF = (f) => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, dec(v)]));

function applyMask(fields, update, paths) {
  const next = structuredClone(fields);
  for (const path of paths) {
    const parts = path.split(".");
    let src = update, dst = next;
    for (let i = 0; i < parts.length - 1; i++) {
      src = src?.[parts[i]]?.mapValue?.fields;
      if (!dst[parts[i]]?.mapValue) dst[parts[i]] = { mapValue: { fields: {} } };
      dst[parts[i]].mapValue.fields ||= {};
      dst = dst[parts[i]].mapValue.fields;
    }
    const last = parts[parts.length - 1];
    if (src && last in src) dst[last] = structuredClone(src[last]); else delete dst[last];
  }
  return next;
}

function fakeFirestore(initial, clock) {
  const docs = new Map();
  let version = 1;
  const put = (path, fields) => docs.set(path, { fields: structuredClone(fields), updateTime: `t${version++}` });
  Object.entries(initial).forEach(([path, data]) => put(path, encF(data)));
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 2));
  const fs = {
    docs, commits: 0, put,
    async query(collection, filters) {
      await tick();
      return [...docs.entries()].filter(([p]) => p.startsWith(`${collection}/`) && p.split("/").length === 2)
        .filter(([, d]) => filters.every(([f, , v]) => decF(d.fields)[f] === v))
        .map(([p, d]) => ({ id: p.split("/")[1], path: p, updateTime: d.updateTime, data: decF(d.fields) }));
    },
    async get(path) { await tick(); const d = docs.get(path); return d ? decF(d.fields) : null; },
    async getRaw(path) { await tick(); const d = docs.get(path); return d ? structuredClone(d) : null; },
    docName: (path) => `${ROOT}/${path}`,
    async commit(writes) {
      await tick();
      const pathOf = (w) => (w.update?.name || w.delete).slice(ROOT.length + 1);
      for (const w of writes) {
        const cur = docs.get(pathOf(w));
        if (w.currentDocument?.updateTime && cur?.updateTime !== w.currentDocument.updateTime) throw Object.assign(new Error("firestore commit 400 FAILED_PRECONDITION: does not match"), { status: 400 });
        if (w.currentDocument?.exists === false && cur) throw Object.assign(new Error("firestore commit 409 ALREADY_EXISTS"), { status: 409 });
        if (w.currentDocument?.exists === true && !cur) throw Object.assign(new Error("firestore commit 404 NOT_FOUND"), { status: 404 });
      }
      for (const w of writes) {
        if (w.delete) { docs.delete(pathOf(w)); continue; }
        const path = w.update.name.slice(ROOT.length + 1);
        const cur = docs.get(path)?.fields || {};
        const next = w.updateMask ? applyMask(cur, w.update.fields, w.updateMask.fieldPaths) : { ...w.update.fields };
        (w.updateTransforms || []).forEach((t) => {
          if (t.setToServerValue) next[t.fieldPath] = { timestampValue: new Date(clock()).toISOString() };
          if (t.increment) next[t.fieldPath] = { integerValue: String((Number(next[t.fieldPath]?.integerValue) || 0) + Number(t.increment.integerValue)) };
        });
        put(path, next);
      }
      fs.commits++;
    }
  };
  return fs;
}

/* 日本時間 2026-10-20 10:00 */
const NOW = Date.parse("2026-10-20T01:00:00Z");
function setup({ coins = 1000, bank = { deposit: 0, interestBase: 0, loan: 0 }, stocks = {}, extra = {}, now = NOW, docs = {} } = {}) {
  let clock = now;
  const firestore = fakeFirestore({
    "users/たろう": { uid: "uT", name: "たろう", coins, bank, stocks, lastSeen: "keep", ...extra },
    "users/はなこ": { uid: "uH", name: "はなこ", coins: 777 },
    "market/current": { date: "2026-10-19", companies: { YGM: { price: 200 }, YEN: { price: 300 } } },
    ...docs
  }, () => clock);
  const deps = { firestore, now: () => clock, random: (() => { let i = 0; return () => ((i++ * 0.6180339) % 1); })() };
  return { firestore, deps, setNow: (ms) => { clock = ms; } };
}
const me = (fs) => decF(fs.docs.get("users/たろう").fields);
const call = (deps, body, uid = "uT") => handleEconomyAction(deps, uid, { username: "たろう", ...body });
const bets = (fs) => [...fs.docs.entries()].filter(([p]) => p.startsWith("raceBets/")).map(([p, d]) => ({ id: p.split("/")[1], ...decF(d.fields) }));

/* ===== 固定オッズ・結果：derby-odds.js と同じ ===== */

test("オッズ表・記録・着順・払戻し・的中判定が derby-odds.js（アプリ・derby-runner）と同じ", () => {
  for (const raceId of ["2026-10-09", "2026-10-10-1130", "2026-11-03", "2026-12-31-m1800", "2027-01-15-1130"]) {
    const a = derbyOddsTable(raceId), b = odds.getRaceOddsTable(raceId);
    for (const type of ["win", "place", "quinella", "trio", "trifecta"]) assert.deepEqual(a[type], b[type], `${raceId} ${type}`);
    assert.deepEqual(derbyRaceOddsRecord(raceId), odds.buildRaceOddsRecord(raceId));
    const seq = () => { let x = 0.123; return () => (x = (x * 9301 + 0.49297) % 1); };
    assert.deepEqual(derbyRaceOrder(raceId, seq()), odds.generateFixedOddsRaceOrder(raceId, seq()));
    for (const [type, horses] of [["win", [3]], ["place", [9]], ["quinella", [2, 7]], ["trio", [1, 5, 9]], ["trifecta", [5, 3, 1]]]) {
      assert.equal(derbyTicketOddsTenths(a, type, horses), odds.getTicketOddsTenths(b, type, horses));
    }
  }
  for (const [amount, t] of [[100, 25], [37, 11], [10, 9999], [0, 30], [-5, 30]]) assert.equal(derbyFixedPayout(amount, t), odds.computeFixedPayout(amount, t));
  assert.equal(derbyOddsTable("2026-10-08"), null, "固定オッズより前は対象外");
});

test("的中判定：単勝・複勝・馬連・三連複・三連単", () => {
  const order = [5, 3, 9, 1, 2, 4, 6, 7, 8, 10];
  assert.ok(derbyBetWins({ type: "win", horses: [5] }, order));
  assert.ok(derbyBetWins({ type: "place", horses: [9] }, order));
  assert.ok(!derbyBetWins({ type: "place", horses: [1] }, order));
  assert.ok(derbyBetWins({ type: "quinella", horses: [3, 5] }, order));
  assert.ok(derbyBetWins({ type: "trio", horses: [9, 5, 3] }, order));
  assert.ok(derbyBetWins({ type: "trifecta", horses: [5, 3, 9] }, order));
  assert.ok(!derbyBetWins({ type: "trifecta", horses: [3, 5, 9] }, order));
});

test("開催時刻：自動開催は 11:30（2026-10-07 から）と 15:02。受付中は締切（10分前）前のいちばん早い回", () => {
  assert.equal(new Date(autoRaceTimeMs("2026-10-20")).toISOString(), "2026-10-20T06:02:00.000Z");
  assert.equal(new Date(autoRaceTimeMs("2026-10-20-1130")).toISOString(), "2026-10-20T02:30:00.000Z");
  assert.equal(autoRaceTimeMs("2026-10-06-1130"), null);
  assert.equal(autoRaceTimeMs("2026-10-20-m1800"), null);
  assert.equal(nextAutoRaceId(Date.parse("2026-10-20T01:00:00Z")), "2026-10-20-1130");   /* 10:00 */
  assert.equal(nextAutoRaceId(Date.parse("2026-10-20T02:19:59Z")), "2026-10-20-1130");   /* 11:19:59 */
  assert.equal(nextAutoRaceId(Date.parse("2026-10-20T02:20:00Z")), "2026-10-20");        /* 11:20 締切 → 15:02 の回 */
  assert.equal(nextAutoRaceId(Date.parse("2026-10-20T05:52:00Z")), "2026-10-21-1130");   /* 14:52 締切 → 翌日 11:30 */
  assert.equal(nextAutoRaceId(Date.parse("2026-10-20T15:30:00Z")), "2026-10-21-1130");   /* 翌 0:30 */
  assert.equal(jstDateString(Date.parse("2026-10-20T15:30:00Z")), "2026-10-21");
});

/* ===== 銀行・株・ボーナス ===== */

test("預け入れ・引き出し：残高を確かめて、コインと預金を移す（利息の対象は預金を超えない）。ほかの項目はそのまま", async () => {
  const { firestore, deps } = setup({ coins: 1000, bank: { deposit: 200, interestBase: 200, loan: 0, interestDate: "2026-10-19" } });
  assert.equal((await call(deps, { action: "bankDeposit", amount: 300 })).ok, true);
  assert.deepEqual([me(firestore).coins, me(firestore).bank.deposit, me(firestore).bank.interestBase, me(firestore).bank.interestDate, me(firestore).lastSeen], [700, 500, 200, "2026-10-19", "keep"]);
  assert.equal((await call(deps, { action: "bankWithdraw", amount: 450 })).ok, true);
  assert.deepEqual([me(firestore).coins, me(firestore).bank.deposit, me(firestore).bank.interestBase], [1150, 50, 50]);
  assert.equal((await call(deps, { action: "bankDeposit", amount: 1151 })).error, "NOT_ENOUGH_COINS");
  assert.equal((await call(deps, { action: "bankWithdraw", amount: 51 })).error, "NOT_ENOUGH_DEPOSIT");
});

test("借入・返済：手持ち100以下のときだけ500借りられ、期限は7日後。借入中は預け入れ・追加の借入はできない。返済は全額", async () => {
  const { firestore, deps } = setup({ coins: 120 });
  assert.equal((await call(deps, { action: "bankBorrow" })).error, "TOO_MANY_COINS");
  firestore.put("users/たろう", encF({ ...me(firestore), coins: 80 }));
  const r = await call(deps, { action: "bankBorrow" });
  assert.equal(r.ok, true);
  const u = me(firestore);
  assert.deepEqual([u.coins, u.bank.loan, u.bank.overdue], [580, 500, false]);
  assert.equal(Date.parse(u.bank.loanDueAt) - Date.parse(u.bank.loanTakenAt), 7 * 86400000);
  assert.equal(firestore.docs.get("users/たろう").fields.bank.mapValue.fields.loanDueAt.timestampValue !== undefined, true, "期限は日時の型で保存");
  assert.equal((await call(deps, { action: "bankBorrow" })).error, "LOAN_ACTIVE");
  assert.equal((await call(deps, { action: "bankDeposit", amount: 10 })).error, "LOAN_ACTIVE");
  firestore.put("users/たろう", encF({ ...me(firestore), coins: 499 }));
  assert.equal((await call(deps, { action: "bankRepay" })).error, "NOT_ENOUGH_COINS");
  firestore.put("users/たろう", encF({ ...me(firestore), coins: 600 }));
  assert.equal((await call(deps, { action: "bankRepay" })).ok, true);
  assert.deepEqual([me(firestore).coins, me(firestore).bank.loan, me(firestore).bank.loanDueAt], [100, 0, null]);
  assert.equal((await call(deps, { action: "bankRepay" })).error, "NO_LOAN");
});

test("株の売買：株価はサーバー（market/current）の値。買うとコインが減り、売ると取得額が比例して減る。全部売ると銘柄が消える", async () => {
  const { firestore, deps } = setup({ coins: 1000 });
  const b = await call(deps, { action: "stockTrade", code: "YEN", side: "buy", qty: 3, price: 1 });
  assert.deepEqual([b.ok, b.price, b.amount], [true, 300, 900], "ブラウザから送られた株価は使わない");
  assert.deepEqual([me(firestore).coins, me(firestore).stocks.YEN], [100, { qty: 3, cost: 900 }]);
  assert.equal((await call(deps, { action: "stockTrade", code: "YEN", side: "buy", qty: 1 })).error, "NOT_ENOUGH_COINS");
  assert.equal((await call(deps, { action: "stockTrade", code: "YEN", side: "sell", qty: 4 })).error, "NOT_ENOUGH_STOCK");
  await call(deps, { action: "stockTrade", code: "YEN", side: "sell", qty: 1 });
  assert.deepEqual([me(firestore).coins, me(firestore).stocks.YEN], [400, { qty: 2, cost: 600 }]);
  await call(deps, { action: "stockTrade", code: "YEN", side: "sell", qty: 2 });
  assert.equal("YEN" in me(firestore).stocks, false);
  /* market に無い銘柄は最初の株価（アプリと同じ） */
  assert.equal((await call(deps, { action: "stockTrade", code: "YPY", side: "buy", qty: 1 })).price, 210);
  for (const [body, error] of [[{ code: "XXX", side: "buy", qty: 1 }, "NO_COMPANY"], [{ code: "YEN", side: "steal", qty: 1 }, "invalid_side"], [{ code: "YEN", side: "buy", qty: 0 }, "invalid_qty"], [{ code: "YEN", side: "buy", qty: -3 }, "invalid_qty"], [{ code: "YEN", side: "buy", qty: 1.5 }, "invalid_qty"], [{ code: "YEN", side: "buy", qty: 100001 }, "invalid_qty"]]) {
    assert.equal((await call(deps, { action: "stockTrade", ...body })).error, error, JSON.stringify(body));
  }
});

test("ログインボーナス（日本時間で1日1回）・追加ボーナス（1人1回）", async () => {
  const { firestore, deps, setNow } = setup({ coins: 100 });
  assert.equal((await call(deps, { action: "loginBonus" })).granted, true);
  assert.equal((await call(deps, { action: "loginBonus" })).granted, false);
  assert.deepEqual([me(firestore).coins, me(firestore).lastLoginBonusDate], [150, "2026-10-20"]);
  setNow(Date.parse("2026-10-20T15:00:00Z")); /* 日本時間 翌 0:00 */
  assert.equal((await call(deps, { action: "loginBonus" })).granted, true);
  assert.equal(me(firestore).coins, 200);
  assert.equal((await call(deps, { action: "bonus500" })).granted, true);
  assert.equal((await call(deps, { action: "bonus500" })).granted, false);
  assert.equal(me(firestore).coins, 700);
  /* 同時に10回押しても1回だけ */
  const s2 = setup({ coins: 0 });
  await Promise.all(Array.from({ length: 10 }, () => call(s2.deps, { action: "loginBonus" })));
  assert.equal(me(s2.firestore).coins, 50);
});

test("不正な金額は拒否（0・マイナス・小数・文字列・大きすぎる）。何も変わらない", async () => {
  const { firestore, deps } = setup();
  for (const amount of [0, -100, 1.5, "100", NaN, Infinity, 100000001, undefined]) {
    for (const action of ["bankDeposit", "bankWithdraw"]) assert.equal((await call(deps, { action, amount })).error, "invalid_amount", `${action} ${amount}`);
  }
  assert.equal(firestore.commits, 0);
});

test("本人の users だけを変える：ほかの人の名前を送っても、その人のデータは変わらない（自分の uid の users を使う）", async () => {
  const { firestore, deps } = setup({ coins: 1000 });
  const r = await handleEconomyAction(deps, "uT", { action: "bankDeposit", amount: 100, username: "はなこ" });
  assert.equal(r.ok, true);
  assert.equal(decF(firestore.docs.get("users/はなこ").fields).coins, 777);
  assert.equal(me(firestore).coins, 900);
  assert.equal((await handleEconomyAction(deps, "nobody", { action: "loginBonus" })).error, "NO_USER");
});

test("同時に：預け入れ20回とアプリ・自動処理のコインの書き換えが重なっても、残高が合う（失われた更新・二重なし）", async () => {
  const { firestore, deps } = setup({ coins: 10000 });
  const results = await Promise.all(Array.from({ length: 20 }, () => call(deps, { action: "bankDeposit", amount: 100 })));
  const ok = results.filter((r) => r.ok).length;
  results.filter((r) => !r.ok).forEach((r) => assert.equal(r.error, "busy"));
  assert.equal(me(firestore).coins + me(firestore).bank.deposit, 10000);
  assert.equal(me(firestore).bank.deposit, ok * 100);
});

/* ===== ゆうダービー ===== */

const BET = { action: "placeBet", raceId: "2026-10-20-1130", type: "win", horses: [5], amount: 100 };

test("馬券：受付中の回（締切前）だけ買える。コイン・累計賭け金・馬券を1回の書き込みで作り、オッズはサーバーで記録", async () => {
  const { firestore, deps } = setup({ coins: 1000, extra: { totalBetAmount: 50 } });
  const r = await call(deps, { ...BET, oddsTenths: 99999 });
  assert.equal(r.ok, true);
  assert.equal(firestore.commits, 1);
  assert.deepEqual([me(firestore).coins, me(firestore).totalBetAmount], [900, 150]);
  const [bet] = bets(firestore);
  assert.deepEqual([bet.raceId, bet.uid, bet.username, bet.type, bet.horses, bet.amount, bet.settled, bet.placedBy], ["2026-10-20-1130", "uT", "たろう", "win", [5], 100, false, "worker"]);
  assert.equal(bet.oddsTenths, odds.getTicketOddsTenths(odds.getRaceOddsTable("2026-10-20-1130"), "win", [5]), "ブラウザから送られたオッズは使わない");
  assert.ok(bet.createdAt, "サーバーの時刻");
});

test("馬券：締切後・まだ受付前の回・過去の回・存在しない回・固定オッズより前の回は拒否", async () => {
  const { firestore, deps, setNow } = setup({ coins: 1000 });
  setNow(Date.parse("2026-10-20T02:20:00Z")); /* 11:20（11:30 の回の締切） */
  assert.equal((await call(deps, BET)).error, "RACE_CLOSED");
  setNow(NOW);
  for (const raceId of ["2026-10-20", "2026-10-21-1130", "2026-10-19", "2026-10-08", "2026-10-20-0930", "../users/x", ""]) {
    assert.ok(["RACE_CLOSED", "invalid_race"].includes((await call(deps, { ...BET, raceId })).error), raceId);
  }
  assert.equal(firestore.commits, 0);
  assert.equal(me(firestore).coins, 1000);
});

test("馬券：不正な中身（券種・馬の数・馬番号・重複・金額・コイン不足）は拒否", async () => {
  const { firestore, deps } = setup({ coins: 1000 });
  const cases = [
    [{ type: "jackpot" }, "invalid_bet_type"], [{ horses: [] }, "invalid_horses"], [{ horses: [11] }, "invalid_horses"], [{ horses: [0] }, "invalid_horses"],
    [{ type: "quinella", horses: [3, 3] }, "invalid_horses"], [{ type: "trio", horses: [1, 2] }, "invalid_horses"], [{ horses: ["5"] }, "invalid_horses"],
    [{ amount: 9 }, "invalid_amount"], [{ amount: -1000 }, "invalid_amount"], [{ amount: 10.5 }, "invalid_amount"], [{ amount: "100" }, "invalid_amount"],
    [{ amount: 1001 }, "NOT_ENOUGH_COINS"]
  ];
  for (const [over, error] of cases) assert.equal((await call(deps, { ...BET, ...over })).error, error, JSON.stringify(over));
  assert.equal(firestore.commits, 0);
});

test("手動レース：受付時間内・キャンセルされていないときだけ。投票数（betCount）も同じ書き込みで増える", async () => {
  const raceId = "2026-10-20-m1800";
  const manual = (o) => ({ [`derbyManualRaces/${raceId}`]: { raceId, status: "scheduled", betCount: 2, openAt: new Date(NOW - 3600e3), closeAt: new Date(NOW + 3600e3), raceAt: new Date(NOW + 4000e3), ...o } });
  const s = setup({ docs: manual() });
  assert.equal((await call(s.deps, { ...BET, raceId })).ok, true);
  assert.equal(decF(s.firestore.docs.get(`derbyManualRaces/${raceId}`).fields).betCount, 3);
  assert.equal((await call(setup({ docs: manual({ status: "cancelled" }) }).deps, { ...BET, raceId })).error, "MANUAL_RACE_CANCELLED");
  assert.equal((await call(setup({ docs: manual({ closeAt: new Date(NOW - 1) }) }).deps, { ...BET, raceId })).error, "MANUAL_RACE_CLOSED");
  assert.equal((await call(setup({ docs: manual({ openAt: new Date(NOW + 1000) }) }).deps, { ...BET, raceId })).error, "MANUAL_RACE_CLOSED");
  assert.equal((await call(setup().deps, { ...BET, raceId })).error, "RACE_CLOSED", "予定の無い手動レース");
});

test("レース結果：発走時刻を過ぎてからサーバーが作る（結果・演出・オッズの記録・開催ログ）。発走前は作らない。2回目は作り直さない", async () => {
  const { firestore, deps, setNow } = setup();
  const raceId = "2026-10-20-1130";
  assert.equal((await call(deps, { action: "ensureRaceResult", raceId })).error, "race_not_started");
  setNow(Date.parse("2026-10-20T02:30:00Z"));
  assert.deepEqual(await call(deps, { action: "ensureRaceResult", raceId }), { ok: true, created: true });
  const race = decF(firestore.docs.get(`races/${raceId}`).fields);
  assert.equal(race.generatedBy, "worker");
  assert.deepEqual([...race.resultOrder].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(race.checkpoints.length, 48); assert.equal(race.finishStats.length, 10);
  assert.deepEqual(race.oddsWinTenths, odds.buildRaceOddsRecord(raceId).oddsWinTenths);
  assert.equal(decF(firestore.docs.get(`raceLogs/${raceId}`).fields).resultGeneratedBy, "worker");
  const before = firestore.docs.get(`races/${raceId}`).updateTime;
  assert.deepEqual(await call(deps, { action: "ensureRaceResult", raceId }), { ok: true, created: false });
  assert.equal(firestore.docs.get(`races/${raceId}`).updateTime, before);
  /* 同時に10回でも1つだけ */
  const s2 = setup({ now: Date.parse("2026-10-20T02:31:00Z") });
  await Promise.all(Array.from({ length: 10 }, () => call(s2.deps, { action: "ensureRaceResult", raceId })));
  assert.equal(s2.firestore.commits, 1);
});

test("精算：結果をもとにサーバーが払い戻しを計算し、当たりの分だけコインを増やす（ブラウザの払戻し額は使わない）。2回目は何もしない", async () => {
  const raceId = "2026-10-20-1130";
  const order = [5, 3, 9, 1, 2, 4, 6, 7, 8, 10];
  const created = new Date(Date.parse("2026-10-20T02:00:00Z"));
  const bet = (id, o) => ({ [`raceBets/${id}`]: { raceId, uid: "uT", username: "たろう", settled: false, win: null, payout: null, createdAt: created, placedBy: "worker", ...o } });
  const { firestore, deps } = setup({ coins: 0, now: Date.parse("2026-10-20T02:35:00Z"), docs: {
    [`races/${raceId}`]: { raceId, resultOrder: order, generatedBy: "worker" },
    ...bet("b1", { type: "win", horses: [5], amount: 100 }),
    ...bet("b2", { type: "trifecta", horses: [5, 3, 9], amount: 10 }),
    ...bet("b3", { type: "win", horses: [1], amount: 100 }),
    ...bet("late", { type: "win", horses: [5], amount: 1000, createdAt: new Date(Date.parse("2026-10-20T02:25:00Z")) }),
    ...bet("other", { type: "win", horses: [5], amount: 100, uid: "uH", username: "はなこ" })
  } });
  const r = await call(deps, { action: "settleMyBets", raceId, payout: 99999999 });
  const table = odds.getRaceOddsTable(raceId);
  const expected = odds.computeFixedPayout(100, table.win[5]) + odds.computeFixedPayout(10, table.trifecta["5-3-9"]);
  assert.equal(r.payoutTotal, expected);
  assert.equal(me(firestore).coins, expected);
  const byId = Object.fromEntries(bets(firestore).map((b) => [b.id, b]));
  assert.deepEqual([byId.b1.settled, byId.b1.win, byId.b1.settledBy, byId.b1.payoutRule], [true, true, "worker", "fixed-v1"]);
  assert.deepEqual([byId.b3.win, byId.b3.payout], [false, 0]);
  assert.deepEqual([byId.late.settled, byId.late.payout, byId.late.rejectedReason], [true, 0, "after_close"], "締切後に作られた馬券は払わない");
  assert.equal(byId.other.settled, false, "他人の馬券には触れない");
  assert.equal((await call(deps, { action: "settleMyBets", raceId })).settled.length, 0);
  assert.equal(me(firestore).coins, expected, "二重に払わない");
});

test("精算（山分け方式・固定オッズより前のレース）：そのレースの全馬券から払い戻しを計算し、当たった人で賭け金に応じて分ける", async () => {
  const raceId = "2026-10-08"; /* 固定オッズより前 */
  const order = [5, 3, 9, 1, 2, 4, 6, 7, 8, 10];
  const created = new Date("2026-10-08T05:50:00Z");
  const bet = (id, uid, o) => ({ [`raceBets/${id}`]: { raceId, uid, username: uid, settled: false, win: null, payout: null, createdAt: created, ...o } });
  const { firestore, deps } = setup({ coins: 0, now: Date.parse("2026-10-08T06:10:00Z"), docs: {
    [`races/${raceId}`]: { raceId, resultOrder: order, generatedBy: "github-actions" },
    ...bet("w1", "uT", { type: "win", horses: [5], amount: 100 }),   /* 当たり（単勝プール 100+300=400、当たり 100）*/
    ...bet("w2", "uH", { type: "win", horses: [3], amount: 300 })    /* はずれ */
  } });
  const r = await call(deps, { action: "settleMyBets", raceId });
  /* payout = floor(100/100 * 400 * 0.8) = 320 */
  assert.equal(r.payoutTotal, 320);
  assert.equal(me(firestore).coins, 320);
  const w1 = decF(firestore.docs.get("raceBets/w1").fields);
  assert.deepEqual([w1.settled, w1.win, w1.payout, w1.settledBy, w1.payoutRule], [true, true, 320, "worker", undefined]);
});

test("精算：結果が無いレースは精算しない。DERBY_SERVER_RESULTS_FROM 以降はブラウザが作った結果を信用しない", () => {
  const raceId = "2026-10-20";
  const race = { resultOrder: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
  assert.equal(isTrustedRaceResult(raceId, null), false);
  assert.equal(isTrustedRaceResult(raceId, { resultOrder: [1, 2] }), false);
  assert.equal(isTrustedRaceResult(raceId, { ...race, generatedBy: "client" }, null), true, "確かめる日付が無いときは今まで通り");
  assert.equal(isTrustedRaceResult(raceId, { ...race, generatedBy: "client" }, "2026-10-15"), false);
  assert.equal(isTrustedRaceResult("2026-10-14", { ...race, generatedBy: "client" }, "2026-10-15"), true, "それより前のレースはそのまま");
  assert.equal(isTrustedRaceResult(raceId, { ...race, generatedBy: "worker" }, "2026-10-15"), true);
  assert.equal(isTrustedRaceResult(raceId, { ...race, generatedBy: "github-actions" }, "2026-10-15"), true);
});

test("精算してよい馬券か：中身・締切（サーバーの記録時刻）・サーバーで買われたか", () => {
  const close = Date.parse("2026-10-20T02:20:00Z");
  const ok = { raceId: "2026-10-20-1130", type: "win", horses: [5], amount: 100, createdAt: "2026-10-20T02:19:59Z", placedBy: "worker" };
  assert.equal(betRejectReason(ok, close), null);
  assert.equal(betRejectReason({ ...ok, createdAt: "2026-10-20T02:20:01Z" }, close), "after_close");
  assert.equal(betRejectReason({ ...ok, createdAt: undefined }, close), "after_close");
  assert.equal(betRejectReason({ ...ok, amount: -100 }, close), "invalid_bet");
  assert.equal(betRejectReason({ ...ok, horses: [5, 5] }, close), "invalid_bet");
  assert.equal(betRejectReason({ ...ok, placedBy: undefined }, close, null), null, "移行前の馬券（ブラウザで買った）も締切前なら払う");
  assert.equal(betRejectReason({ ...ok, placedBy: undefined }, close, "2026-10-15"), "not_server_placed");
  assert.equal(validBetShape("trio", [1, 2, 3], 10), null);
});

test("初期コイン：コインがまだ無いときだけ 1000 を付ける。すでにあれば何もしない", async () => {
  const { firestore, deps } = setup({ extra: { coins: undefined }, coins: undefined });
  firestore.put("users/たろう", encF({ uid: "uT", name: "たろう" }));
  const r = await call(deps, { action: "startingCoins" });
  assert.deepEqual([r.granted, r.coins], [true, 1000]);
  assert.equal(me(firestore).coins, 1000);
  const r2 = await call(deps, { action: "startingCoins" });
  assert.deepEqual([r2.granted, r2.coins], [false, 1000]);
  assert.equal(me(firestore).coins, 1000);
});

test("名前変更の引き継ぎ：from・to がどちらも自分なら、経済項目をコピーして from を消す。どちらかが他人なら拒否", async () => {
  const { firestore, deps } = setup({ coins: 1234, bank: { deposit: 500, interestBase: 500, loan: 0 }, stocks: { YEN: { qty: 2, cost: 600 } }, extra: { totalBetAmount: 42, bonus500Granted: true, lastLoginBonusDate: "2026-10-20" } });
  firestore.put("users/たろう2", encF({ uid: "uT", name: "たろう2", profileImage: "x" }));
  const r = await handleEconomyAction(deps, "uT", { action: "renameCarry", from: "たろう", to: "たろう2" });
  assert.equal(r.carried, true);
  const to = decF(firestore.docs.get("users/たろう2").fields);
  assert.deepEqual([to.coins, to.bank.deposit, to.stocks.YEN.qty, to.totalBetAmount, to.bonus500Granted, to.lastLoginBonusDate, to.profileImage], [1234, 500, 2, 42, true, "2026-10-20", "x"]);
  assert.equal(firestore.docs.has("users/たろう"), false, "古い名前は消える");
  /* to が他人 */
  firestore.put("users/たろう", encF({ uid: "uT", name: "たろう", coins: 5 }));
  firestore.put("users/はなこ2", encF({ uid: "uH", name: "はなこ2" }));
  assert.equal((await handleEconomyAction(deps, "uT", { action: "renameCarry", from: "たろう", to: "はなこ2" })).error, "rename_to_not_mine");
  assert.equal(firestore.docs.has("users/たろう"), true, "拒否されたら消さない");
  /* from が他人（to は自分） */
  firestore.put("users/たろう3", encF({ uid: "uT", name: "たろう3" }));
  assert.equal((await handleEconomyAction(deps, "uT", { action: "renameCarry", from: "はなこ", to: "たろう3" })).error, "rename_from_not_mine");
  /* from が無い（引き継ぐものが無い） */
  assert.deepEqual(await handleEconomyAction(deps, "uT", { action: "renameCarry", from: "いない", to: "たろう3" }), { ok: true, carried: false });
  /* 不正な名前 */
  assert.equal((await handleEconomyAction(deps, "uT", { action: "renameCarry", from: "a/b", to: "たろう3" })).error, "invalid_rename");
});

test("HTTP：/economy はログインが必要（ID トークンなしは 401）。不明な操作は 400", async () => {
  const deps = { verifyIdToken: async () => { throw new Error("bad"); }, firestore: {}, now: () => NOW };
  const env = { ALLOWED_ORIGINS: "https://app.example" };
  const req = (headers, body) => new Request("https://w.example/economy", { method: "POST", headers: { Origin: "https://app.example", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await handleRequest(req({}, { action: "bonus500" }), env, deps)).status, 401);
  assert.equal((await handleRequest(req({ Authorization: "Bearer x.y.z" }, { action: "bonus500" }), env, deps)).status, 401);
  const ok = { ...deps, verifyIdToken: async () => "uT" };
  const r = await handleRequest(req({ Authorization: "Bearer good" }, { action: "giveMeCoins" }), env, ok);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "unknown_action");
});
