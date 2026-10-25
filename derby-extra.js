/* =========================================================
   ゆうダービー：自分の馬券に合わせた演出の計算（画面の表示用。結果も払い戻しも決めない）

   ・レース中：自分の馬券が「いま当たりの順位か」を、今の順位から計算して見せる（馬券チップ）。
   ・レース中：自分の馬が先頭に立つ・3位以内に上がる・順位を落とす、を見つけて、一言にする。
   ・ゴールのあと：外れたとき「あと一歩」がわかる説明を作る。
   ・当たり・外れを決めるのも、払い戻しの額を決めるのも Worker（settleMyBets）。ここは、見せるための計算だけ。
   ・evaluateBetWin は script.js の同名の関数と同じ判定（notify-worker/test/derby-extra.test.mjs が確かめる）。
========================================================= */

const top3 = (order) => [order[0], order[1], order[2]];
const sameSet = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((n, i) => n === [...b].sort((x, y) => x - y)[i]);

/* 馬券が当たりの並びか（order：着順の馬番の配列） */
export function evaluateBetWin(bet, order) {
  const horses = bet?.horses || [];
  const [t1, t2, t3] = top3(order);
  switch (bet?.type) {
    case "win": return horses[0] === t1;
    case "place": return [t1, t2, t3].includes(horses[0]);
    case "quinella": return horses.length === 2 && sameSet(horses, [t1, t2]);
    case "trio": return horses.length === 3 && sameSet(horses, [t1, t2, t3]);
    case "trifecta": return horses.length === 3 && horses[0] === t1 && horses[1] === t2 && horses[2] === t3;
    default: return false;
  }
}

/* レース中の、馬券の様子。order：いまの順位（先頭から並べた馬番）。
   state：good（いま当たりの並び）／near（あと一歩）／off。text：チップに出す短い文 */
export function betTrack(bet, order) {
  const horses = bet?.horses || [];
  const ranks = horses.map((h) => order.indexOf(h) + 1);
  if (ranks.some((r) => r <= 0)) return { state: "off", ranks, text: "—" };
  const hit = evaluateBetWin(bet, order);
  let near = false;
  if (!hit) {
    if (bet.type === "win") near = ranks[0] === 2;
    else if (bet.type === "place") near = ranks[0] === 4;
    else near = ranks.every((r) => r <= horses.length + 1);
  }
  const text = horses.length === 1 ? `いま${ranks[0]}位` : `いま ${ranks.join("・")}位`;
  return { state: hit ? "good" : near ? "near" : "off", ranks, text };
}

/* ゴールのあとの、外れの説明（あと一歩だったかどうか）。resultOrder：着順の馬番の配列 */
export function describeMiss(bet, resultOrder) {
  const horses = bet?.horses || [];
  const rank = (n) => resultOrder.indexOf(n) + 1;
  if (bet.type === "win") {
    const r = rank(horses[0]);
    return { close: r === 2, text: r === 2 ? `${horses[0]}番は2着…あと一歩でした！` : `${horses[0]}番は${r}着でした` };
  }
  if (bet.type === "place") {
    const r = rank(horses[0]);
    return { close: r === 4, text: r === 4 ? `${horses[0]}番は4着…3着以内まであと1つ！` : `${horses[0]}番は${r}着でした` };
  }
  if (bet.type === "quinella") {
    const inTop2 = horses.filter((n) => rank(n) >= 1 && rank(n) <= 2).length;
    return { close: inTop2 === 1, text: inTop2 === 1 ? "2頭のうち1頭が、1・2着に入っていました！" : "1・2着に入った馬は、いませんでした" };
  }
  if (bet.type === "trio") {
    const inTop3 = horses.filter((n) => rank(n) >= 1 && rank(n) <= 3).length;
    return { close: inTop3 === 2, text: inTop3 === 2 ? "3頭のうち2頭が、3着以内に入っていました！" : inTop3 === 1 ? "3頭のうち1頭が、3着以内に入っていました" : "3着以内に入った馬は、いませんでした" };
  }
  if (bet.type === "trifecta") {
    const exact = horses.filter((n, i) => resultOrder[i] === n).length;
    const inTop3 = horses.filter((n) => rank(n) >= 1 && rank(n) <= 3).length;
    return { close: exact === 2 || inTop3 === 3, text: inTop3 === 3 ? "3頭とも3着以内！順番だけ惜しかった…！" : exact === 2 ? "2頭は順番どおりでした！あと1頭…！" : "順番が、ひとつも合いませんでした" };
  }
  return { close: false, text: "" };
}

/* 自分の馬の順位の変化から、一言を作る。prev・now：{ 馬番: 順位(1〜) }。nameOf：馬番 → 名前。
   返す：[{ key, text }]（同じ出来事は1回だけ出すための key つき） */
export function myMoves(prev, now, myHorses) {
  const out = [];
  (myHorses || []).forEach((n) => {
    const a = prev?.[n], b = now?.[n];
    if (!a || !b || a === b) return;
    if (b === 1 && a > 1) out.push({ key: `lead-${n}`, text: `🔥 あなたの${n}番が先頭に立った！` });
    else if (b <= 3 && a > 3) out.push({ key: `top3-${n}`, text: `✨ あなたの${n}番、3位以内に浮上！` });
    else if (a <= 3 && b > 3) out.push({ key: `drop-${n}`, text: `😣 あなたの${n}番、順位を落とした…` });
    else if (a === 1 && b > 1) out.push({ key: `lost-${n}`, text: `😱 あなたの${n}番、先頭を明け渡した！` });
  });
  return out;
}

/* 的中のあとの表示用：的中した馬券の払い戻しの合計 */
export function totalPayout(hits) {
  return (hits || []).reduce((sum, h) => sum + (Number(h.payout) || 0), 0);
}
