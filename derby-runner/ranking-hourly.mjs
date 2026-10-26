/* =========================================================
   総資産ランキングの1時間おきの更新（GitHub Actions から。日本時間 9:00〜16:59 の間だけ動く）。13:00 以降は、1日1回の処理が済んでいなければここからも行う（予備）
   本体は economy.mjs の refreshAssetRanking。1日1回の処理（株価・利息など）には触れない。
   環境変数：FIREBASE_SERVICE_ACCOUNT（GitHub Secrets）／FIRESTORE_EMULATOR_HOST・DERBY_NOW（テスト用）
========================================================= */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { refreshAssetRanking, runDailyJobs } from "./economy.mjs";

async function main() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson && !process.env.FIRESTORE_EMULATOR_HOST) { console.warn("FIREBASE_SERVICE_ACCOUNT が未登録のため、何もしませんでした"); return; }
  if (serviceAccountJson) initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  else initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-yuuchat" });
  const now = process.env.DERBY_NOW ? new Date(process.env.DERBY_NOW) : new Date();
  const db = getFirestore();
  /* 13:00 の1日1回の処理（derby-runner.yml）が GitHub の都合で動かなかった日の予備。13:00 前・済んでいる日は何もしない（読み取りは最大1件） */
  try {
    const daily = await runDailyJobs({ db, now });
    console.log("1日1回の処理", JSON.stringify({ date: daily.date, status: daily.status, reason: daily.reason, marketUpdated: daily.marketUpdated, errors: daily.errors }));
  } catch (e) { console.error("1日1回の処理でエラー：" + String(e?.message || e).slice(0, 300)); }
  const result = await refreshAssetRanking({ db, now });
  console.log("完了", JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error("エラー：" + String(e?.message || e).slice(0, 300)); process.exit(1); });
}
