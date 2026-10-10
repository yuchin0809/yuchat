// 第1段階のセキュリティ修正：一般ユーザー・匿名ゲストが、経済・ゆうダービーの重要データをブラウザから改変できないことを確かめる
// （正規の操作は通知 Worker 経由。この Worker はサービスアカウントで書くのでこのルールの対象外）
const { initializeTestEnvironment, assertSucceeds, assertFails } = require("@firebase/rules-unit-testing");
const fs = require("fs");
const path = require("path");
const { doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection } = require("firebase/firestore");

let pass = 0, fail = 0; const log = [];
async function ng(name, p) { try { await assertFails(p); pass++; log.push(`PASS 拒否 ${name}`); } catch (e) { fail++; log.push(`FAIL (拒否されるべき) ${name}`); } }
async function ok(name, p) { try { await assertSucceeds(p); pass++; log.push(`PASS 許可 ${name}`); } catch (e) { fail++; log.push(`FAIL (許可されるべき) ${name}: ${String(e.message).split("\n")[0]}`); } }

(async () => {
  const env = await initializeTestEnvironment({ projectId: "demo-sec1", firestore: { rules: fs.readFileSync(process.env.RULES || path.join(__dirname, "..", "firestore.rules"), "utf8"), host: "127.0.0.1", port: 8080 } });
  // 一般ユーザー（通常ログイン）と匿名ゲスト（guest ログイン）。どちらも signedIn() は true
  const M = env.authenticatedContext("mallory").firestore();
  const G = env.authenticatedContext("guest", { firebase: { sign_in_provider: "anonymous" } }).firestore();

  await env.withSecurityRulesDisabled(async (ctx) => {
    const d = ctx.firestore();
    await setDoc(doc(d, "users/mallory"), { uid: "mallory", name: "mallory", coins: 100, bank: { deposit: 0, interestBase: 0, loan: 500 }, stocks: {}, totalBetAmount: 0 });
    await setDoc(doc(d, "users/guest"), { uid: "guest", name: "guest", coins: 100 });
    await setDoc(doc(d, "users/victim"), { uid: "victim", name: "victim", coins: 5000 });
    await setDoc(doc(d, "races/2026-10-20"), { raceId: "2026-10-20", resultOrder: [1,2,3,4,5,6,7,8,9,10], status: "finished", generatedBy: "github-actions" });
    await setDoc(doc(d, "raceBets/victimBet"), { raceId: "2026-10-21", uid: "victim", username: "victim", type: "win", horses: [3], amount: 500, settled: false });
    await setDoc(doc(d, "raceBets/myBet"), { raceId: "2026-10-20", uid: "mallory", username: "mallory", type: "win", horses: [9], amount: 100, settled: false, payout: null });
    await setDoc(doc(d, "derbyManualRaces/2026-10-20-m1800"), { raceId: "2026-10-20-m1800", status: "scheduled", betCount: 0, openAt: new Date(Date.now()-6e5), closeAt: new Date(Date.now()+6e5), raceAt: new Date(Date.now()+9e5) });
  });

  for (const [who, U] of [["一般", M], ["匿名ゲスト", G]]) {
    const self = who === "一般" ? "mallory" : "guest";
    // 経済項目
    await ng(`${who}：自分の coins を増やす`, updateDoc(doc(U, `users/${self}`), { coins: 100000 }));
    await ng(`${who}：自分の bank.deposit を増やす`, updateDoc(doc(U, `users/${self}`), { "bank.deposit": 1000000 }));
    await ng(`${who}：自分の借入を 0 にする`, updateDoc(doc(U, `users/${self}`), { bank: { deposit: 0, interestBase: 0, loan: 0 } }));
    await ng(`${who}：自分の stocks を増やす`, updateDoc(doc(U, `users/${self}`), { "stocks.YEN": { qty: 99999, cost: 0 } }));
    await ng(`${who}：ログインボーナス日・累計賭け金・ボーナスを書き換える`, updateDoc(doc(U, `users/${self}`), { lastLoginBonusDate: "2000-01-01", totalBetAmount: 0, bonus500Granted: false }));
    await ng(`${who}：経済項目入りで新しい users を作る`, setDoc(doc(U, "users/newrich"), { uid: self, name: "newrich", coins: 1000000 }));
    // ゆうダービー
    await ng(`${who}：未来のレース結果を先に作る`, setDoc(doc(U, "races/2026-10-21"), { raceId: "2026-10-21", resultOrder: [3,1,2,4,5,6,7,8,9,10], status: "finished", generatedBy: "github-actions" }));
    await ng(`${who}：終わったレースの結果を書き換える`, updateDoc(doc(U, "races/2026-10-20"), { resultOrder: [9,1,2,3,4,5,6,7,8,10] }));
    await ng(`${who}：レースを削除する`, deleteDoc(doc(U, "races/2026-10-20")));
    await ng(`${who}：開催ログを書く`, setDoc(doc(U, "raceLogs/2026-10-20"), { resultGeneratedBy: "github-actions" }));
    await ng(`${who}：コインを払わず馬券を作る`, setDoc(doc(U, "raceBets/free1"), { raceId: "2026-10-21", uid: self, username: self, type: "win", horses: [3], amount: 1000000, settled: false }));
    await ng(`${who}：自分の馬券を好きな額で精算`, updateDoc(doc(U, "raceBets/myBet"), { settled: true, win: true, payout: 9999999, payoutRule: "fixed-v1" }));
    await ng(`${who}：他人の馬券を書き換える`, updateDoc(doc(U, "raceBets/victimBet"), { horses: [10], amount: 1 }));
    await ng(`${who}：手動レースの betCount を増やす`, updateDoc(doc(U, "derbyManualRaces/2026-10-20-m1800"), { betCount: 1 }));
    await ng(`${who}：手動レースの受付時間を変える`, updateDoc(doc(U, "derbyManualRaces/2026-10-20-m1800"), { closeAt: new Date(Date.now()+864e5) }));
    await ng(`${who}：他人のコインを書き換える`, updateDoc(doc(U, "users/victim"), { coins: 0 }));
    // 正規の操作（経済項目でない）は今まで通りできる
    await ok(`${who}：経済項目でない自分のデータ更新（名前・プロフィール・お知らせ既読）`, updateDoc(doc(U, `users/${self}`), { name: self, profileImage: "x" }));
    await ok(`${who}：レース結果・株価・ランキングの読み取り`, getDoc(doc(U, "races/2026-10-20")));
    await ok(`${who}：自分の馬券の読み取り`, getDocs(collection(U, "raceBets")));
  }

  console.log(log.join("\n"));
  console.log(`\n第1段階 不正拒否テスト: ${pass} PASS / ${fail} FAIL`);
  await env.cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
