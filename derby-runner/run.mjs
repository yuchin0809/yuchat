/* =========================================================
   ゆうダービー 自動開催（GitHub Actions から毎日実行）

   毎日 11:30 と 15:02（日本時間）の2回開催。管理者が作った手動レース（derbyManualRaces）も同じように開催する。
   誰もサイトを開いていなくても、開催時刻を過ぎたレースについて
     1. races/{raceId} にレース結果を作る（まだ無ければ）
     2. そのレースの未精算の馬券をすべて精算し、当たった人のコインを増やす
     3. raceLogs/{raceId} に開催ログを残す
     4. 日本時間 13:00 以降の最初の実行で、1日1回の処理（economy.mjs の runDailyJobs）：
        株価の更新・ニュース、預金の利息、返済期限切れの自動返済、追加ボーナス500コイン、総資産ランキング（rankings/assets）
   を行う。読み取りを減らすため、未精算の馬券が無いレースでは馬券を読まない（以前は毎回、過去7日分の全馬券と raceBets 全件を読んでいた）。サイトを開いている利用者の端末も同じ処理を行うが、
   どちらもトランザクションで「まだ無ければ作る」「未精算なら精算する」ので二重にはならない。

   レースの作り方・払い戻しの計算は script.js と同じ（変えるときは両方を直すこと）。

   環境変数：
     FIREBASE_SERVICE_ACCOUNT  サービスアカウントの鍵（JSON）。GitHub Secrets に登録する
     STOCK_SEED_SECRET         ゆう株の株価・ニュースの乱数に使う秘密値（GitHub Secrets。無ければサービスアカウントの鍵から作る）
     FIRESTORE_EMULATOR_HOST   テスト用（Emulator を使うとき）
     DERBY_NOW                 テスト用（現在時刻を ISO 形式で上書き）
     DERBY_WAIT_FOR_RACE       "1" なら、次の開催時刻（11:30 か 15:02）の前に起動したときは開催時刻まで待ってから実行する
                               （GitHub の定期実行は15〜20分ほど遅れるので、早めに起動して待つ）
     GITHUB_STEP_SUMMARY       GitHub Actions が設定する。実行結果の表をここに書き出す
========================================================= */

import fs from "fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { runDailyJobs, getDailyJobTime } from "./economy.mjs";
/* 固定オッズ（script.js と同じファイルを使う） */
import { isFixedOddsRace, buildRaceOddsRecord, generateFixedOddsRaceOrder, computeFixedBetSettlement, FIXED_PAYOUT_RULE } from "../derby-odds.js";

/* ----- script.js と同じ設定 ----- */
const RACE_HOUR = 15;
const RACE_MINUTE = 2;
const RACE_TAKEOUT_RATE = 0.8;
const RACE_SEGMENTS = 48;
const SAFE_RACE_HORSES = [
  { number: 1, name: "ユウウキ", power: 6, style: "start" },
  { number: 2, name: "ユウセイ", power: 7, style: "front" },
  { number: 3, name: "ユウヤン", power: 8, style: "mid" },
  { number: 4, name: "ユウチュウ", power: 5, style: "closer" },
  { number: 5, name: "ユウガ", power: 9, style: "stamina" },
  { number: 6, name: "ユウバエ", power: 4, style: "front" },
  { number: 7, name: "ユウキカイ", power: 6, style: "stamina" },
  { number: 8, name: "ユウマグレ", power: 3, style: "longshot" },
  { number: 9, name: "ユウジン", power: 7, style: "front" },
  { number: 10, name: "ユウシャ", power: 8, style: "closer" }
];

/* 1日2回開催：11:30 の回（raceId は「YYYY-MM-DD-1130」）。15:02 の回の raceId は従来どおり「YYYY-MM-DD」。
   11:30 の回は TWICE_DAILY_FROM の日から（それより前の日にさかのぼって作らない）。script.js と同じ設定にすること */
const MORNING_RACE_HOUR = 11;
const MORNING_RACE_MINUTE = 30;
const MORNING_RACE_SUFFIX = "-1130";
const TWICE_DAILY_FROM = "2026-10-07";

/* 手動レース（特別レース）：raceId は「YYYY-MM-DD-mHHMM」。予定は derbyManualRaces/{raceId}（script.js と同じ） */
const MANUAL_RACE_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-m\d{4}$/;

/* 締切は発走の10分前（script.js・worker.js と同じ） */
const RACE_CLOSE_MINUTES_BEFORE = 10;

/* 不正対策（worker.js と同じ）：
   ・レース結果を作ってよいのはサーバー（この derby-runner と Worker）だけ。SERVER_RESULTS_FROM（レースIDの日付）以降のレースは、
     サーバーが作ったものでない結果を使わず、作り直す（null のあいだは確かめない。Firestore Rules でブラウザからの書き込みを止めるときに日付を入れる）
   ・馬券は、締切までにサーバーの時刻で作られ、中身（券種・馬・金額）が正しいものだけ払う。SERVER_RESULTS_FROM 以降は Worker で買われたもの（placedBy: "worker"）だけ */
const SERVER_RESULTS_FROM = null;
const SERVER_GENERATORS = ["github-actions", "worker"];
const BET_COUNT = { win: 1, place: 1, quinella: 2, trio: 3, trifecta: 3 };
const BET_MIN = 10;
const BET_MAX = 100000000;

export function isTrustedRaceResult(raceId, race, serverResultsFrom = SERVER_RESULTS_FROM) {
  if (!race || !Array.isArray(race.resultOrder) || race.resultOrder.length !== 10) return false;
  if (!serverResultsFrom || String(raceId).slice(0, 10) < serverResultsFrom) return true;
  return SERVER_GENERATORS.includes(race.generatedBy);
}

function timeMillis(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}

export function betRejectReason(bet, closeTime, serverResultsFrom = SERVER_RESULTS_FROM) {
  const horses = bet.horses;
  const shapeOk = Object.prototype.hasOwnProperty.call(BET_COUNT, bet.type)
    && Array.isArray(horses) && horses.length === BET_COUNT[bet.type]
    && horses.every((h) => Number.isInteger(h) && h >= 1 && h <= 10) && new Set(horses).size === horses.length
    && Number.isSafeInteger(bet.amount) && bet.amount >= BET_MIN && bet.amount <= BET_MAX;
  if (!shapeOk) return "invalid_bet";
  const created = timeMillis(bet.createdAt);
  const close = timeMillis(closeTime);
  if (!Number.isFinite(created) || !Number.isFinite(close) || created > close) return "after_close";
  if (serverResultsFrom && String(bet.raceId).slice(0, 10) >= serverResultsFrom && bet.placedBy !== "worker") return "not_server_placed";
  return null;
}

/* 開催時刻は日本時間。何日前までさかのぼって「作られていないレース・未精算の馬券」を処理するか */
const JST_OFFSET_HOURS = 9;
const LOOKBACK_DAYS = 7;

/* 早めに起動したとき、最大でどれだけ開催時刻まで待つか（GitHub Actions の1ジョブは最長6時間） */
const MAX_WAIT_MINUTES = 80;

/* ----- レース結果の生成（script.js と同じ） ----- */

function generateWeightedRaceOrder() {
  const withKey = SAFE_RACE_HORSES.map((h) => {
    const effectivePower = Math.max(0.1, h.power * (0.4 + Math.random() * 1.3));
    const key = Math.pow(Math.random(), 1 / effectivePower);
    return { number: h.number, key };
  });
  withKey.sort((a, b) => b.key - a.key);
  return withKey.map((h) => h.number);
}

function getStyleCurveMultiplier(style, frac) {
  switch (style) {
    case "start": return frac < 0.3 ? 1.5 : (frac < 0.7 ? 1.0 : 0.7);
    case "front": return frac < 0.5 ? 1.25 : 0.9;
    case "mid": return frac < 0.3 ? 0.8 : (frac < 0.75 ? 1.2 : 1.1);
    case "closer": return frac < 0.6 ? 0.65 : 1.6;
    case "stamina": return 1.0;
    case "longshot": return 0.5 + Math.random() * 1.3;
    default: return 1.0;
  }
}

function buildRaceCheckpoints(resultOrder) {
  const gapStep = 0.015 + Math.random() * 0.025;
  const finalProgress = {};

  resultOrder.forEach((horseNumber, rankIndex) => {
    finalProgress[horseNumber] = Math.max(0.7, 1 - rankIndex * gapStep);
  });
  finalProgress[resultOrder[0]] = 1;

  const rawWeights = {};
  SAFE_RACE_HORSES.forEach((h) => {
    rawWeights[h.number] = Array.from({ length: RACE_SEGMENTS }, (_, s) => {
      const frac = s / RACE_SEGMENTS;
      return getStyleCurveMultiplier(h.style, frac) * (0.3 + Math.random());
    });
  });

  SAFE_RACE_HORSES.forEach((h) => {
    const total = rawWeights[h.number].reduce((a, b) => a + b, 0);
    const scale = finalProgress[h.number] / total;
    rawWeights[h.number] = rawWeights[h.number].map((w) => w * scale);
  });

  const cumulative = {};
  SAFE_RACE_HORSES.forEach((h) => { cumulative[h.number] = 0; });

  const checkpoints = [];
  for (let s = 0; s < RACE_SEGMENTS; s++) {
    const frame = {};
    SAFE_RACE_HORSES.forEach((h) => {
      cumulative[h.number] += rawWeights[h.number][s];
      frame[h.number] = Math.min(1, Number(cumulative[h.number].toFixed(4)));
    });
    checkpoints.push(frame);
  }

  return checkpoints;
}

function formatRaceTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function getMarginLabel(gapSeconds) {
  if (gapSeconds < 0.05) return "ハナ";
  if (gapSeconds < 0.12) return "アタマ";
  if (gapSeconds < 0.2) return "クビ";
  if (gapSeconds < 0.35) return "1/2馬身";
  if (gapSeconds < 0.55) return "3/4馬身";
  if (gapSeconds < 0.8) return "1馬身";
  if (gapSeconds < 1.2) return "1馬身1/2";
  if (gapSeconds < 1.8) return "2馬身";
  return `${Math.round(gapSeconds / 0.8)}馬身`;
}

function buildFinishStats(resultOrder) {
  let currentSeconds = 116 + Math.random() * 10;
  const stats = [{ number: resultOrder[0], seconds: currentSeconds, gapSeconds: 0 }];

  for (let i = 1; i < resultOrder.length; i++) {
    const gapSeconds = 0.05 + Math.random() * 0.55;
    currentSeconds += gapSeconds;
    stats.push({ number: resultOrder[i], seconds: currentSeconds, gapSeconds });
  }

  return stats.map((s, index) => ({
    number: s.number,
    timeText: formatRaceTime(s.seconds),
    marginText: index === 0 ? "" : getMarginLabel(s.gapSeconds)
  }));
}

/* ----- 的中判定・払い戻し（script.js と同じ） ----- */

function evaluateBetWin(bet, resultOrder) {
  const top1 = resultOrder[0], top2 = resultOrder[1], top3 = resultOrder[2];
  const top3set = [top1, top2, top3];
  const horses = bet.horses || [];

  if (bet.type === "win") return horses[0] === top1;
  if (bet.type === "place") return top3set.includes(horses[0]);

  if (bet.type === "quinella") {
    if (horses.length !== 2) return false;
    const a = [...horses].sort((x, y) => x - y);
    const b = [top1, top2].sort((x, y) => x - y);
    return a[0] === b[0] && a[1] === b[1];
  }

  if (bet.type === "trio") {
    if (horses.length !== 3) return false;
    const a = [...horses].sort((x, y) => x - y);
    const b = [...top3set].sort((x, y) => x - y);
    return a.every((n, i) => n === b[i]);
  }

  if (bet.type === "trifecta") {
    return horses.length === 3 && horses[0] === top1 && horses[1] === top2 && horses[2] === top3;
  }

  return false;
}

/* パリミュチュエル方式：同じ券種の賭け金の合計 × 0.8 を、当たった人で賭け金に応じて分ける */
function computePayouts(allBets, resultOrder) {
  const pools = {};
  allBets.forEach((bet) => {
    const pool = pools[bet.type] || (pools[bet.type] = { total: 0, winning: 0 });
    const amount = Number(bet.amount || 0);
    pool.total += amount;
    if (evaluateBetWin(bet, resultOrder)) pool.winning += amount;
  });

  const payouts = {};
  allBets.forEach((bet) => {
    const pool = pools[bet.type];
    const isWin = evaluateBetWin(bet, resultOrder);
    const payout = isWin && pool.winning > 0
      ? Math.floor((Number(bet.amount || 0) / pool.winning) * pool.total * RACE_TAKEOUT_RATE)
      : 0;
    payouts[bet.id] = { isWin, payout };
  });
  return payouts;
}

/* ----- 日付（日本時間） ----- */

/* その日（日本時間）に開催されるレースの raceId と開催時刻（開催時刻の早い順）
   ・11:30 の回：「YYYY-MM-DD-1130」（TWICE_DAILY_FROM の日から）
   ・15:02 の回：「YYYY-MM-DD」（従来どおり） */
export function getRacesForJstDay(now, daysAgo) {
  const jst = new Date(now.getTime() + JST_OFFSET_HOURS * 3600 * 1000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth(), d = jst.getUTCDate() - daysAgo;
  const day = new Date(Date.UTC(y, m, d));
  const dayId = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, "0")}-${String(day.getUTCDate()).padStart(2, "0")}`;
  const at = (hour, minute) => new Date(Date.UTC(y, m, d, hour - JST_OFFSET_HOURS, minute, 0, 0));

  const races = [];
  if (dayId >= TWICE_DAILY_FROM) races.push({ raceId: `${dayId}${MORNING_RACE_SUFFIX}`, raceTime: at(MORNING_RACE_HOUR, MORNING_RACE_MINUTE) });
  races.push({ raceId: dayId, raceTime: at(RACE_HOUR, RACE_MINUTE) });
  races.forEach((race) => { race.closeTime = new Date(race.raceTime.getTime() - RACE_CLOSE_MINUTES_BEFORE * 60000); });
  return races;
}

/* ----- 処理本体 ----- */

async function ensureRaceResult(db, raceId, raceTime) {
  const raceRef = db.collection("races").doc(raceId);
  let created = false;

  /* すでに（サーバーが作った）結果があれば、それを使う（読み取り1回。トランザクションと読み直しを省く） */
  const existing = await raceRef.get();
  if (existing.exists && isTrustedRaceResult(raceId, existing.data())) return { created, race: existing.data() };

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(raceRef);
    created = false;
    if (snap.exists && isTrustedRaceResult(raceId, snap.data())) return;

    /* 固定オッズ方式のレースは「能力 × 当日の調子」の比で着順を決め、オッズの記録も残す（乱数は今ここで引く） */
    const fixed = isFixedOddsRace(raceId);
    const resultOrder = fixed ? generateFixedOddsRaceOrder(raceId) : generateWeightedRaceOrder();
    transaction.set(raceRef, {
      raceId,
      resultOrder,
      checkpoints: buildRaceCheckpoints(resultOrder),
      finishStats: buildFinishStats(resultOrder),
      status: "finished",
      generatedAt: FieldValue.serverTimestamp(),
      generatedBy: "github-actions",
      ...(fixed ? buildRaceOddsRecord(raceId) : {})
    });
    transaction.set(db.collection("raceLogs").doc(raceId), {
      raceId,
      scheduledAt: Timestamp.fromDate(raceTime),
      resultGeneratedAt: FieldValue.serverTimestamp(),
      resultGeneratedBy: "github-actions",
      resultGeneratedDelaySeconds: Math.round((Date.now() - raceTime.getTime()) / 1000),
      resultStatus: snap.exists ? "regenerated" : "created"
    }, { merge: true });
    created = true;
  });

  const snap = await raceRef.get();
  return { created, race: snap.data() };
}

async function settleRaceBets(db, raceId, resultOrder, closeTime) {
  /* 未精算の馬券が無いレースは、そのレースの馬券を読まない（読み取り1回で終わる）。
     山分け方式のレースは、払い戻しの計算にそのレースの全馬券（賭け金の合計）が要るので、未精算があるときだけ全部読む。
     固定オッズ方式のレースは floor(賭け金 × オッズ) なので、未精算の馬券だけを読む（馬券の数は集計クエリで数える） */
  const fixed = isFixedOddsRace(raceId);
  const unsettledSnap = await db.collection("raceBets").where("raceId", "==", raceId).where("settled", "==", false).limit(fixed ? 1000 : 1).get();
  if (unsettledSnap.empty) return { betsTotal: null, settledNow: 0, payoutTotal: 0, errors: [], unsettledRemaining: 0 };

  let betsToSettle, payouts, betsTotal;
  if (fixed) {
    betsToSettle = unsettledSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    payouts = {};
    for (const bet of betsToSettle) {
      /* 締切後に作られた・中身が正しくない馬券は払わない（外れとして精算し、理由を残す） */
      const reject = betRejectReason(bet, closeTime);
      payouts[bet.id] = reject
        ? { isWin: false, payout: 0, oddsTenths: computeFixedBetSettlement(bet, raceId, false).oddsTenths, rejectedReason: reject }
        : computeFixedBetSettlement(bet, raceId, evaluateBetWin(bet, resultOrder));
    }
    betsTotal = (await db.collection("raceBets").where("raceId", "==", raceId).count().get()).data().count;
  } else {
    const betsSnap = await db.collection("raceBets").where("raceId", "==", raceId).get();
    const allBets = betsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    payouts = computePayouts(allBets, resultOrder);
    betsToSettle = allBets.filter((b) => !b.settled);
    betsTotal = allBets.length;
  }

  const result = { betsTotal, settledNow: 0, payoutTotal: 0, errors: [] };

  for (const bet of betsToSettle) {
    const { isWin, payout, oddsTenths, rejectedReason } = payouts[bet.id];
    try {
      let settledNow = false;
      await db.runTransaction(async (transaction) => {
        settledNow = false;
        const betRef = db.collection("raceBets").doc(bet.id);
        const fresh = await transaction.get(betRef);
        /* 名前を変えても uid は変わらないので、uid でユーザーを探す */
        const userQuery = payout > 0 && bet.uid
          ? await transaction.get(db.collection("users").where("uid", "==", bet.uid).limit(1))
          : null;

        if (!fresh.exists || fresh.data().settled) return;
        if (payout > 0 && (!userQuery || userQuery.empty)) throw new Error(`USER_NOT_FOUND uid=${bet.uid}`);

        transaction.update(betRef, fixed
          ? { settled: true, win: isWin, payout, settledBy: "github-actions", payoutRule: FIXED_PAYOUT_RULE, settledOddsTenths: oddsTenths, ...(rejectedReason ? { rejectedReason } : {}) }
          : { settled: true, win: isWin, payout, settledBy: "github-actions" });
        if (payout > 0) transaction.update(userQuery.docs[0].ref, { coins: FieldValue.increment(payout) });
        settledNow = true;
      });
      if (settledNow) {
        result.settledNow++;
        result.payoutTotal += payout;
      }
    } catch (error) {
      result.errors.push(`bet ${bet.id}: ${error.message || error}`);
    }
  }

  const remaining = await db.collection("raceBets").where("raceId", "==", raceId).where("settled", "==", false).get();
  result.unsettledRemaining = remaining.size;
  return result;
}

/* 開催時刻を過ぎた手動レース（キャンセルされていないもの）。開催時刻は保存された raceAt を使う */
export async function getDueManualRaces(db, now, lookbackDays = LOOKBACK_DAYS) {
  const since = new Date(now.getTime() - (lookbackDays + 1) * 24 * 3600 * 1000);
  const snap = await db.collection("derbyManualRaces").where("raceAt", ">=", Timestamp.fromDate(since)).get();
  return snap.docs
    .filter((d) => MANUAL_RACE_ID_PATTERN.test(d.id) && d.data().status !== "cancelled" && d.data().raceAt)
    .map((d) => ({ raceId: d.id, raceTime: d.data().raceAt.toDate(), closeTime: d.data().closeAt?.toDate?.() || null }))
    .filter((race) => race.raceTime <= now);
}

export async function runDerby({ db, now = new Date(), lookbackDays = LOOKBACK_DAYS, log = console.log }) {
  const summary = [];

  /* 自動開催の回（11:30・15:02）と手動レースを、開催時刻の順に処理する */
  const races = [];
  for (let daysAgo = lookbackDays; daysAgo >= 0; daysAgo--) {
    for (const race of getRacesForJstDay(now, daysAgo)) {
      if (now < race.raceTime) continue; /* まだ開催時刻になっていない */
      races.push(race);
    }
  }
  races.push(...await getDueManualRaces(db, now, lookbackDays));
  races.sort((a, b) => a.raceTime - b.raceTime);

  for (const { raceId, raceTime, closeTime } of races) {
    const logRef = db.collection("raceLogs").doc(raceId);
    const entry = { raceId, status: "ok" };

    try {
      const { created, race } = await ensureRaceResult(db, raceId, raceTime);
      entry.result = created ? "created" : `exists(${race.generatedBy || "client"})`;

      const settle = await settleRaceBets(db, raceId, race.resultOrder, closeTime);
      Object.assign(entry, settle);
      if (settle.errors.length) entry.status = "error";

      await logRef.set({
        raceId,
        scheduledAt: Timestamp.fromDate(raceTime),
        lastRunnerRunAt: FieldValue.serverTimestamp(),
        lastRunnerStatus: entry.status,
        lastRunnerError: settle.errors.join("\n").slice(0, 1500) || null,
        ...(settle.betsTotal === null ? {} : { betsTotal: settle.betsTotal }), /* 馬券を読まなかったときは前の値のまま */
        betsSettledByRunner: FieldValue.increment(settle.settledNow),
        payoutTotalByRunner: FieldValue.increment(settle.payoutTotal),
        unsettledAfterRun: settle.unsettledRemaining
      }, { merge: true });
    } catch (error) {
      entry.status = "error";
      entry.error = error.message || String(error);
      try {
        await logRef.set({
          raceId,
          scheduledAt: Timestamp.fromDate(raceTime),
          lastRunnerRunAt: FieldValue.serverTimestamp(),
          lastRunnerStatus: "error",
          lastRunnerError: entry.error.slice(0, 1500)
        }, { merge: true });
      } catch (logError) {
        entry.logError = logError.message || String(logError);
      }
    }

    log(JSON.stringify(entry));
    summary.push(entry);
  }

  return summary;
}

export function getWaitMillisUntilTodayRace(now) {
  const next = getRacesForJstDay(now, 0).find((race) => race.raceTime > now);
  if (!next) return 0;
  const wait = next.raceTime.getTime() - now.getTime();
  if (wait <= 0 || wait > MAX_WAIT_MINUTES * 60 * 1000) return 0;
  return wait + 2000; /* 開催時刻ちょうど＋2秒 */
}

/* 1日1回の処理（13:00）の前に起動したときの待ち時間（80分より先なら待たない） */
export function getWaitMillisUntilDailyJob(now) {
  const wait = getDailyJobTime(now).getTime() - now.getTime();
  if (wait <= 0 || wait > MAX_WAIT_MINUTES * 60 * 1000) return 0;
  return wait + 2000; /* 13:00 ちょうど＋2秒 */
}

function writeStepSummary(summary, startedAt, finishedAt, dailyResult) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const jst = (d) => new Date(d.getTime() + JST_OFFSET_HOURS * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " JST";
  const rows = summary.map((e) =>
    `| ${e.raceId} | ${e.status === "ok" ? "✅" : "❌"} | ${e.result || "-"} | ${e.betsTotal ?? "-"} | ${e.settledNow ?? "-"} | ${e.payoutTotal ?? "-"} | ${e.unsettledRemaining ?? "-"} | ${(e.error || (e.errors || []).join(" / ") || "").replace(/\|/g, "/")} |`);
  const text = [
    "## ゆうダービー自動開催",
    `起動 ${jst(startedAt)} ／ 完了 ${jst(finishedAt)}`,
    "",
    "| レース | 状態 | 結果 | 馬券 | 今回精算 | 払戻計 | 未精算 | エラー |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    ...(dailyResult && dailyResult.status !== "skipped" ? [
      `### 1日1回の処理（${dailyResult.date} 13:00）`,
      `株価 ${dailyResult.marketUpdated ? `更新（秘密値：${dailyResult.stockSeedSource === "STOCK_SEED_SECRET" ? "STOCK_SEED_SECRET" : "サービスアカウントの鍵から作った値"}）` : "更新済み"} ／ ニュース ${(dailyResult.news || []).map((n) => `${n.code}${n.kind === "good" ? "↑" : "↓"}`).join(" ") || "なし"}` +
        ` ／ 急騰・暴落 ${(dailyResult.events || []).map((e) => `${e.code}${e.kind === "surge" ? "急騰" : "暴落"}`).join(" ") || "なし"}`,
      `ユーザー ${dailyResult.users} 人 ／ 利息 ${dailyResult.interestUsers} 人（計 ${dailyResult.interestTotal}） ／ 期限切れの自動返済 ${dailyResult.autoRepaid} 人（計 ${dailyResult.autoRepaidTotal}）` +
        ` ／ 追加ボーナス ${dailyResult.bonusGranted} 人 ／ 総資産ランキング ${dailyResult.rankingUsers ?? "-"} 人` +
        (dailyResult.errors.length ? ` ／ ❌ エラー: ${dailyResult.errors.join(" / ").replace(/\|/g, "/").slice(0, 1500)}` : ""),
      ""
    ] : dailyResult ? [`### 1日1回の処理：${dailyResult.reason || "なし"}`, ""] : [])
  ].join("\n");
  fs.appendFileSync(file, text);
}

/* ----- GitHub Actions から直接実行されたとき ----- */

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountJson && !process.env.FIRESTORE_EMULATOR_HOST) {
    console.error("FIREBASE_SERVICE_ACCOUNT が設定されていません（GitHub の Settings → Secrets and variables → Actions で登録してください）");
    process.exit(1);
  }

  if (serviceAccountJson) {
    initializeApp({ credential: cert(JSON.parse(serviceAccountJson)) });
  } else {
    initializeApp({ projectId: process.env.GCLOUD_PROJECT || "demo-yuuchat" });
  }

  const startedAt = new Date();
  let now = process.env.DERBY_NOW ? new Date(process.env.DERBY_NOW) : new Date();
  console.log(`ゆうダービー自動開催 起動 now=${now.toISOString()}`);

  /* 開催時刻まで待つ前に、すでに過ぎた回（例：15:02 を待つ間の 11:30）を先に開催・精算しておく */
  const earlierSummary = [];
  if (process.env.DERBY_WAIT_FOR_RACE === "1" && !process.env.DERBY_NOW) {
    /* 次のレース（11:30・15:02）か、1日1回の処理（13:00）の、近い方まで待つ */
    const waits = [getWaitMillisUntilTodayRace(now), getWaitMillisUntilDailyJob(now)].filter((w) => w > 0);
    const wait = waits.length ? Math.min(...waits) : 0;
    if (wait > 0) {
      earlierSummary.push(...await runDerby({ db: getFirestore(), now }));
      console.log(`開催時刻（または 13:00）まで ${Math.round(wait / 1000)} 秒待ちます`);
      await new Promise((resolve) => setTimeout(resolve, wait));
      now = new Date();
      console.log(`時刻になりました now=${now.toISOString()}`);
    }
  }

  /* 待つ前に作ったレースは、結果の表で「created(開催時刻を待つ前)」と分かるようにする */
  const createdBeforeWait = new Set(earlierSummary.filter((e) => e.result === "created").map((e) => e.raceId));
  const summary = [
    ...earlierSummary.filter((e) => e.status !== "ok"),
    ...(await runDerby({ db: getFirestore(), now })).map((e) => (createdBeforeWait.has(e.raceId) ? { ...e, result: "created(開催時刻を待つ前)" } : e))
  ];

  /* 1日1回の処理（13:00 以降の最初の実行だけ）は、レースの開催・精算が終わってから行う（失敗してもレースの処理には影響しない）。
     13:00 を過ぎてから起動したときは、すぐに行う */
  let dailyResult;
  try {
    dailyResult = await runDailyJobs({ db: getFirestore(), now: process.env.DERBY_NOW ? now : new Date() });
  } catch (error) {
    dailyResult = { date: "", status: "error", users: 0, interestUsers: 0, interestTotal: 0, autoRepaid: 0, autoRepaidTotal: 0, bonusGranted: 0, errors: [error.message || String(error)] };
    console.error("1日1回の処理のエラー:", error);
  }

  writeStepSummary(summary, startedAt, new Date(), dailyResult);
  const failed = summary.filter((e) => e.status !== "ok");
  if (failed.length || dailyResult.status === "error") {
    if (failed.length) console.error(`失敗したレース: ${failed.map((e) => e.raceId).join(", ")}`);
    if (dailyResult.status === "error") console.error(`1日1回の処理のエラー: ${dailyResult.errors.join(" / ")}`);
    process.exit(1); /* Actions の実行が「失敗」になり、GitHub からメールで気づける */
  }
}
