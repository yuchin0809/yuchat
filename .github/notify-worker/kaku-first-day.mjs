/* =========================================================
   🌈 ゆうスロ「確変台」初日（2026-10-20）の準備（GitHub Actions の手動実行から、サービスアカウントで実行する）

   1. 初日の確変台のドキュメント（yuslotKaku/2026-10-20）を作る（前日の抽選の締切後なので「当日分だけ」の日になる）
   2. 「確変台が登場！明日の確変台は…」のお知らせ（📢）を投稿する。プッシュ通知は送らない（夜遅いので）

   安全策（冪等）：ドキュメントとお知らせは固定IDで、すでにあれば作らない。何度実行しても安全。
========================================================= */
import { createDefaultDeps, kakuEnsureDay, kakuMachineFor, KAKU_MACHINE_NAMES, KAKU_EPOCH } from "../../notify-worker/worker.js";

const EXPECTED_PROJECT_ID = "yuuchat-be666";
export const ANNOUNCE_ID = "kaku-open-2026-10-20";
export const ANNOUNCE_TITLE = (machine) => `🌈 ゆうスロに「確変台」が登場！明日は「${machine}」`;
export const announceBody = (machine) => [
  "ゆうスロに、毎日どこか1台、当たりの確率がグンと上がる「確変台」が登場します！🌈",
  "",
  "・確変台は前日に発表。8:00〜15:20の間、抽選か先着で枠をとった人だけが遊べます。",
  "・申込は無料。ゆうスロの台の一覧の上の「確変台チケット売り場」から申し込めます（通知の設定もそこで）。",
  "",
  `【明日 10/20 の確変台】${machine}`,
  "明日は初日のため、12:30〜13:20の10分枠（抽選3枠・先着2枠）だけの発売です。抽選の申込は 7:00〜10:45、先着は 11:45 から！",
  "",
  "（あさってからは、前日12:00に確変台を発表して、21:00までに申し込む抽選も始まります）"
].join("\n");

export async function run({ deps, log = console.log } = {}) {
  const day = KAKU_EPOCH;
  const machine = KAKU_MACHINE_NAMES[kakuMachineFor(day)];
  await kakuEnsureDay(deps, day);
  log(`✓ 初日（${day}）の確変台のドキュメントを用意しました：${machine}`);
  const now = new Date(deps.now());
  const announced = await deps.firestore.createIfAbsent(`announcements/${ANNOUNCE_ID}`, {
    title: ANNOUNCE_TITLE(machine), body: announceBody(machine), createdAt: now, updatedAt: now, createdByUid: "github-actions", createdByName: "ゆうChat自動更新"
  });
  log(announced ? `✓ お知らせを投稿しました（announcements/${ANNOUNCE_ID}。プッシュ通知は送りません）` : "・お知らせはすでにあります（作成しません）");
  return { day, machine, announced };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (sa.project_id !== EXPECTED_PROJECT_ID) { console.error("サービスアカウントのプロジェクトが違います"); process.exit(1); }
  const deps = createDefaultDeps({ FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT, FIREBASE_PROJECT_ID: EXPECTED_PROJECT_ID });
  run({ deps })
    .then((r) => { console.log("完了", JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error("エラー：" + String(e?.message || e).slice(0, 300)); process.exit(1); });
}
