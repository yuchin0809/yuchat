# ゆうChat の iPhone アプリ

Web版（GitHub Pages）を、iPhone アプリの枠で包むだけのもの。中身を直すと、アプリにもそのまま反映される（枠の作り直しは不要）。

- 識別名（Bundle ID）: `jp.yuchat.app`／チーム ID: `QAQ2VTWZCF`
- アプリの中では、Google ログインと、サポーターの案内は出さない（`YuChatApp` という目印で見分ける）
- 作るのは GitHub Actions の「iPhoneアプリ（ビルドして App Store Connect へ送る）」。Mac は要らない
- 必要な鍵（Secrets）: `ASC_KEY_ID`・`ASC_ISSUER_ID`・`ASC_KEY_P8`（App Store Connect の API キー。**公開リポジトリなので、絶対にコードやチャットに貼らない**）
