import { expandPlan, isRankLeague } from './bracket.js';
// 勝点: 勝3・分1・負0
const POINTS = { win: 3, draw: 1, loss: 0 };
const KEY = { points: 'pts', gd: 'gd', gf: 'gf' };

function table(ids, matches) {
  const t = Object.fromEntries(ids.map((id) => [id, { teamId: id, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }]));
  for (const m of matches) {
    const h = t[m.home_team_id];
    const a = t[m.away_team_id];
    if (!h || !a) continue;
    const hs = m.home_score;
    const as = m.away_score;
    h.p++; a.p++;
    h.gf += hs; h.ga += as; a.gf += as; a.ga += hs;
    if (hs > as) { h.w++; a.l++; h.pts += POINTS.win; }
    else if (hs < as) { a.w++; h.l++; a.pts += POINTS.win; }
    else { h.d++; a.d++; h.pts += POINTS.draw; a.pts += POINTS.draw; }
  }
  for (const r of Object.values(t)) r.gd = r.gf - r.ga;
  return t;
}

/**
 * teamIds: 組のチーム
 * allMatches: 組の全リーグ戦（status を含む）。確定済みのみ集計する
 * criteria: ['points','gd','gf','h2h','lottery'] の並び
 * lottery: 管理者が入力した抽選順（teamId の配列）
 */
export function computeStandings(teamIds, allMatches, criteria, lottery = []) {
  const confirmed = allMatches.filter((m) => m.status === 'confirmed' && m.home_score != null && m.away_score != null);
  const full = table(teamIds, confirmed);
  const byLottery = new Set();

  // 抽選結果があれば並び順を決める（判定順に「抽選」が無くても、最後の手段として使う）
  const byDraw = (ids) => {
    if (lottery.length && ids.every((id) => lottery.includes(id))) {
      ids.forEach((id) => byLottery.add(id));
      return [...ids].sort((a, b) => lottery.indexOf(a) - lottery.indexOf(b)).map((id) => [id]);
    }
    return [ids];
  };
  const rank = (ids, ci) => {
    if (ids.length <= 1) return [ids];
    if (ci >= criteria.length) return byDraw(ids);
    const c = criteria[ci];
    // 抽選・代表者じゃんけんは、本部が入力した結果の順番で決める
    if (c === 'lottery' || c === 'janken') return byDraw(ids);
    let key;
    if (c === 'h2h') {
      const sub = table(ids, confirmed.filter((m) => ids.includes(m.home_team_id) && ids.includes(m.away_team_id)));
      key = (id) => [sub[id].pts, sub[id].gd, sub[id].gf];
    } else {
      key = (id) => [full[id][KEY[c]]];
    }
    const cmp = (a, b) => {
      const ka = key(a);
      const kb = key(b);
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
      return 0;
    };
    const sorted = [...ids].sort(cmp);
    const buckets = [];
    for (const id of sorted) {
      const last = buckets[buckets.length - 1];
      if (last && cmp(last[0], id) === 0) last.push(id);
      else buckets.push([id]);
    }
    // 一部だけ順位が決まった場合、残りはその次の基準から続けて判定する
    return buckets.flatMap((bk) => (bk.length > 1 ? rank(bk, ci + 1) : [bk]));
  };

  const buckets = rank([...teamIds], 0);
  const rows = [];
  let pos = 1;
  let hasTie = false;
  for (const bk of buckets) {
    const tied = bk.length > 1;
    if (tied) hasTie = true;
    for (const id of bk) rows.push({ ...full[id], rank: pos, tied, lottery: byLottery.has(id) });
    pos += bk.length;
  }
  const complete = allMatches.length > 0 && allMatches.every((m) => m.status === 'confirmed');
  // 全試合が終わって順位が並んだままなら抽選（判定順に「抽選」が無い場合も含む）
  return { rows, complete, hasTie, needsLottery: complete && hasTie };
}

export function matchOutcome(m) {
  if (m.status !== 'confirmed' || !m.home_team_id || !m.away_team_id) return null;
  if (m.forfeit === 'home') return { winner: m.home_team_id, loser: m.away_team_id };
  if (m.forfeit === 'away') return { winner: m.away_team_id, loser: m.home_team_id };
  if (m.home_score == null || m.away_score == null) return null;
  if (m.home_score > m.away_score) return { winner: m.home_team_id, loser: m.away_team_id };
  if (m.home_score < m.away_score) return { winner: m.away_team_id, loser: m.home_team_id };
  if (m.home_pk != null && m.away_pk != null && m.home_pk !== m.away_pk) {
    return m.home_pk > m.away_pk ? { winner: m.home_team_id, loser: m.away_team_id } : { winner: m.away_team_id, loser: m.home_team_id };
  }
  if (m.stage === 'league') return { draw: true };
  return null;
}

/**
 * カテゴリ全体を評価する
 * 戻り値: { standings: {A: {...}}, updates: [{id, home_team_id, away_team_id}], conflicts: [id], finalRanking: [{rank, teamId}] }
 */
export function evaluateCategory(cfg, teams, matches) {
  const standings = {};
  const league = matches.filter((m) => m.stage === 'league');
  const groups = [...new Set(teams.map((t) => t.group_label).filter(Boolean))].sort();
  if (cfg.format !== 'knockout') {
    for (const g of groups) {
      const ids = teams.filter((t) => t.group_label === g).map((t) => t.id);
      standings[g] = computeStandings(ids, league.filter((m) => m.group_label === g), cfg.tiebreak, (cfg.lottery || {})[g] || []);
    }
  }

  const ko = matches.filter((m) => m.stage === 'knockout').map((m) => ({ ...m }));
  ko.sort((a, b) => (a.round - b.round) || (a.slot - b.slot));
  const byCode = Object.fromEntries(ko.map((m) => [m.code, m]));

  const resolve = (ref) => {
    if (!ref) return null;
    if (ref.t === 'team') return ref.id;
    if (ref.t === 'grp') {
      // その順位が並んでいなければ確定（ほかの順位の抽選待ちに巻き込まない）
      const st = standings[ref.g];
      if (!st || !st.complete) return null;
      const row = st.rows[ref.r - 1];
      if (!row || row.tied) return null;
      return row.teamId;
    }
    const src = byCode[ref.m];
    if (!src) return null;
    const o = matchOutcome(src);
    if (!o || o.draw) return null;
    return ref.t === 'win' ? o.winner : o.loser;
  };

  const updates = [];
  const conflicts = [];
  for (const m of ko) {
    const h = resolve(m.home_ref);
    const a = resolve(m.away_ref);
    if (m.status === 'none') {
      if (h !== m.home_team_id || a !== m.away_team_id) {
        m.home_team_id = h;
        m.away_team_id = a;
        updates.push({ id: m.id, home_team_id: h, away_team_id: a });
      }
    } else if ((h && h !== m.home_team_id) || (a && a !== m.away_team_id)) {
      conflicts.push(m.id);
    }
  }

  const finalRanking = [];
  for (const m of ko) {
    if (isRankLeague(m)) continue;
    const o = matchOutcome(m);
    if (!o || o.draw) continue;
    if (m.place_w) finalRanking.push({ rank: m.place_w, teamId: o.winner });
    if (m.place_l) finalRanking.push({ rank: m.place_l, teamId: o.loser });
  }

  // リーグ戦の段：参加チームが決まったら順位表を作り、全試合が終わって順位が決まれば通しの順位に入れる
  const rankLeagues = [...new Set(ko.filter(isRankLeague).map((m) => m.group_label))];
  if (rankLeagues.length) {
    const sizes = {};
    for (const t of teams) if (t.group_label) sizes[t.group_label] = (sizes[t.group_label] || 0) + 1;
    const maxRank = Math.max(0, ...Object.values(sizes));
    const offsets = {};
    let off = 0;
    for (const b of expandPlan(cfg.knockoutPlan || {}, maxRank)) {
      offsets[b.name] = off;
      for (let r = b.from; r <= b.to; r++) for (const v of Object.values(sizes)) if (v >= r) off++;
    }
    for (const name of rankLeagues) {
      const ms = ko.filter((m) => isRankLeague(m) && m.group_label === name);
      const ids = [...new Set(ms.flatMap((m) => [m.home_team_id, m.away_team_id]))];
      const refs = ms.flatMap((m) => [m.home_ref, m.away_ref]).filter(Boolean);
      const slots = new Set(refs.map((r) => `${r.g}:${r.r}`)).size;
      const ready = ids.every(Boolean) && ids.length === slots;
      const st = ready
        ? computeStandings(ids, ms, cfg.tiebreak, (cfg.lottery || {})[name] || [])
        : { rows: [], complete: false, hasTie: false, needsLottery: false };
      const slotList = [...new Map(refs.map((r) => [`${r.g}:${r.r}`, r])).values()].sort((a, b) => a.r - b.r || a.g.localeCompare(b.g));
      standings[name] = { ...st, placement: true, offset: offsets[name] || 0, slots: slotList.map((r) => `${r.g}組${r.r}位`) };
      if (ready && st.complete && !st.hasTie) {
        for (const row of st.rows) finalRanking.push({ rank: (offsets[name] || 0) + row.rank, teamId: row.teamId });
      }
    }
  }
  finalRanking.sort((a, b) => a.rank - b.rank);

  return { standings, updates, conflicts, finalRanking };
}
