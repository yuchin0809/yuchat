# ゆうChat の iPhone アプリ

サイトの画面から、賭けに関係する機能（競馬・スロット・くじ・確変台）を **最初から入れずに** `node ios-app/build-www.mjs` で書き出し、アプリの中（`www`）に入れる。サイトを直したら、アプリは作り直して提出する（ソースの `#if WEB … #else … #endif` の WEB 側がアプリに入らない）。

- 識別名（Bundle ID）: `jp.yuchat.app`／チーム ID: `QAQ2VTWZCF`
- アプリの中では、Google ログインと、サポーターの案内は出さない（`YuChatApp` という目印で見分ける）
- 作るのは GitHub Actions の「iPhoneアプリ（ビルドして App Store Connect へ送る）」。Mac は要らない
- 必要な鍵（Secrets）: `ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`（App Store Connect の API キー。**公開リポジトリなので、絶対にコードやチャットに貼らない**）
