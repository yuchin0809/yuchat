/* 🎟 ゆう宝くじ売り場（worker.js）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LOTTERY, lotteryNextDrawMs, lotteryRoundId, lotteryEventFor, lotteryPrizeOf, lotteryTiersFor, lotteryPoolFor, lotteryDrawWinners,
  lotteryRunDraw, runLotteryTick, handleYuslotAction, resetLotteryCacheForTest
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
        (w.updateTransforms || []).forEach((t) => { if (t.increment) next[t.fieldPath] = { integerValue: String((Number(next[t.fieldPath]?.integerValue) || 0) + Number(t.increment.integerValue)) }; });
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
  const buy = (uid, name, count) => handleYuslotAction(deps, uid, { action: "lotteryBuy", count, username: name });
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
  // 最初の回(i=0)はグランドオープン記念の特別回でビッグ。6週に1回ビッグ（i=5）。年末(i=9)・新春(i=10)も特別回でビッグ。
  // その隣の週(i=11)はビッグが3週続かないよう見送る
  assert.deepEqual(ev.map((e) => e.big), [true, false, false, false, false, true, false, false, false, true, true, false]);
  assert.match(ev[0].name, /グランドオープン/);
  assert.equal(lotteryPrizeOf(LOTTERY.tiers[0], ev[0].scale), 10000, "最初の回の1等は10,000");
  assert.equal(lotteryPrizeOf(LOTTERY.tiers[1], ev[0].scale), 3000, "最初の回の2等は3,000");
  assert.ok(ev.slice(1).filter((e) => e.big).every((e) => e.scale >= 1.5), "初回以外のビッグは賞金が大きい");
  assert.ok(ev.filter((e) => !e.big).every((e) => e.scale <= 1), "ふつうの週は控えめ（賞金の合計が売上を超えない）");
  const nye = lotteryEventFor(Date.UTC(2026, 11, 25, 5, 30, 0));
  assert.equal(nye.big, true); assert.equal(nye.scale, 2); assert.match(nye.name, /年末/);
});

test("等級：1等は全体で1本。賞金は上位ほど大きく、倍率で変わる（7等だけは元返し固定）", () => {
  assert.equal(LOTTERY.tiers.length, 7);
  assert.equal(LOTTERY.tiers[0].count, 1, "1等は1本だけ");
  const prizes = lotteryTiersFor(1).map((t) => t.prize);
  assert.deepEqual(prizes, [10000, 3000, 1000, 300, 150, 30, 10]);
  assert.equal(LOTTERY.price, 10); assert.equal(LOTTERY.poolSize, 3000);
  assert.ok(prizes.every((p, i) => i === 0 || p < prizes[i - 1]), "上位ほど賞金が大きい");
  assert.equal(prizes[prizes.length - 1], LOTTERY.price, "7等は元返し");
  assert.equal(lotteryTiersFor(2)[0].prize, 20000); assert.equal(lotteryTiersFor(2)[6].prize, LOTTERY.price, "元返しは倍率をかけない");
  const total = (m) => lotteryTiersFor(m).reduce((s, t) => s + t.count * t.prize, 0);
  const ret = (m) => total(m) / (LOTTERY.poolSize * LOTTERY.price);
  assert.ok(ret(0.9) > 0.8 && ret(1) < 1, `ふつうの週の返戻率は100%未満（${ret(0.9)}〜${ret(1)}）`);
  assert.ok(Math.abs(ret(1) - 0.95) < 0.001, "倍率1の返戻率は約95%");
  assert.equal(lotteryPoolFor(10), 3000); assert.equal(lotteryPoolFor(4500), 4500, "売れすぎたら枠を広げる");
});

test("抽選：1枚の1等の確率は 1/3000、枚数に比例。1等は何枚売れても最大1本。1枚だけ売れても確定当選ではない", () => {
  const rng = rngOf(12345);
  const N = 20000;
  let a1 = 0, b1 = 0, tooMany = 0, single = 0;
  for (let i = 0; i < N; i++) {
    const w = lotteryDrawWinners([{ uid: "A", name: "A", count: 100 }, { uid: "B", name: "B", count: 30 }], 1, rng);
    const first = w.filter((x) => x.tier === "1等");
    if (first.length > 1) tooMany++;
    if (first[0]?.uid === "A") a1++; if (first[0]?.uid === "B") b1++;
    if (lotteryDrawWinners([{ uid: "S", name: "S", count: 1 }], 1, rng).some((x) => x.tier === "1等")) single++;
  }
  assert.equal(tooMany, 0, "1等は同じ回に2本出ない");
  assert.ok(Math.abs(a1 / N - 0.0333) < 0.006, `100枚の1等率 ${a1 / N}（期待 3.3%）`);
  assert.ok(Math.abs(b1 / N - 0.01) < 0.004, `30枚の1等率 ${b1 / N}（期待 1%）`);
  assert.ok(single / N < 0.002, `1枚だけ売れても確定ではない（${single / N}）`);
});

test("抽選：等級ごとの当選数の期待値（1,000枚売れたら全等級の本数がちょうど出る）／枠を超えて売れたら枠が広がり当たりの本数は増えない", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ uid: `u${i}`, name: `n${i}`, count: 100 })); // 3000枚
  const w = lotteryDrawWinners(entries, 1, rngOf(3));
  for (const t of LOTTERY.tiers) assert.equal(w.filter((x) => x.tier === t.name).length, t.count, `${t.name} は全部で ${t.count} 本`);
  assert.equal(w.reduce((s, x) => s + x.amount, 0), lotteryTiersFor(1).reduce((s, t) => s + t.count * t.prize, 0));
  const big = Array.from({ length: 60 }, (_, i) => ({ uid: `u${i}`, name: `n${i}`, count: 100 })); // 6000枚
  const w2 = lotteryDrawWinners(big, 1, rngOf(4));
  for (const t of LOTTERY.tiers) assert.ok(w2.filter((x) => x.tier === t.name).length <= t.count, `${t.name} は ${t.count} 本まで`);
  assert.equal(lotteryDrawWinners([{ uid: "A", name: "A", count: 0 }], 1, rngOf(1)).length, 0);
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

test("購入：残高と枚数が正しく動く。まとめ買い・上限・残高不足・不正な枚数を弾く", async () => {
  const { fs, buy } = setup({ users: { "たろう": { uid: "uT", name: "たろう", coins: 5000 } } });
  const P = LOTTERY.price;
  const r = await buy("uT", "たろう", 3);
  assert.equal(r.ok, true); assert.equal(r.myTickets, 3); assert.equal(r.balance, 5000 - 3 * P);
  assert.equal(coins(fs, "たろう"), 5000 - 3 * P);
  assert.equal(fs.plain("lotteryEntries/2026-10-23_uT").count, 3);
  assert.equal(fs.plain("lotteryRounds/2026-10-23").tickets, 3);
  assert.equal(fs.plain("lotteryRounds/2026-10-23").sales, 3 * P);
  const r2 = await buy("uT", "たろう", 2);
  assert.equal(r2.myTickets, 5); assert.equal(coins(fs, "たろう"), 5000 - 5 * P);
  for (const bad of [0, -1, 1.5, "x", LOTTERY.maxPerBuy + 1]) assert.equal((await buy("uT", "たろう", bad)).status, 400, `枚数 ${bad}`);
  // 1人の上限（1回の抽選で30枚まで）
  const lim = await buy("uT", "たろう", LOTTERY.maxPerRound - 5);
  assert.equal(lim.ok, true); assert.equal(lim.myTickets, LOTTERY.maxPerRound);
  const lim2 = await buy("uT", "たろう", 1);
  assert.equal(lim2.error, "limit_reached"); assert.equal(lim2.remaining, 0);
  // 残高不足
  fs.put("users/まずしい", encF({ uid: "uP", name: "まずしい", coins: 25 }));
  assert.equal((await buy("uP", "まずしい", 3)).error, "insufficient_coins");
  assert.equal(coins(fs, "まずしい"), 25, "失敗したら残高は変わらない");
});

test("販売は抽選の5分前に締め切る（直前は買えない・6分前は買える）", async () => {
  const { buy, state } = setup();
  state.now = T - 4 * MIN;
  assert.equal((await buy("uT", "たろう", 1)).error, "sales_closed");
  state.now = T - 6 * MIN;
  assert.equal((await buy("uT", "たろう", 1)).ok, true);
  state.now = T + 1 * MIN; // 抽選後は次の回（来週）として買える
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

test("残高が同時に変わった（競合）ときは busy で、残高も枚数も変わらない", async () => {
  const { buy, fs } = setup();
  const orig = fs.commit;
  fs.commit = async () => { throw Object.assign(new Error("firestore commit 400 FAILED_PRECONDITION"), { status: 400 }); };
  const r = await buy("uT", "たろう", 2);
  fs.commit = orig;
  assert.equal(r.error, "busy"); assert.equal(coins(fs, "たろう"), 1000); assert.equal(fs.docs.has("lotteryEntries/2026-10-23_uT"), false);
});

test("抽選：賞金が支払われ、増えたコイン＝支払った賞金。結果とお知らせが記録される（持ち越しなし）", async () => {
  const { fs, deps, buy, state } = setup({ random: rngOf(99), users: { "たろう": { uid: "uT", name: "たろう", coins: 5000 }, "はなこ": { uid: "uH", name: "はなこ", coins: 5000 }, "じろう": { uid: "uJ", name: "じろう", coins: 5000 } } });
  await buy("uT", "たろう", 100); await buy("uH", "はなこ", 100); await buy("uJ", "じろう", 100);
  const names = ["たろう", "はなこ", "じろう"];
  const before = names.reduce((s, n) => s + coins(fs, n), 0);
  assert.equal(before, 15000 - 300 * LOTTERY.price);
  state.now = T;
  const r = await lotteryRunDraw(deps, T);
  assert.equal(r.status, "drawn");
  const round = fs.plain("lotteryRounds/2026-10-23");
  assert.equal(round.status, "done");
  assert.equal(round.tickets, 300); assert.equal(round.sales, 300 * LOTTERY.price);
  assert.equal(round.carryOut, undefined, "持ち越しは無い");
  const after = names.reduce((s, n) => s + coins(fs, n), 0);
  assert.equal(after - before, round.paid, "増えたコイン＝支払った賞金（二重計上なし）");
  assert.equal(round.winners.reduce((s, w) => s + w.amount, 0), round.paid);
  assert.ok(round.winners.length > 0, "この乱数では何か当たる");
  const ann = fs.plain("announcements/lottery-2026-10-23");
  assert.ok(ann && ann.title.includes(lotteryEventFor(T).name) && ann.title.length <= 50 && ann.body.length <= 500, "結果のお知らせ");
  assert.equal(round.announced, true);
});

test("抽選：1等の賞金は10,000（最初の回）。1等が出たらお知らせに名前、全体で1本だけ払われる", async () => {
  // 全員が上限まで買って、1等が出る回を探す（乱数の種を変えて確認）
  let found = null;
  for (let seed = 1; seed < 400 && !found; seed++) {
    const users = {}; for (let i = 0; i < 31; i++) users[`u${i}`] = { uid: `id${i}`, name: `u${i}`, coins: 5000 };
    const { fs, deps, buy, state } = setup({ random: rngOf(seed), users });
    for (let i = 0; i < 31; i++) await buy(`id${i}`, `u${i}`, 100); // 3100枚 → 枠は3100に広がる
    state.now = T; await lotteryRunDraw(deps, T);
    const round = fs.plain("lotteryRounds/2026-10-23");
    if (round.winners.some((w) => w.tier === "1等")) found = { fs, round };
  }
  assert.ok(found, "1等が出る回がある");
  const firsts = found.round.winners.filter((w) => w.tier === "1等");
  assert.equal(firsts.length, 1); assert.equal(firsts[0].amount, 10000);
  assert.match(found.fs.plain("announcements/lottery-2026-10-23").body, /1等（10,000 コイン）/);
});

test("二重払いしない：同じ回の抽選をもう一度実行しても、残高は増えない。cron も2回目以降は Firestore に触れない", async () => {
  const { fs, deps, buy, state } = setup({ random: rngOf(5) });
  await buy("uT", "たろう", 10); await buy("uH", "はなこ", 10);
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
  const { fs, deps, buy, state } = setup({ random: rngOf(21), users: { "たろう": { uid: "uT", name: "たろう", coins: 5000 } } });
  await buy("uT", "たろう", 100);
  fs.docs.delete("users/たろう");
  state.now = T;
  const r = await lotteryRunDraw(deps, T);
  assert.equal(r.status, "drawn"); assert.equal(r.winners, 0);
  assert.equal(fs.docs.has("users/たろう"), false, "消えたユーザーを作り直さない");
  assert.equal(fs.plain("lotteryRounds/2026-10-23").paid, 0);
});

test("状態の取得：自分の枚数・残高・等級と確率の元（枠）・前回の結果（自分の当選額）。他人の uid は返さない", async () => {
  const { fs, deps, buy, state } = setup({ random: rngOf(77), users: { "たろう": { uid: "uT", name: "たろう", coins: 5000 }, "はなこ": { uid: "uH", name: "はなこ", coins: 5000 } } });
  await buy("uT", "たろう", 100); await buy("uH", "はなこ", 100);
  state.now = T; await lotteryRunDraw(deps, T);
  state.now = T + 3600000;
  resetLotteryCacheForTest();
  const stT = await handleYuslotAction(deps, "uT", { action: "lotteryStatus", username: "たろう" });
  assert.equal(stT.ok, true); assert.equal(stT.event.id, "2026-10-30");
  assert.equal(stT.myTickets, 0, "来週ぶんはまだ買っていない");
  assert.equal(stT.open, true); assert.equal(stT.pool, 3000);
  assert.equal(stT.tiers.length, 7); assert.equal(stT.tiers[0].count, 1);
  assert.equal(stT.event.price, LOTTERY.price);
  assert.ok(stT.last && stT.last.id === "2026-10-23");
  const round = fs.plain("lotteryRounds/2026-10-23");
  assert.equal(stT.last.winnerCount, round.winners.length);
  assert.ok(stT.last.winners.every((w) => ["1等", "2等", "3等"].includes(w.tier)), "表示する当選者は上位3等級まで");
  assert.equal(stT.last.myWin, round.winners.filter((w) => w.uid === "uT").reduce((s, w) => s + w.amount, 0));
  const json = JSON.stringify(stT);
  assert.ok(!json.includes("uH") && !json.includes('"uid"'), "他人の uid を含まない");
  assert.equal(stT.balance, coins(fs, "たろう"));
});

test("購入と状態取得で使う Firestore アクセス数が小さい（購入：読み取り少数＋commit1回）", async () => {
  const { fs, buy } = setup();
  const before = { ...fs.counts };
  await buy("uT", "たろう", 5);
  assert.equal(fs.counts.commit - before.commit, 1, "commit は1回");
  assert.equal(fs.counts.query - before.query, 0, "購入で一覧クエリは使わない");
});
