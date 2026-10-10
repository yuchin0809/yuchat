// ロックダウン後：ブラウザから直接、同時に投票（betCount の加算・コイン引き落とし・馬券の作成）しても、すべて拒否されることを確かめる
// （正規の投票は通知 Worker が行う。Worker 側の同時投票は notify-worker/test/economy.test.mjs で確認している）
const { initializeTestEnvironment, assertFails } = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");
const { doc, getDoc, setDoc, collection, runTransaction } = require("firebase/firestore");
const min = (m) => new Date(Date.now() + m * 60000);

(async () => {
  const env = await initializeTestEnvironment({
    projectId: "demo-yuuchat-concurrency",
    firestore: { rules: fs.readFileSync(path.join(__dirname, "..", "firestore.rules"), "utf8"), host: "127.0.0.1", port: 8080 }
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "derbyManualRaces/2030-01-01-m1300"), { openAt: min(-10), closeAt: min(10), raceAt: min(20), status: "scheduled", betCount: 0 });
    for (let i = 0; i < 6; i++) await setDoc(doc(d, `users/u${i}`), { uid: `u${i}`, coins: 1000 });
  });
  const dbs = [0, 1, 2, 3, 4, 5].map((i) => env.authenticatedContext(`u${i}`).firestore());

  // アプリと同じ形（betCount+1・コイン引き落とし・馬券作成）をブラウザから直接やろうとする
  const bet = (db, uid) => runTransaction(db, async (t) => {
    const m = doc(db, "derbyManualRaces/2030-01-01-m1300"), u = doc(db, `users/${uid}`);
    const ms = await t.get(m); const us = await t.get(u);
    t.update(m, { betCount: ms.data().betCount + 1 });
    t.update(u, { coins: us.data().coins - 10 });
    t.set(doc(collection(db, "raceBets")), { raceId: "2030-01-01-m1300", uid, amount: 10 });
  });

  // 6人が同時に投票 → すべて拒否される
  let denied = 0;
  await Promise.all(dbs.map(async (db, i) => { try { await assertFails(bet(db, `u${i}`)); denied++; } catch (e) {} }));

  let mr, u0;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    mr = (await getDoc(doc(d, "derbyManualRaces/2030-01-01-m1300"))).data();
    u0 = (await getDoc(doc(d, "users/u0"))).data();
  });
  console.log(`同時投票（ブラウザから直接）6人: 拒否 ${denied}/6 → betCount ${mr.betCount}・u0 coins ${u0.coins}`);
  const ok = denied === 6 && mr.betCount === 0 && u0.coins === 1000;
  console.log(ok ? "同時実行テスト PASS（ブラウザからの直接投票はすべて拒否）" : "同時実行テスト FAIL");
  await env.cleanup();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
