/* =========================================================
   ゆうダービー：レース演出（見せ方）専用モジュール

   【役割の分離】
   ・レース結果（着順 resultOrder・途中経過 checkpoints・タイム finishStats）を決めるのは
     script.js / derby-runner の既存処理だけ。このファイルは結果を一切決めない・変えない。
   ・ここでは「すでに決まった結果」を受け取り、
       1. 全馬がその着順どおりにゴールするまでの動き（buildRaceShow）
       2. その動きと矛盾しない実況（commentaryAt）
       3. カメラワーク・遠近感のある描画（createRaceStage）
     を作るだけ。Firebase には触らない（読み書きしない）。
   ・同じレースなら、どの端末・何度再生しても同じ展開・同じ実況になる（乱数は raceId から作る）。
========================================================= */

/* 既存の結果データ（checkpoints）は「発走から60秒で1着馬がゴール」する形で保存されている */
export const RACE_MAIN_SECONDS = 60;
/* 1着のあと、残りの馬が着順どおりにゴールし終えるまでの最長時間（秒） */
export const RACE_TAIL_MAX_SECONDS = 14;
/* 最後の馬がゴールしてから「レース終了」→結果表示までの間（秒） */
export const RACE_RESULT_DELAY_SECONDS = 3;
/* 演出全体の最長時間（カウントダウンの「レース中」表示などに使う） */
export const RACE_SHOW_MAX_SECONDS = RACE_MAIN_SECONDS + RACE_TAIL_MAX_SECONDS + RACE_RESULT_DELAY_SECONDS;

const STRAIGHT_START_SECONDS = RACE_MAIN_SECONDS * 0.7;
/* ラスト200m（最後の直線の終盤）に入る時刻。実況・カメラ・音・字幕が、ここから盛り上がる */
export const RACE_FINAL_SECONDS = RACE_MAIN_SECONDS * 0.85;
/* 1着と2着のゴールがこの秒数以内なら「写真判定」の演出にする */
export const PHOTO_FINISH_GAP_SECONDS = 1.0;   // 実際のレースの1割ほどが、この僅差
const MIN_FINISH_GAP_SECONDS = 0.3;
const CLOSE_GAP = 0.012;

/* ----- 決まった乱数（raceId から作るので、誰が見ても同じ） ----- */

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function createSeededRandom(seedText) {
  let a = hashString(String(seedText || "yuu-derby")) || 1;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ----- 保存されている途中経過（checkpoints）から、ある時刻の位置を求める
         （script.js の getHorseProgressAt と同じ計算） ----- */

function interpolateCheckpoints(checkpoints, numbers, t) {
  const result = {};
  numbers.forEach((n) => { result[n] = 0; });
  if (!checkpoints.length || t <= 0) return result;

  const segDuration = RACE_MAIN_SECONDS / checkpoints.length;
  if (t >= RACE_MAIN_SECONDS) {
    const last = checkpoints[checkpoints.length - 1];
    numbers.forEach((n) => { result[n] = Number(last[n]) || 0; });
    return result;
  }

  const rawIndex = t / segDuration;
  const idx = Math.floor(rawIndex);
  const frac = rawIndex - idx;
  const prev = idx === 0 ? null : checkpoints[idx - 1];
  const curr = checkpoints[idx] || checkpoints[checkpoints.length - 1];
  numbers.forEach((n) => {
    const prevVal = prev ? Number(prev[n]) || 0 : 0;
    const currVal = curr[n] !== undefined ? Number(curr[n]) || 0 : prevVal;
    result[n] = prevVal + (currVal - prevVal) * frac;
  });
  return result;
}

/* 古いデータなどで checkpoints が無いときだけ使う「着順どおりに進む」途中経過（保存はしない） */
function synthesizeCheckpoints(resultOrder, numbers, random) {
  const segments = 48;
  const finalProgress = {};
  resultOrder.forEach((n, rank) => { finalProgress[n] = rank === 0 ? 1 : Math.max(0.72, 1 - rank * 0.025); });

  const weights = {};
  numbers.forEach((n) => {
    const w = Array.from({ length: segments }, () => 0.4 + random());
    const total = w.reduce((a, b) => a + b, 0);
    weights[n] = w.map((x) => (x / total) * finalProgress[n]);
  });

  const cumulative = {};
  numbers.forEach((n) => { cumulative[n] = 0; });
  const checkpoints = [];
  for (let s = 0; s < segments; s++) {
    const frame = {};
    numbers.forEach((n) => {
      cumulative[n] += weights[n][s];
      frame[n] = Math.min(1, cumulative[n]);
    });
    checkpoints.push(frame);
  }
  return checkpoints;
}

/* =========================================================
   レース演出の組み立て（結果 → 全馬ゴールまでの動き・実況）
========================================================= */

export function buildRaceShow(raceData, { horses, raceId }) {
  const numbers = horses.map((h) => h.number);
  const nameOf = (n) => horses.find((h) => h.number === n)?.name || `${n}番`;

  /* 着順は保存されているものをそのまま使う（欠けている馬がいれば最後尾に並べるだけ） */
  const resultOrder = [];
  (Array.isArray(raceData?.resultOrder) ? raceData.resultOrder : []).forEach((n) => {
    const num = Number(n);
    if (numbers.includes(num) && !resultOrder.includes(num)) resultOrder.push(num);
  });
  numbers.forEach((n) => { if (!resultOrder.includes(n)) resultOrder.push(n); });
  const rankOf = {};
  resultOrder.forEach((n, i) => { rankOf[n] = i; });

  const random = createSeededRandom(`${raceId || raceData?.raceId || ""}|${resultOrder.join("-")}`);
  const hasCheckpoints = Array.isArray(raceData?.checkpoints) && raceData.checkpoints.length > 0;
  const checkpoints = hasCheckpoints ? raceData.checkpoints : synthesizeCheckpoints(resultOrder, numbers, random);

  /* 1着がゴールした瞬間（60秒）の各馬の位置 */
  const atMainEnd = interpolateCheckpoints(checkpoints, numbers, RACE_MAIN_SECONDS);

  /* ゴール後半の速さ：1着馬の最後の区間の速さを基準にする */
  const segDuration = RACE_MAIN_SECONDS / checkpoints.length;
  const winner = resultOrder[0];
  const lastFrame = checkpoints[checkpoints.length - 1] || {};
  const prevFrame = checkpoints[checkpoints.length - 2] || {};
  const winnerSpeed = ((Number(lastFrame[winner]) || 0) - (Number(prevFrame[winner]) || 0)) / segDuration;
  const tailSpeed = Math.min(0.03, Math.max(0.014, Number.isFinite(winnerSpeed) && winnerSpeed > 0 ? winnerSpeed : 0.02));

  /* 各馬のゴール時刻：着順どおりに必ず増えていく（同着・順位の入れ替わりは起きない） */
  const finishTimes = {};
  let previous = -Infinity;
  resultOrder.forEach((n, rank) => {
    const remaining = Math.max(0, 1 - Math.min(1, atMainEnd[n]));
    let time = RACE_MAIN_SECONDS + remaining / tailSpeed;
    if (rank > 0) time = Math.max(time, previous + MIN_FINISH_GAP_SECONDS);
    finishTimes[n] = time;
    previous = time;
  });
  const lastRaw = finishTimes[resultOrder[resultOrder.length - 1]];
  if (lastRaw - RACE_MAIN_SECONDS > RACE_TAIL_MAX_SECONDS) {
    const firstExtra = finishTimes[winner] - RACE_MAIN_SECONDS;
    const factor = (RACE_TAIL_MAX_SECONDS - firstExtra) / (lastRaw - RACE_MAIN_SECONDS - firstExtra);
    resultOrder.forEach((n, rank) => {
      if (rank === 0) return;
      finishTimes[n] = finishTimes[winner] + (finishTimes[n] - finishTimes[winner]) * factor;
    });
  }
  const endTime = finishTimes[resultOrder[resultOrder.length - 1]];
  const revealTime = endTime + RACE_RESULT_DELAY_SECONDS;

  /* ある時刻の位置（0=スタート、1=ゴール。ゴール後は少しだけ先へ流れて止まる） */
  function positionOf(n, t) {
    if (t <= 0) return 0;
    const finishAt = finishTimes[n];
    if (t >= finishAt) return 1 + 0.07 * (1 - Math.exp(-(t - finishAt) / 1.6));
    if (t <= RACE_MAIN_SECONDS) return Math.min(interpolateCheckpoints(checkpoints, [n], t)[n], 0.9995);
    const start = Math.min(atMainEnd[n], 0.9995);
    return start + (1 - start) * ((t - RACE_MAIN_SECONDS) / (finishAt - RACE_MAIN_SECONDS));
  }

  function positionsAt(t) {
    const result = {};
    numbers.forEach((n) => { result[n] = positionOf(n, t); });
    return result;
  }

  /* 順位：ゴールした馬は着順どおり、走っている馬は前にいる順（同じ位置なら着順が上の馬を前に） */
  function standingsAt(t) {
    return numbers
      .map((n) => ({ number: n, name: nameOf(n), progress: positionOf(n, t), finished: t >= finishTimes[n] }))
      .sort((a, b) => {
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.finished) return rankOf[a.number] - rankOf[b.number];
        if (b.progress !== a.progress) return b.progress - a.progress;
        return rankOf[a.number] - rankOf[b.number];
      });
  }

  function phaseAt(t) {
    if (t < 0) return "gate";
    if (t < 2) return "start";
    if (t < RACE_MAIN_SECONDS) {
      const frac = t / RACE_MAIN_SECONDS;
      if (frac < 0.22) return "early";
      if (frac < 0.48) return "mid";
      if (frac < 0.7) return "late";
      if (frac < 0.85) return "straight";
      return "finishing";
    }
    if (t < endTime) return "goal";
    if (t < revealTime) return "finished";
    return "results";
  }

  /* ----- 実況（決まった展開から作る。表示するときも毎回、今の順位と合っているか確かめる） ----- */

  const label = (n) => `${n}番${nameOf(n)}`;
  const pick = (list) => list[Math.floor(random() * list.length)];

  function claimHolds(claim, t) {
    const st = standingsAt(t);
    const rank = (n) => st.findIndex((s) => s.number === n);
    switch (claim.type) {
      case "leader": return st[0]?.number === claim.horse;
      case "second": return st[1]?.number === claim.horse;
      case "ahead": return rank(claim.horses[0]) < rank(claim.horses[1]);
      case "close": {
        const [a, b] = claim.horses;
        const top = [st[0]?.number, st[1]?.number];
        if (!top.includes(a) || !top.includes(b)) return false;
        if (st[0].finished || st[1].finished) return false;
        return Math.abs(st[0].progress - st[1].progress) < CLOSE_GAP;
      }
      case "rankAtMost": return rank(claim.horse) >= 0 && rank(claim.horse) + 1 <= claim.rank;
      case "leadGap": return st[0]?.number === claim.horse && (st[0].finished || st[0].progress - st[1].progress > claim.gap);
      case "finished": return claim.horses.every((n) => t >= finishTimes[n]);
      case "before": return t < claim.time;
      case "after": return t >= claim.time;
      default: return false;
    }
  }

  const rawEvents = [];
  const addEvent = (time, text, claims = [], kind = "status") => rawEvents.push({ time, text, claims, kind });

  addEvent(0, pick(["スタートしました！", "ゲートが開いた！各馬いっせいにスタート！", "さあスタート！"]), [{ type: "before", time: 6 }], "major");

  let currentLeader = null;
  let candidateLeader = null;
  let candidateSince = 0;
  let lastStatusAt = 0;
  let straightAnnounced = false;
  let pullAwayAnnounced = false;
  let duelAnnounced = false;
  let finalAnnounced = false;
  const rankHistory = [];

  for (let t = 1.5; t < RACE_MAIN_SECONDS; t += 0.25) {
    const st = standingsAt(t);
    const L = st[0].number;
    const S = st[1].number;
    const gap = st[0].progress - st[1].progress;
    const ranks = {};
    st.forEach((s, i) => { ranks[s.number] = i + 1; });
    rankHistory.push({ t, ranks });

    if (currentLeader === null) {
      currentLeader = L;
      addEvent(t, pick([`まずは${label(L)}が先頭！`, `${label(L)}が好スタートを切った！`, `先頭は${label(L)}！`]), [{ type: "leader", horse: L }]);
      lastStatusAt = t;
      continue;
    }

    /* 先頭の入れ替わり（0.75秒以上続いたら） */
    if (L !== currentLeader) {
      if (candidateLeader !== L) { candidateLeader = L; candidateSince = t; }
      if (t - candidateSince >= 0.75) {
        const previousLeader = currentLeader;
        currentLeader = L;
        candidateLeader = null;
        const options = [
          { text: `${L}番が先頭に立った！`, claims: [{ type: "leader", horse: L }] },
          { text: `${label(L)}、ここで先頭へ！`, claims: [{ type: "leader", horse: L }] },
          { text: `${L}番が${previousLeader}番をかわして先頭！`, claims: [{ type: "leader", horse: L }, { type: "ahead", horses: [L, previousLeader] }] }
        ];
        const chosen = pick(options);
        addEvent(t, chosen.text, chosen.claims, "leader");
        lastStatusAt = t;
        continue;
      }
    } else {
      candidateLeader = null;
    }

    if (!straightAnnounced && t >= STRAIGHT_START_SECONDS) {
      straightAnnounced = true;
      const chosen = pick([
        { text: "最終直線に入りました！", claims: [] },
        { text: `最終直線！先頭は${L}番！`, claims: [{ type: "leader", horse: L }] },
        { text: `さあ最終直線！${L}番が先頭で迎えます！`, claims: [{ type: "leader", horse: L }] }
      ]);
      addEvent(t, chosen.text, [...chosen.claims, { type: "after", time: STRAIGHT_START_SECONDS }], "major");
      lastStatusAt = t;
      continue;
    }

    if (!finalAnnounced && t >= RACE_FINAL_SECONDS) {
      finalAnnounced = true;
      const chosen = pick([
        { text: `残り200メートル！先頭は${L}番！`, claims: [{ type: "leader", horse: L }] },
        { text: `ラスト200！${label(L)}がリード！`, claims: [{ type: "leader", horse: L }] },
        { text: "ラスト200メートル！さあ、ここからが勝負！", claims: [] }
      ]);
      addEvent(t, chosen.text, [...chosen.claims, { type: "after", time: RACE_FINAL_SECONDS }], "major");
      lastStatusAt = t;
      continue;
    }

    if (!pullAwayAnnounced && t >= 50 && L === winner && gap > 0.02) {
      pullAwayAnnounced = true;
      addEvent(t, pick([`${L}番が抜け出した！`, `${label(L)}、リードを広げる！`, `${L}番、ここで突き放す！`]),
        [{ type: "leader", horse: L }, { type: "leadGap", horse: L, gap: CLOSE_GAP }], "status");
      lastStatusAt = t;
      continue;
    }

    if (!duelAnnounced && t >= 54 && gap < 0.008) {
      duelAnnounced = true;
      addEvent(t, pick([`${L}番と${S}番、激しい叩き合い！`, `${L}番と${S}番が並んでゴール前へ！`]),
        [{ type: "close", horses: [L, S] }], "status");
      lastStatusAt = t;
      continue;
    }

    if (t - lastStatusAt >= (t >= RACE_FINAL_SECONDS ? 1.9 : 5.5)) {   // ラスト200mは、実況のテンポを上げる
      const options = [];
      if (t >= RACE_FINAL_SECONDS) {
        if (gap < CLOSE_GAP) options.push({ text: pick([`${L}番と${S}番、どっちだ！`, `${L}番と${S}番、まったくの互角！`, `${L}番、${S}番、並んだまま、ゴールへ！`]), claims: [{ type: "close", horses: [L, S] }] });
        else options.push({ text: pick([`${L}番、リードを保ってゴールへ！`, `${label(L)}が先頭、${S}番が必死に追う！`, `${L}番、${S}番を振り切れるか！`]), claims: [{ type: "leader", horse: L }] });
      }
      if (gap < 0.006) {
        options.push({ text: `${L}番と${S}番が並んでいます！`, claims: [{ type: "close", horses: [L, S] }] });
      }
      const past = rankHistory.find((h) => h.t >= t - 4);
      if (past) {
        st.slice(1, 5).forEach((s, i) => {
          const before = past.ranks[s.number];
          const now = i + 2;
          if (before - now >= 2) {
            options.push({ text: pick([`${s.number}番が追い上げる！`, `${s.number}番が外から伸びてきた！`, `${label(s.number)}がぐんぐん上がってきた！`]),
              claims: [{ type: "rankAtMost", horse: s.number, rank: now }] });
          }
        });
      }
      if (options.length === 0) {
        options.push({ text: `先頭は${L}番、2番手に${S}番！`, claims: [{ type: "leader", horse: L }, { type: "second", horse: S }] });
        options.push({ text: `${label(L)}が先頭をキープ！`, claims: [{ type: "leader", horse: L }] });
      }
      const chosen = pick(options);
      addEvent(t, chosen.text, chosen.claims, "status");
      lastStatusAt = t;
    }
  }

  /* ゴール：着順どおり。4着以降は近いものをまとめて伝える。1着と2着がほぼ同時なら「写真判定」 */
  const photoGap = resultOrder[1] !== undefined ? finishTimes[resultOrder[1]] - finishTimes[winner] : Infinity;
  let photo = null;
  if (photoGap <= PHOTO_FINISH_GAP_SECONDS) {
    const second = resultOrder[1];
    photo = { from: finishTimes[winner], resultAt: finishTimes[second] + 1.1, winner, second, gap: photoGap };
    addEvent(finishTimes[winner], pick(["僅差のゴール！写真判定です…！", "どっちだ！？写真判定へ！", "ほぼ並んでゴール！判定を待ちます…！"]), [{ type: "finished", horses: [winner] }], "finish");
    addEvent(photo.resultAt, pick([`写真判定の結果…${label(winner)}が1着！ 2着は${second}番！`, `判定は…${label(winner)}が僅差で1着！ 2着は${second}番！`]), [{ type: "finished", horses: [winner, second] }], "finish");
    rawEvents[rawEvents.length - 2].photo = true;
    rawEvents[rawEvents.length - 1].photo = true;
  } else {
    addEvent(finishTimes[winner], pick([`${label(winner)}、ゴールイン！`, `1着は${label(winner)}！`, `${label(winner)}、先頭でゴール！`]),
      [{ type: "finished", horses: [winner] }], "finish");
    if (resultOrder[1] !== undefined) {
      const n = resultOrder[1];
      addEvent(finishTimes[n], pick([`続いて${n}番もゴール！`, `2着は${n}番！`, `2番手で${n}番がゴール！`]), [{ type: "finished", horses: [n] }], "finish");
    }
  }
  if (resultOrder[2] !== undefined) {
    const n = resultOrder[2];
    addEvent(finishTimes[n], pick([`3着に${n}番が入りました！`, `3着は${n}番！`]), [{ type: "finished", horses: [n] }], "finish");
  }
  let batch = [];
  const flushBatch = () => {
    if (!batch.length) return;
    const text = batch.length === 1
      ? pick([`${batch[0]}番もゴール！`, `${batch[0]}番がゴール！`])
      : `${batch.map((n) => `${n}番`).join("、")}も続いてゴール！`;
    addEvent(finishTimes[batch[batch.length - 1]], text, [{ type: "finished", horses: [...batch] }], "finish");
    batch = [];
  };
  resultOrder.slice(3).forEach((n) => {
    if (batch.length && (finishTimes[n] - finishTimes[batch[0]] > 1.5 || batch.length >= 3)) flushBatch();
    batch.push(n);
  });
  flushBatch();
  const allFinishedText = pick(["全馬がゴールしました！", "全馬ゴールイン！"]);

  /* 写真判定のときは、判定の結果の実況が出てから、3着以降のゴールを伝える（順番が逆にならないように） */
  if (photo) rawEvents.forEach((e) => { if (e.kind === "finish" && !e.photo && e.time > photo.from) e.time = Math.max(e.time, photo.resultAt + 1.4); });

  /* 表示時間をそろえる：ゴールなどの大事な実況は少し後ろにずらしてでも出す。その他は間に合わなければ出さない */
  rawEvents.sort((a, b) => a.time - b.time);
  const events = [];
  let lastShownAt = -Infinity;
  rawEvents.forEach((e) => {
    const minHold = e.kind === "finish" ? 1.3 : 1.6;
    let time = e.time;
    if (time < lastShownAt + minHold) {
      if (e.kind === "status" || e.kind === "leader") return;
      time = lastShownAt + minHold;
    }
    events.push({ ...e, time });
    lastShownAt = time;
  });

  /* 締めの実況は時刻を固定する：「全馬ゴール」は結果表示の0.8秒前まで、「レース終了」は結果表示と同時。
     （ゴールの実況が混んで後ろにずれても、締めの実況が結果表示より後ろにずれて出なくならないように。
      それより後ろにずれたゴールの実況は「全馬ゴール」に含まれるので出さない） */
  const allFinishedAt = Math.min(Math.max(endTime + 0.6, lastShownAt + 1.3), revealTime - 0.8);
  while (events.length && events[events.length - 1].time >= allFinishedAt) events.pop();
  const allFinishedClaims = [{ type: "finished", horses: [...resultOrder] }];
  events.push({ time: allFinishedAt, text: allFinishedText, claims: allFinishedClaims, kind: "final" });
  events.push({ time: revealTime, text: "レース終了！結果をご覧ください", claims: allFinishedClaims, kind: "final" });

  const neutralText = {
    start: "スタートしました！",
    early: "序盤の位置取り争いです。",
    mid: "レースは中盤に入りました。",
    late: "レースは終盤へ。",
    straight: "最終直線、各馬ゴールを目指します！",
    finishing: "ゴールまであとわずか！",
    goal: "次々とゴールに飛び込みます！",
    finished: "全馬がゴールしました！",
    results: "レース終了！"
  };

  /* 画面の真ん中に大きく出す一言（スタート・ラスト200m・写真判定・1着）。出さない時間は null */
  function calloutAt(t) {
    if (t >= 0 && t < 2) return { key: "start", text: "🏁 スタート！", kind: "start" };
    if (t >= RACE_FINAL_SECONDS && t < RACE_FINAL_SECONDS + 2.4) return { key: "final", text: "🔥 ラスト200m！", kind: "final" };
    if (photo) {
      if (t >= photo.from && t < photo.resultAt) return { key: "photo", text: "📸 写真判定…！", kind: "photo" };
      if (t >= photo.resultAt && t < photo.resultAt + 2) return { key: "photoResult", text: `🏆 ${photo.winner}番が1着！`, kind: "photoResult" };
    } else if (t >= finishTimes[winner] && t < finishTimes[winner] + 1.8) return { key: "goal", text: `🏆 ${winner}番、1着ゴール！`, kind: "goal" };
    return null;
  }

  /* 画面の効き：shake（ゴール前に向けて強くなる揺れ 0〜1）、flash（ゴールの瞬間の白い光 0〜1）、intense（ラスト200mの間 true） */
  function effectsAt(t) {
    const goal = finishTimes[winner];
    let shake = 0;
    if (t >= RACE_FINAL_SECONDS && t < goal) shake = 0.15 + 0.35 * Math.min(1, (t - RACE_FINAL_SECONDS) / Math.max(0.1, goal - RACE_FINAL_SECONDS));
    else if (t >= goal && t < goal + 0.6) shake = 0.8 * (1 - (t - goal) / 0.6);
    const flash = t >= goal && t < goal + 0.35 ? 1 - (t - goal) / 0.35 : 0;
    return { shake, flash, intense: t >= RACE_FINAL_SECONDS && t < endTime };
  }

  function commentaryAt(t) {
    if (t < 0) return "";
    let latest = null;
    for (const e of events) {
      if (e.time <= t) latest = e;
      else break;
    }
    if (latest && latest.claims.every((c) => claimHolds(c, t))) return latest.text;
    return neutralText[phaseAt(t)] || "";
  }

  return {
    raceId: raceId || raceData?.raceId || "",
    resultOrder,
    finishTimes,
    endTime,
    revealTime,
    usedSavedCheckpoints: hasCheckpoints,
    events,
    photo,
    calloutAt,
    effectsAt,
    positionsAt,
    standingsAt,
    phaseAt,
    commentaryAt,
    claimHolds
  };
}


/* =========================================================
   カメラワーク（場面に応じて、どこをどれくらい大きく映すか）
   center：コース上の位置（0=スタート、1=ゴール）、zoom：1でコース全体
========================================================= */

/* コース全体を見せるときの倍率（手前のレーンの馬が画面の端で切れないよう少し引く） */
const WIDE_ZOOM = 0.88;

export function getCameraTarget(show, t) {
  if (!show || t < 2.5) return { center: 0.5, zoom: WIDE_ZOOM };
  if (t >= show.endTime + 0.8) return { center: 0.5, zoom: WIDE_ZOOM };

  const st = show.standingsAt(t);
  const running = st.filter((s) => !s.finished);
  const lead = st[0];
  const second = st[1];

  /* 写真判定：ゴール板の前で、2頭を大きく映したまま判定を待つ */
  if (show.photo && t >= show.photo.from - 0.5 && t < show.photo.resultAt + 1.2) return { center: 0.975, zoom: 5.6 };

  /* ゴール前後：ゴール板の付近を映し、まだ走っている馬が入るように */
  if (t >= RACE_MAIN_SECONDS - 1.5) {
    const trailing = running.length ? running[running.length - 1].progress : 1;
    const span = Math.max(0.2, 1.06 - trailing);
    return { center: Math.min(0.99, Math.max(0.84, 1.03 - span / 2)), zoom: Math.min(6, Math.max(3.2, 1.5 / span)) };
  }

  const leadP = lead.progress;
  if (t >= STRAIGHT_START_SECONDS) {
    /* 最終直線：先頭争いを大きく */
    const zoom = 4.4 + Math.min(1.2, (t - STRAIGHT_START_SECONDS) / 15) + (t >= RACE_FINAL_SECONDS ? 0.5 : 0);
    if (t >= RACE_FINAL_SECONDS && second && leadP - second.progress < CLOSE_GAP * 1.6) {
      /* ラスト200mの接戦：先頭の2頭の間を、さらに寄りで */
      return { center: Math.min(1, (leadP + second.progress) / 2 - 0.01), zoom: zoom + 0.6 };
    }
    return { center: Math.min(1, leadP - 0.02), zoom };
  }

  if (t > 8 && second && leadP - second.progress < CLOSE_GAP) {
    /* 接戦：先頭付近を寄りで */
    return { center: leadP - 0.015, zoom: 4.4 };
  }

  /* レース中：先頭集団を追いかける */
  const pack = st.slice(0, Math.max(3, Math.ceil(st.length / 2)));
  const packCenter = pack.reduce((a, s) => a + s.progress, 0) / pack.length;
  return { center: (packCenter + leadP) / 2 + 0.01, zoom: 3.2 };
}

/* =========================================================
   描画（Canvas 2D・外部ライブラリなし）
   コースを横から少し見下ろした「中継カメラ」風に描く。
   奥のレーンほど小さく・高く、手前ほど大きく・低く（遠近法）。
========================================================= */

const HORSE_COLORS = {
  1: ["#ffffff", "#111"], 2: ["#1d1d1d", "#fff"], 3: ["#e53935", "#fff"], 4: ["#1e63d6", "#fff"],
  5: ["#f9d71c", "#111"], 6: ["#2e9d4f", "#fff"], 7: ["#f57c00", "#fff"], 8: ["#f48fb1", "#111"],
  9: ["#7e57c2", "#fff"], 10: ["#00a3a3", "#fff"]
};

export function getHorseColors(number) {
  return HORSE_COLORS[number] || ["#999", "#fff"];
}

export function createRaceStage(container, { horses }) {
  const canvas = document.createElement("canvas");
  canvas.className = "race-canvas";
  canvas.setAttribute("aria-hidden", "true");
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const numbers = horses.map((h) => h.number);
  /* 奥（上）から 1番、手前（下）が最後の番号 */
  const laneDepth = {};
  const Z_NEAR = 1;
  const LANE_STEP = 0.15;
  numbers.forEach((n, i) => { laneDepth[n] = Z_NEAR + (numbers.length - 1 - i) * LANE_STEP; });
  const Z_FAR = Z_NEAR + (numbers.length - 1) * LANE_STEP;
  const Z_REF = (Z_NEAR + Z_FAR) / 2;

  /* 馬の絵：絵文字の🐎は左向きなので、右へ走る向きに合わせて左右反転した画像を一度だけ作っておく */
  const sprite = document.createElement("canvas");
  const SPRITE = 96;
  sprite.width = SPRITE;
  sprite.height = SPRITE;
  {
    const s = sprite.getContext("2d");
    s.translate(SPRITE, 0);
    s.scale(-1, 1);
    s.textAlign = "center";
    s.textBaseline = "middle";
    s.font = `${SPRITE * 0.8}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    s.fillText("🐎", SPRITE / 2, SPRITE * 0.55);
  }

  let width = 0;
  let height = 0;
  let dpr = 1;
  const camera = { center: 0.5, zoom: 1, ready: false };
  let lastDrawAt = 0;

  function resize() {
    const rect = container.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  resize();
  let resizeObserver = null;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => resize());
    resizeObserver.observe(container);
  } else {
    window.addEventListener("resize", resize);
  }

  /* 投影：コース上の位置 x（0〜1）と奥行き z → 画面座標 */
  function layout() {
    const horizon = height * 0.2;
    const nearY = height * 0.9;
    const groundSpan = (nearY - horizon) * Z_NEAR;
    /* zoom=1 のとき、いちばん手前のレーンでコース全体（0〜1）が画面に収まる */
    const unit = ((width * camera.zoom) / 1.12) * (Z_NEAR / Z_REF);
    return {
      horizon,
      sx: (x, z) => width / 2 + (x - camera.center) * unit * (Z_REF / z),
      sy: (z) => horizon + groundSpan / z,
      scale: (z) => Z_REF / z
    };
  }

  function drawBackground(L) {
    const sky = ctx.createLinearGradient(0, 0, 0, L.horizon);
    sky.addColorStop(0, "#8ec5ff");
    sky.addColorStop(1, "#dff0ff");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, L.horizon + 1);

    /* 遠くのスタンド（ゆっくり流れる＝奥行き） */
    const standTop = L.horizon - height * 0.1;
    ctx.fillStyle = "#5b6b7d";
    ctx.fillRect(0, standTop, width, L.horizon - standTop);
    const parallax = camera.center * width * camera.zoom * 0.25;
    ctx.fillStyle = "rgba(255,255,255,.35)";
    for (let x = -((parallax) % 14) - 14; x < width + 14; x += 14) {
      ctx.fillRect(x, standTop + 4, 6, 3);
      ctx.fillRect(x + 7, standTop + 11, 6, 3);
    }
    ctx.fillStyle = "#3d4a59";
    ctx.fillRect(0, standTop - 4, width, 4);

    /* 外ラチの奥の芝 */
    ctx.fillStyle = "#4f9a4f";
    ctx.fillRect(0, L.horizon, width, L.sy(Z_FAR + 0.25) - L.horizon);
  }

  function quad(L, x0, x1, z0, z1, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(L.sx(x0, z0), L.sy(z0));
    ctx.lineTo(L.sx(x1, z0), L.sy(z0));
    ctx.lineTo(L.sx(x1, z1), L.sy(z1));
    ctx.lineTo(L.sx(x0, z1), L.sy(z1));
    ctx.closePath();
    ctx.fill();
  }

  function visibleRange(L, z) {
    const unit = ((width * camera.zoom) / 1.12) * (Z_NEAR / Z_REF) * (Z_REF / z);
    const half = width / 2 / unit;
    return [camera.center - half - 0.02, camera.center + half + 0.02];
  }

  function drawTrack(L) {
    const zIn = Z_NEAR - 0.22;
    const zOut = Z_FAR + 0.22;
    /* 奥ほど広い範囲が映るので、奥のレーンを基準に描く範囲を決める */
    const [a, b] = visibleRange(L, zOut);

    /* まず地面全体を芝の色で塗る（コースの外側が黒く残らないように） */
    ctx.fillStyle = "#5cab5c";
    ctx.fillRect(0, L.sy(zOut), width, height - L.sy(zOut));

    /* 芝の縞模様（コースに沿ってスクロール） */
    const stripe = 0.04;
    for (let x = Math.floor(Math.max(-0.6, a) / stripe) * stripe; x < Math.min(1.6, b); x += stripe) {
      const even = Math.round(x / stripe) % 2 === 0;
      quad(L, x, x + stripe, zIn, zOut, even ? "#66b866" : "#5cab5c");
    }
    /* ゴールの先とスタートの手前は少し色を変える */
    if (b > 1) quad(L, 1, Math.min(1.6, b), zIn, zOut, "rgba(255,255,255,.08)");

    /* レーンの線 */
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 1;
    numbers.forEach((n) => {
      const z = laneDepth[n] + LANE_STEP / 2;
      if (z > zOut) return;
      ctx.beginPath();
      ctx.moveTo(L.sx(Math.max(-0.6, a), z), L.sy(z));
      ctx.lineTo(L.sx(Math.min(1.6, b), z), L.sy(z));
      ctx.stroke();
    });

    /* ラチ（柵）と距離の目印：流れていくことでスピード感を出す */
    [zOut, zIn].forEach((z, idx) => {
      const y = L.sy(z);
      const s = L.scale(z);
      ctx.strokeStyle = "#f4f4f4";
      ctx.lineWidth = Math.max(1, 2.5 * s);
      ctx.beginPath();
      ctx.moveTo(L.sx(Math.max(-0.6, a), z), y - 10 * s);
      ctx.lineTo(L.sx(Math.min(1.6, b), z), y - 10 * s);
      ctx.stroke();
      ctx.fillStyle = "#e9e9e9";
      const postStep = 0.02;
      for (let x = Math.ceil(Math.max(-0.6, a) / postStep) * postStep; x < Math.min(1.6, b); x += postStep) {
        const px = L.sx(x, z);
        ctx.fillRect(px - 1 * s, y - 12 * s, Math.max(1, 2 * s), 12 * s);
      }
      if (idx === 0) {
        ctx.font = `${Math.max(9, 10 * s)}px sans-serif`;
        ctx.textAlign = "center";
        for (let x = 0.1; x < 1; x += 0.1) {
          if (x < a || x > b) continue;
          const px = L.sx(x, z);
          ctx.fillStyle = "#fff";
          ctx.fillRect(px - 9 * s, y - 30 * s, 18 * s, 14 * s);
          ctx.fillStyle = "#c62828";
          ctx.fillText(String(Math.round((1 - x) * 10) * 200), px, y - 19 * s);
        }
      }
    });

    /* スタートゲート */
    if (a < 0.03) {
      const x = -0.004;
      const top = L.sy(zOut) - 30 * L.scale(zOut);
      ctx.fillStyle = "rgba(90,90,90,.85)";
      ctx.beginPath();
      ctx.moveTo(L.sx(x, zOut), top);
      ctx.lineTo(L.sx(x + 0.006, zOut), top);
      ctx.lineTo(L.sx(x + 0.006, zIn), L.sy(zIn) - 30 * L.scale(zIn));
      ctx.lineTo(L.sx(x, zIn), L.sy(zIn) - 30 * L.scale(zIn));
      ctx.closePath();
      ctx.fill();
    }

    /* ゴール板（白黒） */
    if (a < 1.02 && b > 0.98) {
      const steps = 10;
      for (let i = 0; i < steps; i++) {
        const z0 = zIn + ((zOut - zIn) * i) / steps;
        const z1 = zIn + ((zOut - zIn) * (i + 1)) / steps;
        quad(L, 0.997, 1.003, z0, z1, i % 2 === 0 ? "#111" : "#fff");
      }
      const z = zOut;
      const px = L.sx(1, z);
      const s = L.scale(z);
      ctx.fillStyle = "#c62828";
      ctx.fillRect(px - 2 * s, L.sy(z) - 46 * s, 4 * s, 46 * s);
      ctx.fillStyle = "#fff";
      ctx.fillRect(px - 16 * s, L.sy(z) - 58 * s, 32 * s, 14 * s);
      ctx.fillStyle = "#c62828";
      ctx.font = `bold ${Math.max(8, 10 * s)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("GOAL", px, L.sy(z) - 47 * s);
    }
  }

  function drawHorses(L, positions, t, myHorses, running) {
    const zoomBoost = 0.8 + Math.min(4, camera.zoom) * 0.1;
    const order = [...numbers].sort((a, b) => laneDepth[b] - laneDepth[a]);
    order.forEach((n) => {
      const z = laneDepth[n];
      const p = positions[n] || 0;
      const s = L.scale(z) * zoomBoost;
      const size = Math.max(16, height * 0.11 * s);
      const groundX = L.sx(p, z);
      const groundY = L.sy(z);
      if (groundX < -size * 2 || groundX > width + size * 2) return;

      /* 影 */
      ctx.fillStyle = "rgba(0,0,0,.22)";
      ctx.beginPath();
      ctx.ellipse(groundX - size * 0.15, groundY - size * 0.04, size * 0.42, size * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();

      const bob = running ? Math.sin(t * 13 + n * 1.7) * size * 0.05 : 0;
      const tilt = running ? Math.sin(t * 13 + n * 1.7) * 0.05 : 0;
      ctx.save();
      ctx.translate(groundX - size * 0.15, groundY - size * 0.48 + bob);
      ctx.rotate(tilt);
      if (myHorses.includes(n)) {
        ctx.shadowColor = "rgba(255,107,157,.95)";
        ctx.shadowBlur = size * 0.35;
      }
      ctx.drawImage(sprite, -size / 2, -size / 2, size, size);
      ctx.restore();

      /* ゼッケン（馬番） */
      const [bg, fg] = getHorseColors(n);
      const r = Math.max(7, size * 0.17);
      const bx = groundX - size * 0.12;
      const by = groundY - size * 1.02 + bob;
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.lineWidth = myHorses.includes(n) ? Math.max(2, r * 0.3) : 1;
      ctx.strokeStyle = myHorses.includes(n) ? "#ff6b9d" : "rgba(0,0,0,.45)";
      ctx.stroke();
      ctx.fillStyle = fg;
      ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(n), bx, by + 0.5);
      ctx.textBaseline = "alphabetic";

      /* 自分の馬券の馬：頭の上に「あなた」の印（ぴょこぴょこ動く） */
      if (myHorses.includes(n)) {
        const hop = Math.sin(t * 6) * r * 0.25;
        const mx = bx, my = by - r * 1.5 + hop;
        ctx.fillStyle = "#ff6b9d";
        ctx.beginPath();
        ctx.moveTo(mx - r * 0.7, my - r * 0.5);
        ctx.lineTo(mx + r * 0.7, my - r * 0.5);
        ctx.lineTo(mx, my + r * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.font = `bold ${Math.round(r * 0.95)}px sans-serif`;
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "rgba(190,40,100,.9)";
        ctx.lineWidth = Math.max(2, r * 0.3);
        ctx.strokeText("あなた", mx, my - r * 0.85);
        ctx.fillText("あなた", mx, my - r * 0.85);
      }
    });
  }

  function drawSpeedLines(L, intensity) {
    if (intensity <= 0) return;
    ctx.strokeStyle = `rgba(255,255,255,${0.12 * intensity})`;
    ctx.lineWidth = 1;
    const offset = (camera.center * 4000) % 60;
    for (let i = 0; i < 9; i++) {
      const y = L.horizon + ((i * 37) % Math.max(1, height - L.horizon));
      const x = width - ((offset + i * 53) % (width + 80));
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 40 * intensity, y);
      ctx.stroke();
    }
  }

  function drawVignette(strength) {
    if (strength <= 0) return;
    const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${0.35 * strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }

  /* 1フレーム描く。show が無い（結果待ち・発走前）ときは全馬ゲートに並べる */
  function render({ show, t, myHorses = [], snapCamera = false }) {
    if (!ctx || width < 2 || height < 2) return;
    const now = performance.now();
    const dt = lastDrawAt ? Math.min(0.25, (now - lastDrawAt) / 1000) : 0;
    lastDrawAt = now;

    const target = getCameraTarget(show, t);
    if (!camera.ready || snapCamera) {
      camera.center = target.center;
      camera.zoom = target.zoom;
      camera.ready = true;
    } else {
      const k = 1 - Math.exp(-dt * 2.2);
      camera.center += (target.center - camera.center) * k;
      camera.zoom += (target.zoom - camera.zoom) * k;
    }
    /* 端が映りすぎないように */
    const halfView = 0.56 / camera.zoom;
    if (halfView * 2 >= 1.14) camera.center = 0.5;
    else camera.center = Math.min(1.1 - halfView, Math.max(-0.04 + halfView, camera.center));

    const positions = show ? show.positionsAt(t) : Object.fromEntries(numbers.map((n) => [n, 0]));
    const running = Boolean(show) && t > 0 && t < (show ? show.endTime + 2 : 0);

    const fx = show && running ? show.effectsAt(t) : { shake: 0, flash: 0, intense: false };
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (fx.shake > 0) {   // ゴール前に向けて、画面がだんだん揺れる
      const amp = 3.2 * fx.shake;
      ctx.translate(Math.sin(t * 47) * amp, Math.cos(t * 53) * amp);
    }
    const L = layout();
    drawBackground(L);
    drawTrack(L);
    drawSpeedLines(L, running ? Math.min(1, (camera.zoom - 1) / 3) * (fx.intense ? 1.8 : 1) : 0);
    drawHorses(L, positions, t, myHorses, running);
    const finalStretch = show && t >= RACE_FINAL_SECONDS && t < show.endTime;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawVignette(finalStretch ? 1.25 : 0);
    if (fx.flash > 0) {   // ゴールの瞬間：白い光
      ctx.fillStyle = `rgba(255,255,255,${0.7 * fx.flash})`;
      ctx.fillRect(0, 0, width, height);
    }
  }

  function destroy() {
    if (resizeObserver) resizeObserver.disconnect();
    else window.removeEventListener("resize", resize);
    canvas.remove();
  }

  return { render, resize, destroy, canvas };
}
