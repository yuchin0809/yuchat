/* =========================================================
   ゆうChat Cloud Functions（v2）
   Firestore → Cloud Functions → FCM → firebase-messaging-sw.js → システム通知

   デプロイ：firebase deploy --only functions
   （Hosting / Firestore ルールはこのリポジトリでは管理しないので、ここには書かない）
========================================================= */

const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");

const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const notifications = require("./notifications");

/* Firestore トリガーの関数は、Firestore データベースと同じリージョンに置く必要がある。
   Firebase コンソール → Firestore → データベースの「ロケーション」を確認して合わせること。
   （例：東京なら asia-northeast1。マルチリージョン nam5 なら us-central1） */
const REGION = "asia-northeast1";

/* ゆうダービーの開催時刻（script.js の RACE_HOUR = 15 / RACE_MINUTE = 2 と合わせる）。
   アプリは端末の時刻で動くので、利用者の多い日本時間を基準にする */
const DERBY_TIME_ZONE = "Asia/Tokyo";
const DERBY_SCHEDULE = "2 15 * * *";

setGlobalOptions({ region: REGION, maxInstances: 10 });

initializeApp();

function getDeps() {
  return {
    db: getFirestore(),
    messaging: getMessaging(),
    serverTimestamp: () => FieldValue.serverTimestamp(),
    logger
  };
}

/* 1. 新しいメッセージ */
exports.notifyNewMessage = onDocumentCreated("messages/{messageId}", async (event) => {
  const message = event.data?.data();
  if (!message) return;

  const result = await notifications.handleNewMessage(getDeps(), event.params.messageId, message);
  logger.info("メッセージ通知", { messageId: event.params.messageId, ...result, invalidTokens: result.invalidTokens?.length });
});

/* 2. ゲーム招待（pending になった瞬間だけ。辞退後の再招待も含む） */
exports.notifyGameInvite = onDocumentWritten("gameInvites/{inviteId}", async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;

  const result = await notifications.handleGameInviteWrite(getDeps(), event.params.inviteId, before, after);
  if (!result.skipped) {
    logger.info("ゲーム招待通知", { inviteId: event.params.inviteId, ...result, invalidTokens: result.invalidTokens?.length });
  }
});

/* 3. ゆうダービー開催（毎日決まった時刻。Cloud Scheduler を使う） */
exports.notifyDerbyStart = onSchedule(
  { schedule: DERBY_SCHEDULE, timeZone: DERBY_TIME_ZONE, retryCount: 0 },
  async () => {
    const raceId = notifications.getRaceIdForDate(new Date(), DERBY_TIME_ZONE);
    const result = await notifications.handleDerbyStart(getDeps(), raceId);
    logger.info("ゆうダービー開催通知", { raceId, ...result, invalidTokens: result.invalidTokens?.length });
  }
);
