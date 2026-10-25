/* 🥷 スリ（毎日13:00の処理 applyDailyUserUpdate・runDailyJobs）のテスト
   実行：node --test derby-runner/theft.test.mjs */
import test from "node:test";
import assert from "node:assert/strict";
import { applyDailyUserUpdate, runDailyJobs, yuuTaxOf } from "./economy.mjs";
import { THEFT_MIN_TOTAL, THEFT_WEEK_MAX, THEFT_GUARDS, theftWeeklyRate, isSurge, weekStartOf, takeFromAssets, guardPriceOf } from "../yuu-theft.js";

const PRICES = { YGM: 100, YMT: 200, YFD: 150, YEN: 280, YPY: 210 };
const NOW = new Date(Date.UTC(2026, 9, 25, 4, 5, 0));
const day = (i) => new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const user = (over = {}) => ({ uid: "u1", bonus500Granted: true, coins: 20000, bank: { deposit: 0, interestBase: 0, loan: 0 }, ...over });
/* 1日ぶん進める：返ってきた書き込みを users に反映して、次の日へ */
function step(data, d, opts) {
  const r = applyDailyUserUpdate(data, d, NOW, PRICES, opts);
  return { r, data: r ? { ...data, ...r.fields } : data };
}

test("表と計算：週の平均回数・一気に増えた判定・週の月曜・防犯グッズの値段", () => {
  assert.equal(theftWeeklyRate(14999), 0);
  assert.equal(theftWeeklyRate(15000), 1);
  assert.equal(theftWeeklyRate(30000), 1.5); assert.equal(theftWeeklyRate(60000), 2); assert.equal(theftWeeklyRate(100000), 2.5); assert.equal(theftWeeklyRate(200000), 3); assert.equal(theftWeeklyRate(9e9), 3);
  assert.ok(Math.abs(theftWeeklyRate(22500) - 1.25) < 1e-9, "表のあいだは直線");
  assert.equal(theftWeeklyRate(15000, true), 1.7); assert.equal(theftWeeklyRate(200000, true), THEFT_WEEK_MAX, "上限は週3回");
  assert.equal(isSurge(20000, 10000), true); assert.equal(isSurge(20000, 15000), false, "+5,000 でも 1.5倍に届かない");
  assert.equal(isSurge(7000, 5000), false, "1.4倍・+2,000 は、まだ"); assert.equal(isSurge(20000, undefined), false);
  assert.equal(weekStartOf("2026-10-26"), "2026-10-26"); assert.equal(weekStartOf("2026-10-25"), "2026-10-19", "日曜は、その週の月曜から"); assert.equal(weekStartOf("2026-10-29"), "2026-10-26");
  assert.equal(guardPriceOf(1, 20000), 100); assert.equal(guardPriceOf(3, 20000), 500); assert.equal(guardPriceOf(5, 20000), 1200); assert.equal(guardPriceOf(1, 100), 30, "最低額");
});

test("総資産15,000未満には、何日たっても来ない。秘密の値がないときも来ない", () => {
  let d = user({ coins: 14999 });
  for (let i = 0; i < 400; i++) { const s = step(d, day(i), { secret: "k" }); assert.ok(!s.r?.theft); d = { ...s.data, coins: 14999 }; }
  for (let i = 0; i < 400; i++) assert.ok(!applyDailyUserUpdate(user(), day(i), NOW, PRICES, {})?.theft, "秘密の値なし");
});

test("来る頻度：総資産2万の人は週に平均1.2回ほど。1週間に3回を超えない。同じ日に2回は来ない（再実行しても同じ）", () => {
  let d = user({ coins: 1e9 }), perWeek = new Map(), attempts = 0, total = 20000;
  d = user({ coins: total });
  const DAYS = 7 * 300;
  for (let i = 0; i < DAYS; i++) {
    const dd = day(i), s = step(d, dd, { secret: "k" });
    if (s.r && s.r.theft) {
      attempts++; const w = weekStartOf(dd); perWeek.set(w, (perWeek.get(w) || 0) + 1);
      const again = applyDailyUserUpdate(s.data, dd, NOW, PRICES, { secret: "k" });
      assert.equal(again, null, "同じ日の再実行では、もう来ない");
    }
    d = s.data;
    d = { ...d, coins: total, bank: { deposit: 0, interestBase: 0, loan: 0 }, stocks: undefined };   // 毎日、総資産2万に戻す（頻度だけを見たいので）
  }
  const weeks = DAYS / 7;
  assert.ok(Math.max(...perWeek.values()) <= THEFT_WEEK_MAX);
  const mean = attempts / weeks;
  assert.ok(mean > 0.95 && mean < 1.4, `週の平均 ${mean.toFixed(2)} 回（期待 約1.17）`);
});

test("総資産が大きいほど、また一気に増えた人ほど、よく来る", () => {
  const rate = (total, base) => {
    let d = user({ coins: total }), n = 0; const DAYS = 7 * 200;
    for (let i = 0; i < DAYS; i++) { const s = step(d, day(i), { secret: "k", baseTotal: base }); if (s.r?.theft) n++; d = { ...s.data, coins: total }; }
    return n / (DAYS / 7);
  };
  const small = rate(16000), big = rate(120000), surge = rate(16000, 6000);
  assert.ok(big > small + 0.8, `大金持ちほど多い ${small.toFixed(2)} → ${big.toFixed(2)}`);
  assert.ok(surge > small + 0.4, `急に増えた人は多い ${small.toFixed(2)} → ${surge.toFixed(2)}`);
});

test("取られる順番：手持ち → 預金 → 株（時価で売った扱い）。借入は取られない。取られたものは消える", () => {
  const t = takeFromAssets({ coins: 100, deposit: 300, stocks: { YGM: { qty: 10, cost: 900 }, YMT: { qty: 6, cost: 900 } } }, 250, PRICES);
  assert.deepEqual([t.coins, t.deposit, t.from.coins, t.from.deposit, t.from.stock], [0, 150, 100, 150, 0], "手持ちで足りなければ預金");
  const u = takeFromAssets({ coins: 100, deposit: 300, stocks: { YGM: { qty: 10, cost: 900 }, YMT: { qty: 6, cost: 900 } } }, 1000, PRICES);
  assert.deepEqual([u.coins, u.deposit], [0, 0]);
  assert.equal(u.from.stock, 600, "残りの600を株から");
  assert.deepEqual(u.sold, [{ code: "YMT", qty: 3 }], "時価の高い会社（YMT 200×6=1,200）から、足りるだけ（200×3=600）");
  assert.equal(u.stocks.YMT.qty, 3); assert.equal(u.stocks.YMT.cost, 450, "取得額も、残った株数に合わせて減る"); assert.equal(u.stocks.YGM.qty, 10);
  const v = takeFromAssets({ coins: 0, deposit: 0, stocks: { YGM: { qty: 10, cost: 900 } } }, 250, PRICES);
  assert.equal(v.from.stock, 250); assert.deepEqual(v.sold, [{ code: "YGM", qty: 3 }]);
  assert.equal(v.coins, 50, "売った300のうち、取られた250を超えた50は、手持ちに戻る");
  assert.equal(v.taken, 250);
  const big = takeFromAssets({ coins: 10, deposit: 0, stocks: {} }, 999, PRICES);
  assert.equal(big.taken, 10, "取れる分だけ");
});

test("被害：総資産の2〜6%（防犯なし）。手持ちが多ければスリ、預金に及べば銀行強盗、株に及べば株券泥棒。記録（theft.last）が残る", () => {
  let hits = 0;
  for (let i = 0; i < 3000 && hits < 40; i++) {
    const d = user({ coins: 20000, bank: { deposit: 0, interestBase: 0, loan: 0 } }), s = step(d, day(i), { secret: "k" });
    if (!s.r?.theft || s.r.theft.repelled) continue;
    hits++;
    const afterTax = 20000 - yuuTaxOf(20000), lost = s.r.theft.lost;   // ゆう税を引いたあとの総資産が基準
    assert.ok(lost >= Math.floor(afterTax * 0.02) && lost <= Math.floor(afterTax * 0.06), `被害 ${lost}`);
    assert.equal(s.data.coins, afterTax - lost); assert.equal(s.r.theft.kind.id, "pickpocket");
    assert.deepEqual([s.data.theft.last.date, s.data.theft.last.lost, s.data.theft.last.fromCoins, s.data.theft.last.repelled], [day(i), lost, lost, false]);
    assert.equal(s.data.theft.n, 1); assert.equal(s.data.theft.week, weekStartOf(day(i)));
  }
  assert.ok(hits >= 20);
  // 手持ちが少なく、預金・株が多い人
  let bank = 0, stock = 0;
  for (let i = 0; i < 4000 && (bank < 5 || stock < 5); i++) {
    const d = user({ coins: 100, bank: { deposit: 700, interestBase: 700, loan: 0 }, stocks: { YEN: { qty: 80, cost: 20000 } } }), s = step(d, day(i), { secret: "k" });   // 総資産 約23,200
    const t = s.r?.theft; if (!t || t.repelled) continue;
    if (t.kind.id === "stock") { stock++; assert.ok(s.data.stocks.YEN.qty < 80); assert.ok(s.data.stocks.YEN.cost < 20000); assert.equal(s.data.coins >= 0, true); }
    else if (t.kind.id === "bank") bank++;
    assert.equal(s.data.bank.deposit >= 0 && s.data.bank.interestBase === s.data.bank.deposit, true);
  }
  assert.ok(stock >= 5, "手持ち・預金で足りないときは、株から");
});

test("借入は取られない（総資産は借入を引いた額で決まる）。借入で総資産が15,000未満なら来ない", () => {
  let n = 0;
  for (let i = 0; i < 2000; i++) { const s = step(user({ coins: 20000, bank: { deposit: 0, interestBase: 0, loan: 6000 } }), day(i), { secret: "k" }); if (s.r?.theft) n++; }
  assert.equal(n, 0);
});

test("防犯グッズ：最強なら、来た泥棒の約9割を追い払う。追い払うと被害なし・記録に残る。被害も減る。別の週の分は効かない", () => {
  const trials = (lv, weekOf) => {
    let repelled = 0, hit = 0, lostSum = 0, attempts = 0;
    for (let i = 0; i < 6000; i++) {
      const dd = day(i), g = lv ? { [weekOf ? weekOf(dd) : weekStartOf(dd)]: { lv, paid: 1 } } : undefined;
      const s = step(user({ coins: 20000, guards: g }), dd, { secret: "k" });
      if (!s.r?.theft) continue;
      attempts++;
      if (s.r.theft.repelled) { repelled++; assert.equal(s.data.coins, 20000 - yuuTaxOf(20000), "追い払ったら、取られない（ゆう税だけ）"); assert.equal(s.data.theft.last.repelled, true); } else { hit++; lostSum += s.r.theft.lost; }
    }
    return { repelled, hit, attempts, avg: hit ? lostSum / hit : 0 };
  };
  const none = trials(0), lv5 = trials(5), lv3 = trials(3), old = trials(5, (dd) => weekStartOf(day(-14)));
  assert.equal(none.repelled, 0);
  assert.ok(lv5.repelled / lv5.attempts > 0.85 && lv5.repelled / lv5.attempts < 0.95, `最強の撃退率 ${(lv5.repelled / lv5.attempts).toFixed(2)}`);
  assert.ok(Math.abs(lv3.repelled / lv3.attempts - 0.6) < 0.06);
  assert.ok(lv5.avg < none.avg * 0.45 && lv3.avg < none.avg * 0.85, `被害も減る ${none.avg.toFixed(0)} → ${lv3.avg.toFixed(0)} → ${lv5.avg.toFixed(0)}`);
  assert.equal(old.repelled, 0, "古い週の防犯グッズは効かない");
  assert.equal(THEFT_GUARDS.length, 6);
});

test("来る・来ないは、秘密の値と日付とユーザーで決まる（同じなら同じ。秘密の値が違えば違う）", () => {
  const seq = (secret, uid) => Array.from({ length: 300 }, (_, i) => (applyDailyUserUpdate(user({ uid }), day(i), NOW, PRICES, { secret })?.theft ? 1 : 0)).join("");
  assert.equal(seq("a", "u1"), seq("a", "u1"));
  assert.notEqual(seq("a", "u1"), seq("b", "u1"));
  assert.notEqual(seq("a", "u1"), seq("a", "u2"));
});

/* ---- 毎日の処理（runDailyJobs）：被害の集計・通知の対象・1週間前の総資産の記録 ---- */
function mockDb(users) {
  const docs = new Map();
  const writes = [];
  const userDocs = Object.entries(users).map(([id, data]) => ({ id, data: () => structuredClone(current[id]), ref: { path: `users/${id}` } }));
  const current = structuredClone(users);
  const ref = (path) => ({ path, async get() { const d = docs.get(path); return { exists: d !== undefined && d !== null, data: () => d }; }, async set(v) { writes.push({ path, v }); docs.set(path, v); }, async update(v) { writes.push({ path, v }); } });
  return {
    writes, docs, current,
    collection(name) { return { doc: (id) => ref(`${name}/${id}`), select: () => ({ async get() { return { size: userDocs.length, docs: userDocs }; } }) }; },
    async runTransaction(fn) {
      const t = { async get(r) { return r.path.startsWith("users/") ? { exists: true, data: () => structuredClone(current[r.path.slice(6)]) } : r.get(); }, update(r, v) { Object.assign(current[r.path.slice(6)], v); writes.push({ path: r.path, v }); }, set(r, v) { writes.push({ path: r.path, v }); docs.set(r.path, v); } };
      return fn(t);
    }
  };
}

test("毎日の処理：被害・撃退を集計し、プッシュ通知をオンにした人だけを通知の対象にする。1週間前の総資産を記録し、次の週に「一気に増えた」に使う", async () => {
  const users = {};
  for (let i = 0; i < 60; i++) users[`rich${i}`] = { uid: `ur${i}`, bonus500Granted: true, coins: 50000, bank: { deposit: 0, interestBase: 0, loan: 0 }, theftPush: i % 2 === 0 };
  users.poor = { uid: "up", bonus500Granted: true, coins: 800 };
  const db = mockDb(users);
  const r1 = await runDailyJobs({ db, now: new Date(Date.UTC(2026, 9, 24, 4, 5, 0)), log: () => {}, stockSecret: { secret: "s", source: "test" } });
  assert.equal(r1.status, "ok");
  assert.ok(r1.theftUsers + r1.theftRepelled > 5, `金持ちの何人かに来る（${r1.theftUsers}＋撃退${r1.theftRepelled}）`);
  assert.ok(r1.theftTotal > 0);
  assert.ok(r1.theftNotices.length > 0 && r1.theftNotices.every((n) => db.current[Object.keys(users).find((k) => users[k].uid === n.uid)].theftPush === true), "通知の対象は、プッシュ通知をオンにした人だけ");
  assert.ok(r1.theftNotices.every((n) => /盗まれ/.test(n.body)), "被害の通知");
  assert.equal(db.current.poor.theft, undefined);
  const base = db.writes.filter((w) => w.path === "economyStats/weekBase");
  assert.equal(base.length, 1); assert.equal(base[0].v.date, "2026-10-24"); assert.equal(typeof base[0].v.totals.rich0, "number");
  const hist = db.writes.find((w) => w.path === "economyStats/history").v.points.at(-1);
  assert.equal(hist.theftUsers, r1.theftUsers); assert.equal(hist.theftTotal, r1.theftTotal);
  // 同じ日をもう一度：二重に来ない
  const sum = (k) => Object.values(db.current).reduce((a, u) => a + (u.coins || 0) + (u.bank?.deposit || 0), 0);
  const before = sum();
  db.docs.set("rankings/assets", { date: "x", complete: false });
  const r2 = await runDailyJobs({ db, now: new Date(Date.UTC(2026, 9, 24, 4, 20, 0)), log: () => {}, stockSecret: { secret: "s", source: "test" } });
  assert.equal(r2.theftUsers + r2.theftRepelled, 0, "同じ日の再実行では来ない"); assert.equal(sum(), before);
});
