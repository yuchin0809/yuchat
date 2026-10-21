/* =========================================================
   総資産ランキングの1時間おきの更新（GitHub Actions から。日本時間 9:00〜16:59 の間だけ動く）
   本体は economy.mjs の refreshAssetRanking。1日1回の処理（株価・利息など）には触れない。
   環境変数：FIREBASE_SERVICE_ACCOUNT（GitHub Secrets）／FIRESTORE_EMULATOR_HOST・DERBY_NOW（テスト用）
========================================================= */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { refreshAssetRanking } from "./economy.mjs";

async function main() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson && !process.env.FIRESTORE_EMULATOR_HOST) { console.warn("FIREBASE_SERVICE_ACCOUNT が未登録のため、何もしませんでした"); return; }
  if (serviceAccountJson) initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  else initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-yuuchat" });
  const now = process.env.DERBY_NOW ? new Date(process.env.DERBY_NOW) : new Date();
  const result = await refreshAssetRanking({ db: getFirestore(), now });
  console.log("完了", JSON.stringify(result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error("エラー：" + String(e?.message || e).slice(0, 300)); process.exit(1); });
}
