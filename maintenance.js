/* =========================================================
   メンテナンス表示の切り替え
   ・MAINTENANCE_MODE を true にすると、一般のアクセスにはメンテナンス画面だけを表示し、
     アプリ本体（script.js）は読み込まない（Firebase への接続・読み書きも起きない）
   ・false にすると、これまで通りアプリ本体を読み込む
   ・テスト環境（localhost / 127.0.0.1 で開いたとき）は、MAINTENANCE_MODE に関係なくアプリを読み込む
   ・アプリ本体のファイル名（バージョン付き）は index.html の data-app-src に書く
========================================================= */

(function () {
  /* ↓ メンテナンスの ON / OFF はここだけで切り替える */
  const MAINTENANCE_MODE = false;

  const MAINTENANCE_TITLE = "緊急メンテナンスのお知らせ";
  const MAINTENANCE_BODY = [
    "現在、サーバー障害が発生しているため、ゆうChatを一時的にご利用いただけません。",
    "ご利用の皆様にはご迷惑をおかけしてしまい、誠に申し訳ございません。",
    "復旧に向けて対応を進めております。メンテナンス終了まで、今しばらくお待ちください。"
  ];
  /* 「現在のメンテナンス内容」の一覧（空なら見出しごと出さない） */
  const MAINTENANCE_ITEMS = [];

  const currentScript = document.currentScript;
  const appSrc = currentScript && currentScript.dataset.appSrc ? currentScript.dataset.appSrc : "./script.js";
  const isTestHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  function loadApp() {
    const script = document.createElement("script");
    script.type = "module";
    script.src = appSrc;
    document.body.appendChild(script);
  }

  function showMaintenance() {
    document.title = `${MAINTENANCE_TITLE} | ゆうChat`;
    const style = document.createElement("style");
    style.textContent = `
      html, body { margin: 0; min-height: 100%; background: #f5f6f8; }
      .maintenance-screen { min-height: 100vh; min-height: 100dvh; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
        padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
        font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; color: #111; }
      .maintenance-card { width: min(520px, 100%); box-sizing: border-box; padding: 28px 22px; background: #fff; border-radius: 18px;
        box-shadow: 0 10px 40px rgba(0,0,0,.08); }
      .maintenance-icon { font-size: 40px; line-height: 1; margin-bottom: 12px; text-align: center; }
      .maintenance-title { margin: 0 0 14px; font-size: 22px; font-weight: 800; text-align: center; }
      .maintenance-body { margin: 0 0 18px; font-size: 15px; line-height: 1.8; }
      .maintenance-body p { margin: 0 0 12px; }
      .maintenance-body p:last-child { margin-bottom: 0; }
      .maintenance-subtitle { margin: 0 0 8px; font-size: 13px; font-weight: 700; color: #555; }
      .maintenance-list { margin: 0; padding: 12px 14px 12px 30px; background: #f5f6f8; border-radius: 12px; font-size: 14px; line-height: 1.8; }
      .maintenance-footer { margin: 18px 0 0; font-size: 12px; color: #888; text-align: center; }`;
    document.head.appendChild(style);

    const screen = document.createElement("main");
    screen.className = "maintenance-screen";
    screen.setAttribute("role", "main");
    const card = document.createElement("section");
    card.className = "maintenance-card";

    const icon = document.createElement("div");
    icon.className = "maintenance-icon";
    icon.textContent = "🛠️";

    const title = document.createElement("h1");
    title.className = "maintenance-title";
    title.textContent = MAINTENANCE_TITLE;

    const body = document.createElement("div");
    body.className = "maintenance-body";
    MAINTENANCE_BODY.forEach((line) => {
      const p = document.createElement("p");
      p.textContent = line;
      body.appendChild(p);
    });

    const subtitle = document.createElement("h2");
    subtitle.className = "maintenance-subtitle";
    subtitle.textContent = "現在のメンテナンス内容";

    const list = document.createElement("ul");
    list.className = "maintenance-list";
    MAINTENANCE_ITEMS.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    });

    const footer = document.createElement("p");
    footer.className = "maintenance-footer";
    footer.textContent = "ゆうChat";

    card.append(icon, title, body);
    if (MAINTENANCE_ITEMS.length) card.append(subtitle, list);
    card.append(footer);
    screen.appendChild(card);

    /* 通常の画面（ログイン画面・チャットなど）は表示も操作もできないように取り除く */
    document.body.replaceChildren(screen);
  }

  if (MAINTENANCE_MODE && !isTestHost) {
    showMaintenance();
  } else {
    loadApp();
  }
})();
