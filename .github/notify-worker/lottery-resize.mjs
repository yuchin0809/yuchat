/* =========================================================
   🎟 宝くじの番号の数を 3,000 → 1,500 に減らしたときの「番号の付け替え」（手動実行）
   GitHub Actions（.github/workflows/lottery-resize.yml・手動実行）から、サービスアカウントで実行する。

   ・いま販売中の回（次の金曜 14:30 の回）を、1,500通りの番号に直す。1,500 未満の番号はそのまま。1,500 以上の番号を持つ人だけ、空いている番号に付け替える。
   ・合計の枚数・買った人・コインは変わらない。1,500 枚を超えて売れていたら、何も変えずに知らせる（aborted）。
   ・すでに済んでいれば何もしない（何度実行しても安全）。付け替えの本体は通知 Worker の lotteryResizeRound（購入・状態の表示・抽選のときにも自動で行われる）。
   ・ログには、人の名前・番号は出さない（件数だけ）。このリポジトリは公開なので。
========================================================= */

import { createDefaultDeps, lotteryResizeRound, lotteryEventFor, lotteryNextDrawMs } from "../../notify-worker/worker.js";

const EXPECTED_PROJECT_ID = "yuuchat-be666";

export async function run({ deps, log = console.log } = {}) {
  const ev = lotteryEventFor(lotteryNextDrawMs(deps.now()));
  const r = await lotteryResizeRound(deps, ev.id);
  if (r.ok) log(`✓ 番号を付け替えました（回：${ev.id}・売れた枚数：${r.tickets}枚・付け替えた人：${r.moved}人）`);
  else if (r.aborted) log(`⚠ 付け替えを止めました（${r.aborted}・売れた枚数：${r.tickets}枚）。何も変えていません`);
  else log(`・何もしませんでした（${r.skipped || "対象なし"}。すでに1,500通りの回、または売れた券がない回です）`);
  return { roundId: ev.id, ...r };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (sa.project_id !== EXPECTED_PROJECT_ID) { console.error("サービスアカウントのプロジェクトが違います"); process.exit(1); }
  const deps = createDefaultDeps({ FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT, FIREBASE_PROJECT_ID: EXPECTED_PROJECT_ID });
  run({ deps })
    .then((r) => { console.log("完了", JSON.stringify(r)); process.exit(r.aborted ? 2 : 0); })
    .catch((e) => { console.error("エラー：" + String(e?.message || e).slice(0, 300)); process.exit(1); });
}
