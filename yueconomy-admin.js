/* 📊 経済の状態（インフレの目安）（管理者だけ。ユーザー管理タブに出す）
   ・Worker の economyReport を呼んで見せるだけ。コインの総量・分布・毎日の推移・宝くじとゆう番くじの収支を出す。
   ・何も書き換えない。読み取りは、開いたとき1回と「最新を読み込む」のとき（Worker 側で十数回ぶんの読み取り）。 */

let cfg = null;
const S = { data: null, busy: false, msg: "", loaded: false };
let stylesDone = false;

export function economyAdminInit(config) { cfg = config; }
export function economyAdminReset() { S.data = null; S.busy = false; S.msg = ""; S.loaded = false; const el = document.getElementById("userManageEconomy"); if (el) el.innerHTML = ""; }
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
    return `<tr><td>${esc(String(p.date).slice(5))}</td><td>${fmt(p.total)}</td><td>${fmt(p.avg)}</td><td class="${ch != null && ch >= 0.03 ? "yec-up" : ""}">${ch == null ? "－" : sgn(ch)}</td><td>${p.interestTotal == null ? "－" : fmt(p.interestTotal)}</td><td>${p.bonusGranted == null ? "－" : fmt(p.bonusGranted)}</td></tr>`;
  }).join("");
  const maxBand = Math.max(1, ...(c.bands || []).map((b) => b.users));
  const lot = (d.lotteries || []).map((l) => `<tr><td>${esc(l.id.slice(5))}</td><td>${esc(l.name)}</td><td>${fmt(l.sales)}</td><td>${fmt(l.paid)}</td><td class="${l.rtp != null && l.rtp > 1 ? "yec-up" : ""}">${l.done ? pct(l.rtp, 0) : "販売中"}</td></tr>`).join("");
  const bk = d.bankuji;
  el.innerHTML = `${head}
    <div class="yec-verdict yec-${v.cls}">${esc(v.text)}</div>
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
    ${rows ? `<table class="yec-table"><thead><tr><th>日</th><th>総資産</th><th>1人あたり</th><th>前日比</th><th>預金利息</th><th>ボーナス</th></tr></thead><tbody>${rows}</tbody></table><p class="yec-note">預金利息＝その日13:00に付いた利息の合計、ボーナス＝その日に追加ボーナス（500）をもらった人数。</p>` : `<p class="yec-note">まだ記録がありません（毎日13:00の処理のあと、1日1点ずつたまります）。</p>`}
    <h4>宝くじの収支（還元率が 100% を超えると、コインが増える側）</h4>
    ${lot ? `<table class="yec-table"><thead><tr><th>抽選日</th><th>名前</th><th>売上</th><th>賞金</th><th>還元率</th></tr></thead><tbody>${lot}</tbody></table>` : `<p class="yec-note">記録のある回がありません。</p>`}
    ${bk ? `<h4>ゆう番くじ</h4><p class="yec-note">売れた枚数：${fmt(bk.sold)} / ${fmt(bk.pool)}（売上 ${fmt(bk.sales)} コイン）／ コイン景品：${fmt(bk.coinPrizes)} コイン／ 株の景品：B賞 ${bk.stockPrizes.B}本（25株）・G賞 ${bk.stockPrizes.G}本（1〜3株）</p>` : ""}
    ${(d.notes || []).map((n) => `<p class="yec-note">※${esc(n)}</p>`).join("")}
    ${S.msg ? `<p class="yec-err">${esc(S.msg)}</p>` : ""}`;
}

document.addEventListener("click", (event) => {
  const t = event.target.closest?.("[data-ec]");
  if (!t || !document.getElementById("userManageEconomy")?.contains(t) || S.busy) return;
  if (t.dataset.ec === "load") load();
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
  #userManageEconomy .yec-up { color: #c0392b; font-weight: 800; }`;
  document.head.appendChild(el);
}
