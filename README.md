# MARKET STUDIO Cloud News

PC・Excel・MarketSpeed IIから独立して、総務省統計局と日本銀行の公式RSSを毎日07:00/18:00 JSTに取得します。

- `data/news-memory.json`: 初回確認時刻を含む継続記録（最大5,000件）
- `public/news-program.json`: MARKET STUDIOが読む60秒ニュース
- `public/status.json`: 最終実行と取得成否
- Geminiキー未設定・障害時は、取得できた公式本文だけを使うルールベース編集へフォールバック

GitHub PagesのSourceは「GitHub Actions」を選択します。APIキーを使う場合だけRepository secret `GEMINI_API_KEY` を登録します。
