// ランダムに作った大会を最後まで進め、壊れる条件が無いかを調べる総当たり検査
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, matchLengthFor, dayOf } from './time.js';
import { assignGroups, shuffle } from './grouping.js';
import { generateCategory, scheduleWarnings, planDelay } from './schedule.js';
import { evaluateCategory } from './standings.js';
import { expandPlan } from './bracket.js';

function rng(seed) { return () => ((seed = (seed * 48271) % 2147483647) / 2147483647); }

function runOne(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const n = 2 + Math.floor(r() * 39);
  const format = pick(['league', 'knockout', 'league_knockout', 'league_knockout']);
  const groups = format === 'knockout' ? 1 : Math.max(1, Math.min(Math.floor(n / 2), 1 + Math.floor(r() * 10)));
  const plan = { type: pick(['top', 'all', 'split', 'split3', 'byrank', 'custom']), k: 1 + Math.floor(r() * 3), m: 1 + Math.floor(r() * 2), mode: pick(['top3', 'top3_shared', 'all']),
    formats: r() < 0.35 ? Object.fromEntries([0, 1, 2, 3].filter(() => r() < 0.5).map((i) => [i, 'league'])) : {} };
  if (plan.type === 'custom') {
    let from = 1;
    plan.brackets = Array.from({ length: 2 + Math.floor(r() * 2) }, (_, i) => {
      const to = from + Math.floor(r() * 2);
      const b = { name: `段${i + 1}`, from, to, mode: pick(['top3', 'top3_shared', 'all']), format: r() < 0.4 ? 'league' : 'knockout' };
      from = to + 1;
      return b;
    });
  }
  const days = 1 + Math.floor(r() * 3);
  const cfg = normalizeConfig({
    format, groups, courts: 1 + Math.floor(r() * 6), rankMode: pick(['top3', 'top3_shared', 'all']), knockoutPlan: plan,
    periods: pick([1, 2, 3]), halfMinutes: 8 + Math.floor(r() * 15), halftimeMinutes: Math.floor(r() * 6), intervalMinutes: Math.floor(r() * 10),
    minRestSlots: pick([0, 1, 2]), lunchEnabled: r() < 0.7, lunchStart: 600 + Math.floor(r() * 180), lunchMinutes: 30 + Math.floor(r() * 30),
    koTiming: { enabled: r() < 0.4, periods: pick([1, 2]), halfMinutes: 10 + Math.floor(r() * 10), halftimeMinutes: 5 },
    dayDates: ['2026-11-01', '2026-11-02', '2026-11-03'].slice(0, days),
    // 複数日のとき、ときどき「時刻で区切る」（11:00〜17:00 の終了時刻）
    dayBreaks: days > 1 && r() < 0.5 ? Array.from({ length: days - 1 }, () => `T${660 + Math.floor(r() * 360)}`) : [],
    koGapMinutes: r() < 0.3 ? Math.floor(r() * 60) : 0,
    tiebreak: pick([undefined, ['points', 'h2h', 'gd', 'gf', 'lottery'], ['points', 'gd', 'gf'], ['points', 'gd', 'gf', 'h2h', 'janken'], ['points', 'gd', 'janken', 'lottery'], ['points', 'h2h']]),
  });
  const teams = Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, name: `T${i + 1}`, club: r() < 0.2 ? `C${i % 3}` : '' }));
  let ts = teams;
  if (format !== 'knockout') {
    const { assignment } = assignGroups(teams, { groups: cfg.groups }, r);
    ts = teams.map((t) => ({ ...t, group_label: assignment[t.id] }));
  }
  const gen = generateCategory(cfg, ts, format === 'knockout' ? shuffle(ts.map((t) => t.id), r) : undefined);
  const ctx = `seed=${seed} n=${n} ${format} G=${cfg.groups} courts=${cfg.courts} plan=${JSON.stringify(plan)} rank=${cfg.rankMode} days=${days}`;
  if (gen.error) { if (process.env.SHOWSKIP) console.log('  作成せず:', gen.error, ctx); return { skipped: gen.error }; }
  const c2 = { ...cfg, dayBreakSlots: gen.dayBreakSlots };
  const ms = gen.matches.map((m, i) => ({ ...m, id: `m${i}`, status: 'none' }));

  // 1. 枠とコートの重複なし、時間の重なりなし
  assert.equal(new Set(ms.map((m) => `${m.slot}-${m.court}`)).size, ms.length, `同じ枠・コートに2試合 ${ctx}`);
  assert.ok(ms.every((m) => m.court < cfg.courts && m.slot >= 0), `コート番号の範囲外 ${ctx}`);
  const errs = scheduleWarnings(c2, ms).filter((w) => w.level === 'error');
  assert.equal(errs.length, 0, `時間の重なり ${ctx} ${errs.map((e) => e.text).join(',')}`);
  assert.ok(ms.every((m) => dayOf(c2, m.slot) < Math.max(1, days)), `日の範囲外 ${ctx}`);

  // 2. 遅延調整は同じ日・同じコートの未開始の試合だけ
  if (ms.length) {
    const target = pick(ms);
    const plan2 = planDelay(c2, ms, target, 10, pick(['shorten', 'shift', undefined]));
    const chg = plan2.changes || [];
    for (const ch of chg) {
      const m = ms.find((x) => x.id === ch.id);
      assert.equal(m.court, target.court, `遅延が別コートに波及 ${ctx}`);
      assert.equal(dayOf(c2, m.slot), dayOf(c2, target.slot), `遅延が別の日に波及 ${ctx}`);
    }
  }

  // 3. ランダムに結果を入れて最後まで進める（引き分け・PK戦あり、抽選が必要なら入力）
  const strength = Object.fromEntries(ts.map((t) => [t.id, r()]));
  for (let round = 0; round < 40; round++) {
    const ev = evaluateCategory(c2, ts, ms);
    for (const u of ev.updates) Object.assign(ms.find((m) => m.id === u.id), u);
    let drew = false;
    for (const [g, st] of Object.entries(ev.standings)) {
      if (st.needsLottery) {
        assert.ok(st.complete && st.hasTie, `抽選待ちの判定 ${ctx}`);
        c2.lottery = { ...(c2.lottery || {}), [g]: shuffle(st.rows.filter((x) => x.tied).map((x) => x.teamId), r) };
        drew = true;
      }
    }
    const open = ms.filter((m) => m.status === 'none' && m.home_team_id && m.away_team_id);
    if (!open.length) {
      if (!ev.updates.length && !drew) break;
      continue;
    }
    for (const m of open) {
      const a = r() * 3 + strength[m.home_team_id] * 2;
      const b = r() * 3 + strength[m.away_team_id] * 2;
      let hs = Math.floor(a), as = Math.floor(b);
      const res = { status: 'confirmed', home_score: hs, away_score: as, home_pk: null, away_pk: null };
      if (m.stage === 'knockout' && hs === as) { res.home_pk = 3 + (r() < 0.5 ? 1 : 0); res.away_pk = res.home_pk === 4 ? 3 : 4; }
      Object.assign(m, res);
    }
  }
  const ev = evaluateCategory(c2, ts, ms);
  const left = ms.filter((m) => m.status !== 'confirmed');
  assert.equal(left.length, 0, `確定できない試合が残った（チーム未定 ${left.filter((m) => !m.home_team_id || !m.away_team_id).length}件） ${ctx}`);
  assert.equal(ev.conflicts.length, 0, `対戦チームの食い違い ${ctx}`);

  // 4. 最終順位
  const ranks = ev.finalRanking.map((x) => x.rank);
  assert.equal(new Set(ev.finalRanking.map((x) => x.teamId)).size, ev.finalRanking.length, `同じチームに複数の順位 ${ctx}`);
  if (format !== 'league') {
    const sizes = {};
    for (const t of ts) sizes[t.group_label || 'X'] = (sizes[t.group_label || 'X'] || 0) + 1;
    const brs = format === 'knockout' ? [{ n, mode: cfg.rankMode }]
      : expandPlan(cfg.knockoutPlan, Math.max(...Object.values(sizes))).map((b) => {
        let k = 0; for (let x = b.from; x <= b.to; x++) for (const v of Object.values(sizes)) if (v >= x) k++;
        return { n: k, mode: b.format === 'league' ? 'all' : b.mode };
      });
    let off = 0;
    for (const b of brs) {
      if (b.n >= 2) {
        const want = b.mode === 'all' ? Array.from({ length: b.n }, (_, i) => off + i + 1)
          : b.mode === 'top3' && b.n >= 4 ? [off + 1, off + 2, off + 3, off + 4] : [off + 1, off + 2, ...(b.n >= 3 ? [off + 3] : [])];
        for (const w of want) assert.ok(ranks.includes(w), `${w}位が決まっていない ${ctx}`);
      }
      off += b.n;
    }
  }
  if (format !== 'knockout') for (const st of Object.values(ev.standings)) assert.ok(st.complete, `リーグが完了していない ${ctx}`);
  return { matches: ms.length };
}

test('総当たり検査: ランダムな大会600通りを最後まで進める', () => {
  let ok = 0, skipped = 0, total = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const res = runOne(seed * 7919);
    if (res.skipped) skipped++; else { ok++; total += res.matches; }
  }
  console.log(`  完走 ${ok}通り（試合 合計${total}）／設定エラーで作成せず ${skipped}通り`);
  assert.ok(ok > 400);
});
