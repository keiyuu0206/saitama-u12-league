// 使い方: npm run dev を起動した状態で npm run test:e2e
const B = process.env.BASE_URL || 'http://127.0.0.1:8787';
const PW = process.env.ADMIN_PASSWORD || 'test-pass';
const jar = { admin: '', rel: '' };
async function call(who, method, path, body, headers = {}) {
  const res = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', Cookie: jar[who] || '', ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) jar[who] = sc.split(';')[0];
  let data = {}; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
let ok = 0, ng = 0;
const expect = (cond, msg, extra) => { if (cond) { ok++; } else { ng++; console.log('NG:', msg, extra ? JSON.stringify(extra).slice(0, 300) : ''); } };

let r = await call('admin', 'POST', '/api/admin/login', { password: 'wrong' });
expect(r.status === 401, 'wrong password rejected');
r = await call('admin', 'POST', '/api/admin/login', { password: PW });
expect(r.status === 200, 'login');
r = await call('admin', 'POST', '/api/admin/tournaments', { name: 'さくらカップ', date: '2026-10-18', venue: '市民グラウンド' });
const tid = r.data.id;
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
const { slug, pin } = r.data.tournament;
expect(slug && /^\d{4}$/.test(pin), 'slug & pin', r.data.tournament);

r = await call('admin', 'POST', `/api/admin/tournaments/${tid}/categories`, { name: 'U10', config: { format: 'league_knockout', groups: 2, courts: 2, advance: 2, rankMode: 'top3' } });
const cid = r.data.id;
const teams = ['さくらFC A,さくらFC', 'さくらFC B,さくらFC', '青空SC', '緑川JFC', '港北キッカーズ', '山手SSS', '東台FC', '西野ユナイテッド'].map((l) => { const [name, club] = l.split(','); return { name, club }; });
r = await call('admin', 'POST', `/api/admin/categories/${cid}/teams`, { teams });
expect(r.data.added === 8, 'add teams');
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
let cat = r.data.categories[0];
const byName = Object.fromEntries(cat.teams.map((t) => [t.name, t.id]));
// 主催チーム固定と同組NG
r = await call('admin', 'PATCH', `/api/admin/categories/${cid}`, { config: { grouping: { fixed: { [byName['青空SC']]: 'A' }, separate: [[byName['緑川JFC'], byName['港北キッカーズ']]] } } });
expect(r.status === 200, 'save grouping constraints');
r = await call('admin', 'POST', `/api/admin/categories/${cid}/grouping`);
const asg = r.data.assignment;
expect(asg[byName['青空SC']] === 'A', 'host fixed in A');
expect(asg[byName['さくらFC A']] !== asg[byName['さくらFC B']], 'same club separated');
expect(asg[byName['緑川JFC']] !== asg[byName['港北キッカーズ']], 'separate pair');
r = await call('admin', 'POST', `/api/admin/categories/${cid}/generate`, { assignment: asg, dryRun: true });
expect(r.data.matches.length === 16 && r.data.warnings.length === 0, 'dry run 12 league + 4 ko', { n: r.data.matches?.length, w: r.data.warnings });
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
expect(r.data.categories[0].matches.length === 0, 'dry run did not save');
r = await call('admin', 'POST', `/api/admin/categories/${cid}/generate`, { assignment: asg });
expect(r.status === 200, 'generate saved');

// 公開前は閲覧不可
r = await call('anon', 'GET', `/api/public/${slug}`);
expect(r.status === 404, 'draft hidden');
await call('admin', 'PATCH', `/api/admin/tournaments/${tid}`, { status: 'published' });
r = await call('anon', 'GET', `/api/public/${slug}`);
expect(r.status === 200 && r.data.categories[0].matches.length === 16, 'public visible');
expect(!('pin' in r.data.tournament), 'pin not leaked');
const rev1 = r.data.tournament.rev;
r = await call('anon', 'GET', `/api/public/${slug}?rev=${rev1}`);
expect(r.data.unchanged === true, 'rev unchanged shortcut');

// 開始時刻を30分ずらすと全試合が30分後ろへ
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
cat = r.data.categories[0];
const firstBefore = Math.min(...cat.matches.map((m) => m.start_min));
// 公開中は設定・チーム・日程がロックされる（一時解除 ?unlock=1 の操作だけ受け付ける）
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
const statusNow = r.data.tournament.status;
r = await call('admin', 'PATCH', `/api/admin/categories/${cid}`, { config: { startTime: cat.config.startTime + 30 } });
expect(statusNow === 'draft' ? r.status === 200 : r.status === 423, 'settings locked when published');
if (statusNow !== 'draft') {
  expect((await call('admin', 'POST', `/api/admin/categories/${cid}/teams`, { teams: [{ name: '追加チーム' }] })).status === 423, 'add team locked when published');
  expect((await call('admin', 'POST', `/api/admin/categories/${cid}/grouping`)).status === 423, 'grouping locked when published');
  const anyTeam = cat.teams[0];
  expect((await call('admin', 'PATCH', `/api/admin/teams/${anyTeam.id}`, { name: anyTeam.name })).status === 200, 'team rename allowed when published');
  await call('admin', 'PATCH', `/api/admin/categories/${cid}?unlock=1`, { config: { startTime: cat.config.startTime + 30 } });
}
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
cat = r.data.categories[0];
expect(Math.min(...cat.matches.map((m) => m.start_min)) === firstBefore + 30, 'global shift +30');

// 関係者
r = await call('rel', 'POST', `/api/rel/${slug}/login`, { pin: '0000' === pin ? '1111' : '0000' });
expect(r.status === 401, 'wrong pin rejected');
r = await call('rel', 'POST', `/api/rel/${slug}/login`, { pin });
expect(r.status === 200, 'relative login');
r = await call('rel', 'GET', `/api/rel/${slug}`);
let rc = r.data.categories[0];
const lm = rc.matches.find((m) => m.stage === 'league');
r = await call('rel', 'POST', `/api/rel/${slug}/matches/${lm.id}`, { teamId: lm.home_team_id, home_score: 2, away_score: 1, version: lm.version });
expect(r.status === 200, 'relative provisional', r.data);
r = await call('rel', 'POST', `/api/rel/${slug}/matches/${lm.id}`, { teamId: lm.away_team_id, home_score: 3, away_score: 1, version: lm.version });
expect(r.status === 409 && r.data.match && r.data.match.home_score === 2, 'stale version conflict', r.data);
const other = rc.teams.find((t) => t.id !== lm.home_team_id && t.id !== lm.away_team_id);
r = await call('rel', 'POST', `/api/rel/${slug}/matches/${lm.id}`, { teamId: other.id, home_score: 0, away_score: 0, version: lm.version + 1 });
expect(r.status === 403, 'other team cannot edit');
r = await call('rel', 'POST', `/api/rel/${slug}/matches/${lm.id}`, { teamId: lm.away_team_id, home_score: 2, away_score: 2, version: lm.version + 1 });
expect(r.status === 200, 'opponent edits provisional');
r = await call('anon', 'GET', `/api/public/${slug}`);
let pm = r.data.categories[0].matches.find((m) => m.id === lm.id);
expect(pm.status === 'provisional' && pm.home_score === undefined, 'provisional score hidden from public', pm);

// 他サイトからの書き込みは拒否
r = await call('admin', 'POST', `/api/admin/categories/${cid}/confirm`, { matchIds: [lm.id] }, { Origin: 'https://evil.example' });
expect(r.status === 403, 'cross-origin blocked');
r = await call('admin', 'POST', `/api/admin/categories/${cid}/confirm`, { matchIds: [lm.id] });
expect(r.data.confirmed === 1, 'bulk confirm');
r = await call('anon', 'GET', `/api/public/${slug}`);
pm = r.data.categories[0].matches.find((m) => m.id === lm.id);
expect(pm.status === 'confirmed' && pm.home_score === 2 && pm.away_score === 2, 'confirmed visible');
r = await call('rel', 'POST', `/api/rel/${slug}/matches/${lm.id}`, { teamId: lm.home_team_id, home_score: 5, away_score: 0, version: 99 });
expect(r.status === 409, 'relative cannot edit confirmed');

// 開催中にする → 組み合わせ変更不可
await call('admin', 'PATCH', `/api/admin/tournaments/${tid}`, { status: 'live' });
r = await call('admin', 'POST', `/api/admin/categories/${cid}/move`, { matchId: lm.id, slot: 0, court: 0 });
expect(r.status === 423, 'move locked when live');
r = await call('admin', 'POST', `/api/admin/categories/${cid}/move?unlock=1`, { matchId: lm.id, slot: 0, court: 0 });
expect(r.status === 409, 'move blocked when live even if unlocked');

// 遅延調整（昼休憩をまたぐ）
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
cat = r.data.categories[0];
const amTarget = cat.matches.filter((m) => m.status === 'none' && m.session === 'am' && cat.matches.some((x) => x.court === m.court && x.session === 'pm')).sort((a, b) => a.start_min - b.start_min)[0];
if (amTarget) {
  r = await call('admin', 'POST', `/api/admin/categories/${cid}/delay`, { matchId: amTarget.id, minutes: 10, dryRun: true });
  expect(r.data.needsLunchChoice === true, 'lunch choice offered', r.data);
  r = await call('admin', 'POST', `/api/admin/categories/${cid}/delay`, { matchId: amTarget.id, minutes: 10, lunchMode: 'shorten' });
  expect(r.data.ok && r.data.changed > 0, 'delay applied', r.data);
  r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
  const after = r.data.categories[0].matches.find((m) => m.id === amTarget.id);
  expect(after.start_min === amTarget.start_min + 10 && after.time_changed === 1, 'delayed +10 & flagged');
} else console.log('（午前・午後をまたぐコートが無いため昼休憩テストを省略）');

// 予選を全部確定 → 準決勝が埋まる
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
cat = r.data.categories[0];
for (const m of cat.matches.filter((x) => x.stage === 'league' && x.status !== 'confirmed')) {
  const hi = cat.teams.findIndex((t) => t.id === m.home_team_id), ai = cat.teams.findIndex((t) => t.id === m.away_team_id);
  r = await call('admin', 'POST', `/api/admin/matches/${m.id}/result`, { home_score: hi < ai ? 3 : 1, away_score: hi < ai ? 1 : 3, confirm: true });
  if (r.status !== 200) expect(false, 'confirm league', r.data);
}
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
cat = r.data.categories[0];
const sfs = cat.matches.filter((m) => m.label.startsWith('準決勝'));
expect(sfs.every((m) => m.home_team_id && m.away_team_id), 'semis resolved', sfs);
const A = cat.standings.A.rows, Bs = cat.standings.B.rows;
expect(sfs.some((m) => m.home_team_id === A[0].teamId && m.away_team_id === Bs[1].teamId), 'A1 vs B2 cross');

// 同点はPKが必要
r = await call('admin', 'POST', `/api/admin/matches/${sfs[0].id}/result`, { home_score: 1, away_score: 1, confirm: true });
expect(r.status === 400, 'knockout tie requires PK');
r = await call('admin', 'POST', `/api/admin/matches/${sfs[0].id}/result`, { home_score: 1, away_score: 1, home_pk: 4, away_pk: 3, confirm: true });
expect(r.status === 200, 'PK win');
r = await call('admin', 'POST', `/api/admin/matches/${sfs[1].id}/result`, { home_score: 0, away_score: 2, confirm: true });
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
cat = r.data.categories[0];
const fin = cat.matches.find((m) => m.label === '決勝');
const third = cat.matches.find((m) => m.label === '3位決定戦');
expect(fin.home_team_id === sfs[0].home_team_id && fin.away_team_id === sfs[1].away_team_id, 'final resolved');
await call('admin', 'POST', `/api/admin/matches/${fin.id}/result`, { forfeit: 'away', confirm: true });
await call('admin', 'POST', `/api/admin/matches/${third.id}/result`, { home_score: 2, away_score: 0, confirm: true });
r = await call('anon', 'GET', `/api/public/${slug}`);
const fr = r.data.categories[0].finalRanking;
expect(fr.length === 4 && fr[0].teamId === sfs[1].away_team_id, 'final ranking (forfeit winner first)', fr);

// 予選結果を後から修正 → 開始済みの試合は警告フラグ
const lg = cat.matches.find((m) => m.stage === 'league' && (m.home_team_id === A[0].teamId || m.away_team_id === A[0].teamId));
// 予選首位を落とすように大差で修正（複数試合）
for (const m of cat.matches.filter((x) => x.stage === 'league' && x.group_label === 'A' && (x.home_team_id === A[0].teamId || x.away_team_id === A[0].teamId))) {
  const homeIsTop = m.home_team_id === A[0].teamId;
  await call('admin', 'POST', `/api/admin/matches/${m.id}/result`, { home_score: homeIsTop ? 0 : 9, away_score: homeIsTop ? 9 : 0, confirm: true });
}
r = await call('admin', 'GET', `/api/admin/tournaments/${tid}`);
cat = r.data.categories[0];
expect(cat.matches.some((m) => m.ref_conflict === 1), 'ref conflict flagged after correction');
expect(cat.matches.find((m) => m.id === lg.id).corrected === 1, 'corrected flag');

// テンプレート
r = await call('admin', 'POST', '/api/admin/templates', { name: 'U10 2組クロス', config: cat.config });
r = await call('admin', 'GET', '/api/admin/templates');
const tp = r.data.templates.find((x) => x.name === 'U10 2組クロス');
expect(tp && tp.config.format === 'league_knockout' && !('lottery' in tp.config), 'template saved');

// PIN再発行で関係者セッション無効化
await call('admin', 'POST', `/api/admin/tournaments/${tid}/pin`);
r = await call('rel', 'GET', `/api/rel/${slug}`);
expect(r.status === 401, 'pin reissue invalidates session');

// PINの総当たり制限
let last;
for (let i = 0; i < 6; i++) last = await call('x', 'POST', `/api/rel/${slug}/login`, { pin: 'zzzz' });
expect(last.status === 429, 'pin rate limited', last);

// 静的ファイルとSPA
const html = await fetch(B + '/t/' + slug, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } });
expect(html.status === 200 && (await html.text()).includes('id="app"'), 'SPA fallback');
console.log(`pass ${ok} / fail ${ng}`);
if (ng) process.exit(1);
