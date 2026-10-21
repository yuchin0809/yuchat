/* 🎟 ゆう宝くじ売り場（worker.js）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LOTTERY, lotteryNextDrawMs, lotteryRoundId, lotteryEventFor, lotteryPrizeOf, lotteryTiersFor, lotteryNumberLabel, lotterySaleStartMs, lotteryPrizeNumbers, lotteryAllocate, lotteryDrawWinners,
  lotteryRunDraw, lotteryResizeRound, runLotteryTick, handleYuslotAction, resetLotteryCacheForTest
} from "../worker.js";

console.warn = () => {}; // 通知の送信（テストでは未接続）の警告を出さない

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
    docs, counts, put, plain,
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

const ADMIN = "adminUid";
const T = Date.UTC(2026, 9, 23, 5, 30, 0);          // 2026-10-23（金）14:30 JST（最初の抽選）
const MIN = 60000, WEEK = 7 * 86400000;
const rngOf = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
function setup({ now = T - 3 * 3600000, users, extra = {}, random = rngOf(7) } = {}) {
  resetLotteryCacheForTest();
  const base = { "worldConfig/lottery": { lotteryPublished: true }, ...extra };
  const u = users || { "たろう": { uid: "uT", name: "たろう", coins: 1000 }, "はなこ": { uid: "uH", name: "はなこ", coins: 1000 }, "じろう": { uid: "uJ", name: "じろう", coins: 1000 } };
  Object.entries(u).forEach(([n, d]) => { base[`users/${n}`] = d; });
  const fs = fakeFs(base);
  const state = { now };
  const deps = { firestore: fs, adminUid: ADMIN, random, now: () => state.now };
  const buy = (uid, name, count, mode) => handleYuslotAction(deps, uid, { action: "lotteryBuy", count, mode, username: name });
  return { fs, deps, state, buy };
}
const coins = (fs, n) => Number(fs.docs.get(`users/${n}`).fields.coins.integerValue);

test("抽選日時：次の金曜 14:30（JST）。ちょうどの時刻は次の回。回IDは抽選日", () => {
  assert.equal(lotteryNextDrawMs(Date.UTC(2026, 9, 19, 1, 0, 0)), T, "月曜 → 今週金曜");
  assert.equal(lotteryNextDrawMs(T - 1), T);
  assert.equal(lotteryNextDrawMs(T), T + WEEK, "抽選の瞬間から次の回");
  assert.equal(lotteryNextDrawMs(T + 30 * MIN), T + WEEK, "抽選後は来週");
  assert.equal(lotteryRoundId(T), "2026-10-23");
  assert.equal(new Date(T + 9 * 3600000).getUTCHours(), 14);
  assert.equal(new Date(T + 9 * 3600000).getUTCMinutes(), 30);
});

test("毎週名前と賞金の倍率が変わり、6週に1回ビッグイベント。特別回の上書きも効く", () => {
  const ev = Array.from({ length: 12 }, (_, i) => lotteryEventFor(T + i * WEEK));
  assert.equal(new Set(ev.slice(0, 5).map((e) => e.name)).size, 5, "連続する週で名前が変わる");
  assert.ok(ev.slice(1, 4).map((e) => e.scale).every((x, i, a) => a.indexOf(x) === i), "ふつうの週は倍率が週ごとに違う");
  assert.ok(ev.slice(1, 5).every((e) => !e.big), "最初の回のあとの数週はふつうの週");
  assert.deepEqual(ev.map((e) => e.big), [true, false, false, false, false, true, false, false, false, true, true, false]);
  assert.match(ev[0].name, /グランドオープン/);
  assert.equal(lotteryPrizeOf(LOTTERY.tiers[0], ev[0].scale), 10000, "最初の回の1等は10,000");
  assert.equal(lotteryPrizeOf(LOTTERY.tiers.find((t) => t.name === "2等"), ev[0].scale), 3000, "最初の回の2等は3,000");
  assert.equal(lotteryPrizeOf(LOTTERY.tiers.find((t) => t.adjacent), ev[0].scale), 2500, "最初の回の前後賞は2,500");
  assert.ok(ev.slice(1).filter((e) => e.big).every((e) => e.scale >= 1.5), "初回以外のビッグは賞金が大きい");
  assert.ok(ev.filter((e) => !e.big).every((e) => e.scale <= 1), "ふつうの週は控えめ（賞金の合計が売上を超えない）");
  const nye = lotteryEventFor(Date.UTC(2026, 11, 25, 5, 30, 0));
  assert.equal(nye.big, true); assert.equal(nye.scale, 2); assert.match(nye.name, /年末/);
});

test("販売の開始：抽選の週の月曜 8:00（日本時間）。抽選のあと次の販売開始までは準備中", () => {
  const start = lotterySaleStartMs(T);
  const d = new Date(start + 9 * 3600000);
  assert.equal(d.getUTCDay(), 1, "月曜日"); assert.equal(d.getUTCHours(), 8); assert.equal(d.getUTCMinutes(), 0);
  assert.equal(lotteryRoundId(start), "2026-10-19");
  assert.equal(lotteryEventFor(T).saleStartMs, start);
  // 10/23(金)の抽選のあと、次の販売開始は 10/26(月) 8:00。その回の抽選は 10/30(金) 14:30
  const next = lotteryEventFor(T + WEEK);
  assert.equal(lotteryRoundId(next.saleStartMs), "2026-10-26");
  assert.equal(new Date(next.saleStartMs + 9 * 3600000).getUTCHours(), 8);
  assert.ok(next.saleStartMs > T && next.saleStartMs < next.closeMs);
});

test("等級：1等は全体で1本。前後賞2,500・賞金は上位ほど大きく、倍率で変わる（7等だけは元返し固定）", () => {
  assert.equal(LOTTERY.price, 10); assert.equal(LOTTERY.poolSize, 1500);
  assert.equal(LOTTERY.maxPerRound, undefined, "1人あたりの購入上限はない"); assert.equal(LOTTERY.maxPerBuy, undefined);
  assert.equal(LOTTERY.tiers[0].name, "1等"); assert.equal(LOTTERY.tiers[0].count, 1, "1等は1本だけ");
  const adj = LOTTERY.tiers.filter((t) => t.adjacent);
  assert.equal(adj.length, 1); assert.equal(adj[0].count, 2, "前後賞は前と後ろの2本");
  assert.deepEqual(lotteryTiersFor(1).map((t) => [t.name, t.count, t.prize]),
    [["1等", 1, 10000], ["前後賞", 2, 2500], ["2等", 1, 3000], ["3等", 3, 1000], ["4等", 10, 300], ["5等", 20, 150], ["6等", 60, 30], ["7等", 115, 10]]);
  assert.equal(lotteryTiersFor(1)[1].adjacent, true);
  assert.equal(lotteryTiersFor(2)[0].prize, 20000); assert.equal(lotteryTiersFor(2)[1].prize, 5000);
  assert.equal(lotteryTiersFor(2)[7].prize, LOTTERY.price, "元返しは倍率をかけない");
  const total = (m) => lotteryTiersFor(m).reduce((s, t) => s + t.count * t.prize, 0);
  const ret = (m) => total(m) / (LOTTERY.poolSize * LOTTERY.price);
  assert.equal(total(1), 29950, "賞金の額・本数は変えていない");
  assert.ok(ret(0.9) > 1.7 && ret(1) < 2.1, `1,500枚に減らしたので、全部売れたときの賞金の割合は約2倍（${ret(0.9)}〜${ret(1)}）`);
  assert.equal(lotteryNumberLabel(0), "01組000番"); assert.equal(lotteryNumberLabel(1234), "13組034番"); assert.equal(lotteryNumberLabel(1499), "15組099番");
});

test("当選番号：重ならずに全部で212個。前後賞は1等の前後（端は輪になる）", () => {
  const rng = rngOf(2024);
  for (let i = 0; i < 200; i++) {
    const p = lotteryPrizeNumbers(rng);
    assert.equal(p.length, LOTTERY.tiers.reduce((s, t) => s + t.count, 0));
    assert.equal(new Set(p.map((x) => x.number)).size, p.length, "番号は重ならない");
    assert.ok(p.every((x) => x.number >= 0 && x.number < LOTTERY.poolSize));
    const first = p.find((x) => x.tier === "1等").number;
    const adjN = p.filter((x) => x.tier === "前後賞").map((x) => x.number).sort((a, b) => a - b);
    assert.deepEqual(adjN, [(first + 1499) % 1500, (first + 1) % 1500].sort((a, b) => a - b), "前後賞は1等の前後");
  }
  const edge = (v) => { let first = true; const r = rngOf(5); return () => { if (first) { first = false; return v; } return r(); }; };
  const lo = lotteryPrizeNumbers(edge(0)); // 1等が 01組000番 → 前後賞は 15組099番 と 01組001番
  assert.deepEqual(lo.filter((x) => x.tier === "前後賞").map((x) => x.number).sort((a, b) => a - b), [1, 1499]);
  const hi = lotteryPrizeNumbers(edge(1499.5 / 1500)); // 1等が 15組099番 → 前後賞は 15組098番 と 01組000番
  assert.deepEqual(hi.filter((x) => x.tier === "前後賞").map((x) => x.number).sort((a, b) => a - b), [0, 1498]);
  const stuck = lotteryPrizeNumbers(() => 0); // 偏った乱数でも必ず終わる
  assert.equal(new Set(stuck.map((x) => x.number)).size, stuck.length);
});

test("番号の割り当て：バラは重ならない・連番は同じ組の続き番号・取れなければエラー・売り切れ", () => {
  const rng = rngOf(77);
  const empty = "0".repeat(1500);
  const a = lotteryAllocate(empty, 10, "random", rng);
  assert.equal(new Set(a.numbers).size, 10);
  for (let i = 0; i < 300; i++) {
    const r = lotteryAllocate(empty, 10, "seq", rng);
    assert.equal(r.numbers.length, 10);
    assert.ok(r.numbers.every((n, k) => k === 0 || n === r.numbers[k - 1] + 1), "続き番号");
    assert.equal(new Set(r.numbers.map((n) => Math.floor(n / 100))).size, 1, "同じ組");
  }
  assert.deepEqual(lotteryAllocate(empty, 100, "seq", rng).numbers.map((n) => n % 100), Array.from({ length: 100 }, (_, i) => i), "100枚連番は1組まるごと");
  const bits = empty.split("");
  for (let g = 0; g < 15; g++) bits[g * 100 + 50] = "1"; // どの組にも売れた番号が1つ → 51枚以上の連番は取れない
  assert.equal(lotteryAllocate(bits.join(""), 51, "seq", rng).error, "no_consecutive");
  const ok50 = lotteryAllocate(bits.join(""), 50, "seq", rng);
  assert.ok(ok50.numbers.every((n) => bits[n] === "0"), "売れた番号は取らない");
  assert.equal(lotteryAllocate(empty, 1, "seq", rng).numbers.length, 1, "1枚の連番はバラと同じ");
  const almost = "1".repeat(1495) + "0".repeat(5);
  assert.deepEqual(lotteryAllocate(almost, 10, "random", rng), { error: "sold_out", remaining: 5 });
  assert.equal(lotteryAllocate(almost, 5, "random", rng).numbers.length, 5);
});

test("当選の判定：当選番号の券を持つ人に払う。売れ残りの番号は払わない。連番なら1等と前後賞を一緒に当てられる", () => {
  const prizes = [{ tier: "1等", number: 500 }, { tier: "前後賞", number: 499 }, { tier: "前後賞", number: 501 }, { tier: "2等", number: 900 }, { tier: "7等", number: 1 }];
  const entries = [
    { uid: "A", name: "A", numbers: [498, 499, 500, 501, 502] }, // 連番
    { uid: "B", name: "B", numbers: [900, 1] }
  ];
  const w = lotteryDrawWinners(entries, 1, prizes);
  assert.deepEqual(w.map((x) => [x.name, x.tier, x.number, x.amount]),
    [["A", "1等", 500, 10000], ["A", "前後賞", 499, 2500], ["A", "前後賞", 501, 2500], ["B", "2等", 900, 3000], ["B", "7等", 1, 10]]);
  const w2 = lotteryDrawWinners([{ uid: "A", name: "A", numbers: [499] }], 2, prizes);
  assert.deepEqual(w2.map((x) => x.amount), [5000], "倍率2：前後賞は5,000。売れ残りの1等(500)は払わない");
  assert.equal(lotteryDrawWinners([], 1, prizes).length, 0);
});

test("確率：持っている番号の数に比例（100枚で1等が約3.3%）。1枚だけでも確定ではない。1等は同じ回に2本出ない", () => {
  const rng = rngOf(12345);
  const N = 30000, mine100 = Array.from({ length: 100 }, (_, i) => i * 7), mine1 = [1234];
  let a = 0, s1 = 0, two = 0, any1 = 0;
  for (let i = 0; i < N; i++) {
    const p = lotteryPrizeNumbers(rng);
    if (p.filter((x) => x.tier === "1等").length !== 1) two++;
    const w = lotteryDrawWinners([{ uid: "A", name: "A", numbers: mine100 }], 1, p);
    if (w.some((x) => x.tier === "1等")) a++;
    if (lotteryDrawWinners([{ uid: "S", name: "S", numbers: mine1 }], 1, p).some((x) => x.tier === "1等")) s1++;
    if (w.length) any1++;
  }
  assert.equal(two, 0);
  assert.ok(Math.abs(a / N - 0.0667) < 0.006, `100枚の1等率 ${a / N}（期待 6.7%）`);
  assert.ok(s1 / N < 0.004, `1枚だけでも確定ではない（${s1 / N}）`);
  assert.ok(any1 / N > 0.9, "100枚買えば、何か当たる確率はとても高い");
});

test("公開設定：既定は非公開（一般は中身が見えない）、最上位管理者だけ変更・先に使える", async () => {
  const { deps, fs } = setup({ extra: { "worldConfig/lottery": { lotteryPublished: false } } });
  const st = await handleYuslotAction(deps, "uT", { action: "lotteryStatus", username: "たろう" });
  assert.equal(st.published, false); assert.equal(st.event, undefined, "非公開中は内容を返さない");
  assert.equal((await handleYuslotAction(deps, "uT", { action: "lotteryBuy", count: 1, username: "たろう" })).status, 403);
  assert.equal((await handleYuslotAction(deps, "uT", { action: "lotterySetPublished", published: true })).status, 403, "一般は変更できない");
  fs.put("users/かんりしゃ", encF({ uid: ADMIN, name: "かんりしゃ", coins: 500 }));
  const adminSt = await handleYuslotAction(deps, ADMIN, { action: "lotteryStatus", username: "かんりしゃ" });
  assert.ok(adminSt.event, "管理者は非公開でも見える");
  const set = await handleYuslotAction(deps, ADMIN, { action: "lotterySetPublished", published: true });
  assert.equal(set.ok, true);
  assert.equal(fs.plain("worldConfig/lottery").lotteryPublished, true);
  assert.equal((await handleYuslotAction(deps, "uT", { action: "lotteryStatus", username: "たろう" })).published, true);
});

test("購入：番号が決まり、残高・売れた番号が正しく動く。連番とバラ・残高不足・不正な枚数。購入上限はない", async () => {
  const { fs, buy } = setup({ users: { "たろう": { uid: "uT", name: "たろう", coins: 50000 } } });
  const P = LOTTERY.price;
  const r = await buy("uT", "たろう", 3, "seq");
  assert.equal(r.ok, true); assert.equal(r.tickets, 3); assert.equal(r.remaining, 1497); assert.equal(r.balance, 50000 - 3 * P); assert.equal(r.numbers.length, 3);
  assert.ok(r.numbers.every((n, k) => k === 0 || n === r.numbers[k - 1] + 1), "連番");
  assert.equal(coins(fs, "たろう"), 50000 - 3 * P);
  assert.deepEqual(fs.plain("lotteryEntries/2026-10-23_uT").numbers, r.numbers);
  const round = fs.plain("lotteryRounds/2026-10-23");
  assert.equal(round.tickets, 3); assert.equal(round.sales, 3 * P);
  assert.equal(round.soldBits.length, 1500); assert.deepEqual([...round.soldBits].map((c, i) => c === "1" ? i : -1).filter((i) => i >= 0), r.numbers);
  const r2 = await buy("uT", "たろう", 2, "random");
  assert.equal(coins(fs, "たろう"), 50000 - 5 * P);
  assert.equal(new Set([...r.numbers, ...r2.numbers]).size, 5, "番号が重ならない");
  assert.deepEqual(fs.plain("lotteryEntries/2026-10-23_uT").numbers, [...r.numbers, ...r2.numbers], "自分の番号は追加で記録される");
  for (const bad of [0, -1, 1.5, "x", 1501]) assert.equal((await buy("uT", "たろう", bad)).status, 400, `枚数 ${bad}`);
  // 購入上限はない：1回で何百枚でも、何回でも買える（売り切れまで）
  const big = await buy("uT", "たろう", 600, "random");
  assert.equal(big.ok, true); assert.equal(big.numbers.length, 600);
  const big2 = await buy("uT", "たろう", 800, "random");
  assert.equal(big2.ok, true); assert.equal(big2.remaining, 1500 - 1405);
  assert.equal(fs.plain("lotteryEntries/2026-10-23_uT").numbers.length, 1405);
  assert.equal(new Set(fs.plain("lotteryEntries/2026-10-23_uT").numbers).size, 1405, "全部ちがう番号");
  // 連番は1組（100枚）まで。101枚以上の連番は断る（バラなら買える）
  assert.equal((await buy("uT", "たろう", 101, "seq")).error, "no_consecutive");
  fs.put("users/まずしい", encF({ uid: "uP", name: "まずしい", coins: 25 }));
  assert.equal((await buy("uP", "まずしい", 3)).error, "insufficient_coins");
  assert.equal(coins(fs, "まずしい"), 25, "失敗したら残高は変わらない");
  assert.equal(fs.docs.has("lotteryEntries/2026-10-23_uP"), false);
});

test("販売期間：月曜 8:00 より前は買えない（not_started）。8:00 から買える。抽選後は次の回の販売開始まで買えない", async () => {
  const { buy, state } = setup();
  const start = lotterySaleStartMs(T);
  state.now = start - 1;
  const early = await buy("uT", "たろう", 1);
  assert.equal(early.error, "not_started"); assert.equal(early.saleStartMs, start);
  state.now = start;
  assert.equal((await buy("uT", "たろう", 1)).ok, true);
  state.now = T + 1 * MIN; // 抽選の直後：次の回はまだ販売していない
  const after = await buy("uH", "はなこ", 1);
  assert.equal(after.error, "not_started"); assert.equal(after.saleStartMs, lotterySaleStartMs(T + WEEK));
  state.now = lotterySaleStartMs(T + WEEK) + 1;
  assert.equal((await buy("uH", "はなこ", 1)).ok, true);
});

test("購入：売り切れ・連番が取れない・モード未指定はバラ", async () => {
  const { fs, buy } = setup({ users: { "たろう": { uid: "uT", name: "たろう", coins: 5000 } } });
  const bits = "1".repeat(1495) + "0".repeat(5);
  fs.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 1495, sales: 14950, soldBits: bits }));
  const so = await buy("uT", "たろう", 10, "random");
  assert.equal(so.error, "sold_out"); assert.equal(so.remaining, 5); assert.equal(coins(fs, "たろう"), 5000);
  const ok = await buy("uT", "たろう", 5);                    // モード未指定
  assert.equal(ok.ok, true); assert.equal(ok.mode, "random");
  assert.equal(fs.plain("lotteryRounds/2026-10-23").tickets, 1500);
  assert.equal((await buy("uT", "たろう", 1)).error, "sold_out", "全部売れたら買えない");
  const { fs: fs2, buy: buy2 } = setup({ users: { "たろう": { uid: "uT", name: "たろう", coins: 5000 } } });
  const sparse = "0".repeat(1500).split(""); for (let g = 0; g < 15; g++) sparse[g * 100 + 50] = "1";
  fs2.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 15, sales: 150, soldBits: sparse.join("") }));
  assert.equal((await buy2("uT", "たろう", 60, "seq")).error, "no_consecutive");
  assert.equal((await buy2("uT", "たろう", 60, "random")).ok, true, "バラなら買える");
});

test("同時購入：売れた番号の記録が先に更新されていたら、あとの購入は busy で何も変わらない（番号が重ならない）", async () => {
  const { fs, buy } = setup();
  const orig = fs.commit.bind(fs);
  let once = true;
  fs.commit = async (writes) => {
    if (once) { once = false; fs.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 1, sales: 10, soldBits: "1" + "0".repeat(1499) })); } // 別の人が先に買った
    return orig(writes);
  };
  fs.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 0, sales: 0, soldBits: "0".repeat(1500) }));
  const r = await buy("uT", "たろう", 2, "seq");
  assert.equal(r.error, "busy"); assert.equal(coins(fs, "たろう"), 1000); assert.equal(fs.docs.has("lotteryEntries/2026-10-23_uT"), false);
  const again = await buy("uT", "たろう", 2, "seq");
  assert.equal(again.ok, true); assert.ok(!again.numbers.includes(0), "先に売れた番号は取らない");
});

test("販売は抽選の5分前に締め切る（直前は買えない・6分前は買える）", async () => {
  const { buy, state } = setup();
  state.now = T - 4 * MIN;
  assert.equal((await buy("uT", "たろう", 1)).error, "sales_closed");
  state.now = T - 6 * MIN;
  assert.equal((await buy("uT", "たろう", 1)).ok, true);
  state.now = lotterySaleStartMs(T + WEEK) + MIN; // 次の回は、販売開始（月曜 8:00）のあとなら買える
  const next = await buy("uH", "はなこ", 1);
  assert.equal(next.ok, true);
});

test("ゆうスロに着席中は購入できない（コインの二重使用を防ぐ）。猶予が切れた席は無関係", async () => {
  const { buy, state, fs } = setup();
  fs.put("yuslotSeats/yubasic", encF({ uid: "uT", name: "たろう", nonce: "n", graceUntilMs: state.now + 60000 }));
  assert.equal((await buy("uT", "たろう", 1)).error, "seated");
  assert.equal((await buy("uH", "はなこ", 1)).ok, true, "他人の着席は関係ない");
  state.now += 120000; // 猶予切れ
  assert.equal((await buy("uT", "たろう", 1)).ok, true);
});

test("残高が同時に変わった（競合）ときは busy で、残高も番号も変わらない", async () => {
  const { buy, fs } = setup();
  const orig = fs.commit;
  fs.commit = async () => { throw Object.assign(new Error("firestore commit 400 FAILED_PRECONDITION"), { status: 400 }); };
  const r = await buy("uT", "たろう", 2);
  fs.commit = orig;
  assert.equal(r.error, "busy"); assert.equal(coins(fs, "たろう"), 1000); assert.equal(fs.docs.has("lotteryEntries/2026-10-23_uT"), false);
  assert.equal(fs.docs.has("lotteryRounds/2026-10-23"), false);
});

test("番号の数を減らした引っ越し：1,500 未満の番号はそのまま。1,500 以上は空いている番号に付け替える（連番は連番のまま）。何度やっても安全。超えていたら何も変えない", async () => {
  const { fs, deps } = setup();
  // 古い（3,000通り）の回：A は連番 1500〜1504（01組…の外）、B は 10〜12 と 1700・2999、C は 20〜24（そのまま残る）
  const A = [1500, 1501, 1502, 1503, 1504], B = [10, 11, 12, 1700, 2999], C = [20, 21, 22, 23, 24];
  const legacy = "0".repeat(3000).split(""); [...A, ...B, ...C].forEach((n) => { legacy[n] = "1"; });
  fs.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 15, sales: 150, soldBits: legacy.join("") }));
  for (const [uid, name, nums] of [["uA", "えー", A], ["uB", "びー", B], ["uC", "しー", C]]) fs.put(`lotteryEntries/2026-10-23_${uid}`, encF({ uid, name, round: "2026-10-23", numbers: nums }));
  const before = coins(fs, "たろう");
  const r = await lotteryResizeRound(deps, "2026-10-23");
  assert.equal(r.ok, true); assert.equal(r.moved, 2); assert.equal(r.tickets, 15);
  const round = fs.plain("lotteryRounds/2026-10-23");
  assert.equal(round.soldBits.length, 1500); assert.equal(round.tickets, 15); assert.equal(round.sales, 150, "枚数・売上は変わらない");
  const num = (uid) => fs.plain(`lotteryEntries/2026-10-23_${uid}`).numbers;
  assert.deepEqual(num("uC"), C, "1,500 未満はそのまま");
  assert.deepEqual(num("uB").slice(0, 3), [10, 11, 12], "1,500 未満の分はそのまま");
  assert.equal(num("uA").length, 5); assert.ok(num("uA").every((n, k) => n < 1500 && (k === 0 || n === num("uA")[k - 1] + 1)), "連番は連番のまま（同じ組）");
  assert.equal(new Set(num("uA").map((n) => Math.floor(n / 100))).size, 1);
  assert.equal(num("uB").length, 5); assert.ok(num("uB").every((n) => n < 1500));
  const all = [...num("uA"), ...num("uB"), ...num("uC")];
  assert.equal(new Set(all).size, 15, "番号が重ならない");
  assert.deepEqual([...round.soldBits].map((c, i) => c === "1" ? i : -1).filter((i) => i >= 0), [...all].sort((a, b) => a - b), "売れた番号の表と、みんなの番号が一致");
  assert.equal(coins(fs, "たろう"), before, "コインは変わらない");
  const again = await lotteryResizeRound(deps, "2026-10-23");
  assert.equal(again.skipped, "ok", "2回目は何もしない");
  // 1,500 枚を超えて売れていたら、何も変えない
  const { fs: fs2, deps: deps2 } = setup();
  fs2.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 1600, sales: 16000, soldBits: "1".repeat(1600) + "0".repeat(1400) }));
  fs2.put("lotteryEntries/2026-10-23_uA", encF({ uid: "uA", name: "えー", round: "2026-10-23", numbers: Array.from({ length: 1600 }, (_, i) => i) }));
  const over = await lotteryResizeRound(deps2, "2026-10-23");
  assert.equal(over.aborted, "too_many"); assert.equal(fs2.plain("lotteryRounds/2026-10-23").soldBits.length, 3000, "何も変えない");
  assert.equal((await lotteryResizeRound(deps2, "2099-01-01")).skipped, "no_round");
});

test("引っ越し前の回：購入は付け替えが済むまで断る（番号が重ならない）。状態の表示・抽選は先に付け替える", async () => {
  const { fs, deps, buy } = setup();
  const legacy = "0".repeat(3000).split(""); legacy[1600] = "1"; legacy[5] = "1";
  fs.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 2, sales: 20, soldBits: legacy.join("") }));
  fs.put("lotteryEntries/2026-10-23_uH", encF({ uid: "uH", name: "はなこ", round: "2026-10-23", numbers: [5, 1600] }));
  const r = await buy("uT", "たろう", 3, "random");
  assert.equal(r.status, 409); assert.ok(["busy", "preparing"].includes(r.error)); assert.equal(coins(fs, "たろう"), 1000, "買えていない・コインは変わらない");
  assert.equal(fs.plain("lotteryRounds/2026-10-23").soldBits.length, 1500, "購入の試みで付け替えが済む");
  const r2 = await buy("uT", "たろう", 3, "random");
  assert.equal(r2.ok, true);
  const hanako = fs.plain("lotteryEntries/2026-10-23_uH").numbers;
  assert.ok(hanako.every((n) => n < 1500) && !r2.numbers.some((n) => hanako.includes(n)), "はなこの番号と重ならない");
  // 状態の表示でも付け替える
  const { fs: fsS, deps: depsS } = setup();
  fsS.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 1, sales: 10, soldBits: "0".repeat(1700) + "1" + "0".repeat(1299) }));
  fsS.put("lotteryEntries/2026-10-23_uT", encF({ uid: "uT", name: "たろう", round: "2026-10-23", numbers: [1700] }));
  const st = await handleYuslotAction(depsS, "uT", { action: "lotteryStatus", username: "たろう" });
  assert.equal(st.myNumbers.length, 1); assert.ok(st.myNumbers[0] < 1500); assert.equal(st.pool, 1500); assert.equal(st.remaining, 1499);
  // 抽選でも付け替えてから数える（1,500 以上の番号を持つ人の券が消えない）
  const { fs: fsD, deps: depsD, state } = setup({ random: rngOf(3) });
  fsD.put("lotteryRounds/2026-10-23", encF({ round: "2026-10-23", name: "x", tickets: 1, sales: 10, soldBits: "0".repeat(2000) + "1" + "0".repeat(999) }));
  fsD.put("lotteryEntries/2026-10-23_uT", encF({ uid: "uT", name: "たろう", round: "2026-10-23", numbers: [2000] }));
  state.now = T;
  const d = await lotteryRunDraw(depsD, T);
  assert.equal(d.status, "drawn");
  assert.equal(fsD.plain("lotteryRounds/2026-10-23").tickets, 1, "券が1枚として数えられる（消えない）");
});

/* 15人が100枚ずつ（連番と バラ）買って、1,500枚をすべて売り切る */
async function sellOut(opts = {}) {
  const users = {}; for (let i = 0; i < 15; i++) users[`u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 5000 };
  const env = setup({ users, ...opts });
  for (let i = 0; i < 15; i++) { const r = await env.buy(`id${i}`, `u${i}`, 100, i < 8 ? "seq" : "random"); assert.equal(r.ok, true, `u${i} ${r.error}`); }
  return env;
}

test("抽選：全部売れた回は賞金の合計がちょうど払われる。1等は1人・前後賞2つ・番号つきで結果とお知らせが記録される", async () => {
  const { fs, deps, state } = await sellOut({ random: rngOf(99) });
  const names = Array.from({ length: 15 }, (_, i) => `u${i}`);
  const before = names.reduce((s, n) => s + coins(fs, n), 0);
  assert.equal(before, 15 * 5000 - 1500 * LOTTERY.price);
  state.now = T;
  const r = await lotteryRunDraw(deps, T);
  assert.equal(r.status, "drawn");
  const round = fs.plain("lotteryRounds/2026-10-23");
  assert.equal(round.status, "done"); assert.equal(round.tickets, 1500); assert.equal(round.sales, 15000);
  assert.equal(round.paid, 29950, "全部売れたので、賞金の合計がそのまま払われる");
  assert.equal(round.winners.length, 212);
  const by = (t) => round.winners.filter((w) => w.tier === t);
  assert.equal(by("1等").length, 1); assert.equal(by("1等")[0].amount, 10000);
  assert.equal(by("前後賞").length, 2); assert.ok(by("前後賞").every((w) => w.amount === 2500));
  assert.equal(by("7等").length, 115);
  const after = names.reduce((s, n) => s + coins(fs, n), 0);
  assert.equal(after - before, round.paid, "増えたコイン＝支払った賞金（二重計上なし）");
  assert.equal(round.prizeNumbers.length, 212);
  const ann = fs.plain("announcements/lottery-2026-10-23");
  assert.ok(ann && ann.title.includes(lotteryEventFor(T).name) && ann.title.length <= 50 && ann.body.length <= 500, "結果のお知らせ");
  assert.ok(ann.body.includes(lotteryNumberLabel(by("1等")[0].number)) && ann.body.includes(by("1等")[0].name + "さん"), "1等の番号と当選者");
  assert.match(ann.body, /前後賞/);
  assert.equal(round.announced, true);
  assert.equal(round.carryOut, undefined, "持ち越しは無い");
});

test("抽選：一部しか売れていない回は、売れ残った番号の賞金は払われない（払った合計＝当たった券の賞金）", async () => {
  const { fs, deps, buy, state } = setup({ random: rngOf(5), users: { "たろう": { uid: "uT", name: "たろう", coins: 5000 } } });
  const r = await buy("uT", "たろう", 100, "random");
  const before = coins(fs, "たろう");
  state.now = T; await lotteryRunDraw(deps, T);
  const round = fs.plain("lotteryRounds/2026-10-23");
  assert.equal(round.tickets, 100);
  assert.equal(round.winners.reduce((s, w) => s + w.amount, 0), round.paid);
  assert.ok(round.paid < 29950 / 5, "100枚ぶんしか払われない");
  assert.ok(round.winners.every((w) => r.numbers.includes(w.number)), "当たったのは持っている番号だけ");
  assert.equal(coins(fs, "たろう") - before, round.paid);
});

test("二重払いしない：同じ回の抽選をもう一度実行しても、残高は増えない。cron も2回目以降は Firestore に触れない", async () => {
  const { fs, deps, buy, state } = setup({ random: rngOf(5), users: { "たろう": { uid: "uT", name: "たろう", coins: 5000 }, "はなこ": { uid: "uH", name: "はなこ", coins: 5000 } } });
  await buy("uT", "たろう", 100); await buy("uH", "はなこ", 100);
  state.now = T + 30000;
  const r1 = await runLotteryTick({}, state.now, deps);
  assert.equal(r1.status, "drawn");
  const snap = ["たろう", "はなこ"].map((n) => coins(fs, n));
  const r2 = await lotteryRunDraw(deps, T);
  assert.equal(r2.status, "done");
  assert.deepEqual(["たろう", "はなこ"].map((n) => coins(fs, n)), snap, "再実行で残高が変わらない");
  const c = { ...fs.counts };
  const r3 = await runLotteryTick({}, state.now + 60000, deps);
  assert.equal(r3.skipped, "done");
  assert.deepEqual(fs.counts, c, "完了後の cron は Firestore に触れない");
});

test("cron の間引き：時刻の前・10分後以降の途中の分は動かず、直後の毎分と15分ごとだけ", async () => {
  const { deps } = setup();
  assert.equal((await runLotteryTick({}, T - 3600000, deps)).skipped, "outside");
  assert.equal((await runLotteryTick({}, T - 1, deps)).skipped, "outside", "抽選前は動かない");
  assert.equal((await runLotteryTick({}, T + 11 * MIN, deps)).skipped, "throttle");
  assert.equal((await runLotteryTick({}, T + 25 * 3600000, deps)).skipped, "outside", "24時間後は動かない");
  const r = await runLotteryTick({}, T + 5 * MIN, deps);
  assert.equal(r.status, "no_sales", "売上ゼロの回は何もしない");
  assert.equal((await runLotteryTick({}, T + 6 * MIN, deps)).skipped, "done");
});

test("売上ゼロの回は何も作らない（ドキュメントもお知らせも作らない）", async () => {
  const { fs, deps } = setup();
  const before = fs.docs.size;
  const r = await lotteryRunDraw(deps, T);
  assert.equal(r.status, "no_sales"); assert.equal(fs.docs.size, before);
});

test("当選者のユーザーが消えていたら払わない（空のユーザー文書も作らない）", async () => {
  const users = {}; for (let i = 0; i < 30; i++) users[`u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 5000 };
  const { fs, deps, buy, state } = setup({ random: rngOf(21), users });
  for (let i = 0; i < 30; i++) await buy(`id${i}`, `u${i}`, 100, "random");
  for (let i = 0; i < 30; i++) fs.docs.delete(`users/u${i}`);
  state.now = T;
  const r = await lotteryRunDraw(deps, T);
  assert.equal(r.status, "drawn"); assert.equal(r.winners, 0);
  assert.equal([...fs.docs.keys()].some((k) => k.startsWith("users/")), false, "消えたユーザーを作り直さない");
  assert.equal(fs.plain("lotteryRounds/2026-10-23").paid, 0);
});

test("状態の取得：抽選のあと次の販売開始までは準備中（名前・賞金・自分の番号は出さない）。販売開始後は自分の番号・残り枚数・等級・前回の結果。他人の uid は返さない", async () => {
  const { fs, deps, state } = await sellOut({ random: rngOf(77) });
  state.now = T; await lotteryRunDraw(deps, T);
  state.now = T + 3600000;
  resetLotteryCacheForTest();
  const prep = await handleYuslotAction(deps, "id0", { action: "lotteryStatus", username: "u0" });
  assert.equal(prep.phase, "preparing"); assert.equal(prep.open, false);
  assert.equal(prep.event.id, "2026-10-30"); assert.equal(prep.event.saleStartMs, lotterySaleStartMs(T + WEEK));
  assert.equal(prep.event.name, undefined, "準備中は次の回の名前を出さない");
  assert.equal(prep.tiers, undefined); assert.equal(prep.myNumbers, undefined); assert.equal(prep.balance, undefined);
  assert.ok(prep.last && prep.last.id === "2026-10-23", "前回の結果（リプレイ用）は見られる");
  assert.deepEqual(prep.prev, { id: "2026-10-23", drawMs: T }, "前回の回（結果の集計待ちの判定用）");
  // 販売開始（月曜 8:00）のあと
  state.now = lotterySaleStartMs(T + WEEK) + MIN;
  resetLotteryCacheForTest();
  const stT = await handleYuslotAction(deps, "id0", { action: "lotteryStatus", username: "u0" });
  assert.equal(stT.ok, true); assert.equal(stT.event.id, "2026-10-30"); assert.equal(stT.phase, "selling");
  assert.equal(stT.myTickets, 0); assert.deepEqual(stT.myNumbers, []); assert.equal(stT.remaining, 1500);
  assert.equal(stT.open, true); assert.equal(stT.pool, 1500);
  assert.equal(stT.tiers.length, 8); assert.equal(stT.tiers[0].count, 1); assert.equal(stT.tiers[1].adjacent, true);
  assert.equal(stT.event.price, LOTTERY.price);
  assert.equal(stT.limits.maxPerRound, undefined, "購入上限はない");
  const last = stT.last;
  assert.ok(last && last.id === "2026-10-23");
  assert.deepEqual([...new Set(last.numbers.map((n) => n.tier))].sort(), ["1等", "2等", "3等", "前後賞"].sort(), "表示する当選番号は上位の等級まで");
  assert.equal(last.numbers.length, 1 + 2 + 1 + 3);
  assert.ok(last.numbers.every((n) => n.name), "全部売れたので当選者の名前がある");
  const round = fs.plain("lotteryRounds/2026-10-23");
  assert.equal(last.winnerCount, round.winners.length);
  assert.equal(last.tiers.length, 8);
  assert.equal(last.tiers.reduce((n, t) => n + t.hit, 0), round.winners.length, "等級ごとの当選口数の合計＝当選数");
  assert.equal(last.tiers[0].prize, 10000); assert.equal(last.tiers[0].hit, 1);
  let myTotal = 0; for (let i = 0; i < 30; i++) {
    const st = await handleYuslotAction(deps, `id${i}`, { action: "lotteryStatus", username: `u${i}` });
    assert.equal(st.last.myWin, round.winners.filter((w) => w.uid === `id${i}`).reduce((s, w) => s + w.amount, 0));
    assert.equal(st.last.myWins.length, round.winners.filter((w) => w.uid === `id${i}`).length);
    myTotal += st.last.myWin;
  }
  assert.equal(myTotal, round.paid);
  const json = JSON.stringify(stT);
  assert.ok(!json.includes('"uid"') && !json.includes("id1\""), "uid を含まない");
  assert.equal(stT.balance, coins(fs, "u0"));
  // 買った後は自分の番号が見える
  const b = await handleYuslotAction(deps, "id0", { action: "lotteryBuy", count: 4, mode: "seq", username: "u0" });
  const stAfter = await handleYuslotAction(deps, "id0", { action: "lotteryStatus", username: "u0" });
  assert.deepEqual(stAfter.myNumbers, b.numbers); assert.equal(stAfter.myTickets, 4);
});

test("販売前の「締切済み」：締切（抽選の5分前）から抽選までは closed で、買えない", async () => {
  const { deps, state, buy } = setup();
  state.now = T - 3 * MIN;
  const st = await handleYuslotAction(deps, "uT", { action: "lotteryStatus", username: "たろう" });
  assert.equal(st.phase, "closed"); assert.equal(st.open, false);
  assert.equal((await buy("uT", "たろう", 1)).error, "sales_closed");
});

test("Firestore の読み書きを減らす：購入＝読み取り3回（残高・着席確認1回のクエリ・売れた番号）＋commit1回。準備中の状態表示は2回目からほぼ0", async () => {
  const { fs, buy, deps, state } = setup();
  const b0 = { ...fs.counts };
  await buy("uT", "たろう", 5);
  const d = (k) => fs.counts[k] - b0[k];
  assert.equal(d("commit"), 1, "commit は1回");
  assert.equal(d("query"), 1, "着席確認は1回のクエリ（6台を1台ずつ読まない）");
  assert.equal(d("getRaw"), 2, "残高と売れた番号の記録");
  assert.equal(d("get"), 1, "公開設定だけ（自分の番号は読まずに追加で書く）");
  assert.equal(d("batchGet"), 0);
  // 準備中（抽選のあと）の状態表示：1回目は公開設定と前回の記録、2回目以降はメモリのキャッシュで読み取りなし
  state.now = T + 3600000; resetLotteryCacheForTest();
  const b1 = { ...fs.counts };
  await handleYuslotAction(deps, "uT", { action: "lotteryStatus", username: "たろう" });
  const first = { get: fs.counts.get - b1.get, getRaw: fs.counts.getRaw - b1.getRaw, query: fs.counts.query - b1.query };
  assert.ok(first.get <= 2 && first.getRaw === 0 && first.query === 0, `1回目 ${JSON.stringify(first)}`);
  const b2 = { ...fs.counts };
  await handleYuslotAction(deps, "uH", { action: "lotteryStatus", username: "はなこ" });
  assert.deepEqual({ get: fs.counts.get - b2.get, getRaw: fs.counts.getRaw - b2.getRaw, query: fs.counts.query - b2.query }, { get: 0, getRaw: 0, query: 0 }, "別の人が開いても読み取りなし");
});
