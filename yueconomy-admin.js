/* 📊 経済の状態（インフレの目安）（管理者だけ。ユーザー管理タブに出す）
   ・Worker の economyReport を呼んで見せるだけ。コインの総量・分布・毎日の推移・宝くじとゆう番くじの収支を出す。
   ・何も書き換えない。読み取りは、開いたとき1回と「最新を読み込む」のとき（Worker 側で十数回ぶんの読み取り）。 */

let cfg = null;
const S = { data: null, busy: false, msg: "", loaded: false, prize: { id: "A", data: null, busy: false, msg: "" } };
let stylesDone = false;

export function economyAdminInit(config) { cfg = config; }
export function economyAdminReset() { FUND.busy = false; FUND.msg = ""; S.data = null; S.busy = false; S.msg = ""; S.loaded = false; const el = document.getElementById("userManageEconomy"); if (el) el.innerHTML = ""; }
export function economyAdminOpen() { if (!cfg || !cfg.isAdmin()) return; ensureStyles(); render(); if (!S.loaded && !S.busy) load(); }

const fmt = (n) => Number(n || 0).toLocaleString("ja-JP");
const pct = (v, d = 1) => `${(Number(v || 0) * 100).toFixed(d)}%`;
const sgn = (v, d = 1) => `${v >= 0 ? "+" : ""}${(Number(v || 0) * 100).toFixed(d)}%`;
const BAND = (b) => (b.hi == null ? `${fmt(b.lo)}〜` : `${fmt(b.lo)}〜${fmt(b.hi)}`);

async function load() {
  S.busy = true; S.msg = ""; render();
  try { S.data = await cfg.callAdmin("economyReport", {}); S.loaded = true; }
  catch (error) { console.error("経済の状態のエラー:", error); S.msg = "読み込めませんでした。もう一度お試しください。"; }
  S.busy = false; render();
}

function verdict(t) {
  if (!t) return { cls: "none", text: "⚪ 推移はまだ少ないです（毎日13:00に1日ぶんずつたまります）" };
  const v = `1人あたりの総資産が、${t.days}日で ${sgn(t.avgPct)}`;
  if (t.level === "high") return { cls: "high", text: `🔴 要対策：${v}` };
  if (t.level === "mid") return { cls: "mid", text: `🟡 ゆるやかなインフレ：${v}` };
  if (t.level === "deflation") return { cls: "def", text: `🔵 デフレ気味：${v}` };
  return { cls: "low", text: `🟢 安定：${v}` };
}

/* 🎊 ゆう番くじの景品の取り消し（くじに戻す）：その景品を持っている人を探して、取り消す。券の番号は売れていない状態に戻り、景品は箱に戻り、券代（200コイン）は持ち主に返す */
const PRIZE_ERR = { listed: "ゆうマートに出品中です（先に出品を取り下げさせてください）", bought: "ゆうマートで買った景品なので、取り消せません", used: "すでに使った景品なので、取り消せません", sold_out: "完売したので、取り消せません", ticket_not_sold: "券の番号が売れた状態ではありません", not_found: "その景品が見つかりません（すでに取り消した・動かした）", busy: "ほかの操作と重なりました。もう一度お試しください" };
function prizeHtml(esc) {
  const P = S.prize, d = P.data;
  let body = "";
  if (d) {
    const rows = d.holders.map((h) => `<div class="yec-pz"><span><b>${esc(h.name)}</b>　券 ${h.n + 1} 番　${h.at ? esc(new Date(h.at + 9 * 3600000).toISOString().replace("T", " ").slice(5, 16)) : ""}${h.bought ? "（マートで買った）" : ""}${h.used ? "（使用ずみ）" : ""}</span>
      <button type="button" class="yec-btn yec-danger" data-ec="prize-revoke" data-uid="${esc(h.uid)}" data-n="${h.n}" data-name="${esc(h.name)}" ${P.busy || h.bought || h.used ? "disabled" : ""}>取り消してくじに戻す</button></div>`).join("");
    const listed = d.listed.map((l) => `<div class="yec-note">🏪 ゆうマートに出品中：${esc(l.seller)}（出品の取り下げは、ゆうマートの管理者欄の「取り下げさせる」）</div>`).join("");
    body = `${rows || `<p class="yec-note">${esc(d.prizeId)}賞を持っている人は、いません。</p>`}${listed}`;
  }
  return `<h4>🎊 ゆう番くじ：景品の取り消し（くじに戻す）</h4>
    <p class="yec-note">景品を持っている人を探して、取り消します。券の番号は売れていない状態に戻り、景品は箱に戻って、ほかの人が引けるようになります。券代（200コイン）は持ち主に返します。</p>
    <div class="yec-row"><button type="button" class="yec-btn yec-danger" data-ec="limit-reset" ${P.busy ? "disabled" : ""}>今日の購入上限を、みんなリセットする</button></div>
    <p class="yec-note">ゆう番くじの「1人1日15枚まで」を、今日の分だけ、全員 0 枚に戻します（整理券は戻りません）。</p>
    <div class="yec-row"><select id="yecPrizeId">${["A", "B", "C", "D", "E", "F", "G", "H"].map((x) => `<option value="${x}"${P.id === x ? " selected" : ""}>${x}賞</option>`).join("")}</select> <button type="button" class="yec-btn" data-ec="prize-find" ${P.busy ? "disabled" : ""}>${P.busy && !d ? "探しています…" : "持っている人を探す"}</button></div>
    ${body}${P.msg ? `<p class="${P.msg.startsWith("✅") ? "yec-ok" : "yec-err"}">${esc(P.msg)}</p>` : ""}`;
}
async function prizeFind() {
  const sel = document.getElementById("yecPrizeId"); if (sel) S.prize.id = sel.value;
  S.prize.busy = true; S.prize.msg = ""; render();
  try { S.prize.data = await cfg.callAdmin("bankujiPrize", { prizeId: S.prize.id }); }
  catch (error) { console.error("景品の検索エラー:", error); S.prize.msg = "読み込めませんでした。もう一度お試しください。"; }
  S.prize.busy = false; render();
}
async function limitReset() {
  if (!confirm("ゆう番くじの、今日の購入上限（1人1日15枚）を、全員 0 枚に戻します。よろしいですか？")) return;
  S.prize.busy = true; S.prize.msg = ""; render();
  try { await cfg.callAdmin("bankujiResetLimit", {}); S.prize.msg = "✅ 今日の購入上限を、全員 0 枚に戻しました。"; }
  catch (error) { console.error("購入上限のリセットエラー:", error); S.prize.msg = "うまくいきませんでした。もう一度お試しください。"; }
  S.prize.busy = false; render();
}
async function prizeRevoke(t) {
  const name = t.dataset.name, n = Number(t.dataset.n);
  if (!confirm(`${name} さんの ${S.prize.id}賞（券 ${n + 1} 番）を取り消して、くじに戻します。\n券代 200 コインは ${name} さんに返します。よろしいですか？`)) return;
  S.prize.busy = true; S.prize.msg = ""; render();
  try {
    const r = await cfg.callAdmin("bankujiPrize", { mode: "revoke", prizeId: S.prize.id, uid: t.dataset.uid, n });
    S.prize.msg = `✅ ${r.name} さんの ${r.prizeId}賞を取り消して、くじに戻しました（券 ${r.ticket + 1} 番は売れていない状態に戻り、${r.refund} コインを返しました）。`;
    S.prize.data = await cfg.callAdmin("bankujiPrize", { prizeId: S.prize.id });
  } catch (error) { console.error("景品の取り消しエラー:", error); S.prize.msg = PRIZE_ERR[error && error.code] || "うまくいきませんでした。もう一度お試しください。"; }
  S.prize.busy = false; render();
}

/* 今日の13:00の処理（株価・利息）が済んでいるか。済んでいなければ、見守りが何をしたかも出す */
function dailyLine(x, esc) {
  if (!x) return "";
  if (x.done) return `<p class="yec-note">今日（${esc(x.today)}）の株価・利息の更新：済み</p>`;
  const w = x.watch;
  const why = !w ? "まだ確かめていません（13:00 から確かめます）"
    : w.result === "worker_error" ? "サーバーが自分で更新しようとして失敗しました（しばらくして、もう一度やります）"
    : w.result === "dispatched" ? "見守りが自動実行を頼みました（数分で反映されます）"
    : w.result === "no_token" ? "サーバーでの更新が終わっていません（予備の GITHUB_DISPATCH_TOKEN も未登録です）"
    : `見守りが自動実行を頼めませんでした（GitHub の応答 ${esc(String(w.status))}）`;
  return `<p class="yec-note" style="color:#c0392b;font-weight:bold">⚠ 今日（${esc(x.today)}）の株価・利息の更新は、まだ済んでいません。${why}。</p>`;
}
/* 🏦 ゆう基金（スリ・ゆう税でたまったコインを、毎日 9:15 に、総資産の少ない人から順に配る） */
function fundLine(f, esc) {
  if (!f) return "";
  const last = f.date && f.status === "done" ? `／前回（${esc(f.date)}）：${fmt(f.count)}人に合計 ${fmt(f.total)} コイン` : f.status === "paying" ? "／配っている途中です" : "";
  return `<p class="yec-note">🏦 ゆう基金：いまの残り <b>${fmt(f.balance)}</b> コイン${last}</p>
    ${f.backfill ? `<p class="yec-note">これまでの分（基金ができる前のゆう税 ${fmt(f.backfill.tax)}・スリ ${fmt(f.backfill.theft)}）：足しずみ（合計 ${fmt(f.backfill.total)} コイン）</p>` : ""}
    <div class="yec-row"><button type="button" class="yec-btn" data-ec="fund-now" data-balance="${fmt(f.balance)}" ${FUND.busy ? "disabled" : ""}>${FUND.busy ? "配っています…" : "ゆう基金を今すぐ配る"}</button>
      ${f.backfill ? "" : `<button type="button" class="yec-btn" data-ec="fund-backfill" ${FUND.busy ? "disabled" : ""}>これまでの分を基金に足す</button>`}</div>
    ${FUND.msg ? `<p class="${FUND.error ? "yec-err" : "yec-ok"}">${esc(FUND.msg)}</p>` : ""}
    <div class="yec-row"><button type="button" class="yec-btn" data-ec="derby-settle" ${FUND.busy ? "disabled" : ""}>ゆうダービー：未精算の馬券を今すぐ精算する</button></div>
    <div class="yec-row"><button type="button" class="yec-btn" data-ec="lottery-repay" ${FUND.busy ? "disabled" : ""}>宝くじ：払われていない賞金を調べて払う（直近の回）</button></div>
    ${FUND.derby ? `<p class="${FUND.derbyError ? "yec-err" : "yec-ok"}" style="white-space:pre-line">${esc(FUND.derby)}</p>` : ""}`;
}
async function lotteryRepayNow() {
  FUND.busy = true; FUND.derby = ""; FUND.derbyError = false; render();
  try {
    const p = await cfg.callAdmin("lotteryRepay", {});
    const who = (p.people || []).map((x) => `${x.name || `${x.entryName}（書類が見つからない）`}：${fmt(x.amount)} コイン（${fmt(x.count)}口）`).join("\n");
    if (!p.missing) FUND.derby = `${p.round} の回：払われていない賞金はありません（当選 ${fmt(p.expectedWinners)}口・払い済み ${fmt(p.paidWinners)}口）。`;
    else if (confirm(`${p.round} の回で、払われていない賞金が ${fmt(p.missing)}口あります。\n${who}\n払える分の合計 ${fmt(p.total)} コインを、今すぐ払います。よろしいですか？`)) {
      const r = await cfg.callAdmin("lotteryRepay", { round: p.round, apply: true });
      FUND.derby = r.applied ? `✅ ${p.round} の回：合計 ${fmt(r.total)} コインを払いました。${r.unfound ? `\n（書類が見つからず払えなかった人：${fmt(r.unfound)}人）` : ""}` : "払えませんでした（もう一度お試しください）。";
      FUND.derbyError = !r.applied;
    } else FUND.derby = "やめました。";
  } catch (error) { console.error("宝くじの払い直しエラー:", error); FUND.derby = "うまくいきませんでした。もう一度お試しください。"; FUND.derbyError = true; }
  FUND.busy = false;
  render();
}
async function derbySettleNow() {
  if (!confirm("直近3日の自動開催のレースで、まだ精算されていない馬券を、今すぐ精算します（当たりのコインが入ります。精算済みは触りません）。よろしいですか？")) return;
  FUND.busy = true; FUND.derby = ""; FUND.derbyError = false; render();
  try {
    const r = await cfg.callAdmin("derbySettle", {});
    const why = { no_result: "結果なし", no_schedule: "開催情報なし", not_ready: "まだ" };
    FUND.derby = (r.results || []).map((x) => `${x.raceId}：${x.status === "done" ? `${fmt(x.settled)}件を精算（合計 ${fmt(x.payoutTotal)} コイン）${x.skipped ? `・退会などで ${fmt(x.skipped)}件は飛ばした` : ""}` : x.status === "error" ? `失敗（${x.reason}）` : `飛ばした（${why[x.reason] || x.reason || ""}）`}`).join("\n") || "対象のレースがありません。";
  } catch (error) { console.error("ダービー精算エラー:", error); FUND.derby = "うまくいきませんでした。もう一度お試しください。"; FUND.derbyError = true; }
  FUND.busy = false;
  render();
}
const FUND = { busy: false, msg: "", error: false };
const FUND_SKIP = { done: "今日はもう配りました（1日1回）。", small_pool: "基金が10コイン未満なので、配れません。", no_one: "対象の人（直近3日以内にログインした人）がいないので、配れません。" };
/* 基金ができる前に集めた分（ゆう税・スリ）を、1 回だけ基金に足す。先に内訳を見せる */
async function fundBackfill() {
  FUND.busy = true; FUND.msg = ""; FUND.error = false; render();
  try {
    const p = await cfg.callAdmin("fundBackfill", {});
    if (p.status === "already") { FUND.msg = "これまでの分は、もう足してあります。"; }
    else if (confirm(`基金ができる前に集めた分を、ゆう基金に足します（1回だけ）。\n・ゆう税：${fmt(p.tax)} コイン（${fmt(p.taxDays)}日分）\n・スリ：${fmt(p.theft)} コイン（${fmt(p.theftUsers)}人の、いちばん最近の1回）\n合計 ${fmt(p.total)} コイン。よろしいですか？`)) {
      const r = await cfg.callAdmin("fundBackfill", { apply: true });
      if (r.status === "done") FUND.msg = `✅ これまでの分 ${fmt(r.total)} コインを、ゆう基金に足しました。`;
      else if (r.status === "already") FUND.msg = "これまでの分は、もう足してあります。";
      else { FUND.msg = "ほかの処理とぶつかりました。もう一度押してください。"; FUND.error = true; }
    }
  } catch (error) { console.error("これまでの分の反映エラー:", error); FUND.msg = "うまくいきませんでした。もう一度お試しください。"; FUND.error = true; }
  FUND.busy = false;
  await load();
}
async function fundNow(t) {
  if (!confirm(`ゆう基金（いまの残り ${t.dataset.balance} コイン）を、総資産の少ない人から順に、今すぐ配ります（配り方は毎日 9:15 と同じ・1日1回）。よろしいですか？`)) return;
  FUND.busy = true; FUND.msg = ""; FUND.error = false; render();
  try {
    const r = await cfg.callAdmin("fundDistribute", {});
    if (r.status === "done") FUND.msg = `✅ ${fmt(r.count)}人に、合計 ${fmt(r.total)} コインを配りました。`;
    else if (r.status === "busy") { FUND.msg = "ほかの処理とぶつかりました。もう一度押してください。"; FUND.error = true; }
    else { FUND.msg = FUND_SKIP[r.reason] || "配れませんでした。"; FUND.error = true; }
  } catch (error) { console.error("ゆう基金の配布エラー:", error); FUND.msg = "うまくいきませんでした。もう一度お試しください。"; FUND.error = true; }
  FUND.busy = false;
  await load();
}
function spark(points) {
  const ys = points.map((p) => Number(p.avg) || 0);
  if (ys.length < 2) return "";
  const lo = Math.min(...ys), hi = Math.max(...ys), w = 260, h = 46;
  const pts = ys.map((y, i) => `${((i / (ys.length - 1)) * (w - 8) + 4).toFixed(1)},${(h - 4 - ((y - lo) / (hi - lo || 1)) * (h - 8)).toFixed(1)}`).join(" ");
  return `<svg class="yec-spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="1人あたりの総資産の推移"><polyline points="${pts}" fill="none" stroke="#7b2ff7" stroke-width="2"/></svg>`;
}

function render() {
  const el = document.getElementById("userManageEconomy");
  if (!el) return;
  if (!cfg || !cfg.isAdmin()) { el.innerHTML = ""; return; }
  const esc = cfg.esc, d = S.data;
  const head = `<div class="yec-head"><h3>📊 経済の状態（インフレの目安）</h3><button type="button" class="yec-btn" data-ec="load" ${S.busy ? "disabled" : ""}>${S.busy ? "読み込み中…" : "最新を読み込む"}</button></div>`;
  if (!d) { el.innerHTML = `${head}${S.msg ? `<p class="yec-err">${esc(S.msg)}</p>` : `<p class="yec-note">${S.busy ? "読み込んでいます…" : "読み込めていません。"}</p>`}`; return; }
  const c = d.current || {}, v = verdict(d.trend);
  const hist = (d.history || []).slice(-14);
  const rows = hist.map((p, i) => {
    const prev = i > 0 ? hist[i - 1] : null;
    const ch = prev && prev.avg > 0 ? (p.avg - prev.avg) / prev.avg : null;
    return `<tr><td>${esc(String(p.date).slice(5))}</td><td>${fmt(p.total)}</td><td>${fmt(p.avg)}</td><td class="${ch != null && ch >= 0.03 ? "yec-up" : ""}">${ch == null ? "－" : sgn(ch)}</td><td>${p.interestTotal == null ? "－" : fmt(p.interestTotal)}</td><td>${p.taxTotal == null ? "－" : fmt(p.taxTotal)}</td><td>${p.bonusGranted == null ? "－" : fmt(p.bonusGranted)}</td></tr>`;
  }).join("");
  const maxBand = Math.max(1, ...(c.bands || []).map((b) => b.users));
  const lot = (d.lotteries || []).map((l) => `<tr><td>${esc(l.id.slice(5))}</td><td>${esc(l.name)}</td><td>${fmt(l.sales)}</td><td>${fmt(l.paid)}</td><td class="${l.rtp != null && l.rtp > 1 ? "yec-up" : ""}">${l.done ? pct(l.rtp, 0) : "販売中"}</td></tr>`).join("");
  const bk = d.bankuji;
  el.innerHTML = `${head}
    <div class="yec-verdict yec-${v.cls}">${esc(v.text)}</div>
    ${dailyLine(d.daily, esc)}
    ${fundLine(d.fund, esc)}
    <p class="yec-note">コイン総量の更新：${c.date ? esc(c.date) : "－"}（${c.updatedAt ? esc(String(c.updatedAt).replace("T", " ").slice(0, 16)) + " UTC" : "－"}）</p>
    <div class="yec-grid">
      <div><small>総資産（合計）</small><b>${fmt(c.total)}</b></div><div><small>手持ちコイン</small><b>${fmt(c.coins)}</b></div>
      <div><small>預金</small><b>${fmt(c.deposit)}</b></div><div><small>株の評価額</small><b>${fmt(c.stockValue)}</b></div>
      <div><small>借入</small><b>${fmt(c.loan)}</b></div><div><small>人数</small><b>${fmt(c.users)}</b></div>
      <div><small>1人あたり（平均）</small><b>${fmt(c.avg)}</b></div><div><small>中央値</small><b>${fmt(c.median)}</b></div>
    </div>
    <h4>格差</h4>
    <p class="yec-note">上位1人：${pct(c.top1Share)}（${(d.top || [])[0] ? `${esc(d.top[0].name)} ${fmt(d.top[0].total)}` : "－"}）／上位10人：${pct(c.top10Share)}／ジニ係数：${c.gini}（0＝みんな同じ、1＝1人が全部）</p>
    <div class="yec-bands">${(c.bands || []).map((b) => `<div class="yec-band"><span>${BAND(b)}</span><i style="width:${Math.round((b.users / maxBand) * 100)}%"></i><em>${fmt(b.users)}人</em></div>`).join("")}</div>
    <h4>毎日の推移（直近14日）</h4>
    ${spark(hist)}
    ${rows ? `<table class="yec-table"><thead><tr><th>日</th><th>総資産</th><th>1人あたり</th><th>前日比</th><th>預金利息</th><th>ゆう税</th><th>ボーナス</th></tr></thead><tbody>${rows}</tbody></table><p class="yec-note">預金利息＝その日13:00に付いた利息の合計、ゆう税＝その日に集めた税の合計（消えるコイン）、ボーナス＝その日に追加ボーナス（500）をもらった人数。</p>` : `<p class="yec-note">まだ記録がありません（毎日13:00の処理のあと、1日1点ずつたまります）。</p>`}
    <h4>宝くじの収支（還元率が 100% を超えると、コインが増える側）</h4>
    ${lot ? `<table class="yec-table"><thead><tr><th>抽選日</th><th>名前</th><th>売上</th><th>賞金</th><th>還元率</th></tr></thead><tbody>${lot}</tbody></table>` : `<p class="yec-note">記録のある回がありません。</p>`}
    ${bk ? `<h4>ゆう番くじ</h4><p class="yec-note">売れた枚数：${fmt(bk.sold)} / ${fmt(bk.pool)}（売上 ${fmt(bk.sales)} コイン）／ コイン景品：${fmt(bk.coinPrizes)} コイン／ 株の景品：B賞 ${bk.stockPrizes.B}本（25株）・G賞 ${bk.stockPrizes.G}本（1〜3株）</p>` : ""}
    ${prizeHtml(esc)}
    ${(d.notes || []).map((n) => `<p class="yec-note">※${esc(n)}</p>`).join("")}
    ${S.msg ? `<p class="yec-err">${esc(S.msg)}</p>` : ""}`;
}

document.addEventListener("click", (event) => {
  const t = event.target.closest?.("[data-ec]");
  if (!t || !document.getElementById("userManageEconomy")?.contains(t) || S.busy || S.prize.busy) return;
  if (t.dataset.ec === "load") load();
  else if (t.dataset.ec === "prize-find") prizeFind();
  else if (t.dataset.ec === "prize-revoke") prizeRevoke(t);
  else if (t.dataset.ec === "limit-reset") limitReset();
  else if (t.dataset.ec === "fund-now") fundNow(t);
  else if (t.dataset.ec === "derby-settle") derbySettleNow();
  else if (t.dataset.ec === "lottery-repay") lotteryRepayNow();
  else if (t.dataset.ec === "fund-backfill") fundBackfill();
});

function ensureStyles() {
  if (stylesDone) return; stylesDone = true;
  const el = document.createElement("style"); el.id = "yec-style";
  el.textContent = `
  #userManageEconomy .yec-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; } #userManageEconomy .yec-head h3 { margin: 0; font-size: 15px; }
  #userManageEconomy h4 { margin: 14px 0 4px; font-size: 13px; }
  #userManageEconomy .yec-btn { border: none; border-radius: 10px; padding: 7px 12px; font-weight: 800; cursor: pointer; color: #fff; background: linear-gradient(135deg, #7b2ff7, #ff2d78); } #userManageEconomy .yec-btn:disabled { opacity: .5; }
  #userManageEconomy .yec-note { color: #666; font-size: 12px; line-height: 1.7; margin: 4px 0; } #userManageEconomy .yec-err { color: #c0392b; font-weight: 800; font-size: 13px; }
  #userManageEconomy .yec-verdict { margin: 8px 0 4px; padding: 10px 12px; border-radius: 10px; font-weight: 800; font-size: 13.5px; background: #f0eef6; }
  #userManageEconomy .yec-low { background: #e5f7ec; color: #1f7a45; } #userManageEconomy .yec-mid { background: #fff5d6; color: #8a6a00; } #userManageEconomy .yec-high { background: #fde4e1; color: #b3261e; } #userManageEconomy .yec-def { background: #e3effd; color: #1c5fb4; }
  #userManageEconomy .yec-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; margin: 8px 0; } #userManageEconomy .yec-grid > div { background: #f6f3ff; border-radius: 10px; padding: 8px 10px; }
  #userManageEconomy .yec-grid small { display: block; color: #777; font-size: 11px; } #userManageEconomy .yec-grid b { font-size: 16px; font-variant-numeric: tabular-nums; }
  #userManageEconomy .yec-band { display: grid; grid-template-columns: 90px 1fr 56px; gap: 6px; align-items: center; font-size: 12px; margin: 3px 0; } #userManageEconomy .yec-band i { display: block; height: 10px; border-radius: 5px; background: linear-gradient(90deg, #ffb300, #ff2d78); min-width: 2px; } #userManageEconomy .yec-band em { font-style: normal; text-align: right; }
  #userManageEconomy .yec-spark { width: 100%; max-width: 320px; height: 46px; display: block; }
  #userManageEconomy .yec-table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 6px 0; font-variant-numeric: tabular-nums; } #userManageEconomy .yec-table th, #userManageEconomy .yec-table td { padding: 4px 5px; border-bottom: 1px solid #eee; text-align: right; } #userManageEconomy .yec-table th:first-child, #userManageEconomy .yec-table td:first-child { text-align: left; } #userManageEconomy .yec-table td:nth-child(2) { text-align: left; }
  #userManageEconomy .yec-up { color: #c0392b; font-weight: 800; }
  #userManageEconomy .yec-row { display: flex; gap: 6px; align-items: center; margin: 6px 0; } #userManageEconomy select { padding: 6px; border: 1px solid #ccc; border-radius: 8px; }
  #userManageEconomy .yec-pz { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; background: #f6f3ff; border-radius: 10px; padding: 8px 10px; margin: 4px 0; font-size: 13px; }
  #userManageEconomy .yec-danger { background: #c0392b; } #userManageEconomy .yec-btn:disabled { opacity: .5; cursor: default; } #userManageEconomy .yec-ok { color: #2c8a52; font-weight: 800; font-size: 13px; }`;
  document.head.appendChild(el);
}
