-- 大会
CREATE TABLE tournaments (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,          -- 閲覧・関係者URLに使う推測されにくいID
  name TEXT NOT NULL,
  date TEXT,                          -- 開始日 YYYY-MM-DD
  end_date TEXT,                      -- 終了日（1日開催なら空）
  settings TEXT,                      -- 要項・駐車券などの設定（JSON）
  owner_id TEXT,                      -- 作成した管理者（空なら全体管理者）
  venue TEXT,
  logo TEXT,                          -- data URL（小さな画像のみ）
  show_logo INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | published | live | finished
  pin TEXT NOT NULL,                  -- 関係者用の大会共通PIN
  pin_version INTEGER NOT NULL DEFAULT 1,
  rev INTEGER NOT NULL DEFAULT 1,     -- 変更のたびに増える（閲覧画面の更新検知用）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- カテゴリ（U7〜U12）。コートはカテゴリごとに独立
CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL,               -- 試合時間・形式・判定順などのJSON
  created_at TEXT NOT NULL
);
CREATE INDEX idx_categories_tournament ON categories(tournament_id);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  short_name TEXT,
  club TEXT,                          -- 同じクラブは別の組に分ける
  logo TEXT,
  group_label TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_teams_category ON teams(category_id);

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,                -- league | knockout
  group_label TEXT,
  round INTEGER,
  code TEXT,                          -- トーナメントの参照用（K1, K2...）
  label TEXT,
  slot INTEGER NOT NULL,
  court INTEGER NOT NULL,
  start_min INTEGER NOT NULL,
  session TEXT NOT NULL DEFAULT 'am', -- am | pm（昼休憩の前後）
  home_team_id TEXT,
  away_team_id TEXT,
  home_ref TEXT,                      -- 「A組1位」などの参照JSON
  away_ref TEXT,
  place_w INTEGER,                    -- この試合の勝者が得る最終順位
  place_l INTEGER,
  home_score INTEGER,
  away_score INTEGER,
  home_pk INTEGER,
  away_pk INTEGER,
  forfeit TEXT,                       -- 不戦勝の勝者 home | away
  status TEXT NOT NULL DEFAULT 'none', -- none | provisional | confirmed
  updated_by TEXT,
  updated_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  time_changed INTEGER NOT NULL DEFAULT 0,
  corrected INTEGER NOT NULL DEFAULT 0,
  ref_conflict INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_matches_category ON matches(category_id);

-- 審判（次フェーズで使用。今は定義のみ）
CREATE TABLE match_officials (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                 -- referee | assistant1 | assistant2 | fourth
  team_id TEXT,
  name TEXT
);

-- 形式テンプレート
CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  owner_id TEXT,
  shared INTEGER NOT NULL DEFAULT 0,  -- 全体管理者のものを地域管理者に公開するか
  created_at TEXT NOT NULL
);

-- PIN・パスワードの試行回数制限
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- スポンサー（バナーとリンク先）
CREATE TABLE sponsors (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  image TEXT NOT NULL,              -- data URL
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sponsors_tournament ON sponsors(tournament_id);

-- スポンサーの日ごとのクリック数
CREATE TABLE sponsor_clicks (
  sponsor_id TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sponsor_id, day)
);

-- 添付画像（要項の施設案内など。owner は大会ID か preset:プリセットID）
CREATE TABLE assets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, image TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_assets_owner ON assets(owner);

-- 忘れ物
CREATE TABLE lost_items (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL, image TEXT, note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_lost_tournament ON lost_items(tournament_id);

-- プリセット（要項など）
CREATE TABLE presets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, owner_id TEXT, shared INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

-- 管理者（地域管理者など。全体管理者は環境変数のパスワードでログイン）
CREATE TABLE users (id TEXT PRIMARY KEY, login_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, region TEXT, role TEXT NOT NULL DEFAULT 'region',
  pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, iterations INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, session_ver INTEGER NOT NULL DEFAULT 1,
  parent_id TEXT, scope TEXT,           -- スコア管理者：発行した管理者と担当大会（JSON）
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT);
