// 画面のファイル（HTML・CSS・JavaScript）はWorkerに同梱して配信する。
// これにより、すべてのファイルを1つのフォルダに並べたまま動かせる。
import INDEX_HTML from './index.html';
import APP_CSS from './app.css';
import MANIFEST from './manifest.webmanifest';
import { FAVICON_SVG, ICONS } from './icons.js';
import WEB_APP from './web-app.js';
import WEB_API from './web-api.js';
import WEB_UI from './web-ui.js';
import WEB_VIEWS from './web-views.js';
import WEB_VIEWER from './web-viewer.js';
import WEB_RELATIVE from './web-relative.js';
import WEB_ADMIN from './web-admin.js';
import WEB_PRINT from './web-print.js';
import WEB_OUTLINE from './web-outline.js';
import WEB_QR from './web-qr.js';
import WEB_XLSX from './web-xlsx.js';
import WEB_PAMPHLET from './web-pamphlet.js';
import WEB_SCORE from './web-score.js';
import { normalizeConfig, matchLength } from './time.js';
import { assignGroups, shuffle } from './grouping.js';
import { generateCategory, applyTimes, planDelay, scheduleWarnings } from './schedule.js';
import { evaluateCategory } from './standings.js';
import { issueAdmin, readAdmin, hashPassword, verifyPassword, issueRelative, isRelative, rateLimit, clearRateLimit, safeEqual, cookie } from './auth.js';

// ---------- 共通 ----------

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });

const now = () => new Date().toISOString();

// 閲覧ページ・結果の登録ページのデータを、版ごとに一時保存して使い回す。
// 大会の版が変わるまで内容は同じなので、同じ拠点に来た問い合わせはデータベースを読まずに返せる。
// 同時に大勢から問い合わせが来たときも、読み込みは1回にまとめる（読み込み中の処理を共有）。
const PAYLOAD_CACHE = new Map();
const PAYLOAD_PENDING = new Map();
const jsonText = (text, how) => new Response(text, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Payload-Cache': how } });
async function cachedPayload(key, origin, build) {
  if (PAYLOAD_CACHE.has(key)) return jsonText(PAYLOAD_CACHE.get(key), 'hit');
  // 独自ドメインでは Cache API（拠点の共有キャッシュ）も使う。workers.dev では使えないので、そのときは何もしない
  const ckey = new Request(`${origin}/__payload/${encodeURIComponent(key)}`);
  let cache = null;
  try { cache = caches.default; const hit = await cache.match(ckey); if (hit) { const text = await hit.text(); remember(key, text); return jsonText(text, 'edge'); } } catch { cache = null; }
  const shared = PAYLOAD_PENDING.has(key);
  if (!shared) {
    PAYLOAD_PENDING.set(key, (async () => {
      try {
        const text = JSON.stringify(await build());
        remember(key, text);
        if (cache) { try { await cache.put(ckey, new Response(text, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' } })); } catch { /* 使えない環境では無視 */ } }
        return text;
      } finally { PAYLOAD_PENDING.delete(key); }
    })());
  }
  return jsonText(await PAYLOAD_PENDING.get(key), shared ? 'shared' : 'miss');
}
function remember(key, text) {
  PAYLOAD_CACHE.set(key, text);
  while (PAYLOAD_CACHE.size > 40) PAYLOAD_CACHE.delete(PAYLOAD_CACHE.keys().next().value); // 古いものから捨てる
}
const uid = () => crypto.randomUUID();
const randomSlug = (n = 10) => {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
};
const randomPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

const MAX_LOGO = 300_000;
function checkLogo(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(v)) fail(400, 'ロゴは PNG・JPEG・WebP・SVG の画像を選んでください');
  if (v.length > MAX_LOGO) fail(400, 'ロゴの画像が大きすぎます（300KBまで）');
  return v;
}

// 名前などの長さを制限する（表示崩れや極端に大きなデータを防ぐ）
const clip = (v, max = 100) => String(v ?? '').trim().slice(0, max);

const intOrNull = (v) => (v === '' || v == null ? null : Math.max(0, Math.min(99, Math.trunc(Number(v)))));

// ---------- データベースの項目の自動追加 ----------
// 新しい版で増えた項目を、初回アクセス時に自動で追加する（コンソールでの作業を不要にするため）
let schemaChecked = false;
async function ensureSchema(db) {
  if (schemaChecked) return;
  const cols = (await db.prepare('PRAGMA table_info(tournaments)').all()).results.map((c) => c.name);
  if (!cols.includes('end_date')) {
    try { await db.prepare('ALTER TABLE tournaments ADD COLUMN end_date TEXT').run(); }
    catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  if (!cols.includes('owner_id')) {
    try { await db.prepare('ALTER TABLE tournaments ADD COLUMN owner_id TEXT').run(); }
    catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  if (!cols.includes('settings')) {
    try { await db.prepare('ALTER TABLE tournaments ADD COLUMN settings TEXT').run(); }
    catch (e) { if (!/duplicate column/i.test(String(e))) throw e; }
  }
  const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results.map((r) => r.name);
  if (!tables.includes('users')) {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, login_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, region TEXT, role TEXT NOT NULL DEFAULT 'region',
        pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, iterations INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, session_ver INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT)`),
    ]);
  }
  if (!tables.includes('assets') || !tables.includes('lost_items') || !tables.includes('presets')) {
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, owner TEXT NOT NULL, image TEXT NOT NULL, created_at TEXT NOT NULL)'),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS lost_items (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL, image TEXT, note TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_lost_tournament ON lost_items(tournament_id)'),
      db.prepare('CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)'),
    ]);
  }
  if (!tables.includes('sponsors') || !tables.includes('sponsor_clicks')) {
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS sponsors (id TEXT PRIMARY KEY, tournament_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
        image TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_sponsors_tournament ON sponsors(tournament_id)'),
      db.prepare('CREATE TABLE IF NOT EXISTS sponsor_clicks (sponsor_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (sponsor_id, day))'),
    ]);
  }
  const addCol = async (tb, col, def) => {
    const cs = (await db.prepare(`PRAGMA table_info(${tb})`).all()).results.map((c) => c.name);
    if (!cs.length || cs.includes(col)) return false;
    try { await db.prepare(`ALTER TABLE ${tb} ADD COLUMN ${col} ${def}`).run(); return true; }
    catch (e) { if (!/duplicate column/i.test(String(e))) throw e; return false; }
  };
  for (const tb of ['templates', 'presets']) {
    await addCol(tb, 'owner_id', 'TEXT');
    // 全体管理者のものを地域管理者に公開するか。追加した時点の既存分は、これまでどおり公開のまま引き継ぐ
    if (await addCol(tb, 'shared', 'INTEGER NOT NULL DEFAULT 0')) {
      await db.prepare(`UPDATE ${tb} SET shared = 1 WHERE owner_id IS NULL OR owner_id = 'root'`).run();
    }
  }
  // スコア管理者：発行した管理者（parent_id）と担当する大会（scope：JSON。空ならすべて）
  await addCol('users', 'parent_id', 'TEXT');
  await addCol('users', 'scope', 'TEXT');
  // 全体管理者の大会を地域管理者に共有（'all' = すべての地域管理者、["ユーザーID", ...] = 選んだ地域管理者）
  await addCol('tournaments', 'shared_with', 'TEXT');
  // 閲覧ページ向けの版：保護者に見える内容が変わったときだけ上げる（関係者の仮登録では上げない）
  await addCol('tournaments', 'pub_rev', 'INTEGER NOT NULL DEFAULT 0');
  schemaChecked = true;
}

// 開催期間（開始日〜終了日、最大4日）
const MAX_DAYS = 4;
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function tournamentDates(t) {
  if (!t.date) return [];
  const out = [t.date];
  if (t.end_date && t.end_date > t.date) {
    for (let i = 1; i < MAX_DAYS; i++) {
      const d = addDays(t.date, i);
      if (d > t.end_date) break;
      out.push(d);
    }
  }
  return out;
}
function checkRange(date, end) {
  if (!date) return null;
  if (!end || end === date) return null;
  if (end < date) fail(400, '終了日は開始日より後の日付にしてください');
  if (end > addDays(date, MAX_DAYS - 1)) fail(400, `開催期間は最大${MAX_DAYS}日までです`);
  return end;
}

// ---------- 書き込み ----------
// 大きな大会（300試合など）でも確実に保存できるよう、100件ずつに分けて実行する
async function batchAll(db, stmts, size = 100) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

// ---------- 管理者（全体管理者・地域管理者） ----------
// 全体管理者は環境変数のパスワードでログインする（ID は ADMIN_ID、既定は admin）
const ROOT = { id: 'root', role: 'super', name: '全体管理者', region: '', login_id: 'admin' };
async function currentUser(req, env, db) {
  const a = await readAdmin(req, env);
  if (!a) return null;
  if (a.uid === 'root') return { ...ROOT, login_id: env.ADMIN_ID || 'admin' };
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(a.uid).first();
  if (!u || !u.active || u.session_ver !== a.ver) return null;
  const me = { id: u.id, role: u.role, name: u.name, region: u.region || '', login_id: u.login_id };
  if (u.role === 'scorer') {
    // 発行した管理者が停止・削除されていたら使えない
    let parentRole = 'super';
    if (u.parent_id && u.parent_id !== 'root') {
      const p = await db.prepare('SELECT role, active, region, name FROM users WHERE id = ?').bind(u.parent_id).first();
      if (!p || !p.active) return null;
      parentRole = p.role;
      me.region = p.region || '';
      me.parentName = p.name;
    } else me.parentName = '全体管理者';
    me.parent_id = u.parent_id || 'root';
    me.parentRole = parentRole;
    try { me.scope = JSON.parse(u.scope || '[]'); } catch { me.scope = []; }
  }
  return me;
}
const isSuper = (user) => user && user.role === 'super';
// 大会を操作できるか：全体管理者はすべて、地域管理者は自分が作った大会だけ（所有者の無い既存の大会は全体管理者のもの）
const canAccess = (user, t) => {
  if (!user || isSuper(user)) return true;
  if (user.role === 'scorer') {
    // スコア管理者：発行した管理者が見られる大会のうち、担当に選ばれた大会（未指定ならすべて）
    const parentOk = user.parentRole === 'super' || (t.owner_id && t.owner_id === user.parent_id);
    return parentOk && (!user.scope || !user.scope.length || user.scope.includes(t.id));
  }
  return !!(t.owner_id && t.owner_id === user.id);
};
const mustSuper = (user) => { if (!isSuper(user)) fail(403, '全体管理者だけが使える機能です'); };
// テンプレート・プリセット：自分のもの＋共通（全体管理者が作ったもの）を使える。変更は作成者と全体管理者だけ
const ownerOf = (user) => (isSuper(user) ? 'root' : user.id); // 全体管理者が作ったものは「共通」
const sharedOwner = (o) => !o || o === 'root';
const canEditOwned = (user, owner) => isSuper(user) || owner === user.id;

// ---------- スコア管理者（結果の承認だけを行うアカウント） ----------

// 発行した管理者として、担当大会の指定が正しいか（自分が見られる大会だけ）
async function checkScope(db, user, ids) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  for (const id of list) await getTournament(db, id, user);
  return list;
}
const canManageScorer = (user, sc) => sc && sc.role === 'scorer' && (isSuper(user) || sc.parent_id === user.id);

// ---------- 読み込み ----------

function parseMatch(r) {
  return { ...r, home_ref: r.home_ref ? JSON.parse(r.home_ref) : null, away_ref: r.away_ref ? JSON.parse(r.away_ref) : null };
}

async function getTournament(db, id, user) {
  const t = await db.prepare('SELECT * FROM tournaments WHERE id = ?').bind(id).first();
  if (!t || !canAccess(user, t)) fail(404, '大会が見つかりません');
  return t;
}

// 共有：地域管理者は、全体管理者から共有された大会を「閲覧とコピー」だけできる
const sharedWith = (t) => { try { return JSON.parse(t.shared_with || 'null'); } catch { return null; } };
const isSharedTo = (user, t) => {
  if (!user || user.role !== 'region') return false;
  const s = sharedWith(t);
  return s === 'all' || (Array.isArray(s) && s.includes(user.id));
};
// 閲覧用の取得（自分の大会に加えて、共有された大会も。共有された大会には readonly を付ける）
async function getTournamentForRead(db, id, user) {
  const t = await db.prepare('SELECT * FROM tournaments WHERE id = ?').bind(id).first();
  if (!t) fail(404, '大会が見つかりません');
  if (canAccess(user, t)) return { ...t, readonly: false };
  if (isSharedTo(user, t)) return { ...t, readonly: true };
  fail(404, '大会が見つかりません');
}

async function getTournamentBySlug(db, slug) {
  const t = await db.prepare('SELECT * FROM tournaments WHERE slug = ?').bind(slug).first();
  if (!t) fail(404, '大会が見つかりません');
  return t;
}

// 20秒ごとの更新確認用。ロゴなどの大きな列を読まない
async function getTournamentHead(db, slug) {
  const t = await db.prepare('SELECT id, slug, status, rev, pub_rev, pin_version FROM tournaments WHERE slug = ?').bind(slug).first();
  if (!t) fail(404, '大会が見つかりません');
  return t;
}

async function getCategory(db, id, user) {
  const c = await db.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
  if (!c) fail(404, 'カテゴリが見つかりません');
  if (user) await getTournament(db, c.tournament_id, user);
  c.config = normalizeConfig(JSON.parse(c.config));
  return c;
}

async function loadCategoryData(db, cid) {
  const [teams, matches] = await Promise.all([
    db.prepare('SELECT * FROM teams WHERE category_id = ? ORDER BY sort, name').bind(cid).all(),
    db.prepare('SELECT * FROM matches WHERE category_id = ? ORDER BY start_min, court').bind(cid).all(),
  ]);
  return { teams: teams.results, matches: matches.results.map(parseMatch) };
}

async function loadFull(db, t) {
  const cats = (await db.prepare('SELECT * FROM categories WHERE tournament_id = ? ORDER BY sort, created_at').bind(t.id).all()).results;
  const out = [];
  for (const c of cats) {
    c.config = normalizeConfig(JSON.parse(c.config));
    const { teams, matches } = await loadCategoryData(db, c.id);
    const ev = evaluateCategory(c.config, teams, matches);
    out.push({ id: c.id, name: c.name, sort: c.sort, config: c.config, teams, matches, standings: ev.standings, finalRanking: ev.finalRanking });
  }
  return out;
}

// 大会の版を上げる。pub = false のとき（関係者の仮登録など保護者に見えない変更）は、閲覧ページ向けの版は上げない
async function bump(db, tid, pub = true) {
  await db.prepare('UPDATE tournaments SET rev = rev + 1, pub_rev = pub_rev + ?, updated_at = ? WHERE id = ?').bind(pub ? 1 : 0, now(), tid).run();
}

// 予選・トーナメントの結果から、まだ始まっていない試合のチームを差し替える
async function syncKnockout(db, cat) {
  const { teams, matches } = await loadCategoryData(db, cat.id);
  const ev = evaluateCategory(cat.config, teams, matches);
  const stmts = ev.updates.map((u) =>
    db.prepare('UPDATE matches SET home_team_id = ?, away_team_id = ? WHERE id = ?').bind(u.home_team_id, u.away_team_id, u.id));
  const conflict = new Set(ev.conflicts);
  for (const m of matches.filter((x) => x.stage === 'knockout')) {
    const flag = conflict.has(m.id) ? 1 : 0;
    if (flag !== m.ref_conflict) stmts.push(db.prepare('UPDATE matches SET ref_conflict = ? WHERE id = ?').bind(flag, m.id));
  }
  if (stmts.length) await batchAll(db, stmts);
}

// ---------- スポンサー ----------

const MAX_BANNER = 700_000;
function checkBanner(v) {
  if (typeof v !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(v)) fail(400, 'バナーは PNG・JPEG・WebP の画像を選んでください');
  if (v.length > MAX_BANNER) fail(400, 'バナーの画像が大きすぎます');
  return v;
}
function checkUrl(v) {
  const u = String(v || '').trim();
  if (u.length > 500) fail(400, 'リンク先のURLが長すぎます');
  if (!/^https?:\/\/[^\s]+$/i.test(u)) fail(400, 'リンク先は https:// から始まるURLを入力してください');
  return u;
}
const jstDay = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const sponsorImg = (sp) => `/img/s/${sp.id}?v=${encodeURIComponent(sp.updated_at)}`;

async function listSponsors(db, tid, withStats = false) {
  const rows = (await db.prepare('SELECT id, tournament_id, name, url, sort, active, created_at, updated_at FROM sponsors WHERE tournament_id = ? ORDER BY sort, created_at').bind(tid).all()).results;
  if (!withStats || !rows.length) return rows.map((r) => ({ ...r, img: sponsorImg(r) }));
  const today = jstDay();
  const stats = (await db.prepare(`SELECT sponsor_id, SUM(count) AS total, SUM(CASE WHEN day = ? THEN count ELSE 0 END) AS today
      FROM sponsor_clicks WHERE sponsor_id IN (SELECT id FROM sponsors WHERE tournament_id = ?) GROUP BY sponsor_id`).bind(today, tid).all()).results;
  const by = Object.fromEntries(stats.map((x) => [x.sponsor_id, x]));
  return rows.map((r) => ({ ...r, img: sponsorImg(r), clicks: by[r.id] ? by[r.id].total : 0, clicksToday: by[r.id] ? by[r.id].today : 0 }));
}
const publicSponsors = (list) => list.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, img: x.img }));

// /go/:id … クリック数を数えてからスポンサーのサイトへ移動する
async function sponsorRedirect(req, db, id) {
  const sp = await db.prepare('SELECT id, url FROM sponsors WHERE id = ?').bind(id).first();
  if (!sp) return new Response('見つかりません', { status: 404 });
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  // 同じ人の短時間の連打は1回に数える
  const rl = await rateLimit(db, `click:${id}:${ip}`, 1, 30);
  if (rl.ok) {
    await db.prepare('INSERT INTO sponsor_clicks (sponsor_id, day, count) VALUES (?, ?, 1) ON CONFLICT(sponsor_id, day) DO UPDATE SET count = count + 1').bind(id, jstDay()).run();
  }
  return new Response(null, { status: 302, headers: { Location: sp.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'origin' } });
}

// /img/s/:id … バナー画像、/img/t/:id … 大会ロゴ、/img/team/:id … チームロゴ（ページのデータとは別に配信し、長くキャッシュする）
async function sponsorImage(db, id, kind = 's') {
  const q = kind === 's' ? 'SELECT image FROM sponsors WHERE id = ?'
    : kind === 'l' ? 'SELECT image FROM lost_items WHERE id = ?'
    : kind === 'a' ? 'SELECT image FROM assets WHERE id = ?'
    : kind === 't' ? 'SELECT logo AS image FROM tournaments WHERE id = ? AND show_logo = 1 AND status != \'draft\''
      : 'SELECT t.logo AS image FROM teams t JOIN categories c ON c.id = t.category_id JOIN tournaments x ON x.id = c.tournament_id WHERE t.id = ? AND x.show_logo = 1 AND x.status != \'draft\'';
  const sp = await db.prepare(q).bind(id).first();
  if (!sp || !sp.image) return new Response('見つかりません', { status: 404 });
  const m = sp.image.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) return new Response('画像が正しくありません', { status: 500 });
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // SVG は画像としてのみ表示させ、直接開いてもスクリプトが動かないようにする
  return new Response(bytes, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } });
}

// ---------- 大会の設定（要項・駐車券）と忘れ物 ----------

const readSettings = (t) => { try { return JSON.parse(t.settings || '{}') || {}; } catch { return {}; } };
async function listLost(db, tid, all = false) {
  const rows = (await db.prepare(`SELECT id, note, status, created_at, updated_at, image IS NOT NULL AS has_image FROM lost_items WHERE tournament_id = ?${all ? '' : " AND status = 'open'"} ORDER BY created_at DESC`).bind(tid).all()).results;
  return rows.map((r) => ({ id: r.id, note: r.note, status: r.status, created_at: r.created_at, img: r.has_image ? `/img/l/${r.id}?v=${encodeURIComponent(r.updated_at)}` : null }));
}
function publicParking(settings) {
  const p = settings.parking || {};
  if (!p.enabled) return null;
  return { title: p.title || '駐車証', place: p.place || '', note: p.note || '', perTeam: Math.max(1, Math.min(10, Number(p.perTeam) || 1)), valid: p.valid || '' };
}

// 画像（要項の添付・プリセット用）をコピーする。旧ID → 新ID の対応を返す
async function copyAssets(db, ids, owner) {
  const map = {};
  for (const id of [...new Set(ids)].filter(Boolean)) {
    const a = await db.prepare('SELECT image FROM assets WHERE id = ?').bind(id).first();
    if (!a) continue;
    const nid = uid();
    await db.prepare('INSERT INTO assets (id, owner, image, created_at) VALUES (?, ?, ?, ?)').bind(nid, owner, a.image, now()).run();
    map[id] = nid;
  }
  return map;
}
const outlineImageIds = (o) => ((o && o.sections) || []).flatMap((x) => (x.images || []).map((i) => i.id));
const remapOutline = (o, map) => ({ ...o, sections: ((o && o.sections) || []).map((x) => ({ ...x, images: (x.images || []).filter((i) => map[i.id]).map((i) => ({ ...i, id: map[i.id] })) })) });

// ---------- 公開用の整形 ----------

// 画像の内容が変わったら URL も変わるよう、短い目印を付ける（全体を計算すると重いので長さと末尾から作る）
function imgVersion(dataUrl) {
  let x = dataUrl.length;
  const tail = dataUrl.slice(-64);
  for (let i = 0; i < tail.length; i++) x = (x * 31 + tail.charCodeAt(i)) >>> 0;
  return x.toString(36);
}
const logoUrl = (kind, id, dataUrl) => (dataUrl ? `/img/${kind}/${id}?v=${imgVersion(dataUrl)}` : null);

function publicTournament(t, withPin = false) {
  const o = { id: t.id, slug: t.slug, name: t.name, date: t.date, end_date: t.end_date || null, venue: t.venue, logo: t.show_logo ? logoUrl('t', t.id, t.logo) : null, show_logo: t.show_logo, status: t.status, rev: t.rev };
  if (withPin) Object.assign(o, { logo: t.logo, pin: t.pin });
  return o;
}

function maskMatch(m, level) {
  // level: 'public' は確定のみスコアを出す、'relative' は仮登録も出す
  const base = {
    id: m.id, stage: m.stage, group_label: m.group_label, round: m.round, code: m.code, label: m.label,
    slot: m.slot, court: m.court, start_min: m.start_min, session: m.session,
    home_team_id: m.home_team_id, away_team_id: m.away_team_id, home_ref: m.home_ref, away_ref: m.away_ref,
    place_w: m.place_w, place_l: m.place_l, status: m.status, time_changed: m.time_changed, corrected: m.corrected,
  };
  const showScore = m.status === 'confirmed' || (level === 'relative' && m.status === 'provisional');
  if (showScore) Object.assign(base, { home_score: m.home_score, away_score: m.away_score, home_pk: m.home_pk, away_pk: m.away_pk, forfeit: m.forfeit });
  if (level === 'relative') Object.assign(base, { updated_by: m.updated_by, updated_at: m.updated_at, version: m.version });
  return base;
}

function stripConfig(cfg) {
  const { grouping, lottery, ...rest } = cfg;
  return rest;
}

async function publicPayload(db, t, level) {
  const cats = await loadFull(db, t);
  const sponsors = publicSponsors(await listSponsors(db, t.id));
  const settings = readSettings(t);
  return {
    tournament: { ...publicTournament(t), sponsors, lost: await listLost(db, t.id), parking: publicParking(settings) },
    categories: cats.map((c) => ({
      ...c,
      config: stripConfig(c.config),
      teams: c.teams.map(({ id, name, short_name, logo, group_label }) => ({ id, name, short_name, logo: t.show_logo ? logoUrl('team', id, logo) : null, group_label })),
      matches: c.matches.map((m) => maskMatch(m, level)),
    })),
  };
}

// ---------- 画面ファイルの配信 ----------

const JS = 'text/javascript; charset=utf-8';
// 版の番号：画面のファイルの内容から作る（アプリを更新すると変わる）。拠点ごとに一度だけ計算する
let BUILD_ID = null;
function buildId() {
  if (BUILD_ID) return BUILD_ID;
  let h = 0x811c9dc5;
  for (const [body] of Object.values(STATIC)) {
    const str = String(body);
    for (let i = 0; i < str.length; i += 7) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= str.length; h = Math.imul(h, 16777619) >>> 0;
  }
  BUILD_ID = h.toString(36);
  return BUILD_ID;
}
// 画面のファイルどうしの読み込み（import）にも版の番号を付ける
const versionImports = (src, build) => src.replace(/((?:from\s*|import\()\s*)(['"])\.\/((?:web-[\w-]+|icons)\.js)\2/g, (_, pre, q, f) => `${pre}${q}./${f}?v=${build}${q}`);

const STATIC = {
  '/app.css': [APP_CSS, 'text/css; charset=utf-8'],
  '/manifest.webmanifest': [MANIFEST, 'application/manifest+json; charset=utf-8'],
  '/web-app.js': [WEB_APP, JS],
  '/web-api.js': [WEB_API, JS],
  '/web-ui.js': [WEB_UI, JS],
  '/web-views.js': [WEB_VIEWS, JS],
  '/web-viewer.js': [WEB_VIEWER, JS],
  '/web-relative.js': [WEB_RELATIVE, JS],
  '/web-admin.js': [WEB_ADMIN, JS],
  '/web-print.js': [WEB_PRINT, JS],
  '/web-outline.js': [WEB_OUTLINE, JS],
  '/web-qr.js': [WEB_QR, JS],
  '/web-xlsx.js': [WEB_XLSX, JS],
  '/web-pamphlet.js': [WEB_PAMPHLET, JS],
  '/web-score.js': [WEB_SCORE, JS],
};
// 外部のスクリプトや埋め込みを許さない（画面はすべて自前のファイルで動く）
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "connect-src 'self'", "font-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': CSP, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// 画面のファイルは毎回サーバーに確認させる（ETag が同じなら 304 で本体は送らない）。
// 更新直後に新旧のファイルが混ざって画面が壊れるのを防ぐため。
const etags = {};
async function etagOf(path, body) {
  if (!etags[path]) {
    const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(body));
    etags[path] = `"${[...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}"`;
  }
  return etags[path];
}

async function serveStatic(req, url) {
  // アイコン（ブックマーク・ホーム画面・タブ）。変わらないので長くキャッシュしてよい
  if (url.pathname === '/favicon.svg') return new Response(FAVICON_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' } });
  const iconPath = url.pathname === '/favicon.ico' ? '/favicon-32.png' : url.pathname;
  if (ICONS[iconPath]) {
    const bin = Uint8Array.from(atob(ICONS[iconPath]), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  }
  if (/^\/INFINEX_manual_[a-z]+\.pdf$/.test(url.pathname)) {
    return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>マニュアルが見つかりません</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.8"><h1 style="font-size:20px">マニュアルのファイルが見つかりません</h1>
<p>マニュアル（PDF）が、まだサーバーに配置されていないようです。管理者の方は、次の2点を確認してください。</p>
<ol><li>GitHub のリポジトリに <b>manuals</b> フォルダがあり、その中に INFINEX_manual_〜.pdf の5つのファイルがあること</li>
<li><b>wrangler.jsonc</b> に <code>"assets": { "directory": "./manuals" },</code> の1行があること</li></ol>
<p>確認・修正の後、Cloudflare のデプロイが終わると開けるようになります。</p><p><a href="/admin">管理画面に戻る</a></p></body></html>`,
      { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS } });
  }
  const file = STATIC[url.pathname];
  let [body, type] = file || [INDEX_HTML, 'text/html; charset=utf-8'];
  const key = file ? url.pathname : '/index.html';
  // 画面のファイルには版の番号（全ファイルの内容から作る）を付けて配信する。
  // 番号つきのファイルは内容が変わらないので、ブラウザに1年間保存させる（2回目以降はサーバーに問い合わせない）
  const build = buildId();
  if (key === '/index.html') body = body.replace('href="/app.css"', `href="/app.css?v=${build}"`).replace('src="/web-app.js"', `src="/web-app.js?v=${build}"`);
  else if (/^\/web-[\w-]+\.js$/.test(key)) body = versionImports(body, build);
  const versioned = file && url.searchParams.get('v') === build;
  const etag = await etagOf(key, body);
  const headers = { 'Content-Type': type, 'Cache-Control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache', ETag: etag, ...SECURITY_HEADERS };
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
  // それ以外の画面のURL（/admin, /t/..., /r/...）はすべて index.html を返し、画面側で振り分ける
  return new Response(body, { headers });
}

// ---------- ルーティング ----------

const routes = [];
const route = (method, pattern, handler, auth = null) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const go = url.pathname.match(/^\/go\/([\w-]+)$/);
    const img = url.pathname.match(/^\/img\/(s|t|team|l|a)\/([\w-]+)$/);
    if (go || img) {
      try {
        await ensureSchema(env.DB);
        return go ? await sponsorRedirect(req, env.DB, go[1]) : await sponsorImage(env.DB, img[2], img[1]);
      } catch (e) {
        console.error(e);
        return new Response('エラーが発生しました', { status: 500 });
      }
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, url);
    try {
      if (!env.SESSION_SECRET || !env.ADMIN_PASSWORD) fail(500, 'サーバーの初期設定が完了していません（ADMIN_PASSWORD と SESSION_SECRET を設定してください）');
      await ensureSchema(env.DB);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.get('Origin');
        if (origin && origin !== url.origin) fail(403, '別のサイトからの操作は受け付けません');
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        let user = null;
        if (r.auth === 'admin' || r.auth === 'score') {
          user = await currentUser(req, env, env.DB);
          if (!user) fail(401, 'ログインしてください');
          if (r.auth === 'admin' && user.role === 'scorer') fail(403, 'スコア管理者は、結果の承認だけを行えます');
          // 閲覧専用アカウント：全体管理者と同じ範囲を見られるが、変更は自分のパスワードだけ。アカウント情報は見せない
          if (user.role === 'viewer') {
            if (req.method !== 'GET' && url.pathname !== '/api/admin/password') fail(403, '閲覧専用のアカウントでは変更できません');
            if (/^\/api\/admin\/(users|scorers)(\/|$)/.test(url.pathname)) fail(403, '閲覧専用のアカウントでは表示できません');
            user = { ...user, role: 'super', viewer: true };
          }
        }
        return await r.handler({ req, env, db: env.DB, url, params, user });
      }
      fail(404, 'APIが見つかりません');
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
      console.error(e);
      return json({ error: 'サーバーでエラーが発生しました。時間をおいてもう一度お試しください' }, 500);
    }
  },
};

// ---------- 管理者: 認証 ----------

route('POST', '/api/admin/login', async ({ req, env, db }) => {
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const b = await body(req);
  const loginId = clip(b.login_id || (env.ADMIN_ID || 'admin'), 60).toLowerCase();
  // 通信元ごと・IDごとに試行回数を制限する
  for (const key of [`admin:${ip}`, `adminid:${loginId}`]) {
    const rl = await rateLimit(db, key, 10);
    if (!rl.ok) fail(429, `試行回数が上限に達しました。${Math.ceil(rl.retryAfter / 60)}分後にもう一度お試しください`);
  }
  const password = String(b.password || '');
  const ng = () => fail(401, 'IDまたはパスワードが違います');
  let cookieValue;
  if (loginId === (env.ADMIN_ID || 'admin').toLowerCase()) {
    if (!(await safeEqual(env.SESSION_SECRET, password, env.ADMIN_PASSWORD))) ng();
    cookieValue = await issueAdmin(env, 'root', 0);
  } else {
    const u = await db.prepare('SELECT * FROM users WHERE login_id = ?').bind(loginId).first();
    const ok = await verifyPassword(password, u);
    if (!ok || !u.active) ng();
    await db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), u.id).run();
    cookieValue = await issueAdmin(env, u.id, u.session_ver);
  }
  await clearRateLimit(db, `admin:${ip}`);
  await clearRateLimit(db, `adminid:${loginId}`);
  return json({ ok: true }, 200, { 'Set-Cookie': cookieValue });
});

route('POST', '/api/admin/logout', async () => json({ ok: true }, 200, { 'Set-Cookie': cookie('adm', '', 0) }));

route('GET', '/api/admin/me', async ({ req, env, db }) => {
  const user = await currentUser(req, env, db);
  return json({ admin: !!user, user });
});

// 自分のパスワードを変更（地域管理者）
route('POST', '/api/admin/password', async ({ req, env, db, user }) => {
  if (user.id === 'root') fail(400, '全体管理者のパスワードは Cloudflare の設定（ADMIN_PASSWORD）で変更してください');
  const b = await body(req);
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(user.id).first();
  if (!(await verifyPassword(String(b.current || ''), u))) fail(400, '今のパスワードが違います');
  const next = checkPassword(b.next);
  const h = await hashPassword(next);
  await db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ?, iterations = ?, session_ver = session_ver + 1, updated_at = ? WHERE id = ?')
    .bind(h.hash, h.salt, h.iterations, now(), u.id).run();
  // 変更後もこの端末ではログインしたままにする（ほかの端末は無効になる）
  return json({ ok: true }, 200, { 'Set-Cookie': await issueAdmin(env, u.id, u.session_ver + 1) });
}, 'score');

// ---------- スコア管理者の発行・編集 ----------

route('GET', '/api/admin/scorers', async ({ db, user }) => {
  const r = isSuper(user)
    ? await db.prepare(`SELECT s.id, s.login_id, s.name, s.active, s.scope, s.parent_id, s.last_login_at, s.created_at, p.name AS parent_name, p.region AS parent_region
        FROM users s LEFT JOIN users p ON p.id = s.parent_id WHERE s.role = 'scorer' ORDER BY p.region, s.name`).all()
    : await db.prepare("SELECT id, login_id, name, active, scope, parent_id, last_login_at, created_at FROM users WHERE role = 'scorer' AND parent_id = ? ORDER BY name").bind(user.id).all();
  return json({ scorers: r.results.map((x) => ({ ...x, scope: JSON.parse(x.scope || '[]'), parent_name: x.parent_id === 'root' ? '全体管理者' : x.parent_name || '' })) });
}, 'admin');

route('POST', '/api/admin/scorers', async ({ req, env, db, user }) => {
  const b = await body(req);
  const loginId = checkLoginId(b.login_id);
  if (loginId === (env.ADMIN_ID || 'admin').toLowerCase()) fail(400, 'このログインIDは使えません');
  if (await db.prepare('SELECT id FROM users WHERE login_id = ?').bind(loginId).first()) fail(409, 'このログインIDはすでに使われています');
  const name = clip(b.name, 60);
  if (!name) fail(400, '名前を入力してください');
  const scope = await checkScope(db, user, b.tournament_ids);
  const h = await hashPassword(checkPassword(b.password));
  const id = uid();
  await db.prepare(`INSERT INTO users (id, login_id, name, region, role, pass_hash, pass_salt, iterations, active, session_ver, parent_id, scope, created_at, updated_at)
    VALUES (?, ?, ?, NULL, 'scorer', ?, ?, ?, 1, 1, ?, ?, ?, ?)`)
    .bind(id, loginId, name, h.hash, h.salt, h.iterations, user.id === 'root' ? 'root' : user.id, JSON.stringify(scope), now(), now()).run();
  return json({ ok: true, id });
}, 'admin');

route('PATCH', '/api/admin/scorers/:sid', async ({ req, db, params, user }) => {
  const sc = await db.prepare('SELECT * FROM users WHERE id = ?').bind(params.sid).first();
  if (!canManageScorer(user, sc)) fail(404, 'スコア管理者が見つかりません');
  const b = await body(req);
  let hash = sc.pass_hash, salt = sc.pass_salt, iter = sc.iterations, ver = sc.session_ver;
  if (b.password) { const h = await hashPassword(checkPassword(b.password)); hash = h.hash; salt = h.salt; iter = h.iterations; ver += 1; }
  const active = b.active !== undefined ? (b.active ? 1 : 0) : sc.active;
  if (active !== sc.active) ver += 1;
  const scope = b.tournament_ids !== undefined ? JSON.stringify(await checkScope(db, user, b.tournament_ids)) : sc.scope;
  await db.prepare('UPDATE users SET name = ?, active = ?, pass_hash = ?, pass_salt = ?, iterations = ?, session_ver = ?, scope = ?, updated_at = ? WHERE id = ?')
    .bind(b.name !== undefined ? clip(b.name, 60) || sc.name : sc.name, active, hash, salt, iter, ver, scope, now(), sc.id).run();
  return json({ ok: true });
}, 'admin');

route('DELETE', '/api/admin/scorers/:sid', async ({ db, params, user }) => {
  const sc = await db.prepare('SELECT * FROM users WHERE id = ?').bind(params.sid).first();
  if (!canManageScorer(user, sc)) fail(404, 'スコア管理者が見つかりません');
  await db.prepare('DELETE FROM users WHERE id = ?').bind(sc.id).run();
  return json({ ok: true });
}, 'admin');

// スコア管理者の画面用：担当する大会の一覧（承認待ちの件数つき）
route('GET', '/api/score/tournaments', async ({ db, user }) => {
  const all = (await db.prepare("SELECT id, slug, name, date, end_date, venue, status, owner_id FROM tournaments WHERE status != 'draft' ORDER BY date DESC").all()).results;
  const list = all.filter((t) => canAccess(user, t));
  const pend = list.length ? (await db.prepare(`SELECT c.tournament_id AS tid, COUNT(*) AS n FROM matches m JOIN categories c ON c.id = m.category_id
    WHERE m.status = 'provisional' GROUP BY c.tournament_id`).all()).results : [];
  const by = Object.fromEntries(pend.map((x) => [x.tid, x.n]));
  return json({ tournaments: list.map(({ owner_id, ...t }) => ({ ...t, pending: by[t.id] || 0 })) });
}, 'score');

// スコア管理者の画面用：大会の試合データ（関係者と同じく仮登録の結果も含む）
route('GET', '/api/score/tournaments/:id', async ({ db, params, user, url }) => {
  const t = await getTournament(db, params.id, user);
  if (url.searchParams.get('rev') === String(t.rev)) return json({ unchanged: true, rev: t.rev });
  return json(await publicPayload(db, t, 'relative'));
}, 'score');

// ---------- 全体管理者: 地域管理者のアカウントと利用状況 ----------

function checkPassword(v) {
  const p = String(v || '');
  if (p.length < 10) fail(400, 'パスワードは10文字以上にしてください');
  if (p.length > 200) fail(400, 'パスワードが長すぎます');
  return p;
}
function checkLoginId(v) {
  const id = String(v || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(id)) fail(400, 'ログインIDは半角の英小文字・数字・記号（. _ -）で3〜40文字にしてください');
  return id;
}

route('GET', '/api/admin/users', async ({ db, user }) => {
  mustSuper(user);
  const year = String(new Date(Date.now() + 9 * 3600 * 1000).getUTCFullYear());
  const stats = `
    (SELECT COUNT(*) FROM tournaments t WHERE t.owner_id = @OWNER@) AS total,
    (SELECT COUNT(*) FROM tournaments t WHERE t.owner_id = @OWNER@ AND substr(t.date, 1, 4) = ?) AS this_year,
    (SELECT COUNT(*) FROM tournaments t WHERE t.owner_id = @OWNER@ AND t.status = 'finished') AS finished,
    (SELECT COUNT(*) FROM tournaments t WHERE t.owner_id = @OWNER@ AND t.status IN ('published', 'live')) AS active_now,
    (SELECT MAX(t.date) FROM tournaments t WHERE t.owner_id = @OWNER@) AS last_date,
    (SELECT COUNT(*) FROM teams tm JOIN categories c ON c.id = tm.category_id JOIN tournaments t ON t.id = c.tournament_id WHERE t.owner_id = @OWNER@) AS teams`;
  const r = await db.prepare(`SELECT u.id, u.login_id, u.name, u.region, u.role, u.active, u.created_at, u.last_login_at, ${stats.replaceAll('@OWNER@', 'u.id')} FROM users u WHERE u.role != 'scorer' ORDER BY u.region, u.name`)
    .bind(year).all();
  // 全体管理者（既存の大会を含む）
  const rootStats = await db.prepare(`SELECT ${stats.replaceAll('t.owner_id = @OWNER@', "(t.owner_id IS NULL OR t.owner_id = 'root')")}`).bind(year).first();
  return json({ year, users: r.results, root: { ...ROOT, ...rootStats } });
}, 'admin');

route('POST', '/api/admin/users', async ({ req, env, db, user }) => {
  mustSuper(user);
  const b = await body(req);
  const loginId = checkLoginId(b.login_id);
  if (loginId === (env.ADMIN_ID || 'admin').toLowerCase()) fail(400, 'このログインIDは使えません');
  if (await db.prepare('SELECT id FROM users WHERE login_id = ?').bind(loginId).first()) fail(409, 'このログインIDはすでに使われています');
  const name = clip(b.name, 60);
  if (!name) fail(400, '名前を入力してください');
  const h = await hashPassword(checkPassword(b.password));
  // region：地域管理者／viewer：閲覧専用（設定の確認だけ）／super：全体管理者
  const role = b.role === 'super' ? 'super' : b.role === 'viewer' ? 'viewer' : 'region';
  const id = uid();
  await db.prepare('INSERT INTO users (id, login_id, name, region, role, pass_hash, pass_salt, iterations, active, session_ver, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)')
    .bind(id, loginId, name, clip(b.region, 40) || null, role, h.hash, h.salt, h.iterations, now(), now()).run();
  return json({ ok: true, id });
}, 'admin');

route('PATCH', '/api/admin/users/:uid', async ({ req, db, params, user }) => {
  mustSuper(user);
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(params.uid).first();
  if (!u) fail(404, '管理者が見つかりません');
  const b = await body(req);
  let hash = u.pass_hash, salt = u.pass_salt, iter = u.iterations, ver = u.session_ver;
  if (b.password) {
    const h = await hashPassword(checkPassword(b.password));
    hash = h.hash; salt = h.salt; iter = h.iterations; ver += 1; // 再設定したら、その管理者の古いログインは無効
  }
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  if (active !== u.active) ver += 1; // 停止したら、すぐにログアウトさせる
  await db.prepare('UPDATE users SET name = ?, region = ?, role = ?, active = ?, pass_hash = ?, pass_salt = ?, iterations = ?, session_ver = ?, updated_at = ? WHERE id = ?').bind(
    b.name !== undefined ? clip(b.name, 60) || u.name : u.name,
    b.region !== undefined ? clip(b.region, 40) || null : u.region,
    ['super', 'region', 'viewer'].includes(b.role) && u.role !== 'scorer' ? b.role : u.role,
    active, hash, salt, iter, ver, now(), u.id).run();
  return json({ ok: true });
}, 'admin');

route('DELETE', '/api/admin/users/:uid', async ({ db, params, user }) => {
  mustSuper(user);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM tournaments WHERE owner_id = ?').bind(params.uid).first();
  if (n.n) fail(409, `この管理者の大会が${n.n}件あるため削除できません。利用を止める場合は「停止」にしてください`);
  await db.batch([
    db.prepare('DELETE FROM users WHERE parent_id = ?').bind(params.uid),
    db.prepare('DELETE FROM users WHERE id = ?').bind(params.uid),
  ]);
  return json({ ok: true });
}, 'admin');

// ---------- 管理者: 大会 ----------

route('GET', '/api/admin/tournaments', async ({ db, user }) => {
  const [r, c] = await Promise.all([
    isSuper(user)
      ? db.prepare(`SELECT t.id, t.slug, t.name, t.date, t.end_date, t.venue, t.status, t.logo, t.show_logo, t.owner_id, t.shared_with, u.name AS owner_name, u.region AS owner_region
          FROM tournaments t LEFT JOIN users u ON u.id = t.owner_id ORDER BY t.date DESC, t.created_at DESC`).all()
      : (async () => {
        const own = (await db.prepare('SELECT id, slug, name, date, end_date, venue, status, logo, show_logo, owner_id FROM tournaments WHERE owner_id = ? ORDER BY date DESC, created_at DESC').bind(user.id).all()).results;
        const sh = (await db.prepare('SELECT id, slug, name, date, end_date, venue, status, logo, show_logo, owner_id, shared_with FROM tournaments WHERE shared_with IS NOT NULL AND (owner_id IS NULL OR owner_id != ?) ORDER BY date DESC, created_at DESC').bind(user.id).all()).results
          .filter((t) => isSharedTo(user, t)).map(({ shared_with, ...t }) => ({ ...t, shared: true }));
        return { results: [...own, ...sh] };
      })(),
    db.prepare(`SELECT c.id, c.tournament_id, c.name, c.config,
        (SELECT COUNT(*) FROM teams t WHERE t.category_id = c.id) AS team_count,
        (SELECT COUNT(*) FROM matches m WHERE m.category_id = c.id) AS match_count,
        (SELECT COUNT(*) FROM matches m WHERE m.category_id = c.id AND m.status = 'confirmed') AS done_count,
        (SELECT COUNT(*) FROM matches m WHERE m.category_id = c.id AND m.status = 'provisional') AS pending_count
      FROM categories c ORDER BY c.sort, c.created_at`).all(),
  ]);
  const cats = {};
  for (const x of c.results) {
    const cfg = normalizeConfig(JSON.parse(x.config));
    (cats[x.tournament_id] ||= []).push({ id: x.id, name: x.name, format: cfg.format, groups: cfg.groups, courts: cfg.courts,
      team_count: x.team_count, match_count: x.match_count, done_count: x.done_count, pending_count: x.pending_count });
  }
  return json({ tournaments: r.results.map((t) => ({ ...t, shared_with: t.shared_with !== undefined ? sharedWith(t) : undefined, logo: t.show_logo ? t.logo : null, categories: cats[t.id] || [] })) });
}, 'admin');

route('POST', '/api/admin/tournaments', async ({ req, db, user }) => {
  const b = await body(req);
  if (!b.name || !String(b.name).trim()) fail(400, '大会名を入力してください');
  b.name = clip(b.name, 80); b.venue = b.venue ? clip(b.venue, 80) : b.venue;
  const id = uid();
  const end = checkRange(b.date || null, b.end_date || null);
  await db.prepare('INSERT INTO tournaments (id, slug, name, date, end_date, venue, pin, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, randomSlug(), String(b.name).trim(), b.date || null, end, b.venue || null, randomPin(), user.id === 'root' ? null : user.id, now(), now()).run();
  return json({ id });
}, 'admin');

route('GET', '/api/admin/tournaments/:id', async ({ db, params, url, user }) => {
  const t = await getTournamentForRead(db, params.id, user);
  if (url.searchParams.get('rev') === String(t.rev)) return json({ unchanged: true, rev: t.rev });
  const cats = await loadFull(db, t);
  const out = cats.map((c) => {
    const len = matchLength(c.config);
    const names = Object.fromEntries(c.teams.map((x) => [x.id, x.name]));
    return { ...c, warnings: scheduleWarnings(c.config, c.matches, (id) => names[id] || '未定'), matchLength: len };
  });
  const sponsors = await listSponsors(db, t.id, true);
  const settings = readSettings(t);
  return json({ tournament: { ...publicTournament(t, true), sponsors: publicSponsors(sponsors), settings, parking: publicParking(settings), owner_id: t.owner_id || null,
    readonly: !!t.readonly, shared_with: isSuper(user) ? sharedWith(t) : undefined, pin: t.readonly ? null : t.pin },
    categories: out, sponsors, lost: await listLost(db, t.id, true) });
}, 'admin');

const STATUSES = ['draft', 'published', 'live', 'finished'];

route('PATCH', '/api/admin/tournaments/:id', async ({ req, db, params, user }) => {
  const t = await getTournament(db, params.id, user);
  const b = await body(req);
  if (b.shared_with !== undefined) {
    mustSuper(user);
    let v = b.shared_with;
    if (v === 'all') v = 'all';
    else if (Array.isArray(v)) {
      const ids = [...new Set(v.map(String))];
      for (const uid2 of ids) {
        const u = await db.prepare("SELECT id FROM users WHERE id = ? AND role = 'region'").bind(uid2).first();
        if (!u) fail(400, '共有先の地域管理者が見つかりません');
      }
      v = ids.length ? ids : null;
    } else v = null;
    await db.prepare('UPDATE tournaments SET shared_with = ? WHERE id = ?').bind(v ? JSON.stringify(v) : null, t.id).run();
    if (Object.keys(b).length === 1) return json({ ok: true });
  }
  const next = {
    name: b.name !== undefined ? clip(b.name, 80) || t.name : t.name,
    date: b.date !== undefined ? b.date || null : t.date,
    venue: b.venue !== undefined ? clip(b.venue, 80) || null : t.venue,
    logo: b.logo !== undefined ? checkLogo(b.logo) : t.logo,
    show_logo: b.show_logo !== undefined ? (b.show_logo ? 1 : 0) : t.show_logo,
    status: b.status !== undefined ? b.status : t.status,
  };
  if (!STATUSES.includes(next.status)) fail(400, '大会の状態が正しくありません');
  next.end_date = checkRange(next.date, b.end_date !== undefined ? b.end_date || null : t.end_date);
  let settings = readSettings(t);
  if (b.settings && typeof b.settings === 'object') {
    settings = { ...settings, ...b.settings };
    if (JSON.stringify(settings).length > 300_000) fail(400, '要項の文章が長すぎます');
  }
  await db.prepare('UPDATE tournaments SET name = ?, date = ?, end_date = ?, venue = ?, logo = ?, show_logo = ?, status = ?, settings = ? WHERE id = ?')
    .bind(next.name, next.date, next.end_date, next.venue, next.logo, next.show_logo, next.status, JSON.stringify(settings), t.id).run();
  const oldDates = tournamentDates(t);
  const newDates = tournamentDates({ date: next.date, end_date: next.end_date });
  if (JSON.stringify(oldDates) !== JSON.stringify(newDates)) {
    const cats = (await db.prepare('SELECT * FROM categories WHERE tournament_id = ?').bind(t.id).all()).results;
    const stmts = [];
    for (const c of cats) {
      const cfg = normalizeConfig(JSON.parse(c.config));
      const had = cfg.dayDates.length ? cfg.dayDates : oldDates.slice(0, cfg.dayCount);
      // 全日程に出ていたカテゴリは新しい全日程に、それ以外は期間内の日だけ残す（ずれた分は同じ日目に置き換える）
      let dates = JSON.stringify(had) === JSON.stringify(oldDates) ? newDates
        : had.map((d) => (newDates.includes(d) ? d : newDates[oldDates.indexOf(d)])).filter(Boolean);
      dates = [...new Set(dates)].sort();
      if (!dates.length && newDates.length) dates = [newDates[0]];
      stmts.push(db.prepare('UPDATE categories SET config = ? WHERE id = ?').bind(JSON.stringify({ ...cfg, dayDates: dates, dayCount: Math.max(1, dates.length) }), c.id));
    }
    if (stmts.length) await batchAll(db, stmts);
  }
  await bump(db, t.id);
  return json({ ok: true });
}, 'admin');

route('POST', '/api/admin/tournaments/:id/pin', async ({ db, params, user }) => {
  const t = await getTournament(db, params.id, user);
  const pin = randomPin();
  await db.prepare('UPDATE tournaments SET pin = ?, pin_version = pin_version + 1 WHERE id = ?').bind(pin, t.id).run();
  return json({ pin });
}, 'admin');

route('DELETE', '/api/admin/tournaments/:id', async ({ db, params, user }) => {
  const t = await getTournament(db, params.id, user);
  const cats = (await db.prepare('SELECT id FROM categories WHERE tournament_id = ?').bind(t.id).all()).results;
  const stmts = [];
  for (const c of cats) {
    stmts.push(db.prepare('DELETE FROM match_officials WHERE match_id IN (SELECT id FROM matches WHERE category_id = ?)').bind(c.id));
    stmts.push(db.prepare('DELETE FROM matches WHERE category_id = ?').bind(c.id));
    stmts.push(db.prepare('DELETE FROM teams WHERE category_id = ?').bind(c.id));
  }
  stmts.push(db.prepare('DELETE FROM sponsor_clicks WHERE sponsor_id IN (SELECT id FROM sponsors WHERE tournament_id = ?)').bind(t.id));
  stmts.push(db.prepare('DELETE FROM sponsors WHERE tournament_id = ?').bind(t.id));
  stmts.push(db.prepare('DELETE FROM lost_items WHERE tournament_id = ?').bind(t.id));
  stmts.push(db.prepare('DELETE FROM assets WHERE owner = ?').bind(t.id));
  stmts.push(db.prepare('DELETE FROM categories WHERE tournament_id = ?').bind(t.id));
  stmts.push(db.prepare('DELETE FROM tournaments WHERE id = ?').bind(t.id));
  await batchAll(db, stmts);
  return json({ ok: true });
}, 'admin');

// ---------- 管理者: カテゴリ ----------

const editable = (t) => t.status === 'draft' || t.status === 'published';
// 公開中・開催中・終了の大会では、設定・チーム・日程をロックする（誤操作防止）。
// 管理者が画面で「ロックを一時解除」した操作だけ ?unlock=1 を付けて受け付ける
const LOCKED_MSG = '公開中の大会のため、設定・チーム・日程はロックされています。変更する場合は、画面上部の「ロックを一時解除」を押してから操作してください';
const mustUnlocked = (t, url) => { if (t.status !== 'draft' && url.searchParams.get('unlock') !== '1') fail(423, LOCKED_MSG); };
const mustBeEditable = (t) => { if (!editable(t)) fail(409, '開催中・終了した大会では組み合わせを変更できません。大会の状態を「準備中」に戻してください'); };

route('POST', '/api/admin/tournaments/:id/categories', async ({ req, db, params, user, url }) => {
  const t = await getTournament(db, params.id, user);
  mustUnlocked(t, url);
  const b = await body(req);
  const dates = tournamentDates(t);
  const given = b.config || {};
  const cfg = normalizeConfig({ ...given, dayDates: Array.isArray(given.dayDates) && given.dayDates.length ? given.dayDates : Number(given.dayCount) > 1 ? [] : dates });
  const count = await db.prepare('SELECT COUNT(*) AS n FROM categories WHERE tournament_id = ?').bind(t.id).first();
  const id = uid();
  await db.prepare('INSERT INTO categories (id, tournament_id, name, sort, config, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, t.id, String(b.name || 'U12'), count.n, JSON.stringify(cfg), now()).run();
  await bump(db, t.id);
  return json({ id });
}, 'admin');

const TIMING_KEYS = ['startTime', 'periods', 'halfMinutes', 'halftimeMinutes', 'intervalMinutes', 'koGapMinutes', 'lunchEnabled', 'lunchStart', 'lunchMinutes', 'extraDays', 'koTiming'];

route('PATCH', '/api/admin/categories/:cid', async ({ req, db, params, user, url }) => {
  const c = await getCategory(db, params.cid, user);
  const t = await getTournament(db, c.tournament_id, user);
  mustUnlocked(t, url);
  const b = await body(req);
  const cfg = normalizeConfig({ ...c.config, ...(b.config || {}) });
  if (cfg.courts < c.config.courts) {
    const used = await db.prepare('SELECT MAX(court) AS mx FROM matches WHERE category_id = ?').bind(c.id).first();
    if (used && used.mx != null && used.mx >= cfg.courts) {
      fail(409, `日程で${used.mx + 1}面目のコートを使っているため、コート数を${cfg.courts}面に減らせません。「組み分け・日程」で日程を作り直すか、試合を移動してから変更してください`);
    }
  }
  await db.prepare('UPDATE categories SET name = ?, config = ? WHERE id = ?').bind(b.name ? clip(b.name, 20) : c.name, JSON.stringify(cfg), c.id).run();
  // 準備中なら、開始時刻などの変更を全コートの全試合へ一括反映
  const timingChanged = TIMING_KEYS.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(c.config[k]));
  if (timingChanged && editable(t)) {
    const { matches } = await loadCategoryData(db, c.id);
    applyTimes(cfg, matches);
    await batchAll(db, matches.map((m) => db.prepare('UPDATE matches SET start_min = ?, session = ?, time_changed = 0 WHERE id = ?').bind(m.start_min, m.session, m.id)));
  }
  await syncKnockout(db, { ...c, config: cfg });
  await bump(db, t.id);
  return json({ ok: true, retimed: timingChanged && editable(t) });
}, 'admin');

route('DELETE', '/api/admin/categories/:cid', async ({ db, params, user, url }) => {
  const c = await getCategory(db, params.cid, user);
  mustUnlocked(await getTournament(db, c.tournament_id, user), url);
  await batchAll(db, [
    db.prepare('DELETE FROM matches WHERE category_id = ?').bind(c.id),
    db.prepare('DELETE FROM teams WHERE category_id = ?').bind(c.id),
    db.prepare('DELETE FROM categories WHERE id = ?').bind(c.id),
  ]);
  await bump(db, c.tournament_id);
  return json({ ok: true });
}, 'admin');

// ---------- 管理者: チーム ----------

route('POST', '/api/admin/categories/:cid/teams', async ({ req, db, params, user, url }) => {
  const c = await getCategory(db, params.cid, user);
  mustUnlocked(await getTournament(db, c.tournament_id, user), url);
  const b = await body(req);
  const list = Array.isArray(b.teams) ? b.teams : [b];
  const count = await db.prepare('SELECT COUNT(*) AS n FROM teams WHERE category_id = ?').bind(c.id).first();
  const stmts = [];
  list.forEach((x, i) => {
    const name = clip(x.name, 60);
    if (!name) return;
    x.short_name = x.short_name ? clip(x.short_name, 20) : null;
    x.club = x.club ? clip(x.club, 60) : null;
    stmts.push(db.prepare('INSERT INTO teams (id, category_id, name, short_name, club, logo, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(uid(), c.id, name, x.short_name || null, x.club || null, checkLogo(x.logo), count.n + i));
  });
  if (!stmts.length) fail(400, 'チーム名を入力してください');
  await batchAll(db, stmts);
  await bump(db, c.tournament_id);
  return json({ ok: true, added: stmts.length });
}, 'admin');

route('PATCH', '/api/admin/teams/:id', async ({ req, db, params, user }) => {
  const team = await db.prepare('SELECT * FROM teams WHERE id = ?').bind(params.id).first();
  if (!team) fail(404, 'チームが見つかりません');
  await getCategory(db, team.category_id, user);
  const b = await body(req);
  await db.prepare('UPDATE teams SET name = ?, short_name = ?, club = ?, logo = ? WHERE id = ?').bind(
    b.name !== undefined ? clip(b.name, 60) || team.name : team.name,
    b.short_name !== undefined ? clip(b.short_name, 20) || null : team.short_name,
    b.club !== undefined ? clip(b.club, 60) || null : team.club,
    b.logo !== undefined ? checkLogo(b.logo) : team.logo,
    team.id,
  ).run();
  const c = await getCategory(db, team.category_id, user);
  await bump(db, c.tournament_id);
  return json({ ok: true });
}, 'admin');

route('DELETE', '/api/admin/teams/:id', async ({ db, params, user, url }) => {
  const team = await db.prepare('SELECT * FROM teams WHERE id = ?').bind(params.id).first();
  if (!team) fail(404, 'チームが見つかりません');
  const c = await getCategory(db, team.category_id, user);
  const t = await getTournament(db, c.tournament_id, user);
  mustUnlocked(t, url);
  const used = await db.prepare('SELECT COUNT(*) AS n FROM matches WHERE category_id = ? AND (home_team_id = ? OR away_team_id = ?)').bind(c.id, team.id, team.id).first();
  if (used.n && !editable(t)) fail(409, '試合が組まれているチームは開催中に削除できません');
  await db.prepare('DELETE FROM teams WHERE id = ?').bind(team.id).run();
  if (used.n) await db.prepare('DELETE FROM matches WHERE category_id = ?').bind(c.id).run();
  await bump(db, t.id);
  return json({ ok: true, scheduleCleared: !!used.n });
}, 'admin');

// ---------- 管理者: 組み分け・日程 ----------

route('POST', '/api/admin/categories/:cid/grouping', async ({ db, params, user, url }) => {
  const c = await getCategory(db, params.cid, user);
  mustUnlocked(await getTournament(db, c.tournament_id, user), url);
  const { teams } = await loadCategoryData(db, c.id);
  if (c.config.format === 'knockout') {
    return json({ order: shuffle(teams.map((x) => x.id)), warnings: [] });
  }
  if (teams.length < c.config.groups * 2) fail(400, `${c.config.groups}組に分けるには ${c.config.groups * 2} チーム以上が必要です`);
  return json(assignGroups(teams, { groups: c.config.groups, ...c.config.grouping }));
}, 'admin');

// 日程を削除する（チームと組み分けは残す）。結果が入っている場合は force が必要
route('DELETE', '/api/admin/categories/:cid/schedule', async ({ req, db, params, url, user }) => {
  const c = await getCategory(db, params.cid, user);
  const t = await getTournament(db, c.tournament_id, user);
  mustUnlocked(t, url);
  mustBeEditable(t);
  const n = await db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status != 'none' THEN 1 ELSE 0 END) AS results FROM matches WHERE category_id = ?").bind(c.id).first();
  if (!n.total) return json({ ok: true, deleted: 0 });
  if (n.results && url.searchParams.get('force') !== '1') fail(409, `結果が入っている試合が${n.results}試合あります`);
  const cfg = { ...c.config, dayBreakSlots: [], lottery: {} };
  await db.batch([
    db.prepare('DELETE FROM matches WHERE category_id = ?').bind(c.id),
    db.prepare('UPDATE categories SET config = ? WHERE id = ?').bind(JSON.stringify(cfg), c.id),
  ]);
  await bump(db, t.id);
  return json({ ok: true, deleted: n.total });
}, 'admin');

route('POST', '/api/admin/categories/:cid/generate', async ({ req, db, params, user, url }) => {
  const c = await getCategory(db, params.cid, user);
  const t = await getTournament(db, c.tournament_id, user);
  mustUnlocked(t, url);
  mustBeEditable(t);
  const b = await body(req);
  const { teams } = await loadCategoryData(db, c.id);
  const assign = b.assignment || {};
  const ts = teams.map((x) => ({ ...x, group_label: c.config.format === 'knockout' ? null : assign[x.id] || x.group_label }));
  const res = generateCategory(c.config, ts, b.order);
  if (res.error) fail(400, res.error);
  const names = Object.fromEntries(teams.map((x) => [x.id, x.name]));
  const matches = res.matches.map((m) => ({ ...m, id: uid(), status: 'none' }));
  const dayBreakSlots = res.dayBreakSlots || [];
  const warnings = [...(res.warnings || []), ...scheduleWarnings({ ...c.config, dayBreakSlots }, matches, (id) => names[id] || '未定')];
  if (b.dryRun) return json({ matches, warnings, dayBreakSlots });

  const stmts = [db.prepare('DELETE FROM matches WHERE category_id = ?').bind(c.id)];
  for (const x of ts) stmts.push(db.prepare('UPDATE teams SET group_label = ? WHERE id = ?').bind(x.group_label, x.id));
  for (const m of matches) {
    stmts.push(db.prepare(`INSERT INTO matches (id, category_id, stage, group_label, round, code, label, slot, court, start_min, session,
      home_team_id, away_team_id, home_ref, away_ref, place_w, place_l, status, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 1)`)
      .bind(m.id, c.id, m.stage, m.group_label ?? null, m.round ?? null, m.code ?? null, m.label, m.slot, m.court, m.start_min, m.session,
        m.home_team_id ?? null, m.away_team_id ?? null, m.home_ref ? JSON.stringify(m.home_ref) : null, m.away_ref ? JSON.stringify(m.away_ref) : null,
        m.place_w ?? null, m.place_l ?? null));
  }
  // 組み分けが変わったら抽選結果はリセット
  const cfg = { ...c.config, lottery: {}, dayBreakSlots };
  stmts.push(db.prepare('UPDATE categories SET config = ? WHERE id = ?').bind(JSON.stringify(cfg), c.id));
  await batchAll(db, stmts);
  await bump(db, t.id);
  return json({ ok: true, warnings });
}, 'admin');

// 試合を別の枠・コートへ移動（移動先に試合があれば入れ替え）
route('POST', '/api/admin/categories/:cid/move', async ({ req, db, params, user, url }) => {
  const c = await getCategory(db, params.cid, user);
  const t = await getTournament(db, c.tournament_id, user);
  mustUnlocked(t, url);
  mustBeEditable(t);
  const b = await body(req);
  const { matches } = await loadCategoryData(db, c.id);
  const m = matches.find((x) => x.id === b.matchId);
  if (!m) fail(404, '試合が見つかりません');
  const slot = Math.max(0, Math.trunc(Number(b.slot)));
  const court = Math.trunc(Number(b.court));
  if (court < 0 || court >= c.config.courts) fail(400, 'コートの指定が正しくありません');
  const other = matches.find((x) => x.slot === slot && x.court === court && x.id !== m.id);
  if (other) { other.slot = m.slot; other.court = m.court; }
  m.slot = slot; m.court = court;
  applyTimes(c.config, matches);
  await batchAll(db, matches.map((x) => db.prepare('UPDATE matches SET slot = ?, court = ?, start_min = ?, session = ? WHERE id = ?').bind(x.slot, x.court, x.start_min, x.session, x.id)));
  await bump(db, t.id);
  return json({ ok: true });
}, 'admin');

// 当日の遅延調整（コート単位）
route('POST', '/api/admin/categories/:cid/delay', async ({ req, db, params, user }) => {
  const c = await getCategory(db, params.cid, user);
  const t = await getTournament(db, c.tournament_id, user);
  if (t.status !== 'live') fail(409, '遅延調整は「開催中」の大会で使えます。準備中は開始時刻の設定から全体を調整してください');
  const b = await body(req);
  const minutes = Math.trunc(Number(b.minutes));
  if (!minutes || Math.abs(minutes) > 240) fail(400, 'ずらす時間を分で入力してください（-240〜240）');
  const { teams, matches } = await loadCategoryData(db, c.id);
  const target = matches.find((x) => x.id === b.matchId);
  if (!target) fail(404, '試合が見つかりません');
  if (target.status !== 'none') fail(409, '結果が登録された試合は動かせません');
  const names = Object.fromEntries(teams.map((x) => [x.id, x.name]));
  const plan = planDelay(c.config, matches, target, minutes, b.lunchMode, (id) => names[id] || '未定');
  if (plan.needsLunchChoice || b.dryRun) return json(plan);
  await batchAll(db, plan.changes.map((ch) => db.prepare('UPDATE matches SET start_min = ?, time_changed = 1 WHERE id = ?').bind(ch.start_min, ch.id)));
  await bump(db, t.id);
  return json({ ok: true, changed: plan.changes.length, warnings: plan.warnings });
}, 'admin');

// ---------- 管理者: 結果 ----------

function validateScore(m, b, cfg) {
  if (b.forfeit === 'home' || b.forfeit === 'away') {
    const [w, l] = cfg.forfeitScore || [3, 0];
    return { home: b.forfeit === 'home' ? w : l, away: b.forfeit === 'home' ? l : w, hpk: null, apk: null, forfeit: b.forfeit };
  }
  const home = intOrNull(b.home_score);
  const away = intOrNull(b.away_score);
  if (home == null || away == null) fail(400, '両チームの得点を入力してください');
  let hpk = intOrNull(b.home_pk);
  let apk = intOrNull(b.away_pk);
  if (m.stage === 'league' || home !== away) { hpk = null; apk = null; }
  return { home, away, hpk, apk, forfeit: null };
}

function requirePkIfNeeded(m, s) {
  if (m.stage === 'knockout' && !s.forfeit && s.home === s.away && (s.hpk == null || s.apk == null || s.hpk === s.apk)) {
    fail(400, '同点のためPK戦の結果を入力してください（PKも同点では確定できません）');
  }
}

async function getMatchCtx(db, id, user) {
  const m = await db.prepare('SELECT * FROM matches WHERE id = ?').bind(id).first();
  if (!m) fail(404, '試合が見つかりません');
  const c = await getCategory(db, m.category_id, user);
  const t = await getTournament(db, c.tournament_id, user);
  return { m: parseMatch(m), c, t };
}

route('POST', '/api/admin/matches/:id/result', async ({ req, db, params, user }) => {
  const { m, c, t } = await getMatchCtx(db, params.id, user);
  // スコア管理者は承認まで。確定済みの結果の書き換えは本部（管理者）だけ
  if (user.role === 'scorer' && m.status === 'confirmed') fail(403, '確定済みの結果は変更できません。修正が必要な場合は本部（管理者）に連絡してください');
  if (user.role === 'scorer' && t.status === 'draft') fail(403, '準備中の大会の結果は登録できません');
  if (!m.home_team_id || !m.away_team_id) fail(409, '対戦チームが決まっていません');
  const b = await body(req);
  const s = validateScore(m, b, c.config);
  const confirm = !!b.confirm;
  if (confirm) requirePkIfNeeded(m, s);
  const status = confirm ? 'confirmed' : (m.status === 'confirmed' ? 'confirmed' : 'provisional');
  const corrected = m.status === 'confirmed' ? 1 : m.corrected;
  await db.prepare(`UPDATE matches SET home_score = ?, away_score = ?, home_pk = ?, away_pk = ?, forfeit = ?, status = ?, corrected = ?,
    updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ?`)
    .bind(s.home, s.away, s.hpk, s.apk, s.forfeit, status, corrected, user.role === 'scorer' ? `スコア管理者（${user.name}）` : '本部', now(), m.id).run();
  await syncKnockout(db, c);
  await bump(db, t.id);
  return json({ ok: true });
}, 'score');

route('POST', '/api/admin/categories/:cid/confirm', async ({ req, db, params, user }) => {
  const c = await getCategory(db, params.cid, user);
  const b = await body(req);
  const ids = Array.isArray(b.matchIds) ? b.matchIds : [];
  const { matches } = await loadCategoryData(db, c.id);
  const needsPk = (m) => m.stage === 'knockout' && !m.forfeit && m.home_score === m.away_score && (m.home_pk == null || m.away_pk == null || m.home_pk === m.away_pk);
  const picked = matches.filter((m) => ids.includes(m.id) && m.status === 'provisional');
  const targets = picked.filter((m) => !needsPk(m));
  const skipped = picked.length - targets.length;
  if (targets.length) {
    await batchAll(db, targets.map((m) => db.prepare("UPDATE matches SET status = 'confirmed', version = version + 1 WHERE id = ? AND status = 'provisional'").bind(m.id)));
    await syncKnockout(db, c);
    await bump(db, c.tournament_id);
  }
  return json({ ok: true, confirmed: targets.length, skipped });
}, 'score');

// 確定を取り消して仮登録に戻す
route('POST', '/api/admin/matches/:id/reopen', async ({ db, params, user }) => {
  const { m, c, t } = await getMatchCtx(db, params.id, user);
  if (m.status !== 'confirmed') fail(409, 'この試合は確定していません');
  await db.prepare("UPDATE matches SET status = 'provisional', corrected = 1, version = version + 1 WHERE id = ?").bind(m.id).run();
  await syncKnockout(db, c);
  await bump(db, t.id);
  return json({ ok: true });
}, 'admin');

route('POST', '/api/admin/matches/:id/clear', async ({ db, params, user }) => {
  const { m, c, t } = await getMatchCtx(db, params.id, user);
  await db.prepare(`UPDATE matches SET home_score = NULL, away_score = NULL, home_pk = NULL, away_pk = NULL, forfeit = NULL,
    status = 'none', updated_by = NULL, updated_at = NULL, version = version + 1 WHERE id = ?`).bind(m.id).run();
  await syncKnockout(db, c);
  await bump(db, t.id);
  return json({ ok: true });
}, 'score');

route('POST', '/api/admin/categories/:cid/lottery', async ({ req, db, params, user }) => {
  const c = await getCategory(db, params.cid, user);
  const b = await body(req);
  const cfg = { ...c.config, lottery: { ...c.config.lottery, [b.group]: Array.isArray(b.order) ? b.order : [] } };
  await db.prepare('UPDATE categories SET config = ? WHERE id = ?').bind(JSON.stringify(cfg), c.id).run();
  await syncKnockout(db, { ...c, config: cfg });
  await bump(db, c.tournament_id);
  return json({ ok: true });
}, 'admin');

// ---------- 管理者: スポンサー ----------

route('POST', '/api/admin/tournaments/:id/sponsors', async ({ req, db, params, user }) => {
  const t = await getTournament(db, params.id, user);
  const b = await body(req);
  const name = clip(b.name, 60);
  if (!name) fail(400, 'スポンサー名を入力してください');
  const count = await db.prepare('SELECT COUNT(*) AS n FROM sponsors WHERE tournament_id = ?').bind(t.id).first();
  if (count.n >= 30) fail(400, 'スポンサーは30件まで登録できます');
  await db.prepare('INSERT INTO sponsors (id, tournament_id, name, url, image, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .bind(uid(), t.id, name, checkUrl(b.url), checkBanner(b.image), count.n, now(), now()).run();
  await bump(db, t.id);
  return json({ ok: true });
}, 'admin');

route('PATCH', '/api/admin/sponsors/:sid', async ({ req, db, params, user }) => {
  const sp = await db.prepare('SELECT * FROM sponsors WHERE id = ?').bind(params.sid).first();
  if (!sp) fail(404, 'スポンサーが見つかりません');
  await getTournament(db, sp.tournament_id, user);
  const b = await body(req);
  await db.prepare('UPDATE sponsors SET name = ?, url = ?, image = ?, active = ?, updated_at = ? WHERE id = ?').bind(
    b.name !== undefined ? clip(b.name, 60) || sp.name : sp.name,
    b.url !== undefined ? checkUrl(b.url) : sp.url,
    b.image ? checkBanner(b.image) : sp.image,
    b.active !== undefined ? (b.active ? 1 : 0) : sp.active,
    now(), sp.id).run();
  await bump(db, sp.tournament_id);
  return json({ ok: true });
}, 'admin');

route('DELETE', '/api/admin/sponsors/:sid', async ({ db, params, user }) => {
  const sp = await db.prepare('SELECT * FROM sponsors WHERE id = ?').bind(params.sid).first();
  if (!sp) fail(404, 'スポンサーが見つかりません');
  await getTournament(db, sp.tournament_id, user);
  await db.batch([
    db.prepare('DELETE FROM sponsor_clicks WHERE sponsor_id = ?').bind(sp.id),
    db.prepare('DELETE FROM sponsors WHERE id = ?').bind(sp.id),
  ]);
  await bump(db, sp.tournament_id);
  return json({ ok: true });
}, 'admin');

route('POST', '/api/admin/tournaments/:id/sponsors/order', async ({ req, db, params, user }) => {
  const t = await getTournament(db, params.id, user);
  const b = await body(req);
  const ids = Array.isArray(b.ids) ? b.ids : [];
  await batchAll(db, ids.map((id, i) => db.prepare('UPDATE sponsors SET sort = ? WHERE id = ? AND tournament_id = ?').bind(i, id, t.id)));
  await bump(db, t.id);
  return json({ ok: true });
}, 'admin');

// 日ごとのクリック数
route('GET', '/api/admin/sponsors/:sid/clicks', async ({ db, params, user }) => {
  const sp = await db.prepare('SELECT tournament_id FROM sponsors WHERE id = ?').bind(params.sid).first();
  if (!sp) fail(404, 'スポンサーが見つかりません');
  await getTournament(db, sp.tournament_id, user);
  const r = await db.prepare('SELECT day, count FROM sponsor_clicks WHERE sponsor_id = ? ORDER BY day DESC LIMIT 60').bind(params.sid).all();
  return json({ days: r.results });
}, 'admin');

// 添付画像の持ち主（大会 or プリセット）を操作できるか
async function checkAssetOwner(db, owner, user) {
  if (String(owner).startsWith('preset:')) {
    const p = await db.prepare('SELECT owner_id FROM presets WHERE id = ?').bind(String(owner).slice(7)).first();
    if (!p) fail(404, 'プリセットが見つかりません');
    if (!canEditOwned(user, p.owner_id)) fail(403, 'このプリセットは変更できません');
  } else await getTournament(db, owner, user);
}

// ---------- 管理者: 添付画像（要項の施設案内など） ----------

route('POST', '/api/admin/assets', async ({ req, db, user }) => {
  const b = await body(req);
  const owner = String(b.owner || '');
  await checkAssetOwner(db, owner, user);
  const id = uid();
  await db.prepare('INSERT INTO assets (id, owner, image, created_at) VALUES (?, ?, ?, ?)').bind(id, owner, checkBanner(b.image), now()).run();
  return json({ id, url: `/img/a/${id}` });
}, 'admin');

route('DELETE', '/api/admin/assets/:aid', async ({ db, params, user }) => {
  const a = await db.prepare('SELECT owner FROM assets WHERE id = ?').bind(params.aid).first();
  if (!a) return json({ ok: true });
  await checkAssetOwner(db, a.owner, user);
  await db.prepare('DELETE FROM assets WHERE id = ?').bind(params.aid).run();
  return json({ ok: true });
}, 'admin');

// ---------- 管理者: 忘れ物 ----------

route('POST', '/api/admin/tournaments/:id/lost', async ({ req, db, params, user }) => {
  const t = await getTournament(db, params.id, user);
  const b = await body(req);
  const note = clip(b.note, 400);
  if (!note) fail(400, '忘れ物の内容を入力してください');
  await db.prepare('INSERT INTO lost_items (id, tournament_id, image, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(uid(), t.id, b.image ? checkBanner(b.image) : null, note, 'open', now(), now()).run();
  await bump(db, t.id);
  return json({ ok: true });
}, 'admin');

route('PATCH', '/api/admin/lost/:lid', async ({ req, db, params, user }) => {
  const it = await db.prepare('SELECT * FROM lost_items WHERE id = ?').bind(params.lid).first();
  if (!it) fail(404, '見つかりません');
  await getTournament(db, it.tournament_id, user);
  const b = await body(req);
  await db.prepare('UPDATE lost_items SET note = ?, image = ?, status = ?, updated_at = ? WHERE id = ?').bind(
    b.note !== undefined ? clip(b.note, 400) || it.note : it.note,
    b.image === null ? null : b.image ? checkBanner(b.image) : it.image,
    b.status === 'returned' || b.status === 'open' ? b.status : it.status,
    now(), it.id).run();
  await bump(db, it.tournament_id);
  return json({ ok: true });
}, 'admin');

route('DELETE', '/api/admin/lost/:lid', async ({ db, params, user }) => {
  const it = await db.prepare('SELECT tournament_id FROM lost_items WHERE id = ?').bind(params.lid).first();
  if (!it) fail(404, '見つかりません');
  await getTournament(db, it.tournament_id, user);
  await db.prepare('DELETE FROM lost_items WHERE id = ?').bind(params.lid).run();
  await bump(db, it.tournament_id);
  return json({ ok: true });
}, 'admin');

// ---------- 管理者: プリセット（要項など） ----------

route('GET', '/api/admin/presets', async ({ db, url, user }) => {
  const kind = url.searchParams.get('kind') || 'outline';
  const r = isSuper(user) ? await db.prepare('SELECT * FROM presets WHERE kind = ? ORDER BY updated_at DESC').bind(kind).all()
    : await db.prepare("SELECT * FROM presets WHERE kind = ? AND (owner_id = ? OR ((owner_id IS NULL OR owner_id = 'root') AND shared = 1)) ORDER BY updated_at DESC").bind(kind, user.id).all();
  return json({ presets: r.results.map((x) => ({ ...x, data: JSON.parse(x.data), common: sharedOwner(x.owner_id), published: !!x.shared, editable: canEditOwned(user, x.owner_id) })) });
}, 'admin');

route('POST', '/api/admin/presets', async ({ req, db, user }) => {
  const b = await body(req);
  const name = clip(b.name, 60);
  if (!name) fail(400, 'プリセット名を入力してください');
  const id = uid();
  // 添付画像はプリセット用にコピーしておく（元の大会を消しても残るように）
  const map = await copyAssets(db, outlineImageIds(b.data), `preset:${id}`);
  const data = remapOutline(b.data || {}, map);
  if (JSON.stringify(data).length > 300_000) fail(400, '内容が長すぎます');
  await db.prepare('INSERT INTO presets (id, kind, name, data, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, String(b.kind || 'outline'), name, JSON.stringify(data), ownerOf(user), now(), now()).run();
  return json({ ok: true, id });
}, 'admin');

route('PATCH', '/api/admin/presets/:pid', async ({ req, db, params, user }) => {
  const p = await db.prepare('SELECT * FROM presets WHERE id = ?').bind(params.pid).first();
  if (!p) fail(404, 'プリセットが見つかりません');
  if (!canEditOwned(user, p.owner_id)) fail(403, 'このプリセットは作成した管理者だけが変更できます');
  const b = await body(req);
  const data = b.data !== undefined ? JSON.stringify(b.data) : p.data;
  if (data.length > 300_000) fail(400, '内容が長すぎます');
  let shared = p.shared;
  if (b.shared !== undefined) { mustSuper(user); if (!sharedOwner(p.owner_id)) fail(400, '地域管理者のプリセットは公開できません'); shared = b.shared ? 1 : 0; }
  await db.prepare('UPDATE presets SET name = ?, data = ?, shared = ?, updated_at = ? WHERE id = ?').bind(b.name ? clip(b.name, 60) : p.name, data, shared, now(), p.id).run();
  return json({ ok: true });
}, 'admin');

route('DELETE', '/api/admin/presets/:pid', async ({ db, params, user }) => {
  const p = await db.prepare('SELECT owner_id FROM presets WHERE id = ?').bind(params.pid).first();
  if (!p) fail(404, 'プリセットが見つかりません');
  if (!canEditOwned(user, p.owner_id)) fail(403, 'このプリセットは作成した管理者だけが削除できます');
  await db.batch([
    db.prepare('DELETE FROM assets WHERE owner = ?').bind(`preset:${params.pid}`),
    db.prepare('DELETE FROM presets WHERE id = ?').bind(params.pid),
  ]);
  return json({ ok: true });
}, 'admin');

// プリセットの要項を大会に読み込む（添付画像は大会用にコピー）
route('POST', '/api/admin/tournaments/:id/apply-preset', async ({ req, db, params, user }) => {
  const t = await getTournament(db, params.id, user);
  const b = await body(req);
  const p = await db.prepare('SELECT * FROM presets WHERE id = ?').bind(b.presetId).first();
  if (!p || !(isSuper(user) || (sharedOwner(p.owner_id) && p.shared) || p.owner_id === user.id)) fail(404, 'プリセットが見つかりません');
  const data = JSON.parse(p.data);
  const map = await copyAssets(db, outlineImageIds(data), t.id);
  const settings = { ...readSettings(t), outline: remapOutline(data, map) };
  await db.prepare('UPDATE tournaments SET settings = ? WHERE id = ?').bind(JSON.stringify(settings), t.id).run();
  await bump(db, t.id);
  return json({ ok: true, outline: settings.outline });
}, 'admin');

// 形式テンプレートの名前変更・上書き
route('PATCH', '/api/admin/templates/:id', async ({ req, db, params, user }) => {
  const tp = await db.prepare('SELECT * FROM templates WHERE id = ?').bind(params.id).first();
  if (!tp) fail(404, 'テンプレートが見つかりません');
  if (!canEditOwned(user, tp.owner_id)) fail(403, 'このテンプレートは作成した管理者だけが変更できます');
  const b = await body(req);
  const cfg = b.config ? JSON.stringify(Object.fromEntries(TEMPLATE_KEYS.filter((k) => k in b.config).map((k) => [k, b.config[k]]))) : tp.config;
  let shared = tp.shared;
  if (b.shared !== undefined) { mustSuper(user); if (!sharedOwner(tp.owner_id)) fail(400, '地域管理者のテンプレートは公開できません'); shared = b.shared ? 1 : 0; }
  await db.prepare('UPDATE templates SET name = ?, config = ?, shared = ? WHERE id = ?').bind(b.name ? clip(b.name, 60) : tp.name, cfg, shared, tp.id).run();
  return json({ ok: true });
}, 'admin');

// 大会をコピーして新しい大会を作る（カテゴリの設定・要項・駐車券・スポンサー。チームは任意）
// 大会をコピーして新しい大会を作る
//  scope: settings（設定・要項・駐車券・スポンサー） / teams（＋チーム） / all（丸ごと：チーム・組分け・日程）
//  withResults: 丸ごとのとき、結果もコピーする
const MATCH_COLS = ['stage', 'group_label', 'round', 'code', 'label', 'slot', 'court', 'start_min', 'session', 'home_team_id', 'away_team_id', 'home_ref', 'away_ref',
  'place_w', 'place_l', 'home_score', 'away_score', 'home_pk', 'away_pk', 'forfeit', 'status', 'updated_by', 'updated_at', 'version', 'time_changed', 'corrected', 'ref_conflict'];
route('POST', '/api/admin/tournaments/:id/copy', async ({ req, db, params, user }) => {
  const t = await getTournamentForRead(db, params.id, user);
  const b = await body(req);
  const scope = ['settings', 'teams', 'all'].includes(b.scope) ? b.scope : b.withTeams ? 'teams' : 'settings';
  const withTeams = scope !== 'settings';
  const withSchedule = scope === 'all';
  const withResults = withSchedule && !!b.withResults;
  const name = clip(b.name, 80) || `${t.name}（コピー）`;
  const cats = (await db.prepare('SELECT * FROM categories WHERE tournament_id = ? ORDER BY sort, created_at').bind(t.id).all()).results;
  // 日程ごとコピーするときは、元の日程の日数分の期間を確保する
  let end = b.end_date || null;
  if (withSchedule && b.date) {
    const need = Math.max(1, ...cats.map((c) => normalizeConfig(JSON.parse(c.config)).dayCount || 1));
    const last = addDays(b.date, need - 1);
    if (!end || end < last) end = last;
  }
  end = checkRange(b.date || null, end);
  const nid = uid();
  const settings = readSettings(t);
  const amap = await copyAssets(db, outlineImageIds(settings.outline), nid);
  if (settings.outline) settings.outline = remapOutline(settings.outline, amap);
  await db.prepare('INSERT INTO tournaments (id, slug, name, date, end_date, venue, logo, show_logo, pin, settings, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(nid, randomSlug(), name, b.date || null, end, t.venue, t.logo, t.show_logo, randomPin(), JSON.stringify(settings), user.id === 'root' ? null : user.id, now(), now()).run();
  const dates = tournamentDates({ date: b.date, end_date: end });
  const stmts = [];
  let teamCount = 0, matchCount = 0;
  for (const c of cats) {
    const cfg = normalizeConfig(JSON.parse(c.config));
    const days = Math.max(1, cfg.dayCount || 1);
    const tmap = {};
    const teams = withTeams ? (await db.prepare('SELECT * FROM teams WHERE category_id = ?').bind(c.id).all()).results : [];
    for (const x of teams) tmap[x.id] = uid();
    const mapIds = (arr) => (arr || []).map((id) => tmap[id]).filter(Boolean);
    const ncfg = {
      ...cfg,
      dayDates: dates.slice(0, days),
      dayBreakSlots: withSchedule ? cfg.dayBreakSlots || [] : [],
      lottery: withResults ? Object.fromEntries(Object.entries(cfg.lottery || {}).map(([g, ids]) => [g, mapIds(ids)])) : {},
      grouping: withTeams ? {
        fixed: Object.fromEntries(Object.entries((cfg.grouping || {}).fixed || {}).filter(([id]) => tmap[id]).map(([id, g]) => [tmap[id], g])),
        separate: ((cfg.grouping || {}).separate || []).map(mapIds).filter((x) => x.length > 1),
      } : { fixed: {}, separate: [] },
    };
    const cid = uid();
    stmts.push(db.prepare('INSERT INTO categories (id, tournament_id, name, sort, config, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(cid, nid, c.name, c.sort, JSON.stringify(normalizeConfig(ncfg)), now()));
    for (const x of teams) {
      stmts.push(db.prepare('INSERT INTO teams (id, category_id, name, short_name, club, logo, sort, group_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(tmap[x.id], cid, x.name, x.short_name, x.club, x.logo, x.sort, withSchedule ? x.group_label : null));
      teamCount++;
    }
    if (withSchedule) {
      const ms = (await db.prepare('SELECT * FROM matches WHERE category_id = ?').bind(c.id).all()).results;
      for (const m of ms) {
        const v = { ...m };
        v.home_team_id = m.home_team_id ? tmap[m.home_team_id] || null : null;
        v.away_team_id = m.away_team_id ? tmap[m.away_team_id] || null : null;
        if (!withResults) {
          Object.assign(v, { home_score: null, away_score: null, home_pk: null, away_pk: null, forfeit: null, status: 'none', updated_by: null, updated_at: null,
            version: 1, time_changed: 0, corrected: 0, ref_conflict: 0 });
          // トーナメントの「A組1位」などで決まる枠は、結果が無いので未定に戻す
          if (m.home_ref) v.home_team_id = null;
          if (m.away_ref) v.away_team_id = null;
        }
        stmts.push(db.prepare(`INSERT INTO matches (id, category_id, ${MATCH_COLS.join(', ')}) VALUES (?, ?, ${MATCH_COLS.map(() => '?').join(', ')})`)
          .bind(uid(), cid, ...MATCH_COLS.map((k) => (v[k] === undefined ? null : v[k]))));
        matchCount++;
      }
    }
  }
  const sps = (await db.prepare('SELECT * FROM sponsors WHERE tournament_id = ?').bind(t.id).all()).results;
  for (const sp of sps) stmts.push(db.prepare('INSERT INTO sponsors (id, tournament_id, name, url, image, sort, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(uid(), nid, sp.name, sp.url, sp.image, sp.sort, sp.active, now(), now()));
  await batchAll(db, stmts);
  return json({ ok: true, id: nid, categories: cats.length, teams: teamCount, matches: matchCount });
}, 'admin');

// ---------- 管理者: テンプレート ----------

const TEMPLATE_KEYS = ['dayBreaks', 'koTiming', 'periods', 'halfMinutes', 'halftimeMinutes', 'intervalMinutes', 'lunchEnabled', 'lunchStart', 'lunchMinutes', 'minLunchMinutes',
  'startTime', 'courts', 'courtNames', 'format', 'groups', 'advance', 'rankMode', 'knockoutPlan', 'tiebreak', 'forfeitScore', 'showStandings', 'minRestSlots'];

route('GET', '/api/admin/templates', async ({ db, user }) => {
  const r = isSuper(user) ? await db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all()
    : await db.prepare("SELECT * FROM templates WHERE (owner_id = ? OR ((owner_id IS NULL OR owner_id = 'root') AND shared = 1)) ORDER BY created_at DESC").bind(user.id).all();
  return json({ templates: r.results.map((x) => ({ ...x, config: JSON.parse(x.config), common: sharedOwner(x.owner_id), published: !!x.shared, editable: canEditOwned(user, x.owner_id) })) });
}, 'admin');

route('POST', '/api/admin/templates', async ({ req, db, user }) => {
  const b = await body(req);
  if (!b.name) fail(400, 'テンプレート名を入力してください');
  const cfg = Object.fromEntries(TEMPLATE_KEYS.filter((k) => b.config && k in b.config).map((k) => [k, b.config[k]]));
  await db.prepare('INSERT INTO templates (id, name, config, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').bind(uid(), clip(b.name, 60), JSON.stringify(cfg), ownerOf(user), now()).run();
  return json({ ok: true });
}, 'admin');

route('DELETE', '/api/admin/templates/:id', async ({ db, params, user }) => {
  const tp = await db.prepare('SELECT owner_id FROM templates WHERE id = ?').bind(params.id).first();
  if (!tp) fail(404, 'テンプレートが見つかりません');
  if (!canEditOwned(user, tp.owner_id)) fail(403, 'このテンプレートは作成した管理者だけが削除できます');
  await db.prepare('DELETE FROM templates WHERE id = ?').bind(params.id).run();
  return json({ ok: true });
}, 'admin');

// ---------- 閲覧者 ----------

route('GET', '/api/public/:slug', async ({ db, params, url }) => {
  const head = await getTournamentHead(db, params.slug);
  if (head.status === 'draft') fail(404, 'この大会はまだ公開されていません');
  // 閲覧ページは「閲覧ページ向けの版」で更新を判定する（仮登録では変わらない）
  if (url.searchParams.get('rev') === String(head.pub_rev)) return json({ unchanged: true, rev: head.pub_rev });
  return cachedPayload(`public:${head.slug}:${head.pub_rev}`, url.origin, async () => {
    const t = await getTournamentBySlug(db, params.slug);
    return publicPayload(db, { ...t, rev: t.pub_rev }, 'public');
  });
});

// ---------- 関係者 ----------

route('POST', '/api/rel/:slug/login', async ({ req, env, db, params }) => {
  const t = await getTournamentBySlug(db, params.slug);
  if (t.status === 'draft') fail(404, 'この大会はまだ公開されていません');
  const ip = req.headers.get('CF-Connecting-IP') || 'local';
  const key = `pin:${t.id}:${ip}`;
  const rl = await rateLimit(db, key, 5);
  if (!rl.ok) fail(429, `PINの入力回数が上限に達しました。${Math.ceil(rl.retryAfter / 60)}分後にもう一度お試しください`);
  const { pin } = await body(req);
  if (String(pin || '') !== t.pin) fail(401, 'PINが違います。大会本部から届いたPINを確認してください');
  await clearRateLimit(db, key);
  return json({ ok: true }, 200, { 'Set-Cookie': await issueRelative(env, t) });
});

route('GET', '/api/rel/:slug', async ({ req, env, db, params, url }) => {
  const head = await getTournamentHead(db, params.slug);
  if (!(await isRelative(req, env, head))) fail(401, 'PINを入力してください');
  if (url.searchParams.get('rev') === String(head.rev)) return json({ unchanged: true, rev: head.rev });
  return cachedPayload(`relative:${head.slug}:${head.rev}`, url.origin, async () => publicPayload(db, await getTournamentBySlug(db, params.slug), 'relative'));
});

route('POST', '/api/rel/:slug/matches/:id', async ({ req, env, db, params }) => {
  const t = await getTournamentBySlug(db, params.slug);
  if (!(await isRelative(req, env, t))) fail(401, 'PINを入力してください');
  if (t.status !== 'published' && t.status !== 'live') fail(409, '現在は結果を登録できません');
  const { m, c } = await getMatchCtx(db, params.id);
  if (c.tournament_id !== t.id) fail(404, '試合が見つかりません');
  const b = await body(req);
  const team = await db.prepare('SELECT * FROM teams WHERE id = ? AND category_id = ?').bind(b.teamId, c.id).first();
  if (!team || (team.id !== m.home_team_id && team.id !== m.away_team_id)) fail(403, '自チームの試合だけ登録できます');
  if (m.status === 'confirmed') fail(409, 'この試合は本部で確定済みです。変更は本部に連絡してください');
  const s = validateScore(m, { ...b, forfeit: null }, c.config);
  const r = await db.prepare(`UPDATE matches SET home_score = ?, away_score = ?, home_pk = ?, away_pk = ?, forfeit = NULL, status = 'provisional',
    updated_by = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ? AND status != 'confirmed'`)
    .bind(s.home, s.away, s.hpk, s.apk, team.short_name || team.name, now(), m.id, Number(b.version)).run();
  if (!r.meta.changes) {
    const cur = parseMatch(await db.prepare('SELECT * FROM matches WHERE id = ?').bind(m.id).first());
    fail(409, '他の人が先に更新しました。最新の内容を確認してください', { match: maskMatch(cur, 'relative') });
  }
  await bump(db, t.id, false); // 仮登録は保護者には見えないので、閲覧ページの読み込み直しは起こさない
  return json({ ok: true });
});
