/* =========================================================
   🎰 ゆうスロの演出のうち、「何を出すか」を決める部分（画面には触れない。テストしやすいように別ファイル）
   ・前兆／ステップアップ：当たりそうな回ほど出やすい予告。外れの回にも、弱いものがたまに出る（ガセ）。
     いちばん強い予告（前兆レベル3・ランプの金）は、本物の大当たりのときだけ出る。
   ・連チャン：当たりが続いた数。FEVER 中の回は数えない（果物が毎回揃うため）。REPLAY は数が変わらない。外れで0に戻る。
   ・どれも見た目だけ。結果はサーバー（Worker）が決めたものを変えない。Firestore にも触れない。
========================================================= */

export const OMEN_STEP_MS = 380;   // ステップアップ予告：ランプが次の色になるまでの間隔

/* 当たりの種類：big＝特別役の大当たり／mid＝コインが増える当たり・宝箱・星／weak＝REPLAY・ハズレ */
export const isWinLike = (spin) => Boolean(spin && (spin.feverPending || spin.coinWin || spin.result === "treasure" || spin.result === "star"));

/* 予告の計画。null＝出さない。{ type: "rumble"（前兆：枠が光って・低い音）| "step"（ランプが青→緑→赤→金）, level: 1〜3 } */
export function planOmen(spin, { fever = false, rand = Math.random } = {}) {
  if (!spin || fever) return null;
  const big = Boolean(spin.feverPending);
  const mid = !big && isWinLike(spin);
  const chance = big ? 0.7 : mid ? 0.25 : spin.result === "replay" ? 0.08 : 0.1;
  if (rand() >= chance) return null;
  const r = rand();
  const level = big ? (r < 0.2 ? 1 : r < 0.6 ? 2 : 3) : mid ? (r < 0.6 ? 1 : 2) : (r < 0.75 ? 1 : 2);
  return { type: rand() < 0.5 ? "rumble" : "step", level };
}

/* 自動回転のとき、リールを止めはじめるまでに待つ時間（予告を見せるため） */
export function omenWaitMs(omen) {
  if (!omen) return 0;
  return omen.type === "step" ? omen.level * OMEN_STEP_MS + 300 : [0, 500, 800, 1100][omen.level] || 0;
}

/* 連チャンの数。feverSpin＝その回が FEVER 中だったか */
export function nextChain(chain, spin, feverSpin) {
  if (feverSpin || !spin) return chain;
  if (isWinLike(spin)) return chain + 1;
  if (spin.result === "lose") return 0;
  return chain;   // REPLAY など
}
export const chainTier = (n) => (n >= 5 ? 3 : n >= 3 ? 2 : n >= 2 ? 1 : 0);
export const chainLabel = (n) => `${n}連チャン${n >= 5 ? "!!!" : n >= 3 ? "!!" : "！"}`;
export const chainBadge = (n) => (n >= 2 ? `🔥 ${n}連チャン中` : "");
