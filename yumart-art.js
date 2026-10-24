/* 🏪 ゆうマートの商品の絵（パーツごとに、そのパーツの見た目を描く）。消しバトの3Dの見た目（yukeshi3d.js）と同じ色づかい。
   画像ファイル（mart-img/{部位}-{パーツ}.png）を置けば、そちらが優先される（yumart.js）。 */
const eraser = (fill = "#f4f1ea", extra = "") => `<rect x="9" y="20" width="46" height="24" rx="5" fill="${fill}" stroke="#bdb6a3" stroke-width="1.5"/>${extra}`;
const sleeve = `<rect x="25" y="17" width="14" height="30" rx="2" fill="#2f6fe0"/><rect x="25" y="17" width="14" height="3" fill="#fff" opacity=".85"/><rect x="25" y="44" width="14" height="3" fill="#fff" opacity=".85"/>`;
const dots = (c, pts) => pts.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`).join("");
const ART = {
  "body:sponge": () => eraser("#ffd84a") + dots("#d9a900", [[14, 26, 1.6], [20, 38, 1.4], [31, 24, 1.2], [44, 36, 1.7], [50, 25, 1.3], [36, 40, 1.2], [16, 33, 1], [48, 41, 1.1]]) + sleeve,
  "body:sand": () => eraser("#b8b2a4") + dots("#6e6a60", [[13, 25, 1.2], [18, 40, 1], [22, 28, 1.1], [33, 24, 1], [42, 41, 1.2], [47, 28, 1], [52, 36, 1.2], [37, 33, 1], [15, 33, 1.1], [28, 42, 1]]) + sleeve,
  "body:pro": () => `<defs><linearGradient id="gp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff5f8"/><stop offset="1" stop-color="#f7b5c8"/></linearGradient></defs>` + eraser("url(#gp)") + `<rect x="12" y="22" width="40" height="5" rx="2.5" fill="#fff" opacity=".7"/>` + sleeve,
  "body:titan": () => `<defs><linearGradient id="gt" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f1f3f6"/><stop offset=".5" stop-color="#b9c0c8"/><stop offset="1" stop-color="#8d949c"/></linearGradient></defs>` + eraser("url(#gt)") + `<rect x="14" y="30" width="36" height="4" rx="2" fill="#5d646c"/><rect x="12" y="22" width="40" height="3" rx="1.5" fill="#fff" opacity=".7"/>` + sleeve,
  "edge:plastic": () => eraser() + `<rect x="6" y="36" width="52" height="11" rx="4" fill="#9fd8ff" opacity=".6" stroke="#6bb8ee" stroke-width="1.2"/><rect x="9" y="38" width="30" height="2.5" rx="1" fill="#fff" opacity=".7"/>` + sleeve,
  "edge:band": () => eraser() + `<rect x="9" y="20" width="6" height="24" rx="2" fill="#d8262a"/><rect x="49" y="20" width="6" height="24" rx="2" fill="#d8262a"/>` + sleeve,
  "edge:metal": () => eraser() + `<rect x="6" y="36" width="52" height="11" rx="3" fill="#b9c0c8" stroke="#7d848c" stroke-width="1.2"/><rect x="9" y="38" width="46" height="2.5" rx="1" fill="#fff" opacity=".8"/><circle cx="12" cy="42" r="1.4" fill="#6b727a"/><circle cx="52" cy="42" r="1.4" fill="#6b727a"/>` + sleeve,
  "edge:crystal": () => eraser() + `<rect x="5" y="35" width="54" height="13" rx="5" fill="#66d0ff" opacity=".8" stroke="#2a9ad8" stroke-width="1.4"/><path d="M12 38l4-3 4 3M30 38l4-3 4 3M46 38l4-3 4 3" stroke="#fff" stroke-width="1.3" fill="none" opacity=".9"/><rect x="9" y="39" width="30" height="2.5" rx="1" fill="#fff" opacity=".7"/>` + sleeve + `<circle cx="54" cy="12" r="2" fill="#fff"/><circle cx="10" cy="10" r="1.4" fill="#bfeaff"/>`,
  "sole:tape": () => eraser() + sleeve + `<rect x="10" y="44" width="44" height="5" rx="2" fill="#f4d20a"/><path d="M16 44l-3 5M26 44l-3 5M36 44l-3 5M46 44l-3 5" stroke="#c9a900" stroke-width="1"/>`,
  "sole:wax": () => eraser() + sleeve + `<rect x="10" y="44" width="44" height="6" rx="3" fill="#fff1c9" stroke="#e8cf8a" stroke-width="1"/><rect x="14" y="45" width="20" height="1.8" rx=".9" fill="#fff"/>`,
  "sole:teflon": () => eraser() + sleeve + `<rect x="9" y="44" width="46" height="6" rx="2" fill="#131316"/><rect x="13" y="45" width="24" height="1.8" rx=".9" fill="#fff" opacity=".5"/>`,
  "sole:air": () => eraser() + sleeve + `<rect x="9" y="44" width="46" height="9" rx="4.5" fill="#c4ecff" opacity=".85" stroke="#7fc8ee" stroke-width="1.2"/>` + [16, 26, 36, 46].map((x) => `<circle cx="${x}" cy="48.5" r="2.6" fill="#fff" opacity=".8"/>`).join(""),
  "weight:coin": () => `<circle cx="32" cy="32" r="20" fill="#c97a3a" stroke="#8a4d1f" stroke-width="2"/><circle cx="32" cy="32" r="15" fill="none" stroke="#e8a566" stroke-width="1.5"/><text x="32" y="38" text-anchor="middle" font-size="17" font-weight="900" fill="#fbe0bf" font-family="sans-serif">10</text><path d="M18 22a17 17 0 0 1 12-8" stroke="#fff" stroke-width="2" fill="none" opacity=".5" stroke-linecap="round"/>`,
  "weight:bolt": () => `<polygon points="32,10 49,20 49,42 32,52 15,42 15,20" fill="#aab0b8" stroke="#6b727a" stroke-width="2"/><polygon points="32,10 49,20 32,30 15,20" fill="#d6dbe0"/><circle cx="32" cy="35" r="8" fill="#8d949c" stroke="#5d646c" stroke-width="1.5"/><circle cx="32" cy="35" r="3.5" fill="#4a5058"/>`,
  "weight:lead": () => `<polygon points="12,28 22,16 54,16 44,28" fill="#6a6e76"/><rect x="12" y="28" width="32" height="20" fill="#4a4d54"/><polygon points="44,28 54,16 54,36 44,48" fill="#383b41"/><rect x="15" y="31" width="14" height="3" rx="1.5" fill="#fff" opacity=".25"/>`,
  "weight:gold": () => `<polygon points="10,30 21,16 55,16 44,30" fill="#ffe27a"/><rect x="10" y="30" width="34" height="20" fill="#ffc933"/><polygon points="44,30 55,16 55,36 44,50" fill="#d99a00"/><rect x="14" y="34" width="16" height="3" rx="1.5" fill="#fff" opacity=".6"/><path d="M50 8l1.5 3.5L55 13l-3.5 1.5L50 18l-1.5-3.5L45 13l3.5-1.5z" fill="#fff"/>`
};
const BG = { body: ["#fff1d6", "#ffe0e8"], edge: ["#e3f3ff", "#eaf0ff"], sole: ["#f1ffe3", "#e3f7f3"], weight: ["#f1eee8", "#e6e2dc"] };
/* 商品の絵（SVG の文字列）。id は中古の ~u が付いていてもよい（見た目は同じ） */
export function partArt(slot, id) {
  const base = String(id).replace(/~u$/, "");
  const draw = ART[`${slot}:${base}`];
  const [c1, c2] = BG[slot] || BG.body;
  if (!draw) return `<svg class="ym-art" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" fill="${c1}"/><text x="32" y="42" text-anchor="middle" font-size="28">📦</text></svg>`;
  const gid = `bg-${slot}-${base}`;
  return `<svg class="ym-art" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="64" height="64" fill="url(#${gid})"/>${draw()}</svg>`;
}
export const MART_ART_KEYS = Object.keys(ART);

/* 確変枠・番くじ景品の絵 */
const wrap = (c1, c2, body, id) => `<svg class="ym-art" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="64" height="64" fill="url(#${id})"/>${body}</svg>`;
/* 確変台の枠：虹のスロット台 */
export function kakuArt() {
  const rainbow = ["#ff4d4d", "#ffa534", "#ffe14a", "#4cd964", "#4aa8ff", "#a06bff"].map((c, i) => `<path d="M${8 + i * 2} 30a${24 - i * 2} ${24 - i * 2} 0 0 1 ${48 - i * 4} 0" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>`).join("");
  return wrap("#2a1b52", "#5a2d86", `${rainbow}<rect x="14" y="30" width="36" height="24" rx="4" fill="#fff" stroke="#c9b8ff" stroke-width="1.5"/><rect x="18" y="34" width="8" height="12" rx="2" fill="#ffe9f2"/><rect x="28" y="34" width="8" height="12" rx="2" fill="#ffe9f2"/><rect x="38" y="34" width="8" height="12" rx="2" fill="#ffe9f2"/><text x="22" y="44" text-anchor="middle" font-size="9" font-weight="900" fill="#e5262e" font-family="sans-serif">7</text><text x="32" y="44" text-anchor="middle" font-size="9" font-weight="900" fill="#e5262e" font-family="sans-serif">7</text><text x="42" y="44" text-anchor="middle" font-size="9" font-weight="900" fill="#e5262e" font-family="sans-serif">7</text><rect x="22" y="48" width="20" height="3" rx="1.5" fill="#c9b8ff"/>`, "bg-kaku");
}
const COLORS = { gold: ["#ffe27a", "#d99a00"], silver: ["#f1f3f6", "#8d949c"], rainbow: ["#ff7ab8", "#4aa8ff"], blackgold: ["#2b2b30", "#b8860b"] };
const GEAR_SLOT = { body: "本体", edge: "ふち", sole: "そこ", weight: "おもり" };
export function prizeArt(pid, code) {
  const id = `bg-prize-${pid}`;
  if (pid === "A") return wrap("#fff7d6", "#ffd24a", `<rect x="16" y="14" width="32" height="38" rx="2" fill="#4a6bff"/><rect x="16" y="14" width="32" height="6" fill="#2f4bd0"/>${[0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => `<rect x="${21 + c * 9}" y="${24 + r * 9}" width="5" height="5" rx="1" fill="#ffe9a8"/>`)).join("")}<rect x="28" y="44" width="8" height="8" fill="#ffb300"/><path d="M32 6l2 4 4 .6-3 3 .8 4-3.8-2-3.8 2 .8-4-3-3 4-.6z" fill="#ff6a00"/>`, id);
  if (pid === "C" || pid === "D") return wrap(pid === "C" ? "#efe3ff" : "#ffe9f2", pid === "C" ? "#c9a8ff" : "#ffb3cf", `<path d="M8 22h48v6a4 4 0 0 0 0 8v6H8v-6a4 4 0 0 0 0-8z" fill="#fff" stroke="${pid === "C" ? "#8a5cd0" : "#e0457b"}" stroke-width="2"/><path d="M22 22v20" stroke="${pid === "C" ? "#8a5cd0" : "#e0457b"}" stroke-width="1.5" stroke-dasharray="2 2"/><text x="40" y="38" text-anchor="middle" font-size="${pid === "C" ? 14 : 11}" font-weight="900" fill="${pid === "C" ? "#8a5cd0" : "#e0457b"}" font-family="sans-serif">${pid === "C" ? "×3" : "優先"}</text><text x="15" y="36" text-anchor="middle" font-size="9" fill="#999" font-family="sans-serif">🌈</text>`, id);
  if (pid === "E") return wrap("#e3f3ff", "#c4e0ff", `<g transform="translate(32 32)">${Array.from({ length: 8 }, (_, i) => `<rect x="-3.5" y="-22" width="7" height="9" rx="1.5" fill="#6b727a" transform="rotate(${i * 45})"/>`).join("")}<circle r="15" fill="#b9c0c8" stroke="#6b727a" stroke-width="2"/><circle r="6" fill="#e3f3ff" stroke="#6b727a" stroke-width="2"/></g><text x="32" y="60" text-anchor="middle" font-size="7" font-weight="900" fill="#445" font-family="sans-serif">${GEAR_SLOT[code] || ""}</text>`, id);
  if (pid === "F") { const [a, b] = COLORS[code] || COLORS.gold; return wrap("#fff", "#f0ecf5", `<path d="M32 10c-14 0-24 9-24 20 0 7 5 9 10 9 4 0 5 3 5 6 0 4 3 9 9 9 12 0 19-10 19-22 0-12-8-22-19-22z" fill="url(#pal-${code})" stroke="#999" stroke-width="1.5"/><defs><linearGradient id="pal-${code}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><circle cx="22" cy="26" r="3" fill="#fff" opacity=".7"/><circle cx="34" cy="20" r="3" fill="#fff" opacity=".7"/><circle cx="46" cy="28" r="3" fill="#fff" opacity=".7"/>`, id); }
  return wrap("#f4f1ea", "#e6e2dc", `<text x="32" y="42" text-anchor="middle" font-size="28">🎁</text>`, id);
}
