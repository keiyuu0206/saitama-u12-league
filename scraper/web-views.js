import { h, toHHMM, todayStr, nowMin, icon, formatDate } from './web-ui.js';

export const matchLength = (cfg) => {
  const n = cfg.periods || 2;
  return cfg.halfMinutes * n + (n > 1 ? cfg.halftimeMinutes * (n - 1) : 0);
};
export function matchLengthFor(cfg, m) {
  if (m && m.stage === 'knockout' && cfg.koTiming && cfg.koTiming.enabled && cfg.format === 'league_knockout') return matchLength({ ...cfg, ...cfg.koTiming });
  return matchLength(cfg);
}
export const courtName = (cfg, i) => (cfg.courtNames && cfg.courtNames[i]) || `${String.fromCharCode(65 + i)}コート`;

// 複数日開催
export const dayOf = (cfg, slot) => (cfg.dayBreakSlots || []).filter((b) => slot >= b).length;
export const dayTotal = (cfg) => (cfg.dayBreakSlots || []).length + 1;
export const absMin = (cfg, m) => dayOf(cfg, m.slot) * 1440 + m.start_min;
export function dayDate(cat, d, tournament) {
  const picked = cat.config.dayDates || [];
  if (picked[d]) return picked[d];
  if (!d) return tournament.date || null;
  const x = (cat.config.extraDays || [])[d - 1];
  return (x && x.date) || null;
}
export function dayLabel(cat, d, tournament, short = false) {
  const date = dayDate(cat, d, tournament);
  if (!date) return `${d + 1}日目`;
  const dt = new Date(`${date}T00:00:00`);
  const md = `${dt.getMonth() + 1}/${dt.getDate()}（${'日月火水木金土'[dt.getDay()]}）`;
  return short ? `${d + 1}日目 ${md}` : `${d + 1}日目　${formatDate(date)}`;
}
// 今日が何日目か（無ければ -1）
export function todayIndex(cat, tournament) {
  const t = todayStr();
  for (let d = 0; d < dayTotal(cat.config); d++) if (dayDate(cat, d, tournament) === t) return d;
  return -1;
}

export const teamMap = (cat) => Object.fromEntries(cat.teams.map((t) => [t.id, t]));
export const codeMap = (cat) => Object.fromEntries(cat.matches.filter((m) => m.code).map((m) => [m.code, m]));

export const TIEBREAK_LABEL = { points: '勝点', gd: '得失点差', gf: '総得点', h2h: '当該チーム間の対戦成績', janken: '代表者によるじゃんけん', lottery: '抽選' };
// 本部で決める方法の呼び名（判定順で最初に出てくるもの。どちらも無ければ「本部で決定」）
export function manualLabel(cfg) {
  const first = (cfg.tiebreak || []).find((k) => k === 'janken' || k === 'lottery');
  return first === 'janken' ? 'じゃんけん' : first === 'lottery' ? '抽選' : '本部で決定';
}

export function refText(ref, byCode) {
  if (!ref) return '未定';
  if (ref.t === 'grp') return `${ref.g}組${ref.r}位`;
  if (ref.t === 'win' || ref.t === 'lose') {
    const m = byCode[ref.m];
    return `${m ? m.label : ref.m}の${ref.t === 'win' ? '勝者' : '敗者'}`;
  }
  return '未定';
}

export function sideInfo(m, side, cat, cache = {}) {
  const tm = cache.teams || teamMap(cat);
  const id = side === 'home' ? m.home_team_id : m.away_team_id;
  if (id && tm[id]) return { team: tm[id], text: tm[id].name, placeholder: false };
  const ref = side === 'home' ? m.home_ref : m.away_ref;
  return { team: null, text: refText(ref, cache.codes || codeMap(cat)), placeholder: true };
}

export function winnerSide(m) {
  if (m.home_score == null || m.away_score == null) return null;
  if (m.forfeit) return m.forfeit;
  if (m.home_score !== m.away_score) return m.home_score > m.away_score ? 'home' : 'away';
  if (m.home_pk != null && m.away_pk != null && m.home_pk !== m.away_pk) return m.home_pk > m.away_pk ? 'home' : 'away';
  return null;
}

export function statusOf(m, cat, tournament) {
  if (m.status === 'confirmed') return { key: 'confirmed', label: '終了', cls: 'done' };
  if (m.status === 'provisional') return { key: 'provisional', label: '結果待ち', cls: 'wait' };
  const today = todayStr();
  const end = m.start_min + matchLengthFor(cat.config, m);
  const date = dayDate(cat, dayOf(cat.config, m.slot), tournament);
  if (date && date < today) return { key: 'waiting', label: '結果待ち', cls: 'wait' };
  if (date === today && tournament.status === 'live') {
    const n = nowMin();
    if (n >= m.start_min && n < end) return { key: 'playing', label: '試合中', cls: 'live' };
    if (n >= end) return { key: 'waiting', label: '結果待ち', cls: 'wait' };
  }
  return { key: 'upcoming', label: toHHMM(m.start_min), cls: '' };
}

// エンブレム。ロゴが無ければチーム名の頭文字と、名前から決まる色で丸いマークを作る
function hue(s) {
  let x = 0;
  for (const ch of s) x = (x * 31 + ch.codePointAt(0)) % 3600;
  return x % 360;
}
export function crest(team, size = 28) {
  const box = `width:${size}px;height:${size}px;`;
  if (team && team.logo) return h('img', { class: 'crest', src: team.logo, alt: '', width: size, height: size, style: box });
  if (!team) return h('span', { class: 'crest crest-ph', 'aria-hidden': 'true', style: `${box}font-size:${Math.round(size * 0.4)}px` }, '?');
  const ch = [...team.name.replace(/^(FC|SC|JFC|SSS|SSC)\s*/i, '').trim()][0] || [...team.name][0];
  return h('span', { class: 'crest', 'aria-hidden': 'true', style: `${box}font-size:${Math.round(size * 0.42)}px;--h:${hue(team.name)}` }, ch);
}

// 旧呼び出し互換（管理画面などで使う場合のため）
export function scoreEl(m, { showProvisional = false } = {}) {
  const visible = m.status === 'confirmed' || (showProvisional && m.status === 'provisional');
  if (!visible || m.home_score == null) return h('span', { class: 'mc-score' }, '-');
  return h('span', { class: 'mc-score' }, `${m.home_score} - ${m.away_score}`);
}

export function matchCard(m, cat, ctx) {
  const cache = ctx.cache || {};
  const st = statusOf(m, cat, ctx.tournament);
  const mineMatch = ctx.myTeam && (m.home_team_id === ctx.myTeam || m.away_team_id === ctx.myTeam);
  const showScore = m.status === 'confirmed' || (ctx.showProvisional && m.status === 'provisional');
  const w = showScore ? winnerSide(m) : null;

  const row = (side) => {
    const info = sideInfo(m, side, cat, cache);
    const id = side === 'home' ? m.home_team_id : m.away_team_id;
    const score = showScore ? (side === 'home' ? m.home_score : m.away_score) : null;
    const pk = showScore && m.home_pk != null ? (side === 'home' ? m.home_pk : m.away_pk) : null;
    const cls = w ? (w === side ? 'win' : 'lose') : '';
    return h('div', { class: `mc-row ${cls}` },
      crest(info.team, 28),
      h('span', { class: `mc-name${info.placeholder ? ' ph' : ''}` }, info.text, id && id === ctx.myTeam ? icon('star') : null),
      h('span', { class: 'mc-score' }, score ?? '', pk != null ? h('small', null, `PK${pk}`) : null));
  };

  const status = st.key === 'playing'
    ? h('span', { class: 'mc-st live' }, h('i', { class: 'dot pulse' }), '試合中')
    : h('span', { class: `mc-st ${st.cls}` }, st.label);

  return h('article', { class: `mc${mineMatch ? ' is-mine' : ''}`, 'aria-label': `${m.label} ${sideInfo(m, 'home', cat, cache).text} 対 ${sideInfo(m, 'away', cat, cache).text}` },
    h('div', { class: 'mc-meta' },
      h('span', { class: 'mc-court' }, courtName(cat.config, m.court)),
      h('span', null, m.label),
      m.forfeit && showScore ? h('span', { class: 'flag' }, '不戦勝') : null,
      m.time_changed ? h('span', { class: 'flag changed' }, '時間変更') : null,
      m.corrected && m.status === 'confirmed' ? h('span', { class: 'flag' }, '修正あり') : null,
      status),
    row('home'), row('away'));
}

export function scheduleView(cat, ctx, filter = () => true) {
  const cfg = cat.config;
  const list = cat.matches.filter(filter).sort((a, b) => absMin(cfg, a) - absMin(cfg, b) || a.court - b.court);
  if (!list.length) return h('p', { class: 'empty' }, ctx.emptyText || '表示できる試合がありません');
  const multi = dayTotal(cfg) > 1;
  const out = [];
  let cur = null;
  let prevSession = null;
  let prevDay = -1;
  for (const m of list) {
    const d = dayOf(cfg, m.slot);
    if (d !== prevDay) {
      if (multi) out.push(h('h2', { class: 'day-head' }, dayLabel(cat, d, ctx.tournament)));
      prevDay = d;
      prevSession = null;
      cur = null;
    }
    if (prevSession === 'am' && m.session === 'pm') out.push(h('div', { class: 'break' }, '昼休憩'));
    prevSession = m.session;
    if (!cur || cur.t !== m.start_min) {
      const listEl = h('div', { class: 'slot-list' });
      const head = h('div', { class: 'slot-head' }, h('span', { class: 't' }, toHHMM(m.start_min)));
      cur = { t: m.start_min, list: listEl, head, live: false };
      out.push(h('section', { class: 'slot', 'data-t': m.start_min, 'data-d': d }, head, listEl));
    }
    if (!cur.live && statusOf(m, cat, ctx.tournament).key === 'playing') {
      cur.live = true;
      cur.head.append(h('span', { class: 'live-label' }, h('i', { class: 'dot pulse' }), '試合中'));
    }
    cur.list.append(matchCard(m, cat, ctx));
  }
  return h('div', null, out);
}

// リーグ戦の段の試合（試合コードが R で始まる）
export const isRankLeague = (m) => m && m.stage === 'knockout' && /^R\d/.test(m.code || '');

// 組ごとの人数（組分け前は設定から見積もる）
export function groupSizesOf(cat) {
  const sizes = {};
  for (const x of cat.teams) if (x.group_label) sizes[x.group_label] = (sizes[x.group_label] || 0) + 1;
  if (Object.keys(sizes).length) return sizes;
  const G = Math.max(1, cat.config.groups || 1);
  const n = Math.max(cat.teams.length, G * 2);
  return Object.fromEntries(Array.from({ length: G }, (_, i) => [String.fromCharCode(65 + i), Math.floor(n / G) + (i < n % G ? 1 : 0)]));
}

// 決勝の段の一覧（名前・各組の何位から何位まで・形式・チーム数）。サーバーの expandPlan と同じ考え方
export function planBrackets(cat) {
  const plan = cat.config.knockoutPlan || { type: 'top', k: 2 };
  const sizes = groupSizesOf(cat);
  const maxRank = Math.max(...Object.values(sizes));
  const k = Math.max(1, Math.min(maxRank, Number(plan.k) || 2));
  const m = Math.max(1, Math.min(maxRank, Number(plan.m) || k));
  let list;
  if (plan.type === 'all') list = [{ name: '決勝トーナメント', from: 1, to: maxRank }];
  else if (plan.type === 'split') list = [{ name: '上位トーナメント', from: 1, to: k }, { name: '下位トーナメント', from: k + 1, to: maxRank }];
  else if (plan.type === 'split3') list = [{ name: '上位トーナメント', from: 1, to: k }, { name: '中位トーナメント', from: k + 1, to: k + m }, { name: '下位トーナメント', from: k + m + 1, to: maxRank }];
  else if (plan.type === 'byrank') list = Array.from({ length: maxRank }, (_, i) => ({ name: `${i + 1}位トーナメント`, from: i + 1, to: i + 1 }));
  else if (plan.type === 'custom') list = (plan.brackets || []).map((b, i) => ({ name: b.name || `トーナメント${i + 1}`, from: Number(b.from) || 1, to: Number(b.to) || 1, format: b.format }));
  else list = [{ name: '決勝トーナメント', from: 1, to: k }];
  const formats = plan.formats || {};
  return list.map((b, i) => {
    const format = (plan.type === 'custom' ? b.format : formats[i]) === 'league' ? 'league' : 'knockout';
    return { ...b, format, name: format === 'league' && plan.type !== 'custom' ? b.name.replace(/トーナメント$/, 'リーグ') : b.name };
  }).filter((b) => b.from <= Math.min(b.to, maxRank)).map((b) => {
    const to = Math.min(b.to, maxRank);
    let n = 0;
    for (let r = b.from; r <= to; r++) for (const v of Object.values(sizes)) if (v >= r) n++;
    return { ...b, to, n };
  });
}

export function standingsView(cat, ctx) {
  const all = cat.standings || {};
  // 予選の組を先に、リーグ戦の段（下位リーグなど）を後に並べる。ctx.only で一部だけ表示
  const groups = Object.keys(all).filter((g) => !ctx.only || ctx.only.includes(g))
    .sort((a, b) => (all[a].placement ? 1 : 0) - (all[b].placement ? 1 : 0) || (all[a].offset || 0) - (all[b].offset || 0) || a.localeCompare(b));
  if (!groups.length) return h('p', { class: 'empty' }, '順位表はまだありません');
  const tm = teamMap(cat);
  const plan = cat.config.knockoutPlan || { type: 'top', k: cat.config.advance };
  const lk = cat.config.format === 'league_knockout';
  const advance = lk && (plan.type === 'top' || plan.type === 'split' || plan.type === 'split3') ? plan.k : 0;
  const mid = plan.m || plan.k;
  void mid;
  // 予選の後の進み先（段の形式に合わせて「下位リーグへ」などと表示）
  const brs = lk ? planBrackets(cat) : [];
  const rng = (b) => (b.from === b.to ? `${b.from}位` : `${b.from}〜${b.to}位`);
  const note = !lk ? null
    : plan.type === 'top' ? `上位${plan.k}チームが決勝トーナメントへ`
      : plan.type === 'all' ? '全チームが決勝トーナメントへ'
        : plan.type === 'byrank' && !brs.some((b) => b.format === 'league') ? '同じ順位のチームどうしでトーナメント'
          : brs.map((b) => `${rng(b)}は${b.name}`).join('、') + 'へ';
  return h('div', null, groups.map((g) => {
    const st = cat.standings[g];
    if (st.placement) return rankLeagueCard(cat, g, st, ctx, tm);
    const badge = st.complete
      ? (st.needsLottery ? h('span', { class: 'st-badge alert' }, `${manualLabel(cat.config)}待ち`) : h('span', { class: 'st-badge ok' }, '確定'))
      : h('span', { class: 'st-badge' }, '途中経過');
    return h('section', { class: 'st-card' },
      h('div', { class: 'st-head' }, h('h2', null, `${g}組`), badge),
      h('div', { class: 'table-wrap' }, h('table', { class: 'standings' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, '順位')),
          h('th', { scope: 'col', style: { textAlign: 'left' } }, 'チーム'),
          ['試', '勝', '分', '敗', '得', '失', '差', '点'].map((x) => h('th', { scope: 'col', class: x === '得' || x === '失' ? 'opt' : null }, x)))),
        h('tbody', null, st.rows.map((r) => h('tr', { class: `${r.teamId === ctx.myTeam ? 'mine' : ''} ${r.rank <= advance ? 'advance' : ''}` },
          h('td', { class: 'rank' }, h('span', { class: 'rank-no' }, r.rank)),
          h('td', { class: 'team' }, h('div', { class: 'st-team' }, crest(tm[r.teamId], 22), h('span', null, tm[r.teamId] ? (tm[r.teamId].short_name || tm[r.teamId].name) : '-'),
            r.tied && st.complete ? h('span', { class: 'tie-mark' }, `${manualLabel(cat.config)}待ち`) : null,
            r.lottery ? h('span', { class: 'tie-mark' }, manualLabel(cat.config)) : null)),
          h('td', null, r.p), h('td', null, r.w), h('td', null, r.d), h('td', null, r.l),
          h('td', { class: 'opt' }, r.gf), h('td', { class: 'opt' }, r.ga), h('td', null, r.gd > 0 ? `+${r.gd}` : r.gd),
          h('td', { class: 'pts' }, r.pts)))))),
      note ? h('div', { class: 'st-note' }, h('span', null, advance ? h('i') : null, note)) : null);
  }), ctx.noFoot ? null : h('p', { class: 'muted small', style: { margin: '14px 4px 0' } }, (() => {
    const order = (cat.config.tiebreak || []).filter((k) => k !== 'points').map((k) => TIEBREAK_LABEL[k]);
    const manual = (cat.config.tiebreak || []).some((k) => k === 'janken' || k === 'lottery');
    return `勝点が並んだときは ${order.length ? order.join('、') : '本部の決定'} の順で決めます。${manual ? '' : 'それでも決まらないときは本部で決めます。'}`;
  })()));
}

// リーグ戦の段（下位リーグなど）の順位表
function rankLeagueCard(cat, name, st, ctx, tm) {
  const slots = (st.slots || []).join('・');
  const badge = !st.rows.length ? h('span', { class: 'st-badge' }, '予選の結果待ち')
    : st.complete ? (st.needsLottery ? h('span', { class: 'st-badge alert' }, `${manualLabel(cat.config)}待ち`) : h('span', { class: 'st-badge ok' }, '確定'))
      : h('span', { class: 'st-badge' }, '途中経過');
  if (!st.rows.length) {
    return h('section', { class: 'st-card' }, h('div', { class: 'st-head' }, h('h2', null, name), badge),
      h('p', { class: 'muted small', style: { margin: '0 4px 6px' } }, `${slots} による総当たりです。予選の順位が決まると、参加チームが表示されます。`));
  }
  return h('section', { class: 'st-card' },
    h('div', { class: 'st-head' }, h('h2', null, name), badge),
    h('div', { class: 'table-wrap' }, h('table', { class: 'standings' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, '順位')),
        h('th', { scope: 'col', style: { textAlign: 'left' } }, 'チーム'),
        ['試', '勝', '分', '敗', '得', '失', '差', '点'].map((x) => h('th', { scope: 'col', class: x === '得' || x === '失' ? 'opt' : null }, x)))),
      h('tbody', null, st.rows.map((r) => h('tr', { class: r.teamId === ctx.myTeam ? 'mine' : '' },
        // 全体の順位は順位の数字の下に小さく（横幅を取らない）
        h('td', { class: 'rank' }, h('span', { class: 'rank-no' }, r.rank), st.complete && !r.tied ? h('span', { class: 'rank-all' }, `全体${(st.offset || 0) + r.rank}位`) : null),
        h('td', { class: 'team' }, h('div', { class: 'st-team' }, crest(tm[r.teamId], 22), h('span', null, tm[r.teamId] ? (tm[r.teamId].short_name || tm[r.teamId].name) : '-'),
          r.tied && st.complete ? h('span', { class: 'tie-mark' }, `${manualLabel(cat.config)}待ち`) : null,
          r.lottery ? h('span', { class: 'tie-mark' }, manualLabel(cat.config)) : null)),
        h('td', null, r.p), h('td', null, r.w), h('td', null, r.d), h('td', null, r.l),
        h('td', { class: 'opt' }, r.gf), h('td', { class: 'opt' }, r.ga), h('td', null, r.gd > 0 ? `+${r.gd}` : r.gd),
        h('td', { class: 'pts' }, r.pts)))))),
    h('div', { class: 'st-note' }, h('span', null, `${slots} による総当たり。この表の順位が全体の${(st.offset || 0) + 1}位〜${(st.offset || 0) + (st.slots || []).length}位になります`)));
}

export function finalRankingView(cat, ctx) {
  if (!cat.finalRanking || !cat.finalRanking.length) return null;
  const tm = teamMap(cat);
  return h('section', null,
    h('div', { class: 'section-title' }, icon('trophy'), h('h2', null, '最終順位')),
    h('div', { class: 'podium' }, cat.finalRanking.map((r) => h('div', { class: `p r${r.rank}${r.teamId === ctx.myTeam ? ' mine' : ''}` },
      h('span', { class: 'r' }, `${r.rank}位`), crest(tm[r.teamId], 32), h('strong', null, tm[r.teamId] ? tm[r.teamId].name : '-')))));
}

export function bracketNames(cat) {
  const ko = cat.matches.filter((m) => m.stage === 'knockout' && !isRankLeague(m));
  const seen = [];
  const top = {};
  for (const m of ko) {
    const n = m.group_label || '';
    if (!seen.includes(n)) seen.push(n);
    top[n] = Math.min(top[n] ?? Infinity, m.place_w ?? m.place_l ?? Infinity);
  }
  return seen.sort((a, b) => top[a] - top[b]);
}

export function bracketView(cat, ctx) {
  const ko = cat.matches.filter((m) => m.stage === 'knockout' && !isRankLeague(m));
  // リーグ戦の段（下位リーグなど）は、トーナメント表の後に順位表として載せる
  const leagues = ctx.only !== undefined || ctx.noLeagues ? [] : Object.keys(cat.standings || {}).filter((g) => cat.standings[g].placement);
  if (!ko.length) {
    if (leagues.length) return h('div', null, finalRankingView(cat, ctx), h('div', { class: 'rank-leagues' }, standingsView(cat, { ...ctx, only: leagues })));
    return h('p', { class: 'empty' }, 'トーナメントはありません');
  }
  const cache = { teams: teamMap(cat), codes: codeMap(cat) };
  // 複数のトーナメント（上位・下位など）は分けて表示する
  const sections = [];
  for (const m of ko) {
    const name = m.group_label || '';
    let sec = sections.find((x) => x.name === name);
    if (!sec) sections.push((sec = { name, list: [] }));
    sec.list.push(m);
  }
  // 上位のトーナメントから順に表示する
  const topRank = (sec) => Math.min(...sec.list.map((m) => m.place_w ?? m.place_l ?? Infinity));
  sections.sort((a, b) => topRank(a) - topRank(b));
  // 掲示用印刷などで、1つのトーナメントだけを描く
  if (ctx.only !== undefined) sections.splice(0, sections.length, ...sections.filter((x) => x.name === ctx.only));
  const strip = (label, name) => (name ? label.split(`${name} `).join('') : label);
  // 1試合分のカード
  const card = (m, sec, isFinal) => {
    const showScore = m.status === 'confirmed' || (ctx.showProvisional && m.status === 'provisional');
    const w = showScore ? winnerSide(m) : null;
    const line = (side) => {
      const info = sideInfo(m, side, cat, cache);
      const sc = showScore ? (side === 'home' ? m.home_score : m.away_score) : '';
      const pk = showScore && m.home_pk != null ? h('small', null, `(${side === 'home' ? m.home_pk : m.away_pk})`) : null;
      const id = side === 'home' ? m.home_team_id : m.away_team_id;
      return h('div', { class: `bt${w ? (w === side ? ' win' : ' lose') : ''}${info.placeholder ? ' ph' : ''}${id && id === ctx.myTeam ? ' mine' : ''}` },
        crest(info.team, 20), h('span', { class: 'nm' }, info.placeholder ? strip(info.text, sec.name) : info.text), h('span', { class: 's' }, sc ?? '', pk));
    };
    return h('div', { class: `node bm${isFinal ? ' final' : ''}` },
      h('div', { class: 'bl' }, h('span', null, strip(m.label, sec.name)), h('span', null, `${dayTotal(cat.config) > 1 ? `${dayOf(cat.config, m.slot) + 1}日目 ` : ''}${toHHMM(m.start_min)} ${courtName(cat.config, m.court)}`)),
      line('home'), line('away'));
  };

  // 「どの試合の勝者か」をたどって木を作り、線でつないで描く
  const bracketOf = (sec, si) => {
    const byCode = Object.fromEntries(sec.list.map((m) => [m.code, m]));
    const fed = new Set();
    for (const m of sec.list) for (const r of [m.home_ref, m.away_ref]) if (r && r.t === 'win' && byCode[r.m]) fed.add(r.m);
    const roots = sec.list.filter((m) => !fed.has(m.code))
      .sort((a, b) => (a.place_w ?? a.place_l ?? 999) - (b.place_w ?? b.place_l ?? 999));
    const depth = (m) => 1 + Math.max(0, ...[m.home_ref, m.away_ref].filter((r) => r && r.t === 'win' && byCode[r.m]).map((r) => depth(byCode[r.m])));
    const node = (m, isFinal = false) => {
      const kids = [m.home_ref, m.away_ref].filter((r) => r && r.t === 'win' && byCode[r.m]).map((r) => byCode[r.m]);
      return h('div', { class: `tree${m.status === 'confirmed' ? ' done' : ''}` },
        kids.length ? h('div', { class: 'tree-kids' }, kids.map((k) => node(k))) : null,
        card(m, sec, isFinal));
    };
    const [main, ...others] = roots;
    const champ = () => {
      if (!main || main.status !== 'confirmed' || !main.place_w) return null;
      const w = winnerSide(main);
      if (!w) return null;
      const info = sideInfo(main, w, cat, cache);
      return h('div', { class: `champ${info.team && info.team.id === ctx.myTeam ? ' mine' : ''}` }, icon('trophy'), h('span', null, h('small', null, main.place_w === 1 ? '優勝' : `${main.place_w}位`), info.text));
    };
    const title = (r) => strip(r.label, sec.name).replace(/\s\d+$/, '');
    // 移動ボタン用に、図ごとの目印を記録する
    sec.subs = [{ id: `bk-${si}-main`, label: `${title(main)}まで` }, ...others.map((r, j) => ({ id: `bk-${si}-${j}`, label: title(r) }))];
    return h('div', null,
      depth(main) > 2 ? h('p', { class: 'muted small scroll-hint' }, '横にスクロールすると決勝まで見られます') : null,
      h('div', { class: 'tree-scroll bk-target', id: `bk-${si}-main` }, h('div', { class: 'tree-root' }, node(main, true), champ())),
      others.length ? h('div', { class: 'tree-others' }, others.map((r, j) => h('div', { class: 'bk-target', id: `bk-${si}-${j}` },
        h('h3', null, title(r)),
        h('div', { class: 'tree-scroll' }, h('div', { class: 'tree-root' }, node(r)))))) : null);
  };

  const ranking = ctx.only !== undefined ? null : finalRankingView(cat, ctx);
  if (ranking) { ranking.id = 'bk-rank'; ranking.classList.add('bk-target'); }
  const secEls = sections.map((sec, si) => h('section', { class: 'bk-target', id: `bk-${si}` },
    h('div', { class: 'section-title' }, icon(sections.length > 1 ? 'trophy' : 'list'), h('h2', null, sec.name || 'トーナメント表')),
    bracketOf(sec, si)));
  const items = [
    ranking ? { id: 'bk-rank', label: '最終順位', subs: [] } : null,
    ...sections.map((sec, si) => ({ id: `bk-${si}`, label: sec.name || 'トーナメント表', subs: sec.subs.length > 1 ? sec.subs : [] })),
  ].filter(Boolean);
  // 見出しは順位表のカードにあるので、ここでは付けない
  const leagueEls = leagues.map((g, i) => h('section', { class: 'bk-target rank-league', id: `bk-l${i}` },
    standingsView(cat, { ...ctx, only: [g], noFoot: true })));
  leagues.forEach((g, i) => items.push({ id: `bk-l${i}`, label: g, subs: [] }));
  const needNav = ctx.jumpNav && (items.length > 1 || items.some((x) => x.subs.length));
  return h('div', null, needNav ? bracketNav(items) : null, ranking, secEls, leagueEls);
}

// トーナメント表の上部に固定する移動ボタン（1段目: トーナメント、2段目: その中の順位決定戦）
function bracketNav(items) {
  const st = { sec: items[0].id, sub: null, lockUntil: 0 };
  const nav = h('nav', { class: 'bk-nav', 'aria-label': 'トーナメント内の移動' });
  const jump = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    st.lockUntil = Date.now() + 1200; // 移動中は選択状態を自動で変えない
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const chip = (id, label, on, small) => h('button', { class: `chip-btn${small ? ' sm' : ''}`, type: 'button', 'aria-pressed': String(on), 'data-id': id,
    onclick: () => { const sec = items.find((x) => x.id === id || x.subs.some((s) => s.id === id)); st.sec = sec.id; st.sub = sec.id === id ? null : id; draw(); jump(id); } }, label);
  const draw = () => {
    const cur = items.find((x) => x.id === st.sec) || items[0];
    mountTo(nav,
      h('div', { class: 'chips' }, items.map((x) => chip(x.id, x.label, x.id === cur.id))),
      cur.subs.length ? h('div', { class: 'chips sub' }, cur.subs.map((x) => chip(x.id, x.label, x.id === st.sub, true))) : null);
    // 選択中のボタンが見えるように、ボタンの帯の中だけを横にずらす（ページは動かさない）
    for (const el of nav.querySelectorAll('[aria-pressed="true"]')) {
      const row = el.parentElement;
      const left = el.offsetLeft - row.offsetLeft;
      if (left < row.scrollLeft || left + el.offsetWidth > row.scrollLeft + row.clientWidth) row.scrollLeft = Math.max(0, left - 16);
    }
  };
  draw();
  // スクロールに合わせて、いま見ている場所を選択状態にする
  let ticking = false;
  const onScroll = () => {
    if (!document.body.contains(nav)) return window.removeEventListener('scroll', onScroll);
    if (ticking || Date.now() < st.lockUntil) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const line = nav.getBoundingClientRect().bottom + 24;
      let sec = items[0].id;
      let sub = null;
      for (const x of items) {
        const el = document.getElementById(x.id);
        if (el && el.getBoundingClientRect().top <= line) { sec = x.id; sub = null; }
      }
      const cur = items.find((x) => x.id === sec);
      for (const sItem of cur.subs) {
        const el = document.getElementById(sItem.id);
        if (el && el.getBoundingClientRect().top <= line) sub = sItem.id;
      }
      if (sec !== st.sec || sub !== st.sub) { st.sec = sec; st.sub = sub; draw(); }
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return nav;
}

function mountTo(el, ...kids) {
  el.replaceChildren();
  for (const k of kids) if (k) el.append(k);
}

export function teamsView(cat, ctx, query = '') {
  const q = query.trim();
  const list = cat.teams.filter((t) => !q || t.name.includes(q) || (t.short_name || '').includes(q));
  if (!list.length) return h('p', { class: 'empty' }, q ? `「${q}」に一致するチームはありません` : 'チームはまだ登録されていません');
  const groups = {};
  for (const t of list) (groups[t.group_label || ''] ||= []).push(t);
  return h('div', null, Object.keys(groups).sort().map((g) => h('section', null,
    g ? h('h2', { class: 'group-title' }, `${g}組`) : null,
    h('div', { class: 'team-grid' }, groups[g].map((t) => h('button', { class: `tm${t.id === ctx.myTeam ? ' mine' : ''}`, type: 'button',
      onclick: () => ctx.onPickTeam && ctx.onPickTeam(t.id), 'aria-label': `${t.name}の試合を見る` },
      crest(t, 40), h('strong', null, t.name), t.group_label ? h('span', { class: 'tm-g' }, `${t.group_label}組`) : null,
      t.id === ctx.myTeam ? h('span', { class: 'star' }, icon('star')) : null))))));
}
