import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, slotTimes, toHHMM, matchLengthFor } from './time.js';
import { assignGroups, roundRobin } from './grouping.js';
import { buildKnockout, crossEntrants } from './bracket.js';
import { generateCategory, planDelay, scheduleWarnings } from './schedule.js';
import { computeStandings, evaluateCategory } from './standings.js';

const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const teams = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, name: `チーム${i + 1}`, club: '' }));

test('総当たり: 4チームで6試合、全組み合わせが1回ずつ', () => {
  const r = roundRobin(['a', 'b', 'c', 'd']).flat();
  assert.equal(r.length, 6);
  assert.equal(new Set(r.map((p) => [...p].sort().join())).size, 6);
});

test('時間枠: 昼休憩をまたぐ試合は休憩後に回る', () => {
  const c = normalizeConfig({ startTime: 540, halfMinutes: 20, halftimeMinutes: 5, intervalMinutes: 5, lunchStart: 720, lunchMinutes: 45 });
  const t = slotTimes(c, 6);
  // 9:00, 9:50, 10:40, 11:30(→12:15終了で昼をまたぐので休憩後)
  assert.deepEqual(t.slice(0, 3).map((x) => toHHMM(x.start)), ['09:00', '09:50', '10:40']);
  assert.equal(toHHMM(t[3].start), '12:10'); // 10:40開始の試合が11:25に終わり、45分の昼休憩
  assert.equal(t[3].session, 'pm');
});

test('組み分け: 同じクラブ・同組NG・主催者固定を守る', () => {
  const ts = teams(16);
  ts[0].club = 'FC東'; ts[1].club = 'FC東';
  const res = assignGroups(ts, { groups: 4, fixed: { t5: 'A' }, separate: [['t3', 't4']] }, seeded(7));
  assert.equal(res.warnings.length, 0);
  assert.equal(res.assignment.t5, 'A');
  assert.notEqual(res.assignment.t1, res.assignment.t2);
  assert.notEqual(res.assignment.t3, res.assignment.t4);
  const sizes = Object.values(res.assignment).reduce((a, g) => ({ ...a, [g]: (a[g] || 0) + 1 }), {});
  assert.deepEqual(Object.values(sizes), [4, 4, 4, 4]);
});

test('クロス方式: 4組上位2チームの並び', () => {
  const e = crossEntrants(4, 2).map((r) => `${r.g}${r.r}`);
  assert.deepEqual(e, ['A1', 'B2', 'C1', 'D2', 'B1', 'A2', 'D1', 'C2']);
});

test('トーナメント: 6チームは不戦あり、3位決定戦あり', () => {
  const cfg = normalizeConfig({ format: 'knockout', rankMode: 'top3' });
  const { matches } = buildKnockout(cfg, { format: 'knockout', teamIds: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.equal(matches.filter((m) => m.label.startsWith('準々決勝')).length, 2);
  assert.ok(matches.some((m) => m.label === '3位決定戦'));
  assert.equal(matches[matches.length - 1].label, '決勝');
});

test('全順位決定: 8チームで12試合、1〜8位が決まる', () => {
  const cfg = normalizeConfig({ format: 'knockout', rankMode: 'all' });
  const { matches } = buildKnockout(cfg, { format: 'knockout', teamIds: 'abcdefgh'.split('') });
  assert.equal(matches.length, 12);
  const places = matches.flatMap((m) => [m.place_w, m.place_l]).filter(Boolean).sort((a, b) => a - b);
  assert.deepEqual(places, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('日程: 16チーム4組2コートでチームの重複がない', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 4, courts: 2, advance: 2 });
  const ts = teams(16).map((t, i) => ({ ...t, group_label: 'ABCD'[i % 4] }));
  const { matches, error } = generateCategory(cfg, ts);
  assert.equal(error, undefined);
  assert.equal(matches.filter((m) => m.stage === 'league').length, 24);
  assert.equal(matches.filter((m) => m.stage === 'knockout').length, 8); // QF4 + SF2 + 3決 + 決勝
  const ids = matches.map((m, i) => ({ ...m, id: `m${i}` }));
  assert.equal(scheduleWarnings(cfg, ids).filter((w) => w.level === 'error').length, 0);
  // 同じ枠・同じコートに2試合入らない
  assert.equal(new Set(matches.map((m) => `${m.slot}-${m.court}`)).size, matches.length);
});

test('順位: 総合成績優先と当該対戦優先で結果が変わる', () => {
  // A,B が勝点6で並ぶ。得失点差はAが上、当該対戦はBの勝ち
  const m = (h, a, hs, as) => ({ home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'confirmed', stage: 'league' });
  const ms = [m('A', 'C', 9, 0), m('B', 'A', 1, 0), m('A', 'D', 1, 0), m('C', 'B', 1, 0), m('B', 'D', 1, 0), m('C', 'D', 0, 0)];
  const overall = computeStandings(['A', 'B', 'C', 'D'], ms, ['points', 'gd', 'gf', 'h2h', 'lottery']);
  assert.equal(overall.rows[0].teamId, 'A');
  const h2h = computeStandings(['A', 'B', 'C', 'D'], ms, ['points', 'h2h', 'gd', 'gf', 'lottery']);
  assert.equal(h2h.rows[0].teamId, 'B');
});

test('順位: 抽選待ちと抽選入力', () => {
  const m = (h, a, hs, as) => ({ home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'confirmed', stage: 'league' });
  const ms = [m('A', 'B', 1, 1)];
  const s1 = computeStandings(['A', 'B'], ms, ['points', 'gd', 'gf', 'h2h', 'lottery']);
  assert.equal(s1.needsLottery, true);
  const s2 = computeStandings(['A', 'B'], ms, ['points', 'gd', 'gf', 'h2h', 'lottery'], ['B', 'A']);
  assert.equal(s2.rows[0].teamId, 'B');
  assert.equal(s2.rows[0].lottery, true);
});

test('参照解決: 予選が確定すると決勝トーナメントにチームが入る', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, advance: 2 });
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches } = generateCategory(cfg, ts);
  const ms = matches.map((m, i) => ({ ...m, id: `m${i}`, status: 'none' }));
  for (const m of ms.filter((x) => x.stage === 'league')) {
    // 番号の若いチームが勝つ
    const hn = Number(m.home_team_id.slice(1));
    const an = Number(m.away_team_id.slice(1));
    Object.assign(m, { status: 'confirmed', home_score: hn < an ? 2 : 0, away_score: hn < an ? 0 : 2 });
  }
  const ev = evaluateCategory(cfg, ts, ms);
  assert.equal(ev.standings.A.rows[0].teamId, 't1');
  assert.equal(ev.standings.B.rows[0].teamId, 't2');
  const sf = ev.updates; // 準決勝2試合が埋まる
  assert.equal(sf.length, 2);
  assert.ok(sf.some((u) => u.home_team_id === 't1' && u.away_team_id === 't4')); // A1 vs B2
});

test('遅延調整: 昼休憩にかかる場合は選択肢を返す', () => {
  const cfg = normalizeConfig({ format: 'league', groups: 1, courts: 1, halfMinutes: 10, halftimeMinutes: 5, intervalMinutes: 5, lunchStart: 660, lunchMinutes: 40 });
  const ts = teams(4).map((t) => ({ ...t, group_label: 'A' }));
  const { matches } = generateCategory(cfg, ts);
  const ms = matches.map((m, i) => ({ ...m, id: `m${i}`, status: 'none' })).sort((a, b) => a.start_min - b.start_min);
  const plan = planDelay(cfg, ms, ms[0], 10);
  if (ms.some((m) => m.session === 'pm')) {
    assert.equal(plan.needsLunchChoice, true);
    assert.equal(plan.options.shorten.lunch, 30);
    assert.equal(plan.options.shorten.pmShift, 0);
    const applied = planDelay(cfg, ms, ms[0], 10, 'shorten');
    const pm = ms.filter((m) => m.session === 'pm');
    assert.equal(applied.changes.find((c) => c.id === pm[0].id).start_min, pm[0].start_min);
  } else {
    assert.equal(plan.needsLunchChoice, false);
  }
});

test('日程: 昼休憩の前後に空き枠を残さない', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, advance: 2, halfMinutes: 12, halftimeMinutes: 3, intervalMinutes: 5, startTime: 420, lunchStart: 610, lunchMinutes: 45 });
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches } = generateCategory(cfg, ts);
  const am = matches.filter((m) => m.session === 'am');
  const pm = matches.filter((m) => m.session === 'pm');
  const lastAmEnd = Math.max(...am.map((m) => m.start_min)) + 27;
  const firstPm = Math.min(...pm.map((m) => m.start_min));
  assert.equal(firstPm - lastAmEnd, 45);
});

// ---- 決勝トーナメントの形 ----
const lkCfg = (plan, groups = 4) => normalizeConfig({ format: 'league_knockout', groups, courts: 2, knockoutPlan: plan });
const lkTeams = (n, G) => teams(n).map((t, i) => ({ ...t, group_label: 'ABCDEFGH'[i % G] }));
const firstRound = (ms) => ms.filter((m) => m.home_ref?.t === 'grp' && m.away_ref?.t === 'grp');
const norm = (r) => ({ ...r, matches: (r.matches || []).map((m) => ({ ...m, home_ref: m.home, away_ref: m.away })) });

test('決勝: 3組の上位2チーム（6チーム）は不戦ありで、1回戦に同じ組どうしが当たらない', () => {
  const { matches, error } = generateCategory(lkCfg({ type: 'top', k: 2, mode: 'top3' }, 3), lkTeams(12, 3));
  assert.equal(error, undefined);
  const r1 = firstRound(matches.filter((m) => m.stage === 'knockout'));
  assert.equal(r1.length, 2);
  for (const m of r1) assert.notEqual(m.home_ref.g, m.away_ref.g);
});

test('決勝: 4組の上位3チーム（12チーム）が進出できる', () => {
  const { matches, error } = generateCategory(lkCfg({ type: 'top', k: 3, mode: 'top3' }), lkTeams(16, 4));
  assert.equal(error, undefined);
  const ko = matches.filter((m) => m.stage === 'knockout');
  assert.ok(ko.some((m) => m.label === '決勝') && ko.some((m) => m.label === '3位決定戦'));
  for (const m of firstRound(ko)) assert.notEqual(m.home_ref.g, m.away_ref.g);
});

test('決勝: 全チーム（4組×4）は2回戦まで同じ組どうしが当たらない', () => {
  const r = norm(buildKnockout(lkCfg({ type: 'all', mode: 'top3' }), { format: 'league_knockout', groupSizes: { A: 4, B: 4, C: 4, D: 4 } }));
  assert.equal(r.error, undefined);
  const r1 = firstRound(r.matches);
  assert.equal(r1.length, 8);
  for (const m of r1) assert.notEqual(m.home_ref.g, m.away_ref.g);
  // 2回戦（ベスト8）: 1回戦の勝者どうし。元の組が重ならないこと
  const byCode = Object.fromEntries(r.matches.map((m) => [m.code, m]));
  const groupsOf = (ref) => { const m = byCode[ref.m]; return [m.home_ref.g, m.away_ref.g]; };
  for (const m of r.matches.filter((x) => x.home_ref?.t === 'win' && byCode[x.home_ref.m].home_ref?.t === 'grp' && x.label.startsWith('準々決勝'))) {
    const a = groupsOf(m.home_ref); const b = groupsOf(m.away_ref);
    assert.equal(a.filter((g) => b.includes(g)).length, 0);
  }
});

test('決勝: 上位・下位トーナメントは順位が続きになる（下位の優勝は9位）', () => {
  const r = norm(buildKnockout(lkCfg({ type: 'split', k: 2, mode: 'top3' }), { format: 'league_knockout', groupSizes: { A: 4, B: 4, C: 4, D: 4 } }));
  assert.equal(r.error, undefined);
  const upperFinal = r.matches.find((m) => m.label === '上位トーナメント 決勝');
  const lowerFinal = r.matches.find((m) => m.label === '下位トーナメント 決勝');
  assert.equal(upperFinal.place_w, 1);
  assert.equal(lowerFinal.place_w, 9);
  assert.equal(r.matches.find((m) => m.label === '下位トーナメント 3位決定戦').place_w, 11);
  // 下位はクロス方式（A3 対 B4）
  const low = firstRound(r.matches.filter((m) => m.bracket === '下位トーナメント'));
  assert.ok(low.some((m) => m.home_ref.g === 'A' && m.home_ref.r === 3 && m.away_ref.g === 'B' && m.away_ref.r === 4));
  // 全体の決勝が最後に行われる
  assert.equal(r.matches[r.matches.length - 1].label, '上位トーナメント 決勝');
});

test('決勝: 同じ順位どうしのトーナメントが順位の数だけできる', () => {
  const r = norm(buildKnockout(lkCfg({ type: 'byrank', mode: 'top3' }), { format: 'league_knockout', groupSizes: { A: 4, B: 4, C: 4, D: 4 } }));
  const names = [...new Set(r.matches.map((m) => m.bracket))];
  assert.deepEqual(names.sort(), ['1位トーナメント', '2位トーナメント', '3位トーナメント', '4位トーナメント']);
  for (const m of r.matches.filter((x) => x.home_ref?.t === 'grp')) assert.equal(m.home_ref.r, m.away_ref.r);
});

test('決勝: 12チームでも全順位決定ができ、1〜12位がもれなく決まる', () => {
  const r = norm(buildKnockout(lkCfg({ type: 'top', k: 3, mode: 'all' }), { format: 'league_knockout', groupSizes: { A: 4, B: 4, C: 4, D: 4 } }));
  assert.equal(r.error, undefined);
  const places = r.matches.flatMap((m) => [m.place_w, m.place_l]).filter(Boolean).sort((a, b) => a - b);
  assert.deepEqual(places, Array.from({ length: 12 }, (_, i) => i + 1));
});

test('設定の移行: 旧形式（各組から2チーム）は「上位チームだけ」に読み替える', () => {
  const c = normalizeConfig({ format: 'league_knockout', advance: 1, rankMode: 'top3_shared' });
  assert.deepEqual([c.knockoutPlan.type, c.knockoutPlan.k, c.knockoutPlan.mode], ['top', 1, 'top3_shared']);
});

test('試合の形: ハーフなし・3ピリオドで試合の長さが変わる', () => {
  const one = normalizeConfig({ periods: 1, halfMinutes: 20, halftimeMinutes: 5, intervalMinutes: 5, startTime: 540, lunchEnabled: false });
  const three = normalizeConfig({ periods: 3, halfMinutes: 10, halftimeMinutes: 3, intervalMinutes: 5, startTime: 540, lunchEnabled: false });
  assert.deepEqual(slotTimes(one, 2).map((x) => toHHMM(x.start)), ['09:00', '09:25']);   // 20分＋間隔5分
  assert.deepEqual(slotTimes(three, 2).map((x) => toHHMM(x.start)), ['09:00', '09:41']); // 10×3＋3×2＋間隔5分
});

// ---- 複数日 ----
test('複数日: リーグ戦は1日目、決勝トーナメントは2日目（2日目の開始時刻で計算）', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, startTime: 540, lunchEnabled: false,
    dayCount: 2, extraDays: [{ date: '2026-10-19', startTime: 600 }], dayBreaks: ['L3'] });
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches, dayBreakSlots, error } = generateCategory(cfg, ts);
  assert.equal(error, undefined);
  assert.equal(dayBreakSlots.length, 1);
  const c2 = { ...cfg, dayBreakSlots };
  const day = (m) => dayBreakSlots.filter((b) => m.slot >= b).length;
  assert.ok(matches.filter((m) => m.stage === 'league').every((m) => day(m) === 0));
  assert.ok(matches.filter((m) => m.stage === 'knockout').every((m) => day(m) === 1));
  assert.equal(Math.min(...matches.filter((m) => day(m) === 1).map((m) => m.start_min)), 600); // 2日目は10:00開始
  assert.equal(Math.min(...matches.filter((m) => day(m) === 0).map((m) => m.start_min)), 540);
  const ids = matches.map((m, i) => ({ ...m, id: `m${i}` }));
  assert.equal(scheduleWarnings(c2, ids).filter((w) => w.level === 'error').length, 0);
});

test('複数日: 3日間（リーグ第1節まで／リーグの最後まで／トーナメント）', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, dayCount: 3, dayBreaks: ['L1', 'L3'] });
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches, dayBreakSlots } = generateCategory(cfg, ts);
  assert.equal(dayBreakSlots.length, 2);
  const day = (m) => dayBreakSlots.filter((b) => m.slot >= b).length;
  assert.ok(matches.filter((m) => m.stage === 'league' && m.round === 1).every((m) => day(m) === 0));
  assert.ok(matches.filter((m) => m.stage === 'league' && m.round > 1).every((m) => day(m) === 1));
  assert.ok(matches.filter((m) => m.stage === 'knockout').every((m) => day(m) === 2));
});

test('複数日: トーナメントのみを準々決勝までで区切る', () => {
  const cfg = normalizeConfig({ format: 'knockout', courts: 2, rankMode: 'top3', dayCount: 2, dayBreaks: ['K0'] });
  const { matches, dayBreakSlots } = generateCategory(cfg, teams(8), teams(8).map((t) => t.id));
  const day = (m) => dayBreakSlots.filter((b) => m.slot >= b).length;
  assert.ok(matches.filter((m) => m.label.startsWith('準々決勝')).every((m) => day(m) === 0));
  assert.ok(matches.filter((m) => !m.label.startsWith('準々決勝')).every((m) => day(m) === 1));
});

test('複数日: 遅延調整は同じ日の試合だけを動かす', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, lunchEnabled: false, dayCount: 2, dayBreaks: ['L3'] });
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches, dayBreakSlots } = generateCategory(cfg, ts);
  const c2 = { ...cfg, dayBreakSlots };
  const ms = matches.map((m, i) => ({ ...m, id: `m${i}`, status: 'none' }));
  const first = ms.filter((m) => m.slot === 0)[0];
  const plan = planDelay(c2, ms, first, 10);
  const changed = new Set(plan.changes.map((c) => c.id));
  assert.ok(ms.filter((m) => m.stage === 'knockout').every((m) => !changed.has(m.id)));
  assert.ok(plan.changes.length > 0);
});

// ---- 予選と決勝で試合時間が違う ----
test('試合時間: 予選はハーフなし15分、決勝は前後半20分で時刻を計算する', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, startTime: 540, intervalMinutes: 5, lunchEnabled: false, minRestSlots: 0,
    periods: 1, halfMinutes: 15, koTiming: { enabled: true, periods: 2, halfMinutes: 20, halftimeMinutes: 5 } });
  assert.equal(matchLengthFor(cfg, { stage: 'league' }), 15);
  assert.equal(matchLengthFor(cfg, { stage: 'knockout' }), 45);
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches } = generateCategory(cfg, ts);
  const league = matches.filter((m) => m.stage === 'league').sort((a, b) => a.start_min - b.start_min);
  const ko = matches.filter((m) => m.stage === 'knockout').sort((a, b) => a.start_min - b.start_min);
  // 予選は20分間隔（15分＋間隔5分）
  const ls = [...new Set(league.map((m) => m.start_min))];
  assert.equal(ls[1] - ls[0], 20);
  // 準決勝から決勝までは50分間隔（45分＋間隔5分）
  const ks = [...new Set(ko.map((m) => m.start_min))];
  assert.equal(ks[1] - ks[0], 50);
  assert.equal(scheduleWarnings(cfg, matches.map((m, i) => ({ ...m, id: `m${i}` }))).filter((w) => w.level === 'error').length, 0);
});

test('複数日: 区切りを選んでいなくても、リーグ戦と決勝トーナメントの間で自動的に分ける', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, dayDates: ['2026-10-18', '2026-10-19'] });
  assert.equal(cfg.dayCount, 2);
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches, dayBreakSlots, warnings } = generateCategory(cfg, ts);
  assert.equal(warnings.length, 0);
  const day = (m) => dayBreakSlots.filter((b) => m.slot >= b).length;
  assert.ok(matches.filter((m) => m.stage === 'league').every((m) => day(m) === 0));
  assert.ok(matches.filter((m) => m.stage === 'knockout').every((m) => day(m) === 1));
});

// ---- 同じ順位どうしのトーナメントで全順位を決める ----
const placesOf = (ms) => ms.flatMap((m) => [m.place_w, m.place_l]).filter(Boolean).sort((a, b) => a - b);
const seq = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('順位別トーナメント: 4組×4チームで1〜16位が決まる（2位トーナメントの優勝は5位）', () => {
  const r = norm(buildKnockout(lkCfg({ type: 'byrank', mode: 'all' }), { format: 'league_knockout', groupSizes: { A: 4, B: 4, C: 4, D: 4 } }));
  assert.equal(r.error, undefined);
  assert.deepEqual(placesOf(r.matches), seq(16));
  const final2 = r.matches.find((m) => m.bracket === '2位トーナメント' && m.label.endsWith('決勝'));
  assert.equal(final2.place_w, 5);
  for (const m of r.matches.filter((x) => x.home_ref?.t === 'grp')) assert.equal(m.home_ref.r, m.away_ref.r);
});

test('順位別トーナメント: 3組（各トーナメント3チーム）でも1〜12位が決まる', () => {
  const r = norm(buildKnockout(lkCfg({ type: 'byrank', mode: 'all' }, 3), { format: 'league_knockout', groupSizes: { A: 4, B: 4, C: 4 } }));
  assert.equal(r.error, undefined);
  assert.deepEqual(placesOf(r.matches), seq(12));
  // 3チームのトーナメントは2試合（1チームがシード）
  assert.equal(r.matches.filter((m) => m.bracket === '1位トーナメント').length, 2);
});

test('順位別トーナメント: 組の人数がそろっていなくても、いるチームの分だけ順位が決まる', () => {
  // A・B組は4チーム、C組は3チーム → 4位トーナメントは2チーム
  const r = norm(buildKnockout(lkCfg({ type: 'byrank', mode: 'all' }, 3), { format: 'league_knockout', groupSizes: { A: 4, B: 4, C: 3 } }));
  assert.deepEqual(placesOf(r.matches), seq(11));
});

test('トーナメントのみ: 6チームでも全順位決定で1〜6位が決まる', () => {
  const cfg = normalizeConfig({ format: 'knockout', rankMode: 'all' });
  const r = buildKnockout(cfg, { format: 'knockout', teamIds: 'abcdef'.split('') });
  assert.equal(r.error, undefined);
  assert.deepEqual(placesOf(r.matches), seq(6));
});

test('順位別トーナメント: 全試合の結果が出ると最終順位が1〜12位まで並ぶ（3組）', () => {
  const cfg = lkCfg({ type: 'byrank', mode: 'all' }, 3);
  const ts = teams(12).map((t, i) => ({ ...t, group_label: 'ABC'[i % 3] }));
  const { matches } = generateCategory(cfg, ts);
  const ms = matches.map((m, i) => ({ ...m, id: `m${i}`, status: 'none' }));
  const num = (id) => Number(id.slice(1));
  // 予選: 番号の若いチームが勝つ
  for (const m of ms.filter((x) => x.stage === 'league')) {
    const win = num(m.home_team_id) < num(m.away_team_id);
    Object.assign(m, { status: 'confirmed', home_score: win ? 2 : 0, away_score: win ? 0 : 2 });
  }
  // 決勝トーナメント: 段ごとにチームを埋めて、番号の若いチームが勝つ
  for (let round = 0; round < 6; round++) {
    const ev = evaluateCategory(cfg, ts, ms);
    for (const u of ev.updates) Object.assign(ms.find((m) => m.id === u.id), u);
    for (const m of ms.filter((x) => x.stage === 'knockout' && x.status === 'none' && x.home_team_id && x.away_team_id)) {
      const win = num(m.home_team_id) < num(m.away_team_id);
      Object.assign(m, { status: 'confirmed', home_score: win ? 1 : 0, away_score: win ? 0 : 1 });
    }
  }
  const ev = evaluateCategory(cfg, ts, ms);
  assert.deepEqual(ev.finalRanking.map((r) => r.rank), seq(12));
  assert.equal(new Set(ev.finalRanking.map((r) => r.teamId)).size, 12);
  assert.equal(ev.finalRanking[0].teamId, 't1');
});

// ---- 品質チェックで見つかった点 ----
test('抽選: 判定順に「抽選」が無くても、並んだら抽選待ちになり、抽選結果で決まる', () => {
  const m = (h, a, hs, as) => ({ home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'confirmed', stage: 'league' });
  const ms = [m('A', 'B', 1, 1)];
  const s1 = computeStandings(['A', 'B'], ms, ['points', 'gd', 'gf']);
  assert.equal(s1.needsLottery, true);
  const s2 = computeStandings(['A', 'B'], ms, ['points', 'gd', 'gf'], ['B', 'A']);
  assert.equal(s2.rows[0].teamId, 'B');
  assert.equal(s2.hasTie, false);
});

test('抽選: 3位どうしが並んでいても、1位・2位の進出先は先に決まる', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, knockoutPlan: { type: 'top', k: 2, mode: 'top3' } });
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches } = generateCategory(cfg, ts);
  const ms = matches.map((x, i) => ({ ...x, id: `m${i}`, status: 'none' }));
  // A組: t1 が全勝、t3 が2位、t5 と t7 は全試合引き分け同士で3位タイ
  const res = { 't1-t3': [2, 0], 't1-t5': [2, 0], 't1-t7': [2, 0], 't3-t5': [1, 0], 't3-t7': [1, 0], 't5-t7': [0, 0] };
  for (const x of ms.filter((y) => y.stage === 'league')) {
    const k1 = `${x.home_team_id}-${x.away_team_id}`; const k2 = `${x.away_team_id}-${x.home_team_id}`;
    const lowerWins = Number(x.home_team_id.slice(1)) < Number(x.away_team_id.slice(1)) ? [2, 0] : [0, 2];
    const sc = res[k1] || (res[k2] && [res[k2][1], res[k2][0]]) || lowerWins;
    Object.assign(x, { status: 'confirmed', home_score: sc[0], away_score: sc[1] });
  }
  const ev = evaluateCategory(cfg, ts, ms);
  assert.equal(ev.standings.A.needsLottery, true); // 3位タイ
  const filled = ev.updates.filter((u) => u.home_team_id && u.away_team_id);
  assert.equal(filled.length, 2); // 準決勝2試合はA組1・2位を含めて決まる
});

// ---- 上位・中位・下位トーナメント ----
test('上位・中位・下位: 4組×6チーム（上位2・中位2）で、順位が1〜24位まで通しで決まる', () => {
  const r = norm(buildKnockout(lkCfg({ type: 'split3', k: 2, m: 2, mode: 'all' }), { format: 'league_knockout', groupSizes: { A: 6, B: 6, C: 6, D: 6 } }));
  assert.equal(r.error, undefined);
  const names = [...new Set(r.matches.map((m) => m.bracket))];
  assert.deepEqual([...names].sort(), ['上位トーナメント', '中位トーナメント', '下位トーナメント'].sort());
  assert.deepEqual(placesOf(r.matches), seq(24));
  // 中位は各組3〜4位、クロス方式（A組3位 対 B組4位）
  const mid = firstRound(r.matches.filter((m) => m.bracket === '中位トーナメント'));
  assert.ok(mid.every((m) => [3, 4].includes(m.home_ref.r) && [3, 4].includes(m.away_ref.r)));
  assert.ok(mid.some((m) => m.home_ref.g === 'A' && m.home_ref.r === 3 && m.away_ref.g === 'B' && m.away_ref.r === 4));
  // 中位の優勝は9位、下位の優勝は17位
  assert.equal(r.matches.find((m) => m.label === '中位トーナメント 決勝').place_w, 9);
  assert.equal(r.matches.find((m) => m.label === '下位トーナメント 決勝').place_w, 17);
});

test('上位・中位・下位: 中位の数を省略すると上位と同じ数になり、余った順位は下位へ', () => {
  const r = norm(buildKnockout(lkCfg({ type: 'split3', k: 1, mode: 'top3' }), { format: 'league_knockout', groupSizes: { A: 4, B: 4, C: 4, D: 4 } }));
  const by = (n) => firstRound(r.matches.filter((m) => m.bracket === n)).flatMap((m) => [m.home_ref.r, m.away_ref.r]);
  assert.ok(by('上位トーナメント').every((x) => x === 1));
  assert.ok(by('中位トーナメント').every((x) => x === 2));
  assert.ok(by('下位トーナメント').every((x) => x === 3 || x === 4));
});

// ---- 代表者じゃんけん ----
test('じゃんけん: 判定順に入れると、並んだときに本部が入力した順で決まる', () => {
  const m = (h, a, hs, as) => ({ home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'confirmed', stage: 'league' });
  const ms = [m('A', 'B', 0, 0)];
  const tb = ['points', 'gd', 'gf', 'h2h', 'janken'];
  assert.equal(computeStandings(['A', 'B'], ms, tb).needsLottery, true);
  const s2 = computeStandings(['A', 'B'], ms, tb, ['B', 'A']);
  assert.equal(s2.rows[0].teamId, 'B');
  assert.equal(s2.rows[0].lottery, true);
});

test('判定順: 抽選・じゃんけんを入れない設定も保存でき、知らない項目は除かれる', () => {
  assert.deepEqual(normalizeConfig({ tiebreak: ['points', 'gd', 'gf'] }).tiebreak, ['points', 'gd', 'gf']);
  assert.deepEqual(normalizeConfig({ tiebreak: ['points', 'janken', 'xxx'] }).tiebreak, ['points', 'janken']);
});

// ---- 上位・中位はトーナメント、下位はリーグ戦 ----
test('リーグ戦の段: 4組×6（上位2・中位2、下位はリーグ戦）で、重なり無く日程ができ、17〜24位がリーグ戦で決まる', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 4, courts: 6, knockoutPlan: { type: 'split3', k: 2, m: 2, mode: 'all', formats: { 2: 'league' } } });
  const ts = teams(24).map((t, i) => ({ ...t, group_label: 'ABCD'[i % 4] }));
  const { matches, warnings } = generateCategory(cfg, ts);
  const lg = matches.filter((m) => /^R/.test(m.code || ''));
  assert.equal(lg.length, 28); // 8チームの総当たり
  assert.ok(lg.every((m) => m.group_label === '下位リーグ' && /^下位リーグ 第\d節$/.test(m.label)));
  // 同じ順位の枠が同じ枠（時間）に2試合入らない
  const bySlot = {};
  for (const m of lg) for (const r of [m.home_ref, m.away_ref]) { const k = `${m.slot}-${r.g}${r.r}`; assert.ok(!bySlot[k], `同じ枠で重複 ${k}`); bySlot[k] = 1; }
  const ms = matches.map((m, i) => ({ ...m, id: `m${i}`, status: 'none' }));
  assert.equal(scheduleWarnings({ ...cfg }, ms).filter((w) => w.level === 'error').length, 0);
  const num = (id) => Number(id.slice(1));
  for (const m of ms.filter((x) => x.stage === 'league')) { const w = num(m.home_team_id) < num(m.away_team_id); Object.assign(m, { status: 'confirmed', home_score: w ? 2 : 0, away_score: w ? 0 : 2 }); }
  for (let round = 0; round < 12; round++) {
    const ev = evaluateCategory(cfg, ts, ms);
    for (const u of ev.updates) Object.assign(ms.find((m) => m.id === u.id), u);
    for (const m of ms.filter((x) => x.stage === 'knockout' && x.status === 'none' && x.home_team_id && x.away_team_id)) {
      const w = num(m.home_team_id) < num(m.away_team_id); Object.assign(m, { status: 'confirmed', home_score: w ? 1 : 0, away_score: w ? 0 : 1 });
    }
  }
  const ev = evaluateCategory(cfg, ts, ms);
  assert.ok(ev.standings['下位リーグ'].placement && ev.standings['下位リーグ'].complete);
  assert.deepEqual(ev.finalRanking.map((r) => r.rank), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(new Set(ev.finalRanking.map((r) => r.teamId)).size, 24);
});

test('リーグ戦の段: 並んだら抽選・じゃんけん待ちになり、結果を入れると順位が決まる', () => {
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 2, courts: 2, tiebreak: ['points', 'gd', 'gf', 'janken'], knockoutPlan: { type: 'split', k: 1, mode: 'top3', formats: { 1: 'league' } } });
  const ts = teams(6).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const { matches } = generateCategory(cfg, ts);
  const ms = matches.map((m, i) => ({ ...m, id: `m${i}`, status: 'none' }));
  const num = (id) => Number(id.slice(1));
  for (const m of ms.filter((x) => x.stage === 'league')) { const w = num(m.home_team_id) < num(m.away_team_id); Object.assign(m, { status: 'confirmed', home_score: w ? 2 : 0, away_score: w ? 0 : 2 }); }
  let ev = evaluateCategory(cfg, ts, ms);
  for (const u of ev.updates) Object.assign(ms.find((m) => m.id === u.id), u);
  for (const m of ms.filter((x) => /^R/.test(x.code || ''))) Object.assign(m, { status: 'confirmed', home_score: 1, away_score: 1 }); // 全部引き分け
  ev = evaluateCategory(cfg, ts, ms);
  const st = ev.standings['下位リーグ'];
  assert.equal(st.needsLottery, true);
  const order = st.rows.map((r) => r.teamId).reverse();
  ev = evaluateCategory({ ...cfg, lottery: { 下位リーグ: order } }, ts, ms);
  assert.equal(ev.standings['下位リーグ'].hasTie, false);
  assert.equal(ev.finalRanking.find((r) => r.rank === 3).teamId, order[0]); // 下位リーグ1位 = 全体3位
});

// ---- 開催日ごとの試合間隔 ----
test('試合間隔: 2日目だけ間隔を変えると、2日目の時刻の間隔が変わり、1日目は変わらない', () => {
  const base = { format: 'league_knockout', groups: 2, courts: 2, halfMinutes: 12, halftimeMinutes: 3, intervalMinutes: 8, startTime: 540, lunchEnabled: false, minRestSlots: 0,
    knockoutPlan: { type: 'top', k: 2, mode: 'top3' }, dayDates: ['2026-11-21', '2026-11-22'] };
  const gap = (cfg) => {
    const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
    const { matches, dayBreakSlots } = generateCategory(normalizeConfig(cfg), ts);
    const day = (m) => dayBreakSlots.filter((b) => m.slot >= b).length;
    const g = (d) => { const st = [...new Set(matches.filter((m) => day(m) === d).map((m) => m.start_min))].sort((a, b) => a - b); return st[1] - st[0]; };
    return [g(0), g(1)];
  };
  assert.deepEqual(gap(base), [35, 35]); // 12+3+12 + 間隔8
  assert.deepEqual(gap({ ...base, extraDays: [{ startTime: 510, intervalMinutes: 3 }] }), [35, 30]); // 2日目だけ間隔3分
  assert.equal(normalizeConfig({ ...base, extraDays: [{ intervalMinutes: '' }] }).extraDays[0].intervalMinutes, null);
});

test('自由に設定: 段の形式を「リーグ戦」にすると、その段は総当たりで作られる', () => {
  const plan = { type: 'custom', mode: 'top3', brackets: [
    { name: '上位トーナメント', from: 1, to: 2, format: 'knockout' },
    { name: '中位トーナメント', from: 3, to: 4 },
    { name: '下位リーグ', from: 5, to: 6, format: 'league' }] };
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 4, courts: 6, knockoutPlan: plan });
  const ts = teams(24).map((t, i) => ({ ...t, group_label: 'ABCD'[i % 4] }));
  const { matches } = generateCategory(cfg, ts);
  const low = matches.filter((m) => m.group_label === '下位リーグ');
  assert.equal(low.length, 28);
  assert.ok(low.every((m) => /^R/.test(m.code) && /^下位リーグ 第\d節$/.test(m.label)));
  assert.ok(matches.filter((m) => m.group_label === '中位トーナメント').every((m) => /^K/.test(m.code)));
});

// ---- コートの優先順位 ----
test('コートの優先順位: 同じ時間帯では、上位の段・決勝ほど優先順位の高いコートに入る', () => {
  // 優先順位：Cコート → Aコート → Dコート → Bコート
  const cfg = normalizeConfig({ format: 'league_knockout', groups: 4, courts: 4, minRestSlots: 0, courtPriority: [2, 0, 3, 1],
    knockoutPlan: { type: 'split3', k: 2, m: 2, mode: 'top3' } });
  const ts = teams(24).map((t, i) => ({ ...t, group_label: 'ABCD'[i % 4] }));
  const { matches } = generateCategory(cfg, ts);
  const ko = matches.filter((m) => m.stage === 'knockout');
  // 決勝トーナメントの各時間帯で、最も重要な試合が Cコート（2）に入っている
  const bySlot = {};
  for (const m of ko) (bySlot[m.slot] ||= []).push(m);
  const rankOf = (m) => [m.group_label === '上位トーナメント' ? 0 : m.group_label === '中位トーナメント' ? 1 : 2, m.place_w ?? 999];
  for (const list of Object.values(bySlot)) {
    const top = [...list].sort((a, b) => rankOf(a)[0] - rankOf(b)[0] || rankOf(a)[1] - rankOf(b)[1])[0];
    assert.equal(top.court, 2, `${top.label} が Cコートに入っていない`);
  }
  // 上位トーナメントの決勝は Cコート
  assert.equal(ko.find((m) => m.label === '上位トーナメント 決勝').court, 2);
  // 優先順位の補完：範囲外・重複を除き、足りない分を番号順で足す
  assert.deepEqual(normalizeConfig({ courts: 4, courtPriority: [3, 3, 9, 1] }).courtPriority, [3, 1, 0, 2]);
});

// ---- リーグ戦のコート：同じ組はなるべく同じコートか隣のコートに ----
test('コートの割り当て: 組ごとに担当のコート付近にまとまり、離れたコートは使わない', () => {
  const span = (G, courts, n) => {
    const cfg = normalizeConfig({ format: 'league', groups: G, courts });
    const ts = teams(n).map((t, i) => ({ ...t, group_label: 'ABCDEFGH'[i % G] }));
    const { matches } = generateCategory(cfg, ts);
    return Object.fromEntries([...'ABCDEFGH'.slice(0, G)].map((g) => {
      const cs = matches.filter((m) => m.group_label === g).map((m) => m.court);
      return [g, [Math.min(...cs), Math.max(...cs)]];
    }));
  };
  // 4組・8面（各チーム1枠休む）：1つの時間帯に2組が4面ずつ使うので、A・B組は左半分（A〜D）、C・D組は右半分（E〜H）
  assert.deepEqual(span(4, 8, 32), { A: [0, 3], B: [0, 3], C: [4, 7], D: [4, 7] });
  // 4組・6面（各チーム1枠休む）：A・B組は左側（A〜C）、C・D組は右側（D〜F）
  const s6 = span(4, 6, 24);
  assert.ok(s6.A[1] <= 2 && s6.B[1] <= 2 && s6.C[0] >= 3 && s6.D[0] >= 3, JSON.stringify(s6));
  // 4組・4面：1組1面
  assert.deepEqual(span(4, 4, 24), { A: [0, 0], B: [1, 1], C: [2, 2], D: [3, 3] });
});

// ---- 予選と決勝トーナメントの間の時間 ----
test('予選と決勝の間: 同じ日に続くときだけ、決勝の最初の枠の前に指定の時間をあける', () => {
  const base = { format: 'league_knockout', groups: 2, courts: 4, halfMinutes: 10, halftimeMinutes: 0, periods: 1, intervalMinutes: 5, startTime: 540,
    lunchEnabled: false, minRestSlots: 0, knockoutPlan: { type: 'top', k: 2, mode: 'top3' } };
  const ts = teams(8).map((t, i) => ({ ...t, group_label: 'AB'[i % 2] }));
  const firstKoGap = (cfg) => {
    const { matches } = generateCategory(normalizeConfig(cfg), ts);
    const lastLeague = Math.max(...matches.filter((m) => m.stage === 'league').map((m) => m.start_min));
    const firstKo = Math.min(...matches.filter((m) => m.stage === 'knockout').map((m) => m.start_min));
    return firstKo - lastLeague;
  };
  assert.equal(firstKoGap(base), 15); // 試合10分＋間隔5分
  assert.equal(firstKoGap({ ...base, koGapMinutes: 30 }), 45); // ＋30分
  // 2日開催で決勝が翌日の朝から：あけない（2日目の開始時刻どおり）
  const two = { ...base, koGapMinutes: 30, dayDates: ['2026-11-21', '2026-11-22'], dayBreaks: ['L3'], extraDays: [{ startTime: 510 }] };
  const { matches } = generateCategory(normalizeConfig(two), ts);
  const day2First = Math.min(...matches.filter((m) => m.stage === 'knockout').map((m) => m.start_min));
  assert.equal(day2First, 510);
});

// ---- 1日目を時刻で区切る ----
test('時刻で区切る: 終了時刻までに終わる試合だけ1日目に入り、残りは2日目に回る', () => {
  const ts = teams(24).map((t, i) => ({ ...t, group_label: 'ABCD'[i % 4] }));
  for (const end of [720, 900]) {
    const cfg = normalizeConfig({ format: 'league_knockout', groups: 4, courts: 6, halfMinutes: 12, halftimeMinutes: 3, intervalMinutes: 8, startTime: 540,
      knockoutPlan: { type: 'split3', k: 2, m: 2, mode: 'top3' }, dayDates: ['2026-11-21', '2026-11-22'], dayBreaks: [`T${end}`], extraDays: [{ startTime: 510 }] });
    const { matches, dayBreakSlots } = generateCategory(cfg, ts);
    const day1 = matches.filter((m) => m.slot < dayBreakSlots[0]);
    const day2 = matches.filter((m) => m.slot >= dayBreakSlots[0]);
    assert.ok(day1.length > 0 && day2.length > 0);
    assert.ok(Math.max(...day1.map((m) => m.start_min)) + 27 <= end, `${end}: 1日目の最後の試合が終了時刻を過ぎている`);
    assert.equal(Math.min(...day2.map((m) => m.start_min)), 510);
    const ws = scheduleWarnings({ ...cfg, dayBreakSlots }, matches.map((m, i) => ({ ...m, id: `m${i}` })));
    assert.equal(ws.filter((w) => w.level === 'error').length, 0);
    assert.equal(matches.length, 84);
  }
});
