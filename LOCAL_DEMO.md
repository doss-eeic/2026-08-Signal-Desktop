# 班8「Timesきんぐ」：Signal Desktop のローカル実験

東京大学「大規模ソフトウェアを手探る」2026年度の班用フォークです。
通常の Signal を利用する場合は [公式版](https://signal.org/download/) を使ってください。

## 残している変更

- **Enter送信の切替**：設定 → チャット → 文字入力のスイッチ。既定はオンで Enter が送信、オフでは Enter が改行、Ctrl+Enter（macOSでは⌘+Enter）が送信になります。
- **ローカルデモ**：本物の Desktop を `@signalapp/mock-server` に接続し、送信側Alice・受信側の2画面で試します。実際のスマホ・電話番号登録・QRコードは不要です。
- **改ざん・配達妨害の観察**：次の暗号文の1ビット反転、保留、原本の配達、同じ暗号文の再配達を試し、UIとログを比較できます。

Enter設定だけの上流向け変更は [PR #8071](https://github.com/signalapp/Signal-Desktop/pull/8071)、コミット `792cf8d29c5934545554f34d5a52379c9f267624` です。9ファイル・116行追加・1行削除。プロジェクト方針によりクローズされ、本家には採用されていません。ローカルデモと日本語表示は班のフォーク専用で、このPRには含めていません。

## 取得・ビルド

Node **24.22.0** と pnpm **11.24.0** を使います。指定は `.nvmrc` と `package.json` を参照してください。Nodeの版が違うと `EBADDEVENGINES` になることがあります。

macOSではXcode Command Line Tools、ほかのOSでは公式の [CONTRIBUTING.md](CONTRIBUTING.md) にあるネイティブ依存も必要です。Nodeのバージョン管理ツールを使う場合は、クローン後に `.nvmrc` の版へ切り替えます。

```bash
git clone --branch course-demo https://github.com/doss-eeic/2026-08-Signal-Desktop.git
cd 2026-08-Signal-Desktop
pnpm install --frozen-lockfile
pnpm run generate
```

`generate` はJavaScript・CSS・翻訳の型などを生成します。初回は依存取得とビルドに時間がかかります。ソースを変えた後も再実行してください。これは開発用のビルドで、署名付き配布パッケージの作成ではありません。

## スマホなしで起動

```bash
./start-local-demo.command
```

同じ処理を直接実行する場合：

```bash
node --import=tsx scripts/local-demo.node.ts
```

「Signal — 送信側Alice」と「Signal — 受信側」が開きます。Aliceとの会話は両画面から送受信でき、Bobは自動返信します。設定から Enter送信を切り替えて確かめてください。終了はアプリの⌘Qか、起動ターミナルのCtrl+Cです。

メッセージ用サーバーは `127.0.0.1` に限定して待ち受けます。保存データは毎回一時フォルダに作り、終了時に削除します。通常版のSignalデータは利用しません。実際のユーザーへの送信、通話、外部サービスが必要な機能は対象外です。

macOSでは送信側を別アプリとして扱うため、公式Electronを一時フォルダにコピーし、開発用識別子を付けてアドホック署名します。このコピーも終了時に削除します。

通常の `pnpm start` は、この自動セットアップ付きのデモとは別の起動方法です。実サービスを使う場合はスマホとのリンクが必要です。

## 改ざん・保留・再送

デモの起動後に <http://127.0.0.1:8790/> を開きます。このポートがほかのプロセスで使われている場合は、先にそちらを終了してください。

1. 送信側Aliceで「受信側」の会話、受信側でAliceの会話を開きます。
2. 操作画面で「次の送信側→受信側の配達を改ざんする」か「保留する」を選び、送信側で入力・送信します。
3. 受信側の本文やエラー、送信側のチェックマーク、アプリのログを比較します。
4. 「保管した正しい原本を届ける」で復旧を、「同じ暗号文を再送する」で重複時の動作を観察します。

介入は次の暗号化パケット1通だけです。既読通知などが先に送られると、それを捕捉する場合があります。操作画面の「介入待機を解除する」で取り消せます。

ボタンだけのサンプル配達は架空のスマホが送信するため、送信側Desktopには送信文が追加されません。既知の送信者からのサンプルと、Desktopからの通常の送信では、受信エラーの表示が異なる場合があります。表示がないことだけで、暗号文が受理されたとは判断しないでください。原本を先に配達した場合など、条件によってエラー表示が出ないこともあります。

この実験は悪意ある中継地点をモック内で再現します。通常の第三者がTLSを破らず改ざんできるという主張ではありません。libsignalの認証検証は無効化せず、暗号化済みEnvelopeのcontentだけを変更します。再送はアプリ側で重複排除される場合もあるため、libsignalまで届いたかはログで確認します。

操作APIには起動ごとのトークンと送信元チェックがあります。操作を実行した記録と、アプリから観測したログは区別して表示します。

## 確認コマンド

生成物を作成した後に実行します。

```bash
pnpm run check:types
node --import=tsx --test scripts/local-attack-lab_test.node.ts
pnpm exec mocha --require ts/test-mock/setup-ci.node.ts ts/test-mock/settings/settings_test.node.ts
```

最後のコマンドはElectronのモック統合テストです。GUIを起動できる環境が必要です。Enter設定の既定値、切替、再読み込み後の保持、改行付き送信を確認します。macOS以外での手動確認はまだ行っていません。

## 関係するファイル

- `ts/components/Preferences.dom.tsx`：設定スイッチ。
- `ts/state/smart/Preferences.preload.tsx`・`ts/types/StorageKeys.std.ts`：設定へのアクセスと保存キー。
- `ts/state/smart/CompositionArea.preload.tsx` → `ts/components/CompositionArea.dom.tsx` → `ts/components/CompositionInput.dom.tsx`：設定を入力欄へ渡し、キー処理を分岐。
- `ts/test-mock/settings/settings_test.node.ts`：設定の保持・送信の統合テスト。
- `scripts/local-demo.node.ts`・`local-demo.main.mjs`・`ts/CI.preload.ts`：本家のテスト用Bootstrapを使うローカル起動経路。
- `scripts/local-attack-lab.node.ts`：モック内の配達介入と操作画面。

Desktopの暗号処理には配布済みの `@signalapp/libsignal-client` を利用します。[班のlibsignalフォーク](https://github.com/doss-eeic/2026-08-libsignal)の変更が自動で反映されるわけではありません。

## 発表・関連資料

- [最終発表スライド](https://docs.google.com/presentation/d/1SXWFLHR3DxrsTqLRG38UogEDmFQduflitVboBue9ShU/edit?usp=sharing)
- [班の登録情報](https://github.com/doss-eeic/2026-teams#8-timesきんぐ)
- [上流の貢献ガイドライン](https://github.com/signalapp/Signal-Desktop/blob/main/CONTRIBUTING.md)

このフォークは上流のAGPLv3ライセンスと履歴を維持しています。
