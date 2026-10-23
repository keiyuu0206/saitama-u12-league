import { api, ApiError } from './web-api.js';
const apiBase = api;
import { openPrintDialog, printParking, periodText as printPeriod } from './web-print.js';
import { openOutlineEditor, openOutlineDialog, openPresetList, defaultOutline } from './web-outline.js';
import { h, mount, modal, confirmDialog, toast, store, poller, run, copyText, resizeImage, toHHMM, fromHHMM, formatDate, todayStr, nowMin, formatUpdated, icon, resizeBanner, MANUALS, manualLink, markFetched, refreshButton } from './web-ui.js';
import { teamMap, codeMap, sideInfo, courtName, matchLength, matchLengthFor, manualLabel, planBrackets, standingsView, bracketView, TIEBREAK_LABEL, dayOf, dayTotal, dayLabel, dayDate, absMin } from './web-views.js';

const STATUS = {
  draft: { label: '準備中', note: '閲覧ページは非公開です。自由に編集できます。' },
  published: { label: '公開中', note: '閲覧ページを公開しています。組み合わせの編集もできます。' },
  live: { label: '開催中', note: '組み合わせは固定され、結果の確定とコートごとの時間調整ができます。' },
  finished: { label: '終了', note: '結果の閲覧のみです。' },
};
const CATEGORY_NAMES = ['U7', 'U8', 'U9', 'U10', 'U11', 'U12'];
const FORMAT_LABEL = { league: 'リーグ戦', knockout: 'トーナメント', league_knockout: 'リーグ戦＋トーナメント' };
const RANK_LABEL = { top3: '1〜3位を決める（3位決定戦あり）', top3_shared: '1〜3位を決める（3位は2チーム）', all: '全順位を決める（順位決定戦）' };

const PLAN_LABEL = { top: '上位チームだけでトーナメント', all: '全チームで1つのトーナメント', split: '上位トーナメントと下位トーナメント', split3: '上位・中位・下位トーナメント', byrank: '同じ順位どうしでトーナメント', custom: '自由に設定する' };

// 管理画面での見積もり（実際の組み分け前でも、チーム数と組数から人数を推定する）
function estimateGroupSizes(f, cat) {
  const labels = Array.from({ length: Math.max(1, f.groups) }, (_, i) => String.fromCharCode(65 + i));
  const assigned = cat.teams.filter((t) => t.group_label);
  if (assigned.length === cat.teams.length && assigned.length) {
    const sizes = {};
    for (const t of assigned) sizes[t.group_label] = (sizes[t.group_label] || 0) + 1;
    if (Object.keys(sizes).length === labels.length) return sizes;
  }
  const n = Math.max(cat.teams.length, labels.length * 2);
  return Object.fromEntries(labels.map((l, i) => [l, Math.floor(n / labels.length) + (i < n % labels.length ? 1 : 0)]));
}

function expandPlanPreview(plan, maxRank) {
  const list = expandPlanBase(plan, maxRank);
  const formats = plan.formats || {};
  return list.map((b, i) => {
    const format = (plan.type === 'custom' ? b.format : formats[i]) === 'league' ? 'league' : 'knockout';
    return { ...b, index: i, format, name: format === 'league' && plan.type !== 'custom' ? b.name.replace(/トーナメント$/, 'リーグ') : b.name };
  });
}
function expandPlanBase(plan, maxRank) {
  const k = Math.max(1, Math.min(maxRank, Number(plan.k) || 2));
  if (plan.type === 'all') return [{ name: '決勝トーナメント', from: 1, to: maxRank }];
  if (plan.type === 'split') return [{ name: '上位トーナメント', from: 1, to: k }, { name: '下位トーナメント', from: k + 1, to: maxRank }].filter((b) => b.from <= b.to);
  if (plan.type === 'split3') {
    const m = Math.max(1, Math.min(maxRank, Number(plan.m) || k));
    return [{ name: '上位トーナメント', from: 1, to: k }, { name: '中位トーナメント', from: k + 1, to: Math.min(maxRank, k + m) }, { name: '下位トーナメント', from: k + m + 1, to: maxRank }].filter((b) => b.from <= b.to);
  }
  if (plan.type === 'byrank') return Array.from({ length: maxRank }, (_, i) => ({ name: `${i + 1}位トーナメント`, from: i + 1, to: i + 1 }));
  if (plan.type === 'custom') return (plan.brackets || []).map((b) => ({ ...b, from: Number(b.from) || 1, to: Math.min(Number(b.to) || 1, maxRank) })).filter((b) => b.from <= b.to);
  return [{ name: '決勝トーナメント', from: 1, to: k }];
}

function knockoutPlanPanel(f, cat, redraw) {
  const plan = f.knockoutPlan || (f.knockoutPlan = { type: 'top', k: f.advance || 2, mode: f.rankMode || 'top3', brackets: [] });
  const sizes = estimateGroupSizes(f, cat);
  const maxRank = Math.max(...Object.values(sizes));
  // 各トーナメントのチーム数と、決まる順位（全体の通し順位）
  let offset = 0;
  const preview = expandPlanPreview(plan, maxRank).map((b) => {
    let n = 0;
    for (let r = b.from; r <= b.to; r++) for (const v of Object.values(sizes)) if (v >= r) n++;
    const range = b.from === b.to ? `各組${b.from}位` : `各組${b.from}〜${b.to}位`;
    const mode = b.format === 'league' ? 'all' : b.mode || plan.mode; // リーグ戦は全員の順位が決まる
    const first = offset + 1;
    // 3位決定戦ありなら4位まで、3位が2チームなら3位まで、全順位なら全員
    const decided = n < 2 ? null
      : mode === 'all' ? (n === 2 ? `${first}・${first + 1}位` : `${first}〜${offset + n}位`)
        : n >= 4 ? (mode === 'top3' ? `${first}〜${first + 3}位` : `${first}〜${first + 2}位`)
          : n === 3 ? `${first}〜${first + 2}位` : `${first}・${first + 1}位`;
    offset += n;
    const games = b.format === 'league' ? (n * (n - 1)) / 2 : null;
    return { name: b.name, range, n, decided, index: b.index, format: b.format, games, warn: n < 2 ? '2チーム未満のため作られません' : null };
  });
  const set = (patch) => { Object.assign(plan, patch); redraw(); };

  const custom = plan.type === 'custom' ? h('div', { class: 'stack', style: { marginTop: '12px' } },
    (plan.brackets || []).map((b, i) => h('div', { class: 'grid-form', style: { padding: '12px', background: 'var(--surface-2)', borderRadius: '14px' } },
      h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, h('span', null, '名前'), h('input', { type: 'text', value: b.name || '', oninput: (e) => { b.name = e.target.value; } })),
      h('label', { class: 'field' }, h('span', null, '各組の何位から'), h('input', { type: 'number', min: 1, max: 16, value: b.from, oninput: (e) => { b.from = Number(e.target.value); }, onchange: redraw })),
      h('label', { class: 'field' }, h('span', null, '何位まで'), h('input', { type: 'number', min: 1, max: 16, value: b.to, oninput: (e) => { b.to = Number(e.target.value); }, onchange: redraw })),
      h('label', { class: 'field' }, h('span', null, '形式'), h('select', { 'data-bracket-format': i, onchange: (e) => {
        b.format = e.target.value;
        // 名前の末尾が「トーナメント」「リーグ」なら、形式に合わせて変える（自分で付けた名前はそのまま）
        if (b.format === 'league') b.name = String(b.name || '').replace(/トーナメント$/, 'リーグ');
        else b.name = String(b.name || '').replace(/リーグ$/, 'トーナメント');
        redraw();
      } },
        [['knockout', 'トーナメント'], ['league', 'リーグ戦（総当たり）']].map(([v, l]) => h('option', { value: v, selected: (b.format || 'knockout') === v }, l)))),
      b.format === 'league' ? h('p', { class: 'muted small', style: { margin: 0, alignSelf: 'end' } }, '全チームの順位を決めます') : h('label', { class: 'field' }, h('span', null, '順位の決め方'), h('select', { onchange: (e) => { b.mode = e.target.value; redraw(); } },
        Object.entries(RANK_LABEL).map(([v, l]) => h('option', { value: v, selected: (b.mode || plan.mode) === v }, l)))),
      h('div', { style: { gridColumn: '1 / -1' } }, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { plan.brackets.splice(i, 1); redraw(); } }, 'このトーナメントを削除')))),
    h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
      const last = (plan.brackets || []).at(-1);
      const from = last ? Number(last.to) + 1 : 1;
      plan.brackets = [...(plan.brackets || []), { name: `トーナメント${(plan.brackets || []).length + 1}`, from, to: from, mode: plan.mode }];
      redraw();
    } }, '＋ トーナメントを追加')) : null;

  return h('div', { style: { marginTop: '16px' } },
    h('h3', { style: { marginBottom: '8px' } }, '決勝トーナメント'),
    h('div', { class: 'grid-form' },
      h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, h('span', null, '進み方'), h('select', { onchange: (e) => {
        const type = e.target.value;
        if (type === 'custom' && !(plan.brackets || []).length) plan.brackets = expandPlanPreview(plan, maxRank).map(({ index, ...b }) => ({ ...b, mode: plan.mode }));
        set({ type });
      } }, Object.entries(PLAN_LABEL).map(([v, l]) => h('option', { value: v, selected: plan.type === v }, l)))),
      plan.type === 'top' || plan.type === 'split' || plan.type === 'split3' ? h('label', { class: 'field' }, h('span', null, plan.type === 'top' ? '各組から進む数' : '上位に進む数（各組）'),
        h('input', { type: 'number', min: 1, max: 16, value: plan.k, inputmode: 'numeric', oninput: (e) => { plan.k = Number(e.target.value); }, onchange: redraw })) : null,
      plan.type === 'split3' ? h('label', { class: 'field' }, h('span', null, '中位に進む数（各組）'),
        h('input', { type: 'number', min: 1, max: 16, value: plan.m || plan.k, inputmode: 'numeric', oninput: (e) => { plan.m = Number(e.target.value); }, onchange: redraw })) : null,
      plan.type !== 'custom' ? h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, h('span', null, '順位の決め方'), h('select', { onchange: (e) => set({ mode: e.target.value }) },
        Object.entries(RANK_LABEL).map(([v, l]) => h('option', { value: v, selected: plan.mode === v }, l)))) : null),
    custom,
    h('div', { class: 'notice', style: { marginTop: '12px' } },
      h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, cat.teams.length ? `いまの${cat.teams.length}チーム・${f.groups}組の場合` : `${f.groups}組の場合（チーム登録後に人数が正確になります）`),
      h('div', { class: 'plan-preview' }, preview.map((p) => h('div', { class: 'pp-row' },
        h('strong', null, p.name),
        h('span', null, `${p.range}（${p.n}チーム${p.games ? `・総当たり${p.games}試合` : ''}）`),
        p.warn ? h('span', { class: 'pp-warn' }, p.warn) : h('span', { class: 'pp-rank' }, `${p.decided}を決定`),
        // 段ごとにトーナメントかリーグ戦かを選ぶ（全チームで1つ・上位だけの場合は対象外）
        ['split', 'split3', 'byrank'].includes(plan.type) && p.n >= 2 ? h('span', { class: 'pp-fmt', role: 'group', 'aria-label': `${p.name}の形式` },
          [['knockout', 'トーナメント'], ['league', 'リーグ戦']].map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(p.format === v),
            onclick: () => { plan.formats = { ...(plan.formats || {}) }; if (v === 'league') plan.formats[p.index] = 'league'; else delete plan.formats[p.index]; redraw(); } }, l))) : null)))),
    h('p', { class: 'muted small' }, '同じ組のチームができるだけ後で当たるように、組み合わせを自動で決めます。各組の上位1〜2チームが2・4・8組から進む場合は、クロス方式（A組1位 対 B組2位 など）になります。チーム数が2・4・8・16でないときは、上位の組の1位から順にシード（不戦）が入ります。'));
}

// ---------- テンプレート・プリセットの公開（全体管理者のもの） ----------
// 全体管理者：自分（全体管理者）のものに「地域管理者に公開」のチェック。地域管理者：公開されたものに「共通」の印
export function sharedBadge(x, onToggle) {
  if (!x.common) return null;
  if (window.__ycRole !== 'super') return h('span', { class: 'tag done' }, '共通');
  return h('label', { class: 'check share-check', title: 'チェックすると、地域管理者も読み込めるようになります' },
    h('input', { type: 'checkbox', checked: !!x.published, onchange: (e) => onToggle(e.target.checked) }), '地域管理者に公開');
}

// ---------- カテゴリの色（取り違え防止） ----------
const CAT_COLORS = ['#0f7b4a', '#1d5fbf', '#c2410c', '#7c3aed', '#be185d', '#0e7490', '#a16207', '#4d7c0f'];
const catColor = (i) => CAT_COLORS[(i < 0 ? 0 : i) % CAT_COLORS.length];

// ---------- 大会のコピー ----------
function openCopyDialog(t, navigate) {
  const f = { name: `${t.name}（コピー）`, date: todayStr(), end_date: todayStr(), scope: 'all', withResults: false };
  const body = h('div');
  const draw = () => mount(body, h('div', { class: 'stack' },
    h('label', { class: 'field' }, h('span', null, '新しい大会名'), h('input', { type: 'text', value: f.name, oninput: (e) => { f.name = e.target.value; } })),
    h('div', { class: 'grid-form' },
      h('label', { class: 'field' }, h('span', null, '開始日'), h('input', { type: 'date', value: f.date, oninput: (e) => { f.date = e.target.value; } })),
      h('label', { class: 'field' }, h('span', null, '終了日'), h('input', { type: 'date', value: f.end_date, oninput: (e) => { f.end_date = e.target.value; } }))),
    h('div', null,
      h('div', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)', marginBottom: '4px' } }, 'コピーする範囲'),
      [['all', '丸ごと', 'カテゴリの設定・チーム・組分け・日程（試合の組み合わせと時刻）・要項・駐車券・スポンサー'],
        ['teams', '設定とチーム', '組分けと日程は作り直します'],
        ['settings', '設定だけ', 'カテゴリの設定（試合時間・形式・判定順など）・要項・駐車券・スポンサー']].map(([k, l, d]) =>
        h('label', { class: `copy-opt${f.scope === k ? ' on' : ''}` },
          h('input', { type: 'radio', name: 'copy-scope', checked: f.scope === k, onchange: () => { f.scope = k; draw(); } }),
          h('span', null, h('strong', null, l), h('small', null, d))))),
    f.scope === 'all' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.withResults, onchange: (e) => { f.withResults = e.target.checked; } }), '試合結果もコピーする（通常はオフ。結果が空の状態で始まります）') : null,
    h('p', { class: 'muted small', style: { margin: 0 } }, '日程は新しい開始日に合わせて日付がずれます（試合の時刻・コートはそのまま）。忘れ物はコピーしません。コピー後は「準備中」の状態で作られます。')));
  draw();
  modal({
    title: '大会をコピー',
    content: body,
    actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: 'コピーして作成', kind: 'btn-primary', onClick: async () => {
      if (!f.date) { toast('開始日を入力してください', true); return true; }
      const r = await run(() => api('POST', `/api/admin/tournaments/${t.id}/copy`, f));
      if (!r) return true;
      toast(`コピーしました（${r.categories}カテゴリ・${r.teams}チーム・${r.matches}試合）`);
      navigate(`/admin/t/${r.id}`);
    } }],
  });
}

// ---------- 勝点が並んだときの判定順 ----------
const MANUAL = ['janken', 'lottery'];
function tiebreakEditor(f, redraw) {
  if (f.tiebreak[0] !== 'points') f.tiebreak = ['points', ...f.tiebreak.filter((k) => k !== 'points')];
  const has = (k) => f.tiebreak.includes(k);
  // 本部で決める方法（じゃんけん・抽選）は常に一番後ろ。計算で決まる項目より前には置けない
  const tidy = () => { f.tiebreak = [...f.tiebreak.filter((k) => !MANUAL.includes(k)), ...f.tiebreak.filter((k) => MANUAL.includes(k))]; };
  const toggle = (k, on) => { f.tiebreak = on ? [...f.tiebreak.filter((x) => x !== k), k] : f.tiebreak.filter((x) => x !== k); tidy(); redraw(); };
  const swap = (i, j) => { [f.tiebreak[i], f.tiebreak[j]] = [f.tiebreak[j], f.tiebreak[i]]; tidy(); redraw(); };
  const addable = ['gd', 'gf', 'h2h'].filter((k) => !has(k));
  const rows = f.tiebreak.map((k, i) => {
    const fixed = k === 'points';
    const manual = MANUAL.includes(k);
    const prevOk = i > 1 && (manual ? MANUAL.includes(f.tiebreak[i - 1]) : true);
    const nextOk = i < f.tiebreak.length - 1 && (manual || !MANUAL.includes(f.tiebreak[i + 1]));
    return h('div', { class: 'row tb-row' },
      h('span', { class: 'num', style: { width: '24px', fontWeight: 700 } }, i + 1),
      h('span', null, TIEBREAK_LABEL[k]),
      manual ? h('span', { class: 'tag' }, '本部で入力') : null,
      h('span', { class: 'spacer' }),
      fixed ? h('span', { class: 'muted small' }, '固定') : [
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '上へ', disabled: !prevOk, onclick: () => swap(i - 1, i) }, '↑'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '下へ', disabled: !nextOk, onclick: () => swap(i, i + 1) }, '↓'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '判定順から外す', onclick: () => { f.tiebreak = f.tiebreak.filter((x) => x !== k); redraw(); } }, '×')]);
  });
  return h('div', null,
    h('div', { class: 'stack' }, rows),
    addable.length ? h('div', { class: 'row', style: { marginTop: '8px' } },
      h('select', { style: { width: 'auto' }, 'aria-label': '判定を追加', onchange: (e) => { if (e.target.value) { f.tiebreak.push(e.target.value); tidy(); redraw(); } } },
        h('option', { value: '' }, '＋ 判定を追加…'), addable.map((k) => h('option', { value: k }, TIEBREAK_LABEL[k])))) : null,
    h('div', { class: 'tb-manual' },
      h('div', { class: 'small', style: { fontWeight: 700 } }, '計算で決まらないときの決め方（入れるかどうかを選べます）'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: has('janken'), onchange: (e) => toggle('janken', e.target.checked) }), '代表者によるじゃんけん'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: has('lottery'), onchange: (e) => toggle('lottery', e.target.checked) }), '抽選'),
      h('p', { class: 'muted small', style: { margin: '4px 0 0' } }, 'どちらも、全試合が終わって並んだときに本部で結果を入力します。両方入れた場合は上にある方で決めます。どちらも入れない場合は、最後に本部で決めた順位を入力します。')),
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { f.tiebreak = ['points', 'gd', 'gf', 'h2h', ...f.tiebreak.filter((k) => MANUAL.includes(k))]; redraw(); } }, '総合成績優先にする'),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { f.tiebreak = ['points', 'h2h', 'gd', 'gf', ...f.tiebreak.filter((k) => MANUAL.includes(k))]; redraw(); } }, '当該対戦優先にする')));
}

// ---------- 複数日の設定 ----------

function periodText(t) {
  if (t.end_date && t.end_date > t.date) return `${formatDate(t.date)} 〜 ${formatDate(t.end_date).replace(/^\d+年/, '')}`;
  return formatDate(t.date);
}

// 大会の開催期間の日付（最大4日）
function tournamentDays(t) {
  if (!t.date) return [];
  const out = [t.date];
  if (t.end_date && t.end_date > t.date) {
    for (let i = 1; i < 4; i++) {
      const d = addDays(t.date, i);
      if (d > t.end_date) break;
      out.push(d);
    }
  }
  return out;
}

// 「◯日目はどこまで」の選択肢（形式とチーム数から作る）
function dayBreakOptions(f, cat) {
  const hasLeague = f.format !== 'knockout';
  const hasKo = f.format !== 'league';
  const sizes = estimateGroupSizes(f, cat);
  const mx = Math.max(...Object.values(sizes));
  const R = hasLeague ? (mx % 2 ? mx : mx - 1) : 0;
  // 決勝の段：トーナメントは何回戦あるか、リーグ戦の段は何節あるか
  let koDepth = 0;
  const leagues = [];
  if (hasKo) {
    if (f.format === 'knockout') koDepth = Math.ceil(Math.log2(Math.max(2, cat.teams.length)));
    else {
      const plan = f.knockoutPlan || { type: 'top', k: 2 };
      for (const b of expandPlanPreview(plan, mx)) {
        let n = 0;
        for (let r = b.from; r <= b.to; r++) for (const v of Object.values(sizes)) if (v >= r) n++;
        if (n < 2) continue;
        if (b.format === 'league') leagues.push({ name: b.name, rounds: n % 2 ? n : n - 1 });
        else koDepth = Math.max(koDepth, Math.ceil(Math.log2(n)));
      }
    }
  }
  const T = Math.max(koDepth, ...leagues.map((l) => l.rounds));
  const opts = [];
  for (let r = 1; r <= R; r++) {
    if (r === R && !hasKo) break;
    opts.push([`L${r}`, r === R ? `リーグ戦の最後（第${r}節）まで` : `リーグ第${r}節まで`]);
  }
  for (let i = 0; i < T - 1; i++) {
    const parts = [];
    if (i < koDepth - 1) { const d = koDepth - 1 - i; parts.push(`トーナメントの${d === 1 ? '準決勝' : d === 2 ? '準々決勝' : `${i + 1}回戦`}`); }
    for (const l of leagues) if (i < l.rounds - 1) parts.push(`${l.name}第${i + 1}節`);
    if (parts.length) opts.push([`K${i}`, `${parts.join('・')}まで`]);
  }
  return opts;
}

function addDays(date, n) {
  if (!date) return '';
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayPanel(f, cat, t, redraw) {
  const all = tournamentDays(t);
  // このカテゴリが試合をする日（未設定なら、これまでの設定か大会の全日程）
  let picked = (f.dayDates || []).filter((d) => all.includes(d));
  if (!picked.length) {
    const legacy = [t.date, ...(f.extraDays || []).map((x) => x.date)].slice(0, f.dayCount || 1).filter((d) => all.includes(d));
    picked = legacy.length ? legacy : all.slice(0, 1);
  }
  picked = [...new Set(picked)].sort();
  f.dayDates = picked;
  f.dayCount = Math.max(1, picked.length);
  const n = f.dayCount;

  const opts = dayBreakOptions(f, cat);
  const keys = opts.map(([k]) => k);
  f.extraDays = Array.from({ length: n - 1 }, (_, i) => ({
    date: picked[i + 1],
    startTime: f.extraDays && f.extraDays[i] && f.extraDays[i].startTime != null ? f.extraDays[i].startTime : f.startTime,
    intervalMinutes: f.extraDays && f.extraDays[i] && f.extraDays[i].intervalMinutes != null ? f.extraDays[i].intervalMinutes : null,
  }));
  f.dayBreaks = Array.from({ length: n - 1 }, (_, i) => {
    const cur = f.dayBreaks && f.dayBreaks[i];
    if (cur && (keys.includes(cur) || /^T\d+$/.test(cur))) return cur; // 'T900' = 15:00 までに終わる試合まで
    const leagueEnd = keys.filter((k) => k[0] === 'L').at(-1);
    if (n === 2 && f.format === 'league_knockout' && leagueEnd) return leagueEnd;
    return keys[Math.min(keys.length - 1, Math.max(0, Math.round(((i + 1) * keys.length) / n) - 1))] || '';
  });
  for (let i = 1; i < f.dayBreaks.length; i++) {
    if (/^T/.test(f.dayBreaks[i]) || /^T/.test(f.dayBreaks[i - 1])) continue;
    const prev = keys.indexOf(f.dayBreaks[i - 1]);
    if (keys.indexOf(f.dayBreaks[i]) <= prev && keys[prev + 1] && !(f._touched || {})[i]) f.dayBreaks[i] = keys[prev + 1];
  }
  // 節・段で区切る日どうしの順番だけを確かめる（時刻で区切る日は順番の確認の対象外）
  const order = f.dayBreaks.filter((k) => !/^T/.test(k)).map((k) => keys.indexOf(k));
  const bad = order.some((x, i) => x < 0 || (i > 0 && x <= order[i - 1]));
  const tooFew = keys.length < n - 1;

  const toggle = (date, on) => {
    const next = on ? [...picked, date] : picked.filter((d) => d !== date);
    if (!next.length) return toast('少なくとも1日は選んでください', true);
    f.dayDates = [...new Set(next)].sort();
    f.dayCount = f.dayDates.length;
    redraw();
  };
  const md = (date) => { const d = new Date(`${date}T00:00:00`); return `${d.getMonth() + 1}/${d.getDate()}（${'日月火水木金土'[d.getDay()]}）`; };

  if (all.length <= 1) {
    return h('section', { class: 'panel' },
      h('h2', { style: { marginBottom: '6px' } }, '開催日'),
      h('p', { class: 'muted small', style: { margin: 0 } }, all.length ? `${formatDate(all[0])}の1日開催です。複数日に分けるときは、左の「大会情報を編集」で終了日を設定してください。` : '大会情報で開始日と終了日を設定してください。'));
  }

  return h('section', { class: 'panel' },
    h('h2', { style: { marginBottom: '4px' } }, '開催日'),
    h('p', { class: 'muted small', style: { marginTop: 0 } }, `大会の期間（${all.length}日間）のうち、このカテゴリが試合をする日を選んでください。`),
    h('div', { class: 'day-picks' }, all.map((date) => h('label', { class: `day-pick${picked.includes(date) ? ' on' : ''}` },
      h('input', { type: 'checkbox', checked: picked.includes(date), onchange: (e) => toggle(date, e.target.checked) }),
      h('span', null, md(date))))),
    n > 1 ? h('div', { class: 'stack', style: { marginTop: '14px' } }, picked.map((date, d) => h('div', { class: 'day-box' },
      h('div', { class: 'day-box-head' }, h('strong', null, `${d + 1}日目`), h('span', { class: 'muted small' }, formatDate(date))),
      d === 0 ? h('p', { class: 'muted small', style: { margin: '0 0 4px' } }, '第1試合の開始は「基本」の設定を使います') : h('div', { class: 'grid-form' },
        h('label', { class: 'field' }, h('span', null, '第1試合の開始'), h('input', { type: 'time', value: toHHMM(f.extraDays[d - 1].startTime), oninput: (e) => { if (e.target.value) f.extraDays[d - 1].startTime = fromHHMM(e.target.value); } })),
        h('label', { class: 'field' }, h('span', null, '試合間隔（分）'), h('input', { type: 'number', min: 0, max: 120, inputmode: 'numeric',
          value: f.extraDays[d - 1].intervalMinutes ?? '', placeholder: `1日目と同じ（${f.intervalMinutes}分）`,
          oninput: (e) => { f.extraDays[d - 1].intervalMinutes = e.target.value === '' ? null : Number(e.target.value); } }))),
      d < n - 1 && opts.length ? h('div', { class: 'grid-form', style: { marginTop: '8px' } },
        h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, h('span', null, `${d + 1}日目はどこまで`),
          h('select', { onchange: (e) => {
            // 「時刻で区切る」を選んだら、終了時刻は15:00から（前に入れていた時刻があればそれ）
            f.dayBreaks[d] = e.target.value === 'T' ? (/^T\d+$/.test(f.dayBreaks[d]) ? f.dayBreaks[d] : 'T900') : e.target.value;
            f._touched = { ...(f._touched || {}), [d]: true }; redraw();
          } },
            opts.map(([k, l]) => h('option', { value: k, selected: f.dayBreaks[d] === k }, l)),
            h('option', { value: 'T', selected: /^T/.test(f.dayBreaks[d] || '') }, '時刻で区切る（終了時刻を指定）'))),
        /^T\d+$/.test(f.dayBreaks[d] || '') ? h('label', { class: 'field' }, h('span', null, `${d + 1}日目の終了時刻`),
          h('input', { type: 'time', value: toHHMM(Number(f.dayBreaks[d].slice(1))), oninput: (e) => { if (e.target.value) f.dayBreaks[d] = `T${fromHHMM(e.target.value)}`; } })) : null,
        /^T\d+$/.test(f.dayBreaks[d] || '') ? h('p', { class: 'muted small', style: { margin: 0, gridColumn: '1 / -1' } },
          `この時刻までに終わる試合を${d + 1}日目に入れ、残りの試合は${d + 2}日目に回します（節の途中で区切れることもあります）。`) : null) : null))) : null,
    tooFew && n > 1 ? h('p', { class: 'notice error', style: { marginTop: '12px' } }, `いまの形式とチーム数では、${n}日に分けるだけの区切りがありません。試合をする日を減らしてください。`) : null,
    bad && !tooFew && n > 1 ? h('p', { class: 'notice error', style: { marginTop: '12px' } }, '区切りは、1日目 → 2日目 … の順に後ろの段階になるように選んでください。') : null,
    h('p', { class: 'muted small' }, '開催日や区切りを変えたときは「組み分け・日程」で日程を作り直してください。'));
}

// ログイン中の管理者（全体管理者 / 地域管理者）
let ME = null;
const isSuperUser = () => ME && ME.role === 'super';
const isViewer = () => ME && ME.role === 'viewer'; // 閲覧専用（設定の確認だけ。変更はできない）

export async function admin(root, path, navigate) {
  let me;
  try { me = await api('GET', '/api/admin/me'); } catch (e) { return mount(root, h('p', { class: 'empty' }, e.message)); }
  if (!me.admin) return loginView(root, () => admin(root, path, navigate));
  ME = me.user;
  window.__ycRole = ME.role;
  // スコア管理者は、結果の承認だけを行う専用画面へ
  if (ME.role === 'scorer') return (await import('./web-score.js')).scoreApp(root, ME);
  if (path.startsWith('/admin/scorers')) return isViewer() ? navigate('/admin') : scorersView(root, navigate);
  if (path.startsWith('/admin/accounts')) return isSuperUser() ? accountsView(root, navigate) : navigate('/admin');
  const m = path.match(/^\/admin\/t\/([^/]+)/);
  if (m) return tournamentView(root, m[1], navigate);
  return listView(root, navigate);
}

// マニュアルの一覧（権限に合わせて並べる）
function openManuals() {
  const keys = isSuperUser() ? ['organizer', 'superadmin', 'scorer', 'team', 'parents']
    : isViewer() ? ['organizer', 'parents'] : ['organizer', 'scorer', 'team', 'parents'];
  modal({
    title: '利用マニュアル（PDF）',
    content: h('div', { class: 'manual-list' }, keys.map((k) => h('a', { href: MANUALS[k].href, target: '_blank', rel: 'noopener' },
      h('strong', null, '📖 ', MANUALS[k].title), h('small', null, MANUALS[k].desc))),
      h('p', { class: 'muted small', style: { margin: '6px 0 0' } }, 'チーム関係者・スコア管理者・保護者のマニュアルは、それぞれの方に案内するときにもお使いください。')),
    actions: [{ label: '閉じる', kind: 'btn-ghost' }],
  });
}

function adminHeader(title, navigate, back) {
  const ghost = { background: 'transparent', color: '#fff', borderColor: 'rgba(255,255,255,0.7)' };
  return h('header', { class: 'site-head no-print' }, h('div', { class: 'wrap wide' },
    back ? h('a', { href: '/admin', onclick: async (e) => { e.preventDefault(); if (window.__leaveGuard && !(await window.__leaveGuard())) return; window.__leaveGuard = null; navigate('/admin'); } }, '← 大会一覧') : null,
    h('h1', { style: { marginLeft: back ? '8px' : 0 } }, title),
    h('span', { class: 'spacer' }),
    ME ? h('span', { class: 'me-chip', title: `ログインID：${ME.login_id}` }, ME.role === 'super' ? '全体管理者' : ME.region || '地域管理者', h('small', null, ME.id === 'root' ? `ID：${ME.login_id}` : ME.name)) : null,
    isSuperUser() ? h('button', { class: 'btn btn-sm', type: 'button', style: ghost, onclick: () => navigate('/admin/accounts') }, 'アカウント管理') : null,
    ME && !isViewer() ? h('button', { class: 'btn btn-sm', type: 'button', style: ghost, onclick: () => navigate('/admin/scorers') }, 'スコア管理者') : null,
    ME ? h('button', { class: 'btn btn-sm', type: 'button', style: ghost, onclick: openManuals }, 'マニュアル') : null,
    ME && ME.id !== 'root' ? h('button', { class: 'btn btn-sm', type: 'button', style: ghost, onclick: changePassword }, 'パスワード変更') : null,
    h('button', { class: 'btn btn-sm', type: 'button', style: ghost,
      onclick: async () => { await api('POST', '/api/admin/logout'); location.href = '/admin'; } }, 'ログアウト')));
}

function changePassword() {
  const f = { current: '', next: '', again: '' };
  const inp = (k, label, ac) => h('label', { class: 'field' }, h('span', null, label), h('input', { type: 'password', autocomplete: ac, oninput: (e) => { f[k] = e.target.value; } }));
  modal({
    title: 'パスワードを変更',
    content: h('div', { class: 'stack' }, inp('current', '今のパスワード', 'current-password'), inp('next', '新しいパスワード（10文字以上）', 'new-password'), inp('again', '新しいパスワード（確認）', 'new-password'),
      h('p', { class: 'muted small', style: { margin: 0 } }, '変更すると、ほかの端末ではログアウトされます。')),
    actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '変更する', kind: 'btn-primary', onClick: async () => {
      if (f.next !== f.again) { toast('新しいパスワードが一致しません', true); return true; }
      return (await run(() => api('POST', '/api/admin/password', { current: f.current, next: f.next }), 'パスワードを変更しました')) ? undefined : true;
    } }],
  });
}

// ---------- ログイン ----------

function loginView(root, onDone) {
  let last = '';
  try { last = localStorage.getItem('yc:loginId') || ''; } catch { /* 使えない環境では記憶しない */ }
  const id = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', value: last, placeholder: '例: shizuoka' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password' });
  const err = h('p', { class: 'notice error', hidden: true });
  mount(root,
    h('header', { class: 'site-head' }, h('div', { class: 'wrap' }, h('h1', null, '大会運営'))),
    h('form', { class: 'wrap stack', style: { marginTop: '32px', maxWidth: '420px' }, onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/api/admin/login', { login_id: id.value.trim(), password: pw.value });
        try { localStorage.setItem('yc:loginId', id.value.trim()); } catch { /* 無視 */ }
        onDone();
      } catch (ex) { err.hidden = false; err.textContent = ex.message; }
    } },
    h('label', { class: 'field' }, h('span', null, 'ログインID'), id),
    h('label', { class: 'field' }, h('span', null, 'パスワード'), pw), err,
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'ログイン'),
    h('p', { class: 'muted small', style: { margin: 0 } }, 'IDとパスワードは全体管理者から発行されます。わからない場合は全体管理者にお問い合わせください。'),
    h('p', { class: 'manual-row', style: { margin: 0 } }, manualLink('organizer', '大会管理者マニュアル'), manualLink('scorer', 'スコア管理者マニュアル'))));
  (last ? pw : id).focus();
}

// ---------- スコア管理者（全体管理者・地域管理者が発行） ----------

async function scorersView(root, navigate) {
  const [{ scorers }, { tournaments }] = await Promise.all([api('GET', '/api/admin/scorers'), api('GET', '/api/admin/tournaments')]);
  const tName = Object.fromEntries(tournaments.map((t) => [t.id, t.name]));
  const fmt = (iso) => (iso ? formatDate(iso.slice(0, 10)) : '未ログイン');
  const scopeText = (sc) => (sc.scope && sc.scope.length ? sc.scope.map((id) => tName[id] || '（削除された大会）').join('、') : 'すべての大会');
  const reload = () => scorersView(root, navigate);
  const scopePicker = (f) => h('div', null,
    h('div', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, '担当する大会（選ばなければ、すべての大会）'),
    tournaments.length ? h('div', { class: 'scope-list' }, tournaments.map((t) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: f.tournament_ids.includes(t.id), onchange: (e) => { f.tournament_ids = e.target.checked ? [...f.tournament_ids, t.id] : f.tournament_ids.filter((x) => x !== t.id); } }),
      `${t.name}（${t.date ? formatDate(t.date) : '日付未定'}）`))) : h('p', { class: 'muted small' }, '大会がまだありません'));
  const issued = (loginId, pw) => {
    const text = `大会運営アプリのスコア管理者アカウントです。\n結果の承認だけを行えます（スマートフォンで使えます）。\n\nログイン画面：${location.origin}/admin\nログインID：${loginId}\nパスワード：${pw}\n\nログイン後、右上の「パスワード変更」から変更してください。`;
    modal({ title: '発行しました', content: h('div', { class: 'stack' }, h('pre', { class: 'issued' }, text), h('p', { class: 'muted small', style: { margin: 0 } }, 'この画面を閉じるとパスワードは表示できません。')),
      actions: [{ label: '閉じる', kind: 'btn-ghost' }, { label: '案内文をコピー', kind: 'btn-primary', onClick: async () => { await copyText(text); toast('コピーしました'); return true; } }] });
  };
  const edit = (sc) => {
    const f = { login_id: '', name: sc ? sc.name : '', password: sc ? '' : genPassword(), tournament_ids: sc ? [...(sc.scope || [])] : [] };
    const pw = h('input', { type: 'text', value: f.password, oninput: (e) => { f.password = e.target.value; } });
    modal({
      title: sc ? 'スコア管理者を編集' : 'スコア管理者を発行',
      content: h('div', { class: 'stack' },
        sc ? null : h('label', { class: 'field' }, h('span', null, 'ログインID（半角英小文字・数字）'), h('input', { type: 'text', autocapitalize: 'none', placeholder: '例: shizuoka-score1', oninput: (e) => { f.login_id = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, '名前'), h('input', { type: 'text', value: f.name, placeholder: '例: 本部 結果担当 佐藤', oninput: (e) => { f.name = e.target.value; } })),
        sc ? null : h('div', null, h('label', { class: 'field' }, h('span', null, '初期パスワード（10文字以上）'), pw),
          h('button', { class: 'link-btn', type: 'button', onclick: () => { f.password = genPassword(); pw.value = f.password; } }, '別のパスワードを作る')),
        scopePicker(f),
        h('p', { class: 'muted small', style: { margin: 0 } }, 'スコア管理者は、関係者が仮登録した結果の承認・修正・差し戻しと、結果の入力だけを行えます。設定・チーム・日程などは変更できません。')),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: sc ? '保存' : '発行する', kind: 'btn-primary', onClick: async () => {
        const res = sc ? await run(() => api('PATCH', `/api/admin/scorers/${sc.id}`, { name: f.name, tournament_ids: f.tournament_ids }), '保存しました')
          : await run(() => api('POST', '/api/admin/scorers', f));
        if (!res) return true;
        if (!sc) issued(f.login_id.trim().toLowerCase(), f.password);
        reload();
      } }],
    });
  };
  const reset = (sc) => {
    const f = { password: genPassword() };
    const pw = h('input', { type: 'text', value: f.password, oninput: (e) => { f.password = e.target.value; } });
    modal({ title: `${sc.name}のパスワードを再設定`, content: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', null, '新しいパスワード'), pw),
      h('p', { class: 'muted small', style: { margin: 0 } }, '再設定すると、この管理者はすべての端末でログアウトされます。')),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '再設定する', kind: 'btn-primary', onClick: async () => {
        if (!(await run(() => api('PATCH', `/api/admin/scorers/${sc.id}`, { password: f.password })))) return true;
        issued(sc.login_id, f.password);
      } }] });
  };
  mount(root,
    adminHeader('スコア管理者', navigate, true),
    h('main', { class: 'wrap wide', style: { marginTop: '16px' } },
      h('section', { class: 'panel' },
        h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'スコア管理者'), h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => edit(null) }, '＋ スコア管理者を発行')),
        h('p', { class: 'muted small' }, '結果の承認だけを行えるアカウントです。大会当日に本部の結果担当の方へ渡すと、スマートフォンで関係者の仮登録を確認して承認できます。'),
        scorers.length ? h('div', { class: 'acc-list' }, scorers.map((sc) => h('article', { class: `acc-card${sc.active ? '' : ' off'}` },
          h('div', { class: 'acc-head' },
            h('div', null,
              h('div', { class: 'acc-region' }, sc.name, sc.active ? null : h('span', { class: 'tag' }, '停止中')),
              h('div', { class: 'acc-name muted' }, `ID：${sc.login_id}${isSuperUser() ? `　発行：${sc.parent_region || sc.parent_name}` : ''}　最終ログイン：${fmt(sc.last_login_at)}`),
              h('div', { class: 'acc-name' }, `担当：${scopeText(sc)}`)),
            h('div', { class: 'row', style: { gap: '4px' } },
              h('button', { class: 'btn btn-sm', type: 'button', onclick: () => edit(sc) }, '編集'),
              h('button', { class: 'btn btn-sm', type: 'button', onclick: () => reset(sc) }, 'パスワード再設定'),
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
                if (await run(() => api('PATCH', `/api/admin/scorers/${sc.id}`, { active: !sc.active }), sc.active ? '停止しました' : '再開しました')) reload();
              } }, sc.active ? '停止' : '再開'),
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
                if (!(await confirmDialog(`${sc.name}を削除します`, 'このアカウントではログインできなくなります。', '削除する', true))) return;
                if (await run(() => api('DELETE', `/api/admin/scorers/${sc.id}`), '削除しました')) reload();
              } }, '削除')))))) : h('p', { class: 'muted' }, 'まだスコア管理者はいません。'))));
}

// ---------- アカウント管理（全体管理者） ----------

function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint32Array(12));
  return [...r].map((x) => chars[x % chars.length]).join('');
}

async function accountsView(root, navigate) {
  const r = await api('GET', '/api/admin/users');
  const fmt = (iso) => (iso ? formatDate(iso.slice(0, 10)) : '—');
  const stat = (label, v, strong) => h('div', { class: 'acc-stat' }, h('span', null, label), h(strong ? 'strong' : 'b', null, v));
  const totalYear = r.users.reduce((a, u) => a + u.this_year, 0) + (r.root.this_year || 0);
  const card = (u, isRoot) => h('article', { class: `acc-card${u.active === 0 ? ' off' : ''}` },
    h('div', { class: 'acc-head' },
      h('div', null,
        h('div', { class: 'acc-region' }, isRoot ? '全体管理者' : u.region || '（地域未設定）', u.role === 'super' && !isRoot ? h('span', { class: 'tag done' }, '全体管理者') : null, u.active === 0 ? h('span', { class: 'tag' }, '停止中') : null),
        h('div', { class: 'acc-name' }, `${u.name}　`, h('span', { class: 'muted small' }, `ID：${isRoot ? (ME.login_id || 'admin') : u.login_id}`))),
      isRoot ? null : h('div', { class: 'row', style: { gap: '4px' } },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editUser(u) }, '編集'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => resetPassword(u) }, 'パスワード再設定'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
          const stop = u.active !== 0;
          if (stop && !(await confirmDialog(`${u.name}を停止します`, 'ログインできなくなり、ログイン中の端末もすぐにログアウトされます。大会のデータはそのまま残り、閲覧ページも引き続き見られます。', '停止する', true))) return;
          if (await run(() => api('PATCH', `/api/admin/users/${u.id}`, { active: !stop }), stop ? '停止しました' : '再開しました')) accountsView(root, navigate);
        } }, u.active === 0 ? '再開' : '停止'))),
    h('div', { class: 'acc-stats' },
      stat(`${r.year}年の開催`, `${u.this_year}回`, true), stat('累計', `${u.total}回`), stat('公開・開催中', `${u.active_now}件`), stat('終了', `${u.finished}件`),
      stat('最終開催日', fmt(u.last_date)), stat('登録チーム', `${u.teams}`), isRoot ? null : stat('最終ログイン', u.last_login_at ? fmt(u.last_login_at) : '未ログイン')));

  const viewerCard = (u) => h('article', { class: `acc-card${u.active ? '' : ' off'}` },
    h('div', { class: 'acc-head' },
      h('div', null,
        h('div', { class: 'acc-region' }, u.name, h('span', { class: 'tag' }, '閲覧専用'), u.active === 0 ? h('span', { class: 'tag' }, '停止中') : null),
        h('div', { class: 'acc-name muted' }, `ID：${u.login_id}${u.region ? `　所属：${u.region}` : ''}　最終ログイン：${u.last_login_at ? fmt(u.last_login_at) : '未ログイン'}`)),
      h('div', { class: 'row', style: { gap: '4px' } },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editUser(u) }, '編集'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => resetPassword(u) }, 'パスワード再設定'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
          if (await run(() => api('PATCH', `/api/admin/users/${u.id}`, { active: !u.active }), u.active ? '停止しました' : '再開しました')) accountsView(root, navigate);
        } }, u.active ? '停止' : '再開'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
          if (!(await confirmDialog(`${u.name}を削除します`, 'このアカウントではログインできなくなります。', '削除する', true))) return;
          if (await run(() => api('DELETE', `/api/admin/users/${u.id}`), '削除しました')) accountsView(root, navigate);
        } }, '削除'))));

  const editUser = (u, presetRole) => {
    const f = { login_id: u ? u.login_id : '', name: u ? u.name : '', region: u ? u.region || '' : '', role: u ? u.role : presetRole || 'region', password: u ? '' : genPassword() };
    const pwInput = h('input', { type: 'text', value: f.password, oninput: (e) => { f.password = e.target.value; } });
    modal({
      title: u ? '管理者を編集' : f.role === 'viewer' ? '閲覧専用アカウントを発行' : '地域管理者を発行',
      content: h('div', { class: 'stack' },
        u ? null : h('label', { class: 'field' }, h('span', null, 'ログインID（半角英小文字・数字）'), h('input', { type: 'text', autocapitalize: 'none', placeholder: '例: shizuoka', oninput: (e) => { f.login_id = e.target.value; } })),
        h('div', { class: 'grid-form' },
          h('label', { class: 'field' }, h('span', null, f.role === 'viewer' ? '所属（任意）' : '地域名'), h('input', { type: 'text', value: f.region, placeholder: f.role === 'viewer' ? '例: 協会事務局' : '例: 静岡', oninput: (e) => { f.region = e.target.value; } })),
          h('label', { class: 'field' }, h('span', null, '担当者名'), h('input', { type: 'text', value: f.name, placeholder: '例: 山田 太郎', oninput: (e) => { f.name = e.target.value; } }))),
        h('label', { class: 'field' }, h('span', null, '権限'), h('select', { onchange: (e) => { f.role = e.target.value; } },
          h('option', { value: 'region', selected: f.role === 'region' }, '地域管理者（自分の大会だけ）'),
          h('option', { value: 'super', selected: f.role === 'super' }, '全体管理者（すべての大会とアカウント管理）'),
          h('option', { value: 'viewer', selected: f.role === 'viewer' }, '閲覧専用（すべての大会の設定を確認するだけ・変更はできない）'))),
        u ? null : h('div', null,
          h('label', { class: 'field' }, h('span', null, '初期パスワード（10文字以上）'), pwInput),
          h('button', { class: 'link-btn', type: 'button', onclick: () => { f.password = genPassword(); pwInput.value = f.password; } }, '別のパスワードを作る'),
          h('p', { class: 'muted small', style: { margin: '4px 0 0' } }, '発行後はパスワードを確認できません。このIDとパスワードを担当者にお伝えください（ログイン後に本人が変更できます）。'))),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: u ? '保存' : '発行する', kind: 'btn-primary', onClick: async () => {
        const res = u ? await run(() => api('PATCH', `/api/admin/users/${u.id}`, { name: f.name, region: f.region, role: f.role }), '保存しました')
          : await run(() => api('POST', '/api/admin/users', f));
        if (!res) return true;
        if (!u) showIssued(f);
        accountsView(root, navigate);
      } }],
    });
  };
  const showIssued = (f) => {
    const text = `大会運営アプリの管理者アカウントを発行しました。\n\nログイン画面：${location.origin}/admin\nログインID：${f.login_id.trim().toLowerCase()}\nパスワード：${f.password}\n\nログイン後、右上の「パスワード変更」から変更してください。`;
    modal({ title: '発行しました', content: h('div', { class: 'stack' }, h('pre', { class: 'issued' }, text), h('p', { class: 'muted small', style: { margin: 0 } }, 'この画面を閉じるとパスワードは表示できません。')),
      actions: [{ label: '閉じる', kind: 'btn-ghost' }, { label: '案内文をコピー', kind: 'btn-primary', onClick: async () => { await copyText(text); toast('コピーしました'); return true; } }] });
  };
  const resetPassword = (u) => {
    const f = { password: genPassword() };
    const pwInput = h('input', { type: 'text', value: f.password, oninput: (e) => { f.password = e.target.value; } });
    modal({
      title: `${u.name}のパスワードを再設定`,
      content: h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', null, '新しいパスワード'), pwInput),
        h('p', { class: 'muted small', style: { margin: 0 } }, '再設定すると、この管理者はすべての端末でログアウトされます。')),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '再設定する', kind: 'btn-primary', onClick: async () => {
        if (!(await run(() => api('PATCH', `/api/admin/users/${u.id}`, { password: f.password })))) return true;
        showIssued({ login_id: u.login_id, password: f.password });
      } }],
    });
  };

  mount(root,
    adminHeader('アカウント管理', navigate, true),
    h('main', { class: 'wrap wide' },
      h('section', { class: 'acc-summary' },
        h('div', null, h('span', null, '地域管理者'), h('strong', null, `${r.users.filter((u) => u.role === 'region').length}`)),
        h('div', null, h('span', null, `${r.year}年の開催（全体）`), h('strong', null, `${totalYear}回`)),
        h('div', null, h('span', null, '停止中'), h('strong', null, `${r.users.filter((u) => !u.active).length}`))),
      h('div', { class: 'row', style: { margin: '16px 0 8px' } }, h('h2', { class: 'group-title', style: { margin: 0 } }, '管理者と利用状況'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => editUser(null) }, '＋ 地域管理者を発行')),
      h('div', { class: 'acc-list' }, card(r.root, true), r.users.filter((u) => u.role !== 'viewer').map((u) => card(u, false))),
      r.users.some((u) => u.role !== 'viewer') ? null : h('p', { class: 'muted' }, 'まだ地域管理者はいません。「＋ 地域管理者を発行」から作成してください。'),
      // 閲覧専用アカウント：すべての大会の設定・日程・結果などを確認できるが、変更はできない
      h('div', { class: 'row', style: { margin: '24px 0 8px' } }, h('h2', { class: 'group-title', style: { margin: 0 } }, '閲覧専用アカウント'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editUser(null, 'viewer') }, '＋ 閲覧専用アカウントを発行')),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, 'すべての大会の設定・チーム・日程・結果・要項を、管理画面と同じ画面で確認できます（PDF・Excelの出力も可）。変更や、アカウント情報の表示はできません。'),
      r.users.some((u) => u.role === 'viewer') ? h('div', { class: 'acc-list' }, r.users.filter((u) => u.role === 'viewer').map((u) => viewerCard(u)))
        : h('p', { class: 'muted' }, 'まだ閲覧専用アカウントはありません。')));
}

// ---------- 大会一覧 ----------

let listFilter = 'all';
async function listView(root, navigate) {
  const all = (await api('GET', '/api/admin/tournaments')).tournaments;
  const ownerKey = (t) => t.owner_id || 'root';
  const ownerLabel = (t) => (t.owner_id ? t.owner_region || t.owner_name || '地域管理者' : '全体管理者');
  const owners = [...new Map(all.map((t) => [ownerKey(t), ownerLabel(t)])).entries()];
  if (!owners.some(([k]) => k === listFilter)) listFilter = 'all';
  const tournaments = listFilter === 'all' ? all : all.filter((t) => ownerKey(t) === listFilter);

  const createDialog = () => {
    const name = h('input', { type: 'text', placeholder: '例: 第5回 さくらカップ' });
    const date = h('input', { type: 'date', value: todayStr() });
    const end = h('input', { type: 'date', value: todayStr() });
    date.addEventListener('change', () => { if (!end.value || end.value < date.value) end.value = date.value; });
    const venue = h('input', { type: 'text', placeholder: '例: 市民グラウンド' });
    modal({
      title: '大会を作成',
      content: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', null, '大会名'), name),
        h('div', { class: 'grid-form' },
          h('label', { class: 'field' }, h('span', null, '開始日'), date),
          h('label', { class: 'field' }, h('span', null, '終了日（最大4日間）'), end)),
        h('label', { class: 'field' }, h('span', null, '会場'), venue)),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '作成してカテゴリを追加', kind: 'btn-primary', onClick: async () => {
        const r = await run(() => api('POST', '/api/admin/tournaments', { name: name.value, date: date.value, end_date: end.value, venue: venue.value }));
        if (!r) return true;
        navigate(`/admin/t/${r.id}?add=1`);
      } }],
    });
  };

  // カテゴリを開いたとき、いま必要な作業のタブを選んでおく
  const openCategory = (t, c) => {
    store.set(`a:${t.id}:cat`, c.id);
    store.set(`a:${t.id}:sub`, !c.team_count ? 'teams' : !c.match_count ? 'schedule' : 'results');
    navigate(`/admin/t/${t.id}`);
  };

  const catCard = (t, c) => {
    const pct = c.match_count ? Math.round((c.done_count / c.match_count) * 100) : 0;
    const step = !c.team_count ? 'チームを登録しましょう' : !c.match_count ? '組み分けと日程を作りましょう' : c.done_count === c.match_count ? 'すべての試合が確定' : `確定 ${c.done_count} / ${c.match_count} 試合`;
    return h('button', { class: 'cat-card', type: 'button', onclick: () => openCategory(t, c) },
      h('div', { class: 'cat-top' }, h('strong', null, c.name),
        c.pending_count ? h('span', { class: 'tag alert' }, `仮登録 ${c.pending_count}`) : null),
      h('div', { class: 'cat-meta' }, `${c.team_count}チーム`, h('span', null, FORMAT_LABEL[c.format] || '')),
      c.match_count ? h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: { width: `${pct}%` } })) : null,
      h('div', { class: `cat-step${!c.team_count || !c.match_count ? ' todo' : ''}` }, step));
  };

  const tCard = (t) => h('article', { class: 't-card' },
    h('a', { class: 't-head', href: `/admin/t/${t.id}`, onclick: (e) => { e.preventDefault(); navigate(`/admin/t/${t.id}`); } },
      t.logo ? h('img', { class: 't-logo', src: t.logo, alt: '' }) : h('span', { class: 't-logo ph' }, icon('ball')),
      h('div', { class: 't-title' },
        h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: `tag ${t.status === 'live' ? 'live' : t.status === 'published' ? 'done' : ''}` }, STATUS[t.status].label),
          isSuperUser() || isViewer() ? h('span', { class: 'tag owner' }, ownerLabel(t)) : null,
          t.shared ? h('span', { class: 'tag shared' }, '共有（閲覧・コピーのみ）') : null,
          isSuperUser() && t.shared_with ? h('span', { class: 'tag shared' }, t.shared_with === 'all' ? '地域管理者に共有中（全員）' : `地域管理者に共有中（${t.shared_with.length}人）`) : null),
        h('h2', null, t.name),
        h('div', { class: 't-meta' },
          t.date ? h('span', null, icon('calendar'), periodText(t)) : null,
          t.venue ? h('span', null, icon('pin'), t.venue) : null)),
      icon('chevron', 't-go')),
    h('div', { class: 'cat-grid' },
      t.categories.map((c) => catCard(t, c)),
      t.shared || isViewer() ? null : h('button', { class: 'cat-card cat-add', type: 'button', onclick: () => navigate(`/admin/t/${t.id}?add=1`) }, '＋ カテゴリを追加')),
    isViewer() ? null : h('div', { class: 't-actions' },
      h('button', { class: 'link-btn', type: 'button', onclick: () => openCopyDialog(t, navigate) }, icon('list'), 'この大会をコピー')));

  // 地域管理者：全体管理者から共有された大会は、自分の大会とは分けて表示する
  const sharedList = tournaments.filter((t) => t.shared);
  const own = tournaments.filter((t) => !t.shared);
  const live = own.filter((t) => t.status !== 'finished');
  const done = own.filter((t) => t.status === 'finished');
  mount(root,
    adminHeader('大会運営', navigate, false),
    h('main', { class: 'wrap wide', style: { marginTop: '20px' } },
      h('div', { class: 'row' }, h('h2', { style: { fontSize: '1.3rem' } }, isSuperUser() || isViewer() ? '大会一覧（すべての地域）' : '大会一覧'), h('span', { class: 'spacer' }),
        isViewer() ? h('span', { class: 'tag' }, '👁 閲覧専用') : h('button', { class: 'btn btn-primary', type: 'button', onclick: createDialog }, '＋ 大会を作成')),
      (isSuperUser() || isViewer()) && owners.length > 1 ? h('div', { class: 'chips', style: { marginTop: '8px' } },
        [['all', `すべて（${all.length}）`], ...owners.map(([k, l]) => [k, `${l}（${all.filter((t) => ownerKey(t) === k).length}）`])].map(([k, l]) =>
          h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(listFilter === k), onclick: () => { listFilter = k; listView(root, navigate); } }, l))) : null,
      own.length ? null : h('div', { class: 'panel empty', style: { marginTop: '16px' } },
        h('p', { style: { marginTop: 0 } }, '大会はまだありません。'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: createDialog }, '最初の大会を作成')),
      live.length ? h('div', { class: 't-grid' }, live.map(tCard)) : null,
      done.length ? h('section', null, h('h3', { class: 'group-title' }, '終了した大会'), h('div', { class: 't-grid' }, done.map(tCard))) : null,
      sharedList.length ? h('section', null, h('h3', { class: 'group-title' }, '全体管理者から共有された大会'),
        h('p', { class: 'muted small', style: { margin: '-4px 0 10px' } }, '閲覧と、コピーして自分の大会を作ることができます（編集はできません）。'),
        h('div', { class: 't-grid' }, sharedList.map(tCard))) : null));
}

// ---------- 大会画面 ----------

async function tournamentView(root, id, navigate) {
  let data = null;
  let templates = null;
  const st = {
    catId: store.get(`a:${id}:cat`),
    sub: store.get(`a:${id}:sub`, 'settings'),
    moveSel: null,
    drafts: {}, // カテゴリID → {assignment, order, warnings}
    preview: {}, // カテゴリID → {matches, warnings}
    resultFilter: 'pending',
    unlocked: false, // 公開中のロックを一時解除しているか（この画面を開いている間だけ）
  };
  // ロックを一時解除している間は、設定・チーム・日程の変更に ?unlock=1 を付ける
  // eslint-disable-next-line no-shadow
  const api = (method, path, body) => apiBase(method,
    st.unlocked && method !== 'GET' && /^\/api\/admin\/(categories|teams|tournaments\/[^/]+\/categories)/.test(path) ? `${path}${path.includes('?') ? '&' : '?'}unlock=1` : path, body);
  // 変更できない表示：閲覧専用アカウント、または全体管理者から共有された大会（閲覧とコピーだけ）
  const ro = () => isViewer() || !!(data && data.tournament.readonly);
  const isLocked = () => ro() || (data && data.tournament.status !== 'draft' && !st.unlocked);
  // 閲覧専用アカウントでは、中の入力欄・ボタンをまとめて無効に（見やすさのため薄くはしない）
  const readOnly = (el) => (ro() ? h('fieldset', { class: 'lockable ro', disabled: true }, el) : el);

  async function load() {
    const res = await api('GET', `/api/admin/tournaments/${id}${data ? `?rev=${data.tournament.rev}` : ''}`);
    markFetched();
    if (res.unchanged) return false;
    data = res;
    if (!data.categories.find((c) => c.id === st.catId)) st.catId = data.categories[0]?.id || null;
    return true;
  }
  const reload = async () => { data = null; await load(); render(); };

  try { await load(); } catch (e) {
    if (e instanceof ApiError && e.status === 401) return loginView(root, () => tournamentView(root, id, navigate));
    return mount(root, adminHeader('大会運営', navigate, true), h('p', { class: 'empty' }, e.message));
  }
  render();
  if (new URLSearchParams(location.search).get('add')) {
    history.replaceState(null, '', location.pathname);
    addCategory();
  }

  // 自動更新はしない（「更新」ボタンで読み込む）。5分以上たって画面に戻ってきたときだけ、入力中でなければ1回確認する
  function canRefresh() {
    const a = document.activeElement;
    return !(document.querySelector('.modal-back') || st.moveSel || st.dirty || settingsDirty() || (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)));
  }
  // 自動更新はしない。最新の情報（関係者の仮登録など）は「更新」ボタン（取得した時刻つき）で読み込む
  // 画面を描く処理から使うので、定義の順番に左右されない関数宣言にする
  async function refreshNow() {
    if (!canRefresh()) throw new Error('入力中の内容があるため更新できません。保存するか、入力を終えてから押してください');
    const changed = await load();
    if (changed) render();
    return changed;
  }

  function render() {
    const t = data.tournament;
    document.title = `${t.name} | 大会運営`;
    const cat = data.categories.find((c) => c.id === st.catId);
    const editable = (t.status === 'draft' || t.status === 'published') && !isLocked();
    mount(root,
      adminHeader(t.name, navigate, true),
      h('main', { class: 'wrap wide', style: { marginTop: '16px' } },
        h('div', { class: 'admin-layout split' },
          h('aside', { class: 'no-print' }, statusPanel(t), sharePanel(t), isSuperUser() ? regionSharePanel(t) : null, readOnly(infoPanel(t)), outlinePanel(t), readOnly(lostPanel()), readOnly(parkingPanel(t)), readOnly(sponsorPanel())),
          h('div', null,
            h('div', { class: 'row no-print' },
              h('div', { class: 'chips', style: { flex: 1 } },
                data.categories.map((c, i) => h('button', { class: 'chip-btn cat-chip', type: 'button', 'aria-pressed': String(c.id === st.catId), style: `--cat:${catColor(i)}`,
                  onclick: () => switchCategory(c) }, h('i', { class: 'cat-dot' }), c.name, h('small', null, `${c.teams.length}チーム`)))),
              h('button', { class: 'btn btn-sm', type: 'button', disabled: isLocked(), onclick: addCategory }, '＋ カテゴリを追加')),
            lockBanner(t),
            cat ? categoryView(t, cat, editable) : h('div', { class: 'panel empty', style: { marginTop: '12px' } }, 'カテゴリ（U7〜U12）を追加すると、チーム登録と日程作成ができます。')))));
  }

  // ----- 地域管理者への共有（全体管理者のみ） -----

  function regionSharePanel(t) {
    const box = h('section', { class: 'panel' });
    const cur = t.shared_with;
    const f = { mode: cur === 'all' ? 'all' : Array.isArray(cur) && cur.length ? 'some' : 'none', ids: Array.isArray(cur) ? [...cur] : [] };
    let users = null;
    const draw = () => mount(box,
      h('h2', null, '地域管理者への共有'),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, '共有した地域管理者は、この大会を閲覧し、コピーして自分の大会を作れます（編集はできません）。'),
      [['none', '共有しない'], ['all', 'すべての地域管理者'], ['some', '地域管理者を選ぶ']].map(([k, l]) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'region-share', checked: f.mode === k, onchange: async () => {
          f.mode = k;
          if (k === 'some' && !users) users = (await run(() => api('GET', '/api/admin/users')) || { users: [] }).users.filter((u) => u.role === 'region');
          draw();
        } }), l)),
      f.mode === 'some' ? h('div', { class: 'scope-list' }, users === null ? h('span', { class: 'muted small' }, '読み込み中…')
        : users.length ? users.map((u) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: f.ids.includes(u.id), onchange: (e) => { f.ids = e.target.checked ? [...f.ids, u.id] : f.ids.filter((x) => x !== u.id); } }),
          `${u.region || '（地域未設定）'}　${u.name}`)) : h('span', { class: 'muted small' }, '地域管理者がいません')) : null,
      h('button', { class: 'btn btn-sm btn-block', type: 'button', style: { marginTop: '8px' }, onclick: async () => {
        const v = f.mode === 'all' ? 'all' : f.mode === 'some' ? f.ids : null;
        if (f.mode === 'some' && !f.ids.length) { toast('共有する地域管理者を選んでください', true); return; }
        if (await run(() => api('PATCH', `/api/admin/tournaments/${id}`, { shared_with: v }), v ? '共有しました' : '共有をやめました')) await reload();
      } }, '共有の設定を保存'));
    if (f.mode === 'some') run(() => api('GET', '/api/admin/users')).then((r) => { users = ((r || {}).users || []).filter((u) => u.role === 'region'); draw(); });
    draw();
    return box;
  }

  // ----- 公開中のロック -----

  function lockBanner(t) {
    if (data && data.tournament.readonly) {
      return h('div', { class: 'lock-banner viewer no-print' },
        h('span', null, '👁 全体管理者から共有された大会です。設定・チーム・日程・結果などの閲覧と、PDF・Excelの出力ができます（編集はできません）。この大会をもとに自分の大会を作るときは、コピーしてください。'),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => openCopyDialog(t, navigate) }, 'コピーして自分の大会を作る'));
    }
    if (isViewer()) {
      return h('div', { class: 'lock-banner viewer no-print' },
        h('span', null, '👁 閲覧専用のアカウントです。設定・チーム・日程・結果などの確認と、PDF・Excelの出力ができます（変更はできません）。'));
    }
    if (t.status === 'draft') return null;
    const STATE = { published: '公開中', live: '開催中', finished: '終了' };
    if (st.unlocked) {
      return h('div', { class: 'lock-banner open no-print' },
        h('span', null, '🔓 ロックを一時解除しています。設定・チーム・日程を変更できます（この画面を閉じるか、再読み込みすると元に戻ります）。'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { st.unlocked = false; render(); toast('ロックに戻しました'); } }, 'ロックに戻す'));
    }
    return h('div', { class: 'lock-banner no-print' },
      h('span', null, `🔒 ${STATE[t.status]}のため、カテゴリの設定・チームの追加と削除・組み分け・日程はロックされています（誤操作防止）。結果の登録・時間調整・チーム名の修正はこのまま行えます。`),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
        const ok = await confirmDialog('ロックを一時解除します', `${STATE[t.status]}の大会です。設定や日程を変えると、閲覧ページの内容もすぐに変わります。保護者に案内済みの日程を変える場合は、あわせてお知らせしてください。${t.status !== 'published' ? '（開催中・終了の大会では、解除しても日程の作り直しはできません）' : ''}`, 'ロックを解除する', true);
        if (!ok) return;
        st.unlocked = true; render();
      } }, 'ロックを一時解除'));
  }

  // ----- カテゴリの切り替え（保存していない設定があれば確認） -----

  // 設定画面の内容が、開いた時点（または最後に保存した時点）から変わっているか
  const settingsDirty = () => !!(st.sub === 'settings' && st.form && st.form.base != null && st.form.snap() !== st.form.base);

  async function leaveSettings() {
    if (settingsDirty()) st.dirty = st.form.catId;
    if (!st.dirty) return true;
    const c = data.categories.find((x) => x.id === st.dirty);
    const ok = await confirmDialog(`${c ? c.name : 'カテゴリ'}の設定が保存されていません`, '切り替えると、入力した内容は失われます。保存する場合は「キャンセル」を押して、「設定を保存」を押してください。', '保存せずに切り替える', true);
    if (ok) { st.dirty = null; st.form = null; }
    return ok;
  }

  // ほかの画面に移るとき・ブラウザを閉じるときも、未保存の設定があれば確認する
  window.__leaveGuard = leaveSettings;
  window.onbeforeunload = () => (settingsDirty() || st.dirty ? true : undefined);

  async function switchCategory(c) {
    if (c.id === st.catId) return;
    if (!(await leaveSettings())) return;
    st.catId = c.id; store.set(`a:${id}:cat`, c.id); st.moveSel = null;
    render();
    toast(`${c.name} に切り替えました`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ----- 左側: 状態・共有・大会情報 -----

  function statusPanel(t) {
    const order = ['draft', 'published', 'live', 'finished'];
    const set = async (s) => {
      if (s === t.status) return;
      const back = order.indexOf(s) < order.indexOf(t.status);
      if (s === 'live' && !(await confirmDialog('大会を開催中にします', '組み合わせと日程が固定されます。以降はコートごとの時間調整と結果の確定ができます。', '開催中にする'))) return;
      if (back && (t.status === 'live' || t.status === 'finished') && !(await confirmDialog(`「${STATUS[s].label}」に戻します`, '組み合わせを編集できるようになります。日程を作り直すと、登録済みの結果は消えます。', '戻す', true))) return;
      if (await run(() => api('PATCH', `/api/admin/tournaments/${id}`, { status: s }), `「${STATUS[s].label}」にしました`)) await reload();
    };
    return h('section', { class: 'panel' },
      h('h2', { style: { marginBottom: '8px' } }, '大会の状態'),
      h('div', { class: 'chips', style: { flexWrap: 'wrap', paddingTop: 0 } }, order.map((s) =>
        h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(s === t.status), disabled: ro() && s !== t.status, onclick: () => set(s) }, STATUS[s].label))),
      h('p', { class: 'muted small', style: { margin: '6px 0 0' } }, STATUS[t.status].note));
  }

  function sharePanel(t) {
    const viewUrl = `${location.origin}/t/${t.slug}`;
    const relUrl = `${location.origin}/r/${t.slug}`;
    const lineText = `【${t.name}】\n結果の登録ページ\n${relUrl}\nPIN：${t.pin}\n\n試合結果（閲覧用）\n${viewUrl}`;
    return h('section', { class: 'panel' },
      h('h2', { style: { marginBottom: '8px' } }, '共有'),
      h('div', { class: 'stack small' },
        h('div', null, h('strong', null, '閲覧ページ（保護者向け）'),
          t.status === 'draft' ? h('p', { class: 'muted', style: { margin: 0 } }, '「公開中」にすると見られるようになります') : null,
          h('div', { class: 'row' }, h('a', { href: viewUrl, target: '_blank', rel: 'noopener', style: { overflowWrap: 'anywhere' } }, viewUrl),
            h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(viewUrl) }, 'コピー'))),
        // 共有された大会では、保護者向けの閲覧ページだけ（結果の登録ページ・PINは主催者だけのもの）
        t.readonly ? null : h('div', null, h('strong', null, '結果の登録ページ（チーム関係者向け）'),
          h('div', { class: 'row' }, h('span', { style: { overflowWrap: 'anywhere' } }, relUrl), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(relUrl) }, 'コピー'))),
        t.readonly ? null : h('div', { class: 'row' }, h('strong', null, 'PIN'), h('span', { class: 'num', style: { fontSize: '1.8rem', fontWeight: 700, letterSpacing: '0.15em' } }, t.pin),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm', type: 'button', disabled: ro(), onclick: async () => {
            if (!(await confirmDialog('PINを再発行します', '今のPINでログインしている関係者は、新しいPINで入り直す必要があります。', '再発行する', true))) return;
            if (await run(() => api('POST', `/api/admin/tournaments/${id}/pin`), 'PINを再発行しました')) await reload();
          } }, '再発行')),
        t.readonly ? null : h('button', { class: 'btn btn-block', type: 'button', onclick: () => copyText(lineText) }, 'LINE用の案内文をコピー')));
  }

  function infoPanel(t) {
    const f = { name: t.name, date: t.date || '', end_date: t.end_date || t.date || '', venue: t.venue || '', logo: t.logo, show_logo: !!t.show_logo };
    const preview = h('div');
    const drawLogo = () => mount(preview, f.logo ? h('div', { class: 'row' }, h('img', { src: f.logo, alt: '大会ロゴ', width: 56, height: 56, style: { objectFit: 'contain', background: '#fff', borderRadius: '50%' } }),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { f.logo = null; drawLogo(); } }, 'ロゴを外す')) : h('span', { class: 'muted small' }, 'ロゴは未設定です'));
    drawLogo();
    return h('details', { class: 'panel' },
      h('summary', { style: { cursor: 'pointer', fontWeight: 700 } }, '大会情報を編集'),
      h('div', { class: 'stack', style: { marginTop: '12px' } },
        h('label', { class: 'field' }, h('span', null, '大会名'), h('input', { type: 'text', value: f.name, oninput: (e) => { f.name = e.target.value; } })),
        h('div', { class: 'grid-form' },
          h('label', { class: 'field' }, h('span', null, '開始日'), h('input', { type: 'date', value: f.date, oninput: (e) => { f.date = e.target.value; } })),
          h('label', { class: 'field' }, h('span', null, '終了日'), h('input', { type: 'date', value: f.end_date, oninput: (e) => { f.end_date = e.target.value; } }))),
        h('p', { class: 'muted small', style: { margin: 0 } }, '最大4日間です。期間を変えると、各カテゴリの開催日も合わせて調整されます。'),
        h('label', { class: 'field' }, h('span', null, '会場'), h('input', { type: 'text', value: f.venue, oninput: (e) => { f.venue = e.target.value; } })),
        h('div', null, h('span', { class: 'small', style: { fontWeight: 700 } }, '大会ロゴ'), preview,
          h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', 'aria-label': '大会ロゴの画像', onchange: async (e) => {
            const v = await run(() => resizeImage(e.target.files[0], 320));
            if (v) { f.logo = v; drawLogo(); }
          } })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.show_logo, onchange: (e) => { f.show_logo = e.target.checked; } }), 'ロゴを表示する（大会・チームとも）'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          if (await run(() => api('PATCH', `/api/admin/tournaments/${id}`, f), '保存しました')) await reload();
        } }, '大会情報を保存'),
        h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async () => {
          if (!(await confirmDialog('大会を削除します', `「${t.name}」のチーム・日程・結果がすべて消えます。元に戻せません。`, '削除する', true))) return;
          if (await run(() => api('DELETE', `/api/admin/tournaments/${id}`), '削除しました')) navigate('/admin');
        } }, 'この大会を削除')));
  }

  // ----- 日程の削除 -----

  async function deleteSchedule(cat) {
    const results = cat.matches.filter((m) => m.status !== 'none').length;
    const ok = await confirmDialog(`${cat.name}の日程を削除します`,
      `${cat.matches.length}試合の日程を削除します。チームと組み分けは残るので、「組み分け・日程」から日程を作り直せます。${results ? `　※結果が入っている試合が${results}試合あります。結果も削除され、元に戻せません。` : ''}`,
      '日程を削除する', true);
    if (!ok) return;
    if (await run(() => api('DELETE', `/api/admin/categories/${cat.id}/schedule${results ? '?force=1' : ''}`), '日程を削除しました')) await reload();
  }

  // ----- 大会要項・大会のコピー -----

  function outlinePanel(t) {
    const settings = t.settings || {};
    const outline = settings.outline || defaultOutline(t);
    return h('section', { class: 'panel' },
      h('h2', { style: { marginBottom: '6px' } }, '大会要項'),
      h('p', { class: 'muted small', style: { marginTop: 0 } }, settings.outline ? `見出し${(settings.outline.sections || []).length}件を登録済み` : 'まだ作成していません（サンプルの項目から始められます）'),
      h('div', { class: 'stack' },
        h('button', { class: 'btn btn-block', type: 'button', onclick: () => openOutlineEditor({ t, categories: data.categories, outline, target: { kind: 'tournament', id },
          onSave: async (o) => { const r = await run(() => api('PATCH', `/api/admin/tournaments/${id}`, { settings: { outline: o } })); if (r) await reload(); return !!r; } }) }, '要項を作成・編集'),
        h('button', { class: 'btn btn-block', type: 'button', onclick: () => openOutlineDialog(data.tournament, data.categories, outline) }, '要項をPDFで出力'),
        h('button', { class: 'btn btn-block btn-ghost', type: 'button', onclick: () => openPresetList({ t, categories: data.categories, onApply: () => reload() }) }, '要項のプリセットを管理'),
        isViewer() ? null : h('button', { class: 'btn btn-block btn-ghost', type: 'button', onclick: () => openCopyDialog(t, navigate) }, 'この大会をコピーして新しい大会を作る')));
  }

  // ----- 忘れ物 -----

  function lostPanel() {
    const list = data.lost || [];
    const open = list.filter((x) => x.status === 'open').length;
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, '忘れ物'), open ? h('span', { class: 'tag alert' }, `告知中 ${open}`) : null, h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editLost(null) }, '＋ 登録')),
      list.length ? h('div', { class: 'lost-admin' }, list.map((it) => h('div', { class: `lost-a${it.status === 'open' ? '' : ' done'}` },
        it.img ? h('img', { src: it.img, alt: '' }) : h('div', { class: 'lost-noimg' }, icon('bag')),
        h('div', { class: 'lost-a-body' },
          h('div', { class: 'lost-a-note' }, it.note),
          h('div', { class: 'row', style: { gap: '4px' } },
            h('span', { class: `tag ${it.status === 'open' ? 'alert' : 'done'}` }, it.status === 'open' ? '告知中' : '返却済み'),
            h('span', { class: 'spacer' }),
            h('button', { class: 'link-btn', type: 'button', onclick: async () => {
              if (await run(() => api('PATCH', `/api/admin/lost/${it.id}`, { status: it.status === 'open' ? 'returned' : 'open' }), it.status === 'open' ? '返却済みにしました' : '告知に戻しました')) await reload();
            } }, it.status === 'open' ? '返却済みにする' : '告知に戻す'),
            h('button', { class: 'link-btn', type: 'button', onclick: () => editLost(it) }, '編集')))))) :
        h('p', { class: 'muted small', style: { margin: 0 } }, '登録すると、閲覧ページに忘れ物のお知らせが表示されます。'));
  }

  function editLost(it) {
    const f = { note: it ? it.note : '', image: undefined };
    const prev = h('div', { class: 'sp-preview' });
    const drawPrev = () => mount(prev, f.image ? h('img', { src: f.image, alt: '' }) : it && it.img && f.image !== null ? h('img', { src: it.img, alt: '' }) : h('span', { class: 'muted small' }, '写真は任意です'));
    drawPrev();
    modal({
      title: it ? '忘れ物を編集' : '忘れ物を登録',
      content: h('div', { class: 'stack' },
        h('div', null, h('span', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, '写真'), prev,
          h('div', { class: 'row' },
            h('input', { type: 'file', accept: 'image/*', 'aria-label': '忘れ物の写真', onchange: async (e) => { const v = await run(() => resizeBanner(e.target.files[0], 1200, 1200)); if (v) { f.image = v; drawPrev(); } } }),
            it && it.img ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { f.image = null; drawPrev(); } }, '写真を外す') : null)),
        h('label', { class: 'field' }, h('span', null, '申し送り事項'), (() => { const a = h('textarea', { rows: 4, placeholder: '例：Bコート横のベンチに黒いすね当て（片方）。本部でお預かりしています。', oninput: (e) => { f.note = e.target.value; } }); a.value = f.note; return a; })()),
        it ? h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async () => {
          if (!(await confirmDialog('この忘れ物を削除します', '閲覧ページからも消えます。', '削除する', true))) return;
          document.querySelector('.modal-back')?.remove();
          if (await run(() => api('DELETE', `/api/admin/lost/${it.id}`), '削除しました')) await reload();
        } }, 'この忘れ物を削除') : null),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: it ? '保存' : '登録して告知', kind: 'btn-primary', onClick: async () => {
        const body = { note: f.note };
        if (f.image !== undefined) body.image = f.image;
        const r = it ? await run(() => api('PATCH', `/api/admin/lost/${it.id}`, body), '保存しました')
          : await run(() => api('POST', `/api/admin/tournaments/${id}/lost`, body), '登録しました。閲覧ページに表示されます');
        if (!r) return true;
        await reload();
      } }],
    });
  }

  // ----- 駐車券 -----

  function parkingPanel(t) {
    const p = { enabled: false, title: '駐車証', place: '', valid: '', perTeam: 1, note: '', ...((t.settings || {}).parking || {}) };
    const firstCat = data.categories.find((c) => c.teams.length);
    return h('details', { class: 'panel', open: p.enabled ? true : null },
      h('summary', { style: { cursor: 'pointer', fontWeight: 700 } }, '駐車券', p.enabled ? h('span', { class: 'tag done', style: { marginLeft: '8px' } }, '発行中') : null),
      h('div', { class: 'stack', style: { marginTop: '10px' } },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.enabled, onchange: (e) => { p.enabled = e.target.checked; } }), '駐車券を発行する（保護者が自チームの駐車券をPDFで出せます）'),
        h('label', { class: 'field' }, h('span', null, '表題'), h('input', { type: 'text', value: p.title, oninput: (e) => { p.title = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, '駐車場所'), h('input', { type: 'text', value: p.place, placeholder: '例：グラウンド横 第2駐車場', oninput: (e) => { p.place = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, '有効期間（空欄なら開催期間）'), h('input', { type: 'text', value: p.valid, placeholder: printPeriod(t), oninput: (e) => { p.valid = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, '1チームあたりの枚数'), h('input', { type: 'number', min: 1, max: 10, value: p.perTeam, oninput: (e) => { p.perTeam = Number(e.target.value); } })),
        h('label', { class: 'field' }, h('span', null, '注意書き'), (() => { const a = h('textarea', { rows: 3, placeholder: '例：各チーム2台までとなります。その他の車は一般駐車場（有料）をご利用ください。', oninput: (e) => { p.note = e.target.value; } }); a.value = p.note; return a; })()),
        h('div', { class: 'row' },
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => { if (await run(() => api('PATCH', `/api/admin/tournaments/${id}`, { settings: { parking: p } }), '保存しました')) await reload(); } }, '保存'),
          firstCat ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => printParking({ ...data.tournament, parking: p }, firstCat, firstCat.teams[0]) }, '見本をPDFで確認') : null)));
  }

  // ----- スポンサー -----

  function sponsorPanel() {
    const list = data.sponsors || [];
    const move = async (i, d) => {
      const ids = list.map((x) => x.id);
      [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
      if (await run(() => api('POST', `/api/admin/tournaments/${id}/sponsors/order`, { ids }))) await reload();
    };
    return h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'スポンサー'), h('span', { class: 'muted small' }, `${list.length}件`), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editSponsor(null) }, '＋ 追加')),
      list.length ? h('div', { class: 'sp-list' }, list.map((sp, i) => h('div', { class: `sp-item${sp.active ? '' : ' off'}` },
        h('img', { class: 'sp-thumb', src: sp.img, alt: sp.name, loading: 'lazy' }),
        h('div', { class: 'sp-row' },
          h('strong', null, sp.name), sp.active ? null : h('span', { class: 'tag' }, '非表示'), h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '上へ', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '下へ', disabled: i === list.length - 1, onclick: () => move(i, 1) }, '↓')),
        h('div', { class: 'sp-stat' },
          h('span', { class: 'sp-count' }, 'クリック ', h('strong', null, `${sp.clicks}回`), h('span', { class: 'muted' }, `（今日 ${sp.clicksToday}回）`)),
          h('span', { class: 'sp-actions' },
            h('button', { class: 'link-btn', type: 'button', onclick: () => clickHistory(sp) }, '日別の回数'),
            h('button', { class: 'link-btn', type: 'button', onclick: () => editSponsor(sp) }, '編集')))))) :
        h('p', { class: 'muted small', style: { margin: 0 } }, 'バナー画像とリンク先を登録すると、閲覧ページとPDFに表示されます。'));
  }

  function editSponsor(sp) {
    const f = { name: sp ? sp.name : '', url: sp ? sp.url : 'https://', image: null, active: sp ? !!sp.active : true };
    const preview = h('div', { class: 'sp-preview' });
    const drawPreview = () => mount(preview, f.image || sp ? h('img', { src: f.image || sp.img, alt: '' }) : h('span', { class: 'muted small' }, '横4：縦1の画像（例：1200×300）がきれいに表示されます'));
    drawPreview();
    modal({
      title: sp ? 'スポンサーを編集' : 'スポンサーを追加',
      content: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', null, 'スポンサー名'), h('input', { type: 'text', value: f.name, placeholder: '例: さくらスポーツ', oninput: (e) => { f.name = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, 'リンク先URL'), h('input', { type: 'text', inputmode: 'url', value: f.url, oninput: (e) => { f.url = e.target.value.trim(); } })),
        h('div', null, h('span', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, 'バナー画像'), preview,
          h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', 'aria-label': 'バナー画像', onchange: async (e) => {
            const v = await run(() => resizeBanner(e.target.files[0]));
            if (v) { f.image = v; drawPreview(); }
          } })),
        sp ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.active, onchange: (e) => { f.active = e.target.checked; } }), '閲覧ページとPDFに表示する') : null,
        sp ? h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: async () => {
          if (!(await confirmDialog(`${sp.name}を削除します`, 'クリック数の記録も消えます。', '削除する', true))) return;
          document.querySelector('.modal-back')?.remove();
          if (await run(() => api('DELETE', `/api/admin/sponsors/${sp.id}`), '削除しました')) await reload();
        } }, 'このスポンサーを削除') : null),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '保存', kind: 'btn-primary', onClick: async () => {
        if (!sp && !f.image) { toast('バナー画像を選んでください', true); return true; }
        const r = sp
          ? await run(() => api('PATCH', `/api/admin/sponsors/${sp.id}`, f), '保存しました')
          : await run(() => api('POST', `/api/admin/tournaments/${id}/sponsors`, f), '追加しました');
        if (!r) return true;
        await reload();
      } }],
    });
  }

  async function clickHistory(sp) {
    const r = await run(() => api('GET', `/api/admin/sponsors/${sp.id}/clicks`));
    if (!r) return;
    const max = Math.max(1, ...r.days.map((x) => x.count));
    modal({
      title: `${sp.name}のクリック数`,
      content: r.days.length ? h('div', { class: 'stack' },
        h('p', { class: 'muted small', style: { margin: 0 } }, `合計 ${sp.clicks}回。同じ人が30秒以内に何度押しても1回と数えます。`),
        h('div', { class: 'sp-days' }, r.days.map((x) => h('div', { class: 'sp-day' },
          h('span', null, formatDate(x.day)), h('span', { class: 'bar' }, h('i', { style: { width: `${Math.round((x.count / max) * 100)}%` } })), h('strong', null, `${x.count}回`))))) :
        h('p', null, 'まだクリックされていません。'),
      actions: [{ label: '閉じる', kind: 'btn-ghost' }],
    });
  }

  async function getTemplates() {
    if (!templates) templates = (await api('GET', '/api/admin/templates')).templates;
    return templates;
  }

  async function addCategory() {
    const tpls = await run(getTemplates) || [];
    const used = new Set(data.categories.map((c) => c.name));
    const name = h('select', null, CATEGORY_NAMES.map((n) => h('option', { value: n, selected: !used.has(n) && n === CATEGORY_NAMES.find((x) => !used.has(x)) }, n)));
    const tpl = h('select', null, h('option', { value: '' }, '使わない'), tpls.map((x) => h('option', { value: x.id }, x.name)));
    modal({
      title: 'カテゴリを追加',
      content: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', null, 'カテゴリ'), name),
        h('label', { class: 'field' }, h('span', null, '形式テンプレート'), tpl)),
      actions: [
        { label: 'キャンセル', kind: 'btn-ghost' },
        { label: '追加', kind: 'btn-primary', onClick: async () => {
          const config = tpl.value ? tpls.find((x) => x.id === tpl.value).config : {};
          const r = await run(() => api('POST', `/api/admin/tournaments/${id}/categories`, { name: name.value, config }), 'カテゴリを追加しました');
          if (r) { st.catId = r.id; store.set(`a:${id}:cat`, r.id); st.sub = 'settings'; await reload(); }
        } },
      ],
    });
  }

  // ----- カテゴリ -----

  // カテゴリの帯の「更新」ボタン（関係者の仮登録などを読み込む）
  function refreshInline() {
    const b = refreshButton(refreshNow);
    b.classList.remove('refresh-fab'); b.classList.add('btn', 'btn-sm', 'refresh-inline');
    return b;
  }

  function categoryView(t, cat, editable) {
    const subs = [['settings', '設定'], ['teams', `チーム（${cat.teams.length}）`], ['schedule', '組み分け・日程'], ['results', '結果'], ['standings', '順位']];
    const pending = cat.matches.filter((m) => m.status === 'provisional').length;
    const idx = data.categories.findIndex((c) => c.id === cat.id);
    const FORMAT = { league: 'リーグ戦', knockout: 'トーナメント', league_knockout: 'リーグ戦＋トーナメント' };
    const markDirty = () => { if (st.sub === 'settings') st.dirty = cat.id; };
    return h('div', { class: 'cat-scope', style: `--cat:${catColor(idx)}` },
      h('div', { class: 'cat-bar no-print' },
        h('div', { class: 'cat-bar-head' },
          h('span', { class: 'cat-bar-name' }, cat.name),
          h('span', { class: 'cat-bar-label' }, 'を編集中'),
          h('span', { class: 'cat-bar-meta' }, `${FORMAT[cat.config.format] || ''}　${cat.teams.length}チーム`),
          h('span', { class: 'spacer' }),
          refreshInline(),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openPrintDialog(data.tournament, data.categories, cat.id) }, icon('share'), 'PDFで出力')),
        h('div', { class: 'chips' }, subs.map(([k, label]) =>
          h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(st.sub === k), onclick: async () => {
            if (k === st.sub || !(await leaveSettings())) return;
            st.sub = k; store.set(`a:${id}:sub`, k); st.moveSel = null; render();
          } },
            label, k === 'results' && pending ? h('span', { class: 'tag alert', style: { marginLeft: '6px' } }, pending) : null)))),
      h('div', { style: { marginTop: '8px' }, oninput: markDirty, onchange: markDirty },
        st.sub === 'settings' && isLocked() && !ro() ? h('div', { class: 'row', style: { justifyContent: 'flex-end', marginBottom: '8px' } },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => applyTemplate(null, null) }, 'テンプレートの管理（公開・名前変更・削除）')) : null,
        st.sub === 'settings' ? h('fieldset', { class: `lockable${ro() ? ' ro' : ''}`, disabled: isLocked() }, settingsView(t, cat, editable))
          : readOnly(st.sub === 'teams' ? teamsView(t, cat, editable)
            : st.sub === 'schedule' ? scheduleTab(t, cat, editable)
              : st.sub === 'results' ? resultsTab(t, cat)
                : standingsTab(t, cat))));
  }

  // ----- 設定 -----

  function settingsView(t, cat, editable) {
    const f = JSON.parse(JSON.stringify(cat.config));
    let name = cat.name;
    // 未保存の判定は「設定の中身」を比べて行う（ボタンでの変更も見逃さない）。基準は最初の描画の後に記録する
    const form = { catId: cat.id, snap: () => JSON.stringify({ f, name }), base: null };
    st.form = form;
    const box = h('div');
    const num = (key, label, opts = {}) => h('label', { class: 'field' }, h('span', null, label),
      h('input', { type: 'number', min: opts.min ?? 0, max: opts.max ?? 240, inputmode: 'numeric', value: f[key], oninput: (e) => { f[key] = Number(e.target.value); drawSummary(); } }));
    const time = (key, label) => h('label', { class: 'field' }, h('span', null, label),
      h('input', { type: 'time', value: toHHMM(f[key]), oninput: (e) => { if (e.target.value) { f[key] = fromHHMM(e.target.value); drawSummary(); } } }));
    const summary = h('p', { class: 'notice' });
    const describe = (x) => {
      const n = x.periods || 2;
      const len = x.halfMinutes * n + (n > 1 ? x.halftimeMinutes * (n - 1) : 0);
      const body = n === 1 ? `試合${x.halfMinutes}分`
        : n === 2 ? `前半${x.halfMinutes}分＋ハーフタイム${x.halftimeMinutes}分＋後半${x.halfMinutes}分`
          : `${x.halfMinutes}分×${n}ピリオド＋休憩${x.halftimeMinutes}分×${n - 1}`;
      return `${body}＋試合間隔${f.intervalMinutes}分＝${len + f.intervalMinutes}分`;
    };
    // コートの優先順位（決勝の重要な試合から、上のコートを使う）
    const courtPriorityPanel = () => {
      const n = Math.max(1, Number(f.courts) || 1);
      const pr = (f.courtPriority || []).filter((x) => x < n);
      for (let i = 0; i < n; i++) if (!pr.includes(i)) pr.push(i);
      f.courtPriority = pr;
      const nm = (i) => (f.courtNames && f.courtNames[i]) || `${String.fromCharCode(65 + i)}コート`;
      const move = (i, d) => { [pr[i], pr[i + d]] = [pr[i + d], pr[i]]; draw(); };
      return h('div', { class: 'court-prio' },
        h('div', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, 'コートの優先順位'),
        h('p', { class: 'muted small', style: { margin: '2px 0 6px' } }, f.format === 'league' ? 'リーグ戦のみのカテゴリでは使いません。' : '決勝トーナメントでは、同じ時間帯の中で重要な試合（上位の段・決勝・順位決定戦）から順に、上のコートを使います。変えた後は日程を作り直すと反映されます。'),
        h('ol', { class: 'court-prio-list' }, pr.map((c, i) => h('li', null,
          h('span', { class: 'cp-no' }, i + 1), h('span', { class: 'cp-name' }, nm(c)), i === 0 ? h('span', { class: 'tag done' }, '決勝などに優先') : null,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `${nm(c)}を上へ`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `${nm(c)}を下へ`, disabled: i === pr.length - 1, onclick: () => move(i, 1) }, '↓')))));
    };
    const koOn = () => f.format === 'league_knockout' && f.koTiming && f.koTiming.enabled;
    const drawSummary = () => {
      // null をそのまま渡すと「null」という文字が表示されるため、表示する行だけを渡す
      summary.replaceChildren(...[
        h('div', null, `${koOn() ? '予選の1試合の枠' : '1試合の枠'}：${describe(f)}`),
        koOn() ? h('div', null, `決勝トーナメントの1試合の枠：${describe(f.koTiming)}`) : null,
      ].filter(Boolean));
    };
    // 決勝トーナメントの試合時間（予選と違う場合）
    const koPanel = () => {
      if (f.format !== 'league_knockout') return null;
      f.koTiming = f.koTiming || { enabled: false, periods: 2, halfMinutes: 15, halftimeMinutes: 5 };
      const k = f.koTiming;
      const kn = (key, label, max) => h('label', { class: 'field' }, h('span', null, label),
        h('input', { type: 'number', min: key === 'halfMinutes' ? 1 : 0, max, inputmode: 'numeric', value: k[key], oninput: (e) => { k[key] = Number(e.target.value); drawSummary(); } }));
      return h('div', { class: 'ko-timing' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!k.enabled, onchange: (e) => { k.enabled = e.target.checked; draw(); } }), '決勝トーナメントは試合時間を変える'),
        k.enabled ? h('div', { class: 'grid-form' },
          h('label', { class: 'field' }, h('span', null, '決勝の試合の形'), h('select', { onchange: (e) => { k.periods = Number(e.target.value); draw(); } },
            [[2, '前後半'], [1, 'ハーフなし'], [3, '3ピリオド']].map(([v, l]) => h('option', { value: v, selected: k.periods === v }, l)))),
          kn('halfMinutes', k.periods === 1 ? '決勝の試合時間（分）' : k.periods === 2 ? '決勝の前後半（各・分）' : '決勝の1ピリオド（分）', 90),
          k.periods > 1 ? kn('halftimeMinutes', k.periods === 2 ? '決勝のハーフタイム（分）' : '決勝のピリオド間の休憩（分）', 30) : null) : null,
        // 予選と決勝トーナメントの間にあける時間（同じ日に続くときだけ）
        h('div', { class: 'grid-form', style: { marginTop: '10px' } },
          h('label', { class: 'field' }, h('span', null, '予選と決勝トーナメントの間（分）'),
            h('input', { type: 'number', min: 0, max: 240, inputmode: 'numeric', value: f.koGapMinutes || 0, oninput: (e) => { f.koGapMinutes = Math.max(0, Number(e.target.value) || 0); } }))),
        h('p', { class: 'muted small', style: { margin: '4px 0 0' } }, '同じ日に予選の後に決勝トーナメントが続くとき、最後の予選の試合と最初の決勝の試合の間に、試合間隔に加えてこの時間をあけます（組み合わせの確認や会場の切り替えのため）。決勝トーナメントが翌日の朝から始まる場合はあけません。'));
    };
    drawSummary();

    const draw = () => mount(box,
      h('section', { class: 'panel' },
        h('h2', { style: { marginBottom: '12px' } }, '基本'),
        h('div', { class: 'grid-form' },
          h('label', { class: 'field' }, h('span', null, 'カテゴリ'), h('select', { onchange: (e) => { name = e.target.value; } },
            CATEGORY_NAMES.map((n) => h('option', { value: n, selected: n === name }, n)))),
          time('startTime', '第1試合の開始'),
          h('label', { class: 'field' }, h('span', null, '試合の形'), h('select', { onchange: (e) => { f.periods = Number(e.target.value); draw(); } },
            [[2, '前後半'], [1, 'ハーフなし'], [3, '3ピリオド']].map(([v, l]) => h('option', { value: v, selected: (f.periods || 2) === v }, l)))),
          num('halfMinutes', (f.periods || 2) === 1 ? '試合時間（分）' : (f.periods || 2) === 2 ? '前後半（各・分）' : '1ピリオド（分）', { min: 1, max: 90 }),
          (f.periods || 2) > 1 ? num('halftimeMinutes', (f.periods || 2) === 2 ? 'ハーフタイム（分）' : 'ピリオド間の休憩（分）', { max: 30 }) : null,
          num('intervalMinutes', '試合間隔（分）', { max: 60 }),
          num('courts', 'コート数', { min: 1, max: 12 }),
          h('label', { class: 'field' }, h('span', null, '連戦を避ける'), h('select', { onchange: (e) => { f.minRestSlots = Number(e.target.value); } },
            [[0, '避けない'], [1, '1試合分は休む'], [2, '2試合分は休む']].map(([v, l]) => h('option', { value: v, selected: f.minRestSlots === v }, l))))),
        h('label', { class: 'field', style: { marginTop: '12px' } }, h('span', null, 'コート名（カンマ区切り・空欄なら Aコート, Bコート…）'),
          h('input', { type: 'text', value: (f.courtNames || []).join(', '), placeholder: '例: 第1コート, 第2コート', oninput: (e) => { f.courtNames = e.target.value.split(/[,、]/).map((s) => s.trim()).filter(Boolean); } })),
        courtPriorityPanel(),
        koPanel(),
        h('div', { style: { marginTop: '12px' } }, (drawSummary(), summary))),
      h('section', { class: 'panel' },
        h('h2', { style: { marginBottom: '8px' } }, '昼休憩'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.lunchEnabled, onchange: (e) => { f.lunchEnabled = e.target.checked; draw(); } }), '昼休憩をとる'),
        f.lunchEnabled ? h('div', { class: 'grid-form' },
          time('lunchStart', '昼休憩の開始めやす'),
          num('lunchMinutes', '昼休憩（分）', { max: 180 }),
          num('minLunchMinutes', '短縮時の最低（分）', { max: 180 })) : null,
        f.lunchEnabled ? h('p', { class: 'muted small', style: { marginBottom: 0 } }, '開始めやすの時刻をまたぐ試合は、昼休憩の後に回します。当日の遅れで昼休憩を短くするときも、最低の時間は残します。') : null),
      h('section', { class: 'panel' },
        h('h2', { style: { marginBottom: '12px' } }, '形式'),
        h('div', { class: 'grid-form' },
          h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, h('span', null, '形式'), h('select', { onchange: (e) => { f.format = e.target.value; draw(); } },
            Object.entries(FORMAT_LABEL).map(([v, l]) => h('option', { value: v, selected: f.format === v }, l)))),
          f.format !== 'knockout' ? num('groups', '組の数', { min: 1, max: 26 }) : null,
          f.format === 'knockout' ? h('label', { class: 'field', style: { gridColumn: 'span 2' } }, h('span', null, '順位の決め方'), h('select', { onchange: (e) => { f.rankMode = e.target.value; } },
            Object.entries(RANK_LABEL).map(([v, l]) => h('option', { value: v, selected: f.rankMode === v }, l)))) : null),
        f.format === 'league_knockout' ? knockoutPlanPanel(f, cat, draw) : null,
        f.format !== 'knockout' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.showStandings, onchange: (e) => { f.showStandings = e.target.checked; } }), '閲覧ページに順位表を表示する') : null,
        h('p', { class: 'muted small' }, '形式・組の数・コート数を変えた場合は「組み分け・日程」で日程を作り直してください。')),
      dayPanel(f, cat, t, draw),
      f.format !== 'knockout' ? h('section', { class: 'panel' },
        h('h2', { style: { marginBottom: '4px' } }, '勝点が並んだときの判定順'),
        h('p', { class: 'muted small', style: { marginTop: 0 } }, '勝点は 勝ち3・引き分け1・負け0 です。上から順に比べます。'),
        tiebreakEditor(f, draw),        h('div', { class: 'grid-form', style: { marginTop: '12px' } },
          h('label', { class: 'field' }, h('span', null, '不戦勝のスコア（勝ち）'), h('input', { type: 'number', min: 0, max: 20, value: f.forfeitScore[0], oninput: (e) => { f.forfeitScore[0] = Number(e.target.value); } })),
          h('label', { class: 'field' }, h('span', null, '不戦勝のスコア（負け）'), h('input', { type: 'number', min: 0, max: 20, value: f.forfeitScore[1], oninput: (e) => { f.forfeitScore[1] = Number(e.target.value); } })))) : null,
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { class: 'btn btn-primary', type: 'button', onclick: async () => {
          const r = await run(() => api('PATCH', `/api/admin/categories/${cat.id}`, { name, config: { ...f, _touched: undefined } }));
          if (r) { st.dirty = null; st.form = null; toast(r.retimed ? `${cat.name}の設定を保存し、全試合の開始時刻を再計算しました` : `${cat.name}の設定を保存しました`); await reload(); }
        } }, `${cat.name}の設定を保存`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => saveTemplate(f) }, 'テンプレートとして保存'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => applyTemplate(f, draw) }, 'テンプレートの読み込み・編集'),
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async () => {
          if (!(await confirmDialog(`${cat.name}を削除します`, 'このカテゴリのチーム・日程・結果がすべて消えます。', '削除する', true))) return;
          if (await run(() => api('DELETE', `/api/admin/categories/${cat.id}`), '削除しました')) { st.catId = null; await reload(); }
        } }, 'カテゴリを削除')),
      !editable ? h('p', { class: 'notice', style: { marginTop: '12px' } }, '開催中は、試合時間などを変えても組み合わせ済みの開始時刻は変わりません。当日の時間調整は「結果」または「組み分け・日程」から行ってください。') : null);
    draw();
    drawSummary();
    form.base = form.snap(); // 描画時の自動の補完（開催日など）を含めた状態を基準にする
    return box;
  }

  function saveTemplate(f) {
    const nm = h('input', { type: 'text', placeholder: '例: U10 4組リーグ＋クロス' });
    modal({ title: 'テンプレートとして保存', content: h('label', { class: 'field' }, h('span', null, 'テンプレート名'), nm),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '保存', kind: 'btn-primary', onClick: async () => {
        const r = await run(() => api('POST', '/api/admin/templates', { name: nm.value, config: f }), 'テンプレートを保存しました');
        templates = null;
        return r ? undefined : true;
      } }] });
  }

  async function applyTemplate(f, redraw) {
    const tpls = await run(getTemplates);
    if (!tpls) return;
    if (!tpls.length) return toast('保存されたテンプレートはありません', true);
    const list = h('div', null, tpls.map((x) => h('div', { class: 'row', style: { padding: '6px 0', borderBottom: '1px solid var(--line)' } },
      h('div', null, h('strong', null, x.name), ' ', sharedBadge(x, async (on) => {
        if (await run(() => api('PATCH', `/api/admin/templates/${x.id}`, { shared: on }), on ? '地域管理者に公開しました' : '非公開にしました')) { templates = null; x.published = on; }
      }), h('div', { class: 'muted small' }, `${FORMAT_LABEL[x.config.format] || ''}　${(x.config.periods || 2) === 1 ? `1本${x.config.halfMinutes}分` : (x.config.periods || 2) === 2 ? `前後半${x.config.halfMinutes}分` : `${x.config.halfMinutes}分×3ピリオド`}`)),
      h('span', { class: 'spacer' }),
      !f ? null : h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { Object.assign(f, JSON.parse(JSON.stringify(x.config))); dlg.close(); redraw(); toast('読み込みました。「設定を保存」で反映されます'); } }, '読み込む'),
      x.editable === false || !f ? null : h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => {
        if (!(await confirmDialog(`「${x.name}」を上書きします`, '今この画面で設定している内容で、テンプレートを置き換えます。', '上書きする'))) return;
        if (await run(() => api('PATCH', `/api/admin/templates/${x.id}`, { config: f }), '上書きしました')) { templates = null; dlg.close(); }
      } }, '今の設定で上書き'),
      x.editable === false ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => {
        const nm = h('input', { type: 'text', value: x.name });
        modal({ title: '名前を変更', content: h('label', { class: 'field' }, h('span', null, 'テンプレート名'), nm), actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '保存', kind: 'btn-primary', onClick: async () => {
          if (await run(() => api('PATCH', `/api/admin/templates/${x.id}`, { name: nm.value }), '変更しました')) { templates = null; dlg.close(); }
        } }] });
      } }, '名前変更'),
      x.editable === false ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
        if (await run(() => api('DELETE', `/api/admin/templates/${x.id}`), '削除しました')) { templates = null; dlg.close(); }
      } }, '削除'))));
    const dlg = modal({ title: f ? 'テンプレートを読み込む' : 'テンプレートの管理', content: list, actions: [{ label: '閉じる', kind: 'btn-ghost' }] });
  }

  // ----- チーム -----

  function teamsView(t, cat, editable) {
    const bulk = h('textarea', { placeholder: '1行に1チーム\n例:\nさくらFC A, さくらFC\nさくらFC B, さくらFC\n青空SC' });
    return h('div', null,
      h('fieldset', { class: 'lockable', disabled: isLocked() }, h('section', { class: 'panel' },
        h('h2', { style: { marginBottom: '8px' } }, 'チームを追加'),
        h('p', { class: 'muted small', style: { marginTop: 0 } }, '「チーム名, クラブ名」と書くとクラブも登録できます。同じクラブのチームは組み分けで別の組になります。'),
        bulk,
        h('button', { class: 'btn btn-primary', type: 'button', style: { marginTop: '8px' }, onclick: async () => {
          const teams = bulk.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
            const [name, club] = l.split(/[,、\t]/).map((s) => s.trim());
            return { name, club: club || null };
          });
          if (await run(() => api('POST', `/api/admin/categories/${cat.id}/teams`, { teams }), `${teams.length}チームを追加しました`)) await reload();
        } }, 'チームを追加'))),
      h('section', { class: 'panel' },
        h('h2', { style: { marginBottom: '8px' } }, `登録チーム（${cat.teams.length}）`),
        cat.teams.length ? cat.teams.map((tm) => h('div', { class: 'row', style: { padding: '6px 0', borderBottom: '1px solid var(--line)' } },
          tm.logo ? h('img', { src: tm.logo, alt: '', width: 28, height: 28, style: { objectFit: 'contain', borderRadius: '50%' } }) : null,
          h('strong', null, tm.name),
          tm.club ? h('span', { class: 'muted small' }, tm.club) : null,
          tm.group_label ? h('span', { class: 'tag' }, `${tm.group_label}組`) : null,
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => editTeam(tm) }, '編集'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: isLocked(), onclick: async () => {
            const scheduled = cat.matches.length > 0;
            if (!editable && scheduled) return toast('開催中は日程に入っているチームを削除できません', true);
            if (!(await confirmDialog(`${tm.name}を削除します`, scheduled ? 'このカテゴリの日程は作り直しが必要になります（今の日程は消えます）。' : '削除してよろしいですか。', '削除する', true))) return;
            if (await run(() => api('DELETE', `/api/admin/teams/${tm.id}`), '削除しました')) await reload();
          } }, '削除')))
          : h('p', { class: 'empty' }, 'まだチームがありません')));
  }

  function editTeam(tm) {
    const f = { name: tm.name, short_name: tm.short_name || '', club: tm.club || '', logo: tm.logo };
    const img = h('div');
    const drawImg = () => mount(img, f.logo ? h('div', { class: 'row' }, h('img', { src: f.logo, alt: '', width: 48, height: 48, style: { objectFit: 'contain' } }),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { f.logo = null; drawImg(); } }, 'ロゴを外す')) : null);
    drawImg();
    modal({
      title: 'チームを編集',
      content: h('div', { class: 'stack' },
        h('label', { class: 'field' }, h('span', null, 'チーム名'), h('input', { type: 'text', value: f.name, oninput: (e) => { f.name = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, '略称（関係者の更新表示などに使用）'), h('input', { type: 'text', value: f.short_name, oninput: (e) => { f.short_name = e.target.value; } })),
        h('label', { class: 'field' }, h('span', null, 'クラブ名'), h('input', { type: 'text', value: f.club, oninput: (e) => { f.club = e.target.value; } })),
        h('div', null, h('span', { class: 'small', style: { fontWeight: 700 } }, 'ロゴ'), img,
          h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', 'aria-label': 'チームロゴの画像', onchange: async (e) => {
            const v = await run(() => resizeImage(e.target.files[0], 160));
            if (v) { f.logo = v; drawImg(); }
          } }))),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '保存', kind: 'btn-primary', onClick: async () => {
        if (await run(() => api('PATCH', `/api/admin/teams/${tm.id}`, f), '保存しました')) await reload();
      } }],
    });
  }

  // ----- 組み分け・日程 -----

  function scheduleTab(t, cat, editable) {
    const box = h('div');
    if (!editable) {
      box.append(h('p', { class: 'notice' }, ro() ? (isViewer() ? '閲覧専用のアカウントのため、組み分けと日程は確認だけできます。' : '共有された大会のため、組み分けと日程は確認だけできます。')
        : t.status === 'live'
        ? '開催中は組み合わせを変更できません。遅れが出たら、遅らせたい試合をタップすると、そのコートの以降の試合をまとめてずらせます。'
        : t.status === 'published' ? '公開中のため、組み分けと日程はロックされています。変更する場合は、上の「ロックを一時解除」を押してください。'
          : '終了した大会は変更できません。'));
    } else {
      if (cat.config.format !== 'knockout') box.append(constraintsPanel(cat));
      box.append(groupingPanel(cat));
    }
    if (cat.matches.length) {
      const names = teamMap(cat);
      box.append(h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, '現在の日程'), h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm no-print', type: 'button', onclick: () => openPrintDialog(data.tournament, data.categories, cat.id) }, 'PDFで出力'),
          editable ? h('button', { class: 'btn btn-sm btn-danger no-print', type: 'button', onclick: () => deleteSchedule(cat) }, '日程を削除') : null),
        editable ? h('p', { class: 'muted small no-print', style: { marginTop: 0 } }, '試合をタップして選び、移動先の枠をタップすると入れ替わります。開始時刻を全体でずらすときは「設定」の第1試合の開始を変更してください。') : null,
        warningsList(cat.warnings),
        h('div', { class: 'table-wrap' }, scheduleGrid(cat, cat.matches, {
          editable,
          live: t.status === 'live',
          onPick: async (m, slot, court) => {
            if (t.status === 'live') { if (m && m.status === 'none') openDelay(cat, m); return; }
            if (!editable) return;
            if (!st.moveSel) { if (m) { st.moveSel = m.id; render(); } return; }
            if (m && m.id === st.moveSel) { st.moveSel = null; render(); return; }
            const matchId = st.moveSel;
            st.moveSel = null;
            if (await run(() => api('POST', `/api/admin/categories/${cat.id}/move`, { matchId, slot, court }), '移動しました')) await reload();
            else render();
          },
          names,
        }))));
    }
    return box;
  }

  function warningsList(ws) {
    if (!ws || !ws.length) return null;
    return h('div', { class: 'stack', style: { marginBottom: '10px' } }, ws.map((w) => h('p', { class: `notice${w.level === 'error' ? ' error' : ''}`, style: { margin: 0 } }, w.text)));
  }

  function constraintsPanel(cat) {
    const g = cat.config.grouping || { fixed: {}, separate: [] };
    const labels = Array.from({ length: cat.config.groups }, (_, i) => String.fromCharCode(65 + i));
    const tm = teamMap(cat);
    const save = async (grouping) => {
      if (await run(() => api('PATCH', `/api/admin/categories/${cat.id}`, { config: { grouping } }), '保存しました')) await reload();
    };
    const fixTeam = h('select', null, h('option', { value: '' }, 'チームを選ぶ'), cat.teams.map((x) => h('option', { value: x.id }, x.name)));
    const fixGroup = h('select', null, labels.map((l) => h('option', { value: l }, `${l}組`)));
    const sepA = h('select', null, h('option', { value: '' }, 'チームを選ぶ'), cat.teams.map((x) => h('option', { value: x.id }, x.name)));
    const sepB = h('select', null, h('option', { value: '' }, 'チームを選ぶ'), cat.teams.map((x) => h('option', { value: x.id }, x.name)));
    return h('details', { class: 'panel', open: Object.keys(g.fixed || {}).length || (g.separate || []).length ? true : null },
      h('summary', { style: { cursor: 'pointer', fontWeight: 700 } }, '組み分けの条件（主催チームの固定・同組NG）'),
      h('div', { class: 'stack', style: { marginTop: '12px' } },
        h('p', { class: 'muted small', style: { margin: 0 } }, '同じクラブ名のチームは自動的に別の組になります。'),
        h('h3', null, '組を固定するチーム'),
        Object.entries(g.fixed || {}).map(([tid, gl]) => h('div', { class: 'row' }, h('span', null, `${tm[tid]?.name || '（削除済み）'} → ${gl}組`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { const fixed = { ...g.fixed }; delete fixed[tid]; save({ ...g, fixed }); } }, '外す'))),
        h('div', { class: 'row' }, h('div', { style: { flex: '2 1 160px' } }, fixTeam), h('div', { style: { flex: '1 1 80px' } }, fixGroup),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { if (fixTeam.value) save({ ...g, fixed: { ...g.fixed, [fixTeam.value]: fixGroup.value } }); } }, '追加')),
        h('h3', null, '同じ組にしない組み合わせ'),
        (g.separate || []).map(([a, b], i) => h('div', { class: 'row' }, h('span', null, `${tm[a]?.name || '-'} と ${tm[b]?.name || '-'}`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => save({ ...g, separate: g.separate.filter((_, j) => j !== i) }) }, '外す'))),
        h('div', { class: 'row' }, h('div', { style: { flex: '1 1 140px' } }, sepA), h('div', { style: { flex: '1 1 140px' } }, sepB),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { if (sepA.value && sepB.value && sepA.value !== sepB.value) save({ ...g, separate: [...(g.separate || []), [sepA.value, sepB.value]] }); } }, '追加'))));
  }

  function groupingPanel(cat) {
    const ko = cat.config.format === 'knockout';
    const tm = teamMap(cat);
    const labels = Array.from({ length: cat.config.groups }, (_, i) => String.fromCharCode(65 + i));
    let d = st.drafts[cat.id];
    if (!d) {
      if (ko) {
        const order = cat.teams.map((x) => x.id);
        d = { order, warnings: [] };
      } else if (cat.teams.some((x) => x.group_label)) {
        d = { assignment: Object.fromEntries(cat.teams.map((x) => [x.id, x.group_label || labels[0]])), warnings: [] };
      }
    }
    const preview = st.preview[cat.id];
    const panel = h('section', { class: 'panel' });

    const randomize = async () => {
      const r = await run(() => api('POST', `/api/admin/categories/${cat.id}/grouping`));
      if (!r) return;
      st.drafts[cat.id] = ko ? { order: r.order, warnings: [] } : { assignment: r.assignment, warnings: r.warnings };
      delete st.preview[cat.id];
      render();
    };
    const makePreview = async () => {
      const body = ko ? { order: d.order, dryRun: true } : { assignment: d.assignment, dryRun: true };
      const r = await run(() => api('POST', `/api/admin/categories/${cat.id}/generate`, body));
      if (r) { st.drafts[cat.id] = d; st.preview[cat.id] = r; render(); }
    };
    const apply = async () => {
      if (cat.matches.some((m) => m.status !== 'none') && !(await confirmDialog('日程を作り直します', '登録済みの結果はすべて消えます。', '作り直す', true))) return;
      const body = ko ? { order: d.order } : { assignment: d.assignment };
      const r = await run(() => api('POST', `/api/admin/categories/${cat.id}/generate`, body), '日程を反映しました');
      if (r) { delete st.preview[cat.id]; delete st.drafts[cat.id]; await reload(); }
    };

    const groupsView = () => {
      if (ko) {
        return h('div', null,
          h('p', { class: 'muted small' }, '上から順にトーナメントの枠に入ります（1番と最後が逆の山）。チーム数が2・4・8・16でない場合は上位に不戦（シード）が入ります。'),
          d.order.map((tid, i) => h('div', { class: 'row', style: { padding: '4px 0', borderBottom: '1px solid var(--line)' } },
            h('span', { class: 'num', style: { width: '28px', fontWeight: 700 } }, i + 1), h('span', null, tm[tid]?.name), h('span', { class: 'spacer' }),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '上へ', disabled: i === 0, onclick: () => { [d.order[i - 1], d.order[i]] = [d.order[i], d.order[i - 1]]; st.drafts[cat.id] = d; delete st.preview[cat.id]; render(); } }, '↑'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '下へ', disabled: i === d.order.length - 1, onclick: () => { [d.order[i + 1], d.order[i]] = [d.order[i], d.order[i + 1]]; st.drafts[cat.id] = d; delete st.preview[cat.id]; render(); } }, '↓'))));
      }
      const by = Object.fromEntries(labels.map((l) => [l, []]));
      for (const x of cat.teams) (by[d.assignment[x.id]] ||= []).push(x);
      return h('div', { class: 'grid-form', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' } },
        Object.keys(by).sort().map((l) => h('div', { class: 'panel', style: { padding: '10px' } },
          h('h3', { style: { marginBottom: '6px' } }, `${l}組（${by[l].length}）`),
          by[l].map((x) => h('div', { class: 'row', style: { padding: '2px 0' } }, h('span', { style: { flex: 1 } }, x.name),
            h('select', { style: { width: '76px', minHeight: '34px', padding: '2px' }, 'aria-label': `${x.name}の組`, onchange: (e) => { d.assignment[x.id] = e.target.value; st.drafts[cat.id] = d; delete st.preview[cat.id]; render(); } },
              labels.map((o) => h('option', { value: o, selected: o === l }, `${o}組`))))))));
    };

    mount(panel,
      h('div', { class: 'panel-head' }, h('h2', null, ko ? 'トーナメントの組み合わせ' : '組み分け'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: randomize, disabled: cat.teams.length < 2 }, ko ? 'ランダムに抽選' : 'ランダムに組み分け')),
      cat.teams.length < 2 ? h('p', { class: 'empty' }, '先に「チーム」でチームを登録してください') : null,
      d ? warningsList((d.warnings || []).map((text) => ({ level: 'warn', text }))) : null,
      d ? groupsView() : cat.teams.length >= 2 ? h('p', { class: 'muted' }, '「ランダムに組み分け」を押すと、条件を守って組を決めます。決まった後で手動でも変更できます。') : null,
      d && cat.config.format === 'league_knockout' ? h('p', { class: 'notice', style: { marginTop: '12px' } }, '決勝の形式（保存済みの設定）：',
        planBrackets(cat).filter((b) => b.n >= 2).map((b, i) => [i ? '・' : '', h('strong', null, b.name), b.format === 'league' ? '（総当たり）' : '']),
        h('span', { class: 'muted small', style: { display: 'block', marginTop: '2px' } }, '変える場合は「設定」で変更し、「設定を保存」を押してから日程を作成してください。')) : null,
      d ? h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn btn-primary', type: 'button', onclick: makePreview }, '日程を作成して確認')) : null,
      preview ? h('div', { style: { marginTop: '16px' } },
        h('h3', { style: { marginBottom: '6px' } }, '日程の確認（まだ反映されていません）'),
        warningsList(preview.warnings),
        h('div', { class: 'table-wrap' }, scheduleGrid(cat, preview.matches, { names: tm, editable: false, breaks: preview.dayBreakSlots })),
        h('div', { class: 'row', style: { marginTop: '12px' } },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: apply }, 'この内容で反映'),
          h('button', { class: 'btn', type: 'button', onclick: () => { delete st.preview[cat.id]; render(); } }, 'やり直す'))) : null);
    return panel;
  }

  function scheduleGrid(cat, matches, opts) {
    const cfg = opts.breaks ? { ...cat.config, dayBreakSlots: opts.breaks } : cat.config;
    const multi = dayTotal(cfg) > 1;
    let prevDay = -1;
    const cache = { teams: opts.names || teamMap(cat), codes: Object.fromEntries(matches.filter((m) => m.code).map((m) => [m.code, m])) };
    const fakeCat = { ...cat, matches };
    const slots = [...new Set(matches.map((m) => m.slot))].sort((a, b) => a - b);
    if (opts.editable && st.moveSel) slots.push((slots[slots.length - 1] ?? -1) + 1);
    const warnIds = new Set((cat.warnings || []).flatMap((w) => w.ids || []));
    const rows = [];
    let prevSession = null;
    for (const s of slots) {
      const inSlot = matches.filter((m) => m.slot === s);
      const d = dayOf(cfg, s);
      if (multi && d !== prevDay) {
        rows.push(h('tr', { class: 'day-row' }, h('td', { colspan: cfg.courts + 1 }, dayLabel({ ...cat, config: cfg }, d, data.tournament))));
        prevSession = null;
      }
      prevDay = d;
      const session = inSlot[0]?.session || prevSession;
      if (prevSession === 'am' && session === 'pm') rows.push(h('tr', { class: 'lunch' }, h('td', { colspan: cfg.courts + 1 }, '昼休憩')));
      prevSession = session;
      const rowTime = inSlot.length ? Math.min(...inSlot.map((m) => m.start_min)) : null;
      rows.push(h('tr', null,
        h('td', { class: 't' }, rowTime != null ? toHHMM(rowTime) : '追加'),
        Array.from({ length: cfg.courts }, (_, c) => {
          const m = inSlot.find((x) => x.court === c);
          if (!m) {
            return h('td', null, opts.editable && st.moveSel
              ? h('button', { class: 'cell empty-cell', type: 'button', onclick: () => opts.onPick(null, s, c) }, 'ここへ移動')
              : h('div', { class: 'cell empty-cell', style: { cursor: 'default' } }, '－'));
          }
          const home = sideInfo(m, 'home', fakeCat, cache).text;
          const away = sideInfo(m, 'away', fakeCat, cache).text;
          const sc = m.status !== 'none' && m.home_score != null ? `　${m.home_score}-${m.away_score}` : '';
          const clickable = opts.onPick && (opts.editable || (opts.live && m.status === 'none'));
          return h('td', null, h(clickable ? 'button' : 'div', {
            class: `cell${st.moveSel === m.id ? ' selected' : ''}${warnIds.has(m.id) ? ' warn' : ''}`,
            type: clickable ? 'button' : null,
            onclick: clickable ? () => opts.onPick(m, s, c) : null,
            'aria-pressed': clickable && opts.editable ? String(st.moveSel === m.id) : null,
          },
          h('span', { class: 'cl' }, `${m.label}${m.start_min !== rowTime || m.time_changed ? `　${toHHMM(m.start_min)}` : ''}${m.status === 'confirmed' ? '　確定' : m.status === 'provisional' ? '　仮登録' : ''}`),
          `${home} - ${away}${sc}`));
        })));
    }
    return h('table', { class: 'sched' },
      h('thead', null, h('tr', null, h('th', null, '時刻'), Array.from({ length: cfg.courts }, (_, c) => h('th', null, courtName(cfg, c))))),
      h('tbody', null, rows));
  }

  // ----- 当日の遅延調整 -----

  function openDelay(cat, m) {
    const content = h('div');
    let minutes = 10;
    const names = teamMap(cat);
    const step1 = () => mount(content,
      h('p', { style: { marginTop: 0 } }, `${courtName(cat.config, m.court)}の ${toHHMM(m.start_min)}「${sideInfo(m, 'home', cat, { teams: names, codes: codeMap(cat) }).text} - ${sideInfo(m, 'away', cat, { teams: names, codes: codeMap(cat) }).text}」以降の試合をまとめてずらします。`),
      h('div', { class: 'row' }, [-10, -5, 5, 10, 15, 20, 30].map((v) => h('button', { class: 'btn btn-sm', type: 'button', 'aria-pressed': String(v === minutes), onclick: () => { minutes = v; step1(); } }, v > 0 ? `+${v}分` : `${v}分`))),
      h('label', { class: 'field', style: { marginTop: '12px' } }, h('span', null, 'ずらす時間（分・マイナスで前倒し）'),
        h('input', { type: 'number', value: minutes, min: -240, max: 240, oninput: (e) => { minutes = Number(e.target.value); } })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dlg.close() }, 'キャンセル'),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: check }, '確認する')));

    const check = async () => {
      const r = await run(() => api('POST', `/api/admin/categories/${cat.id}/delay`, { matchId: m.id, minutes, dryRun: true }));
      if (!r) return;
      if (r.needsLunchChoice) return lunchChoice(r.options);
      mount(content,
        h('p', { style: { marginTop: 0 } }, `${r.changes.length}試合の開始時刻を${minutes > 0 ? `${minutes}分遅らせます` : `${-minutes}分早めます`}。`),
        warningsList(r.warnings),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: step1 }, '戻る'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: () => applyDelay() }, 'ずらす')));
    };

    const lunchChoice = (o) => mount(content,
      h('p', { style: { marginTop: 0 } }, 'この変更は昼休憩にかかります。どちらにしますか。'),
      h('button', { class: 'choice', type: 'button', onclick: () => applyDelay('shorten') },
        h('strong', null, '昼休憩を短くする'),
        h('span', null, `昼休憩 ${o.shorten.lunchBefore}分 → ${o.shorten.lunch}分、午後の開始 ${toHHMM(o.shorten.pmStart)}${o.shorten.pmShift ? `（${o.shorten.pmShift}分遅れ）` : '（定刻）'}`),
        warningsList(o.shorten.warnings)),
      h('button', { class: 'choice', type: 'button', onclick: () => applyDelay('shift') },
        h('strong', null, '午後の試合もずらす'),
        h('span', null, `昼休憩 ${o.shift.lunch}分のまま、午後の開始 ${toHHMM(o.shift.pmStart - o.shift.pmShift)} → ${toHHMM(o.shift.pmStart)}`),
        warningsList(o.shift.warnings)),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: step1 }, '戻る')));

    const applyDelay = async (lunchMode) => {
      const r = await run(() => api('POST', `/api/admin/categories/${cat.id}/delay`, { matchId: m.id, minutes, lunchMode }));
      if (r) { toast(`${r.changed}試合の時刻を変更しました`); dlg.close(); await reload(); }
    };

    const dlg = modal({ title: '試合の時間をずらす', content });
    step1();
  }

  // ----- 結果 -----

  function resultsTab(t, cat) {
    const cache = { teams: teamMap(cat), codes: codeMap(cat) };
    const len = matchLength(cat.config);
    const today = todayStr();
    const filters = [['pending', '要対応'], ['provisional', '仮登録'], ['all', 'すべて'], ['confirmed', '確定済み']];
    const overdue = (m) => t.status === 'live' && m.status !== 'confirmed' && (() => {
      const date = dayDate(cat, dayOf(cat.config, m.slot), t);
      return date && (date < today || (date === today && nowMin() >= m.start_min + matchLengthFor(cat.config, m)));
    })();
    const list = [...cat.matches].sort((a, b) => absMin(cat.config, a) - absMin(cat.config, b) || a.court - b.court).filter((m) => {
      if (st.resultFilter === 'pending') return m.status !== 'confirmed';
      if (st.resultFilter === 'provisional') return m.status === 'provisional';
      if (st.resultFilter === 'confirmed') return m.status === 'confirmed';
      return true;
    });
    const provisional = cat.matches.filter((m) => m.status === 'provisional');
    const picked = new Set(provisional.map((m) => m.id));

    return h('div', null,
      t.status !== 'live' && t.status !== 'finished' ? h('p', { class: 'notice' }, '大会当日は「大会の状態」を「開催中」にしてください。確定待ちの強調表示と時間調整が使えるようになります。') : null,
      h('div', { class: 'chips' }, filters.map(([k, label]) => h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(st.resultFilter === k), onclick: () => { st.resultFilter = k; render(); } }, label))),
      provisional.length ? h('section', { class: 'panel', style: { marginTop: '8px' } },
        h('div', { class: 'row' },
          h('strong', null, `仮登録が ${provisional.length} 試合あります`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
            const r = await run(() => api('POST', `/api/admin/categories/${cat.id}/confirm`, { matchIds: [...picked] }));
            if (r) { toast(r.skipped ? `${r.confirmed}試合を確定しました（PK未入力の${r.skipped}試合は確定していません）` : `${r.confirmed}試合を確定しました`); await reload(); }
          } }, 'チェックした試合をまとめて確定')),
        h('p', { class: 'muted small', style: { margin: '4px 0 0' } }, '下の一覧のチェックを外した試合は確定されません。')) : null,
      h('div', { style: { marginTop: '10px' } }, list.length ? list.map((m) => resultRow(t, cat, m, cache, overdue(m), picked))
        : h('p', { class: 'empty' }, st.resultFilter === 'pending' ? 'すべての試合が確定しています' : '該当する試合はありません')));
  }

  function resultRow(t, cat, m, cache, isOverdue, picked) {
    const home = sideInfo(m, 'home', cat, cache);
    const away = sideInfo(m, 'away', cat, cache);
    const ready = !home.placeholder && !away.placeholder;
    const locked = m.status === 'confirmed';
    let editing = !locked;
    const f = { home_score: m.home_score ?? '', away_score: m.away_score ?? '', home_pk: m.home_pk ?? '', away_pk: m.away_pk ?? '', forfeit: m.forfeit || '' };
    const row = h('div', { class: `result-row${isOverdue ? ' overdue' : ''}${m.status === 'provisional' ? ' provisional' : ''}${m.ref_conflict ? ' conflict' : ''}` });

    const draw = () => {
      const isKo = m.stage === 'knockout';
      const tie = f.home_score !== '' && String(f.home_score) === String(f.away_score);
      const numIn = (key, cls, label) => h('input', { type: 'number', min: 0, max: 99, inputmode: 'numeric', class: cls, value: f[key], disabled: !editing || !ready || !!f.forfeit, 'aria-label': label,
        oninput: (e) => { f[key] = e.target.value; if (key === 'home_score' || key === 'away_score') { const pkNow = f.home_score !== '' && String(f.home_score) === String(f.away_score); if (pkNow !== tie) draw(); } } });
      const save = async (confirm) => {
        const r = await run(() => api('POST', `/api/admin/matches/${m.id}/result`, { ...f, forfeit: f.forfeit || null, confirm }), confirm ? '確定しました' : '保存しました');
        if (r) await reload();
      };
      mount(row,
        h('div', { class: 'rl' },
          m.status === 'provisional' ? h('input', { type: 'checkbox', checked: picked.has(m.id), 'aria-label': 'まとめて確定の対象', style: { width: '20px', height: '20px', accentColor: 'var(--pitch)' },
            onchange: (e) => { if (e.target.checked) picked.add(m.id); else picked.delete(m.id); } }) : null,
          h('div', { class: 'rt' }, toHHMM(m.start_min)),
          h('div', { class: 'muted small' }, courtName(cat.config, m.court))),
        h('div', { class: 'ri' },
          h('div', { class: 'row small' },
            dayTotal(cat.config) > 1 ? h('span', { class: 'tag' }, dayLabel(cat, dayOf(cat.config, m.slot), t, true)) : null,
            h('span', null, m.label),
            locked ? h('span', { class: 'tag done' }, '確定') : m.status === 'provisional' ? h('span', { class: 'tag wait' }, `仮登録：${m.updated_by || ''} ${formatUpdated(m.updated_at)}`) : h('span', { class: 'tag' }, '未登録'),
            isOverdue ? h('span', { class: 'tag alert' }, '確定待ち') : null,
            m.time_changed ? h('span', { class: 'tag changed' }, '時間変更') : null,
            m.corrected ? h('span', { class: 'tag' }, '修正済み') : null,
            m.ref_conflict ? h('span', { class: 'tag alert' }, '予選結果の変更で対戦チームが変わっています。結果を見直してください') : null),
          h('div', { class: 'rs' },
            h('strong', { class: 'rn', style: { textAlign: 'right', color: home.placeholder ? 'var(--ink-2)' : null } }, home.text),
            numIn('home_score', '', `${home.text}の得点`), h('span', null, '-'), numIn('away_score', '', `${away.text}の得点`),
            h('strong', { class: 'rn', style: { color: away.placeholder ? 'var(--ink-2)' : null } }, away.text)),
          isKo && tie && ready && !f.forfeit ? h('div', { class: 'rs small' }, h('span', null, 'PK'), numIn('home_pk', 'pk', 'PK（左）'), h('span', null, '-'), numIn('away_pk', 'pk', 'PK（右）')) : null,
          ready ? h('div', { class: 'rs' },
            editing ? h('select', { style: { width: 'auto', minHeight: '36px' }, 'aria-label': '不戦勝', onchange: (e) => { f.forfeit = e.target.value; draw(); } },
              h('option', { value: '' }, '通常の試合'),
              h('option', { value: 'home', selected: f.forfeit === 'home' }, `${home.text} の不戦勝`),
              h('option', { value: 'away', selected: f.forfeit === 'away' }, `${away.text} の不戦勝`)) : null,
            h('span', { class: 'spacer' }),
            editing ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => save(true) }, locked ? '修正を確定' : 'この結果で確定') : null,
            !locked && editing && m.status === 'none' ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => save(false) }, '仮で保存') : null,
            locked && !editing ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { editing = true; draw(); } }, '修正する') : null,
            locked ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
              if (!(await confirmDialog('確定を取り消します', '閲覧ページから結果が消え、仮登録に戻ります。', '取り消す', true))) return;
              if (await run(() => api('POST', `/api/admin/matches/${m.id}/reopen`), '仮登録に戻しました')) await reload();
            } }, '確定を取り消す') : null,
            m.status === 'provisional' ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
              if (await run(() => api('POST', `/api/admin/matches/${m.id}/clear`), '未登録に戻しました')) await reload();
            } }, '入力を消す') : null,
            t.status === 'live' && m.status === 'none' ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openDelay(cat, m) }, '時間をずらす') : null)
            : h('p', { class: 'muted small', style: { margin: 0 } }, '対戦チームが決まると入力できます')));
    };
    draw();
    return row;
  }

  // ----- 順位 -----

  function standingsTab(t, cat) {
    const tm = teamMap(cat);
    const lotteryPanels = Object.entries(cat.standings || {}).filter(([, s]) => s.needsLottery || s.rows.some((r) => r.lottery)).map(([g, s]) => {
      const order = s.rows.filter((r) => r.tied || r.lottery).map((r) => r.teamId);
      const list = h('div', { class: 'stack' });
      const drawList = () => mount(list, order.map((tid, i) => h('div', { class: 'row' },
        h('span', { class: 'num', style: { width: '28px', fontWeight: 700 } }, i + 1), h('span', null, tm[tid]?.name), h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '上へ', disabled: i === 0, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; drawList(); } }, '↑'),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '下へ', disabled: i === order.length - 1, onclick: () => { [order[i + 1], order[i]] = [order[i], order[i + 1]]; drawList(); } }, '↓'))));
      drawList();
      const how = manualLabel(cat.config);
      const word = how === '本部で決定' ? '本部の決定' : how;
      return h('section', { class: 'panel' },
        h('h2', { style: { marginBottom: '6px' } }, `${cat.standings[g] && cat.standings[g].placement ? g : `${g}組`}の${word}結果`),
        h('p', { class: 'muted small', style: { marginTop: 0 } }, how === 'じゃんけん' ? '並んだチームを、代表者によるじゃんけんの結果どおりの順番に並べて保存してください。'
          : how === '抽選' ? '並んだチームを、抽選の結果どおりの順番に並べて保存してください。'
            : '判定順で決まらなかったチームです。本部で決めた順番に並べて保存してください（判定順に抽選・じゃんけんを入れると、その結果として表示されます）。'),
        list,
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: async () => {
            if (await run(() => api('POST', `/api/admin/categories/${cat.id}/lottery`, { group: g, order }), `${word}結果を保存しました`)) await reload();
          } }, `${word}結果を保存`),
          s.rows.some((r) => r.lottery) ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
            if (await run(() => api('POST', `/api/admin/categories/${cat.id}/lottery`, { group: g, order: [] }), `${word}結果を消しました`)) await reload();
          } }, `${word}結果を消す`) : null));
    });
    const ctx = { tournament: t, myTeam: null };
    return h('div', null,
      cat.config.format !== 'knockout' ? standingsView(cat, ctx) : null,
      lotteryPanels.length ? h('div', { style: { marginTop: '12px' } }, lotteryPanels) : null,
      cat.config.format !== 'league' ? h('section', { style: { marginTop: '16px' } }, h('h2', null, 'トーナメント'), bracketView(cat, ctx)) : null);
  }
}
