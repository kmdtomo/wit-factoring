# Wit Factoring - Mastra AI Agent

ファクタリング審査の自動化AIエージェント（Mastraフレームワーク使用）

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. 環境変数の設定

`.env.example`をコピーして`.env`を作成し、必要な値を設定してください：

```bash
cp .env.example .env
```

### 3. 開発サーバーの起動

```bash
npm run dev
```

Playgroundが起動します:
- Playground: http://localhost:4111/
- API: http://localhost:4111/api

## プロジェクト構造

```
src/mastra/
├── index.ts        # Mastraインスタンス
├── tools/          # ツール定義
├── workflows/      # ワークフロー定義
└── agents/         # エージェント定義
```

## コマンド

- `npm run dev` - 開発サーバー起動（ホットリロード対応）
- `npm run build` - プロダクションビルド
- `npm start` - プロダクションサーバー起動

## 次のステップ

1. GitHubリポジトリを作成
2. 初回コミット＆プッシュ
3. Renderと連携
4. tools/workflowsを段階的に追加
