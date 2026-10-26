/* 🎊 ゆう番くじ（worker.js）のテスト
   実行：node --test "notify-worker/test/*.test.mjs" */
import test from "node:test";
import assert from "node:assert/strict";
import { BANKUJI, bankujiPickPrize, bankujiMakeAward, bankujiMode, bankujiApplyWindow, bankujiFirstDay, handleYuslotAction, resetBankujiCacheForTest, resetLotteryCacheForTest } from "../worker.js";

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
        if (w.updateMask) for (const fp of w.updateMask.fieldPaths) {
          if (fp.includes(".")) { const [top, key] = fp.split("."); const child = w.update.fields[top]?.mapValue?.fields?.[key]; const m = { ...(next[top]?.mapValue?.fields || {}) }; if (child) m[key] = child; else delete m[key]; next[top] = { mapValue: { fields: m } }; continue; }
          if (w.update.fields[fp] !== undefined) next[fp] = w.update.fields[fp]; else delete next[fp];
        }
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
const START = BANKUJI.saleStartMs;                         // 2026-10-26（月）8:00 JST
const DAY2 = START + 86400000;                              // 2026-10-27（火）8:00 JST
const MIN = 60000;
const rngOf = (seed) => { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; };
function setup({ now = START + 5 * MIN, users, random = rngOf(11), extra = {} } = {}) {
  resetLotteryCacheForTest(); resetBankujiCacheForTest();
  const base = { ...extra };
  const u = users || { "たろう": { uid: "uT", name: "たろう", coins: 5000 }, "はなこ": { uid: "uH", name: "はなこ", coins: 5000 }, "じろう": { uid: "uJ", name: "じろう", coins: 5000 } };
  Object.entries(u).forEach(([n, d]) => { base[`users/${n}`] = d; });
  const fs = fakeFs(base);
  const state = { now };
  const deps = { firestore: fs, adminUid: ADMIN, random, now: () => state.now };
  const call = (uid, name, action, body = {}) => handleYuslotAction(deps, uid, { action, username: name, ...body });
  return { fs, deps, state, call, buy: (uid, name, body) => call(uid, name, "bankujiBuy", body), status: (uid, name) => call(uid, name, "bankujiStatus"), apply: (uid, name) => call(uid, name, "bankujiApply") };
}
const coins = (fs, n) => fs.plain(`users/${n}`).coins;
/* 売れた番号の表と箱の残りを、指定の枚数ぶん売れた状態にして書く（残りの景品は、残り枚数−1 本になるように） */
function seedSold(fs, soldN, leftSum = null, extraRound = {}) {
  const left = Object.fromEntries(BANKUJI.prizes.map((p) => [p.id, 0]));
  let need = leftSum ?? (BANKUJI.pool - soldN - 1);
  for (const p of BANKUJI.prizes) { const k = Math.min(p.count, need); left[p.id] = k; need -= k; }
  fs.putP("bankujiRounds/r1", { round: "r1", soldBits: "1".repeat(soldN) + "0".repeat(BANKUJI.pool - soldN), sold: soldN, left, status: "selling", ...extraRound });
}

test("設定：景品は299本＋ラストワン1本＝300枚。1日15枚・残り100枚ルール・整理券の人数、発売は 2026-10-26 8:00 JST", () => {
  assert.equal(BANKUJI.prizes.reduce((s, p) => s + p.count, 0), 299);
  assert.equal(BANKUJI.pool, 300); assert.equal(BANKUJI.price, 200); assert.equal(BANKUJI.perDay, 15); assert.equal(BANKUJI.stopRemaining, 100);
  assert.equal(new Date(START + 9 * 3600000).toISOString(), "2026-10-26T08:00:00.000Z".replace("08:00", "08:00"));
  assert.equal(bankujiFirstDay(), "2026-10-26"); assert.equal(bankujiMode("2026-10-26"), "open"); assert.equal(bankujiMode("2026-10-27"), "pass");
  const w = bankujiApplyWindow("2026-10-27"); assert.equal(w.openMs, DAY2); assert.equal(w.closeMs, DAY2 + 30 * MIN);
});

test("景品の引き方：箱の残りから引くと、299回で本数がぴったり使い切られる（偏らず、余りも不足もない）", () => {
  const left = Object.fromEntries(BANKUJI.prizes.map((p) => [p.id, p.count]));
  const got = {}; const rng = rngOf(5);
  for (let i = 0; i < 299; i++) { const id = bankujiPickPrize(left, rng); got[id] = (got[id] || 0) + 1; }
  BANKUJI.prizes.forEach((p) => assert.equal(got[p.id], p.count, `${p.id} の本数`));
  assert.ok(Object.values(left).every((v) => v === 0));
  const stock = bankujiMakeAward("G", 1, 0, rng); assert.ok(["YGM", "YMT", "YFD", "YEN", "YPY"].includes(stock.code) && stock.qty >= 1 && stock.qty <= 3);
  assert.equal(bankujiMakeAward("B", 1, 0, rng).qty, 25);
  assert.equal(bankujiMakeAward("H", 1, 0, rng).amount, 100);
  assert.ok(["gold", "silver", "rainbow", "blackgold"].includes(bankujiMakeAward("F", 1, 0, rng).code));
  assert.equal(bankujiMakeAward("C", 1, 1000, rng).until, 1000 + 60 * 86400000);
});

test("発売前：ふつうの人には中身を出さない。管理者だけは本物の売り場をテストで見られる（何も書き込まない）", async () => {
  const { fs, call, state } = setup({ now: START - 3600000 });
  fs.putP("users/かんりしゃ", { uid: ADMIN, name: "かんりしゃ", coins: 1000 });
  const u = await call("uT", "たろう", "bankujiStatus");
  assert.equal(u.phase, "before"); assert.equal(u.prizes, undefined); assert.equal(u.sold, undefined);
  const a = await call(ADMIN, "かんりしゃ", "bankujiStatus");
  assert.equal(a.phase, "before"); assert.equal(a.adminPreview, true); assert.equal(a.prizes.length, 9); assert.equal(a.sold.length, 300);
  assert.equal((await call("uT", "たろう", "bankujiBuy", { random: 1 })).error, "not_started");
  assert.equal([...fs.docs.keys()].some((k) => k.startsWith("bankuji")), false, "発売前は何も作らない");
  state.now = START + MIN;
  assert.equal((await call("uT", "たろう", "bankujiStatus")).phase, "selling");
});

test("初日の購入：おまかせ15枚。コインが引かれ、コイン景品は同じ commit で渡り、株の景品はゆう株に入る。1日16枚目は買えない", async () => {
  const { fs, buy, status } = setup({ random: rngOf(2) });
  const r = await buy("uT", "たろう", { random: 15 });
  assert.equal(r.ok, true); assert.equal(r.bought, 15); assert.equal(r.results.length, 15); assert.equal(r.remaining, 285); assert.equal(r.todayCount, 15);
  const coinGain = r.results.filter((x) => x.kind === "coin").reduce((s, x) => s + x.amount, 0);
  assert.equal(coins(fs, "たろう"), 5000 - 3000 + coinGain); assert.equal(r.balance, coins(fs, "たろう"));
  const user = fs.plain("users/たろう");
  r.results.filter((x) => x.kind === "stock").forEach((x) => assert.ok(user.stocks[x.code].qty >= x.qty, "ゆう株に入っている"));
  const round = fs.plain("bankujiRounds/r1"); assert.equal(round.soldBits.length, 300); assert.equal(round.sold, 15); assert.equal(round.status, "selling");
  const entry = fs.plain("bankujiEntries/r1_uT"); assert.equal(entry.tickets.length, 15); assert.equal(entry.prizes.length, 15); assert.equal(entry.dayCount, 15);
  assert.equal((await buy("uT", "たろう", { random: 1 })).error, "daily_limit");
  assert.equal((await buy("uH", "はなこ", { random: 16 })).error, "bad_count");
  const st = await status("uT", "たろう");
  assert.equal(st.todayCount, 15); assert.equal(st.mine.tickets, 15); assert.equal(st.remaining, 285); assert.equal(st.balance, coins(fs, "たろう"));
  assert.equal(st.prizes.find((p) => p.id === "L").count, 1);
});

test("番号を選んで買う：選んだ番号が売れ済みになり、ほかの人が同じ番号を選ぶと「売れました」。境界・重複・範囲外は受け付けない", async () => {
  const { fs, buy } = setup({ random: rngOf(3) });
  const r = await buy("uT", "たろう", { tickets: [0, 7, 299] });
  assert.equal(r.ok, true); assert.deepEqual(r.results.map((x) => x.n), [0, 7, 299]);
  assert.equal(fs.plain("bankujiRounds/r1").soldBits[7], "1");
  const t = await buy("uH", "はなこ", { tickets: [8, 7] });
  assert.equal(t.error, "taken"); assert.deepEqual(t.taken, [7]); assert.equal(coins(fs, "はなこ"), 5000, "売れていた券を含むと、何も買わない");
  assert.equal((await buy("uH", "はなこ", { tickets: [1, 1] })).error, "bad_request");
  assert.equal((await buy("uH", "はなこ", { tickets: [300] })).error, "bad_request");
  assert.equal((await buy("uH", "はなこ", { tickets: [] })).error, "bad_count");
  fs.putP("users/まずしい", { uid: "uP", name: "まずしい", coins: 150 });
  assert.equal((await buy("uP", "まずしい", { tickets: [10] })).error, "insufficient_coins");
});

test("初日の100枚ルール：残り101枚なら次の人は15枚まで買える。そのあとは買えない。残りちょうど100枚も買えない", async () => {
  const { fs, buy, status } = setup({ random: rngOf(4) });
  seedSold(fs, 199);               // 残り101
  const a = await buy("uT", "たろう", { random: 15 });
  assert.equal(a.ok, true); assert.equal(a.remaining, 86);
  const b = await buy("uH", "はなこ", { random: 1 });
  assert.equal(b.error, "closed_today");
  assert.equal((await status("uH", "はなこ")).phase, "closedToday");
  const c = setup({ random: rngOf(4) });
  seedSold(c.fs, 200);             // 残りちょうど100
  assert.equal((await c.buy("uT", "たろう", { random: 1 })).error, "closed_today");
});

test("2日目以降は整理券：申込は 8:00〜8:30 だけ。抽選は8:30のあと1回だけ。当たった人だけ買える。人数は「残り÷15を切り上げ×2」", async () => {
  const { fs, state, buy, apply, status } = setup({ random: rngOf(6) });
  seedSold(fs, 215);               // 残り85 → 6人ぶん×2＝12人
  state.now = DAY2 - 3600000; assert.equal((await apply("uT", "たろう")).error, "apply_not_open");
  state.now = DAY2 + MIN;
  assert.equal((await buy("uT", "たろう", { random: 1 })).error, "pass_pending");
  assert.equal((await status("uT", "たろう")).pass.state, "canApply");
  assert.equal((await apply("uT", "たろう")).ok, true);
  assert.equal((await apply("uT", "たろう")).already, true, "二重に申し込んでも1件");
  assert.equal((await status("uT", "たろう")).pass.state, "applied");
  for (let i = 0; i < 20; i++) { fs.putP(`users/u${i}`, { uid: `id${i}`, name: `u${i}`, coins: 5000 }); await apply(`id${i}`, `u${i}`); }
  state.now = DAY2 + 31 * MIN;
  assert.equal((await apply("uH", "はなこ")).error, "apply_closed");
  const st = await status("uT", "たろう");
  const pass = fs.plain("bankujiPasses/r1_2026-10-27");
  assert.equal(pass.applicants, 21); assert.equal(pass.count, 12); assert.equal(pass.winners.length, 12);
  assert.ok(["won", "lost"].includes(st.pass.state));
  const winnerIds = pass.winners;
  const loser = ["uT", ...Array.from({ length: 20 }, (_, i) => `id${i}`)].find((id) => !winnerIds.includes(id));
  const loserName = loser === "uT" ? "たろう" : `u${loser.slice(2)}`;
  assert.equal((await buy(loser, loserName, { random: 1 })).error, "no_pass");
  assert.equal((await status("uH", "はなこ")).pass.state, "none", "申し込んでいない人");
  const win = winnerIds[0]; const winName = win === "uT" ? "たろう" : `u${win.slice(2)}`;
  const r = await buy(win, winName, { random: 15 });
  assert.equal(r.ok, true); assert.equal(r.remaining, 70);
  assert.equal(fs.counts.query, 1, "抽選は1回だけ（申込の読み取りは1回）");
  assert.equal(fs.plain("bankujiPasses/r1_2026-10-27").winners.length, 12);
});

test("ラストワン賞：最後の1枚を買った人だけがもらえる。そのとき売り切れ（done）になり、買えなくなる。もらう景品は1回だけ", async () => {
  const { fs, state, buy, apply, status } = setup({ random: rngOf(8) });
  seedSold(fs, 285);               // 残り15、箱には14本
  state.now = DAY2 + MIN; await apply("uT", "たろう");
  state.now = DAY2 + 31 * MIN;
  const r = await buy("uT", "たろう", { random: 15 });
  assert.equal(r.ok, true); assert.equal(r.lastOne, true); assert.equal(r.results.filter((x) => x.id === "L").length, 1);
  assert.equal(r.results.filter((x) => x.id !== "L").length, 14);
  const round = fs.plain("bankujiRounds/r1"); assert.equal(round.status, "done"); assert.equal(round.lastName, "たろう"); assert.equal(round.sold, 300);
  assert.ok(Object.values(round.left).every((v) => v === 0));
  const st = await status("uH", "はなこ"); assert.equal(st.phase, "soldout"); assert.equal(st.lastOne.name, "たろう");
  assert.equal((await buy("uH", "はなこ", { random: 1 })).error, "sold_out");
});

test("ラストワン賞の「全5社5株」も、買った瞬間にゆう株へ自動で入る（すでに持っている株には足される）。当たった株の景品も同じ", async () => {
  const { fs, state, buy, apply } = setup({ random: rngOf(8), users: { "たろう": { uid: "uT", name: "たろう", coins: 5000, stocks: { YGM: { qty: 2, cost: 400 } } } } });
  seedSold(fs, 285);
  state.now = DAY2 + MIN; await apply("uT", "たろう");
  state.now = DAY2 + 31 * MIN;
  const r = await buy("uT", "たろう", { random: 15 });
  assert.equal(r.lastOne, true);
  const user = fs.plain("users/たろう");
  const prizeStock = {}; r.results.filter((x) => x.kind === "stock").forEach((x) => { prizeStock[x.code] = (prizeStock[x.code] || 0) + x.qty; });
  for (const code of ["YGM", "YMT", "YFD", "YEN", "YPY"]) {
    const want = (code === "YGM" ? 2 : 0) + 5 + (prizeStock[code] || 0);
    assert.equal(user.stocks[code].qty, want, `${code}：もとの株＋ラストワン賞の5株＋当たった株`);
    assert.ok(user.stocks[code].cost > (code === "YGM" ? 400 : 0), `${code} の取得額も増えている`);
  }
});

test("同時に買われたとき：どちらか一方だけが成功し、もう一方は「もう一度」（番号が重ならない）", async () => {
  const { fs, deps, buy } = setup({ random: rngOf(9) });
  const real = fs.commit;
  let first = true;
  fs.commit = async (writes) => { if (first) { first = false; fs.putP("bankujiRounds/r1", { round: "r1", soldBits: "1" + "0".repeat(299), sold: 1, left: Object.fromEntries(BANKUJI.prizes.map((p) => [p.id, p.count])), status: "selling" }); } return real(writes); };
  const r = await buy("uT", "たろう", { tickets: [5] });
  assert.equal(r.error, "busy"); assert.equal(coins(fs, "たろう"), 5000, "失敗したときは何も引かれない");
  fs.commit = real;
  assert.equal((await buy("uT", "たろう", { tickets: [5] })).ok, true);
});

test("販売の一時停止：最上位管理者だけが切り替えられる。停止中はふつうの人は買えず、管理者は動かせる", async () => {
  const { fs, call, buy, status } = setup();
  fs.putP("users/かんりしゃ", { uid: ADMIN, name: "かんりしゃ", coins: 1000 });
  assert.equal((await call("uT", "たろう", "bankujiSetPaused", { paused: true })).error, "not_top_admin");
  assert.equal((await call(ADMIN, "かんりしゃ", "bankujiSetPaused", { paused: true })).paused, true);
  assert.equal((await status("uT", "たろう")).phase, "paused");
  assert.equal((await buy("uT", "たろう", { random: 1 })).error, "paused");
  assert.equal((await call("uT", "たろう", "bankujiApply")).error, "paused");
  assert.equal((await call(ADMIN, "かんりしゃ", "bankujiStatus")).paused, true);
  assert.equal((await call(ADMIN, "かんりしゃ", "bankujiSetPaused", { paused: false })).paused, false);
  assert.equal((await buy("uT", "たろう", { random: 1 })).ok, true);
});

test("購入の読み書き：読み取り（残高・券・売れた番号）のあと、書き込みは1回の commit", async () => {
  const { fs, buy } = setup({ random: rngOf(10) });
  await buy("uT", "たろう", { random: 3 });
  assert.equal(fs.counts.commit, 1);
});

test("残り本数のリアルタイム更新（bankujiLeft）：景品ごとの残りと売れた券だけを返す。読み取りは5秒に1回まで。書き込みはしない", async () => {
  const { fs, state, call, buy } = setup({ random: rngOf(10) });
  const first = await call("uT", "たろう", "bankujiLeft");
  assert.equal(first.ok, true); assert.equal(first.remaining, BANKUJI.pool);
  BANKUJI.prizes.forEach((p) => assert.equal(first.left[p.id], p.count)); assert.equal(first.left.L, 1);
  const base = { get: fs.counts.get, getRaw: fs.counts.getRaw, query: fs.counts.query, commit: fs.counts.commit };
  for (let i = 0; i < 20; i++) { state.now += 200; await call("uH", "はなこ", "bankujiLeft"); }   // 4秒のあいだに何人が頼んでも
  assert.deepEqual({ get: fs.counts.get, getRaw: fs.counts.getRaw, query: fs.counts.query, commit: fs.counts.commit }, base, "読み取りも書き込みも増えない");
  state.now += 2000;
  await call("uH", "はなこ", "bankujiLeft");
  assert.equal(fs.counts.get, base.get + 1, "5秒たったら1回だけ読む");
  assert.equal(fs.counts.commit, base.commit, "書き込みはしない");
});

test("残り本数：買うとすぐ（同じ Worker の中では）反映される。景品の残りの合計＝残り枚数−ラストワン1", async () => {
  const { buy, call } = setup({ random: rngOf(10) });
  await call("uT", "たろう", "bankujiLeft");
  const r = await buy("uT", "たろう", { random: 5 });
  assert.equal(r.ok, true);
  const after = await call("uH", "はなこ", "bankujiLeft");
  assert.equal(after.remaining, BANKUJI.pool - 5);
  const sum = BANKUJI.prizes.reduce((a, p) => a + after.left[p.id], 0);
  assert.equal(sum, BANKUJI.prizes.reduce((a, p) => a + p.count, 0) - 5, "引いた5本ぶんが減っている");
  assert.equal(after.sold.split("1").length - 1, 5);
  const st = await call("uH", "はなこ", "bankujiStatus");
  assert.deepEqual(st.left, after.left, "ふつうの状態取得にも同じ残りが入る");
});

test("残り本数：発売前は何も返さない", async () => {
  const before = setup({ now: START - 60000 });
  assert.equal((await before.call("uT", "たろう", "bankujiLeft")).phase, "before");
});
