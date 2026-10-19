/* =========================================================
   🎟 ゆう宝くじ売り場 オープンの自動処理
   GitHub Actions（.github/workflows/lottery-open.yml・手動実行）から、サービスアカウントで実行する。

   1. 宝くじ売り場を公開（worldConfig/lottery.lotteryPublished = true）
   2. お知らせ（📢）に「ゆう宝くじ売り場オープン」の記事を投稿
   3. お知らせのプッシュ通知を送る（通知ONの端末へ。通知サーバーと同じ処理・二重送信しない）

   安全策（冪等）：
   ・公開は何度実行しても安全（true を入れ直すだけ）。
   ・お知らせは固定IDで createIfAbsent（すでにあれば作らない）。
   ・プッシュ通知は notificationLogs の記録で二重送信しない。
   ・コインは配らない。クライアントからは実行できない（サービスアカウントのみ）。
========================================================= */

import { createDefaultDeps, notifyNewAnnouncement } from "../../notify-worker/worker.js";

const EXPECTED_PROJECT_ID = "yuuchat-be666";
export const ANNOUNCE_ID = "lottery-open-2026-10-19";
export const ANNOUNCE_TITLE = "🎟 ゆう宝くじ売り場がオープン！1等は10,000コイン";
export const ANNOUNCE_BODY = [
  "「ゆうワールド」タブに、新しいお店「ゆう宝くじ売り場」がオープンしました！🎟",
  "",
  "・1枚10コイン。券には番号（30組×100番）が付き、「連番」か「バラ」を選んで買えます。購入枚数の上限はありません。",
  "・1等は全体で1本、10,000コイン！ 1等の前後の番号の「前後賞」2,500コインをはじめ、7等までたくさんの当たりがあります。",
  "・販売は毎週月曜 8:00 から。抽選は毎週金曜 14:30 で、結果は豪華な「抽選会」の演出で発表します。",
  "・今週は「グランドオープン記念 ゆうミリオンジャンボ」！ 抽選は 10/23（金）14:30、すでに販売中です。",
  "",
  "ぜひ「ゆうワールド」からのぞいてみてください。"
].join("\n");

export async function run({ deps, notify = notifyNewAnnouncement, log = console.log } = {}) {
  const fs = deps.firestore;
  const result = { published: false, announced: false, notified: null };

  // 1) 公開
  await fs.set("worldConfig/lottery", { lotteryPublished: true, updatedAtMs: deps.now(), updatedByUid: "github-actions-lottery-open" });
  result.published = true;
  log("✓ 宝くじ売り場を公開しました（worldConfig/lottery.lotteryPublished = true）");

  // 2) お知らせ投稿（固定ID・まだ無ければ）
  const now = new Date(deps.now());
  result.announced = await fs.createIfAbsent(`announcements/${ANNOUNCE_ID}`, {
    title: ANNOUNCE_TITLE, body: ANNOUNCE_BODY, createdAt: now, updatedAt: now,
    createdByUid: "github-actions", createdByName: "ゆうChat自動更新"
  });
  log(result.announced ? `✓ お知らせを投稿しました（announcements/${ANNOUNCE_ID}）` : "・お知らせはすでにあります（作成しません）");

  // 3) プッシュ通知（冪等）
  try {
    const r = await notify(deps, ANNOUNCE_ID);
    result.notified = r;
    log(r && r.skipped === "duplicate" ? "・プッシュ通知はすでに送信済み" : `✓ プッシュ通知：${(r && r.tokens) || 0} 台中 ${(r && r.sent) || 0} 台に送信`);
  } catch (error) {
    log("⚠ プッシュ通知に失敗（お知らせは投稿済み）：" + String(error?.message || error).slice(0, 100));
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (sa.project_id !== EXPECTED_PROJECT_ID) { console.error("サービスアカウントのプロジェクトが違います"); process.exit(1); }
  const deps = createDefaultDeps({ FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT, FIREBASE_PROJECT_ID: EXPECTED_PROJECT_ID });
  run({ deps })
    .then((r) => { console.log("完了", JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error("エラー：" + String(e?.message || e).slice(0, 300)); process.exit(1); });
}
