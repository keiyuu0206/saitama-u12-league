// 時刻は「その日の0時からの分」で扱う（例: 9:30 → 570）

export const toHHMM = (m) => {
  if (m == null || Number.isNaN(m)) return '--:--';
  const h = Math.floor(m / 60);
  const mm = ((m % 60) + 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};

export const fromHHMM = (s) => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + (m || 0);
};

export const MAX_DAYS = 4;
export const MAX_GROUPS = 26; // A〜Z組

// 枠番号が何日目（0始まり）か
export const dayOf = (cfg, slot) => (cfg.dayBreakSlots || []).filter((b) => slot >= b).length;

// その日の設定（2日目以降は開始時刻を差し替える）
export function dayConfig(cfg, d) {
  if (!d) return cfg;
  const x = (cfg.extraDays || [])[d - 1];
  // 2日目以降は、開始時刻と試合間隔を日ごとに変えられる（空欄なら1日目と同じ）
  return {
    ...cfg,
    startTime: x && x.startTime != null ? x.startTime : cfg.startTime,
    intervalMinutes: x && x.intervalMinutes != null ? x.intervalMinutes : cfg.intervalMinutes,
  };
}

export const CATEGORY_NAMES = ['U7', 'U8', 'U9', 'U10', 'U11', 'U12'];

export const TIEBREAK_KEYS = {
  points: '勝点',
  gd: '得失点差',
  gf: '総得点',
  h2h: '当該チーム間の対戦成績',
  janken: '代表者によるじゃんけん',
  lottery: '抽選',
};

// 既定は「総合成績優先」
export const DEFAULT_TIEBREAK = ['points', 'gd', 'gf', 'h2h', 'lottery'];

export function defaultConfig() {
  return {
    startTime: 540, // 9:00
    periods: 2, // 2: 前後半、1: ハーフなし、3: 3ピリオド
    halfMinutes: 15,
    halftimeMinutes: 5,
    intervalMinutes: 5,
    koGapMinutes: 0, // 同じ日に予選の後に決勝トーナメントが続くとき、その間にあける時間（試合間隔に加えて）
    lunchEnabled: true,
    lunchStart: 720, // 12:00 を過ぎる試合は昼休憩の後に回す
    lunchMinutes: 45,
    minLunchMinutes: 0,
    courts: 2,
    courtNames: [],
    format: 'league', // league | knockout | league_knockout
    groups: 2,
    advance: 2, // リーグ→トーナメントで各組から進出するチーム数（1 or 2）
    rankMode: 'top3', // top3 | top3_shared | all
    tiebreak: [...DEFAULT_TIEBREAK],
    forfeitScore: [3, 0],
    showStandings: true,
    minRestSlots: 1, // 同じチームの試合の間に空ける枠数
    koTiming: { enabled: false, periods: 2, halfMinutes: 15, halftimeMinutes: 5 }, // 決勝トーナメントだけ別の試合時間
    dayDates: [], // このカテゴリが試合をする日（大会の開催期間から選ぶ）
    dayCount: 1, // 開催日数（最大4日）
    extraDays: [], // 2日目以降 [{date, startTime, intervalMinutes（空なら1日目と同じ）}]
    dayBreaks: [], // 各日の区切り（'L2' = リーグ第2節まで、'K0' = トーナメント1段目まで）
    dayBreakSlots: [], // 日程作成時に決まる「◯日目が始まる枠番号」
    grouping: { fixed: {}, separate: [] },
    lottery: {},
  };
}

export function normalizeConfig(c) {
  const d = defaultConfig();
  const out = { ...d, ...(c || {}) };
  out.grouping = { ...d.grouping, ...(out.grouping || {}) };
  out.lottery = out.lottery || {};
  out.courts = Math.max(1, Math.min(12, Number(out.courts) || 1));
  out.groups = Math.max(1, Math.min(MAX_GROUPS, Number(out.groups) || 1));
  // コートの優先順位（コート番号の並び）。範囲外・重複を除き、足りないコートは後ろに番号順で足す
  const pr = (Array.isArray(out.courtPriority) ? out.courtPriority : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < out.courts);
  out.courtPriority = [...new Set(pr)];
  for (let i = 0; i < out.courts; i++) if (!out.courtPriority.includes(i)) out.courtPriority.push(i);
  out.advance = Number(out.advance) === 1 ? 1 : 2;
  for (const k of ['startTime', 'halfMinutes', 'halftimeMinutes', 'intervalMinutes', 'lunchStart', 'lunchMinutes', 'minLunchMinutes', 'minRestSlots']) {
    out[k] = Math.max(0, Number(out[k]) || 0);
  }
  out.koGapMinutes = Math.max(0, Math.min(240, Number(out.koGapMinutes) || 0));
  out.periods = [1, 2, 3].includes(Number(out.periods)) ? Number(out.periods) : 2;
  const kt = out.koTiming && typeof out.koTiming === 'object' ? out.koTiming : {};
  out.koTiming = {
    enabled: !!kt.enabled,
    periods: [1, 2, 3].includes(Number(kt.periods)) ? Number(kt.periods) : 2,
    halfMinutes: Math.max(1, Number(kt.halfMinutes) || 15),
    halftimeMinutes: Math.max(0, Number(kt.halftimeMinutes ?? 5) || 0),
  };
  out.dayDates = [...new Set((Array.isArray(out.dayDates) ? out.dayDates : []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort().slice(0, MAX_DAYS);
  if (out.dayDates.length) out.dayCount = out.dayDates.length;
  out.dayCount = Math.max(1, Math.min(MAX_DAYS, Number(out.dayCount) || 1));
  const ed = Array.isArray(out.extraDays) ? out.extraDays : [];
  out.extraDays = Array.from({ length: out.dayCount - 1 }, (_, i) => ({
    date: (ed[i] && ed[i].date) || '',
    startTime: ed[i] && ed[i].startTime != null && ed[i].startTime !== '' ? Math.max(0, Number(ed[i].startTime) || 0) : out.startTime,
    intervalMinutes: ed[i] && ed[i].intervalMinutes != null && ed[i].intervalMinutes !== '' && Number.isFinite(Number(ed[i].intervalMinutes))
      ? Math.max(0, Math.min(120, Number(ed[i].intervalMinutes))) : null,
  }));
  out.dayBreaks = (Array.isArray(out.dayBreaks) ? out.dayBreaks : []).slice(0, out.dayCount - 1).map(String);
  out.dayBreakSlots = (Array.isArray(out.dayBreakSlots) ? out.dayBreakSlots : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!out.knockoutPlan || typeof out.knockoutPlan !== 'object') {
    // 旧設定（advance / rankMode）から移行
    out.knockoutPlan = { type: 'top', k: out.advance, mode: out.rankMode === 'all' ? 'all' : out.rankMode };
  }
  out.knockoutPlan = { type: 'top', k: 2, mode: 'top3', brackets: [], ...out.knockoutPlan };
  out.knockoutPlan.k = Math.max(1, Math.min(16, Number(out.knockoutPlan.k) || 2));
  out.knockoutPlan.m = Math.max(1, Math.min(16, Number(out.knockoutPlan.m) || out.knockoutPlan.k)); // 上位・中位・下位のときの中位の数
  if (!Array.isArray(out.tiebreak) || !out.tiebreak.length) out.tiebreak = [...DEFAULT_TIEBREAK];
  out.tiebreak = out.tiebreak.filter((k) => k in TIEBREAK_KEYS);
  return out;
}

// 試合の長さ。periods=2 は前後半、1 はハーフなしの1本、3 は3ピリオド
export const matchLength = (c) => {
  const n = c.periods || 2;
  return c.halfMinutes * n + (n > 1 ? c.halftimeMinutes * (n - 1) : 0);
};

export function courtName(c, i) {
  return (c.courtNames && c.courtNames[i]) || `${String.fromCharCode(65 + i)}コート`;
}

// 枠番号ごとの開始時刻。lunchStart をまたぐ試合は昼休憩の後に回す。
// 枠ごとの開始時刻。lenOf(i) で枠ごとに試合の長さを変えられる（予選と決勝で時間が違う場合）
// gapBefore(i)：i 番目の枠の前に、試合間隔に加えてあける時間（予選と決勝トーナメントの間など）
export function slotTimes(c, n, lenOf = () => matchLength(c), gapBefore = () => 0) {
  const out = [];
  let t = c.startTime;
  let lunchDone = !c.lunchEnabled || c.lunchMinutes <= 0;
  let session = 'am';
  for (let i = 0; i < n; i++) {
    const len = lenOf(i);
    const gap = i > 0 ? gapBefore(i) : 0;
    if (!lunchDone && t + gap + len > c.lunchStart) {
      lunchDone = true;
      if (i > 0) {
        // 昼休憩と「試合間隔＋あける時間」の長い方をとる
        t = Math.max(out[i - 1].start + lenOf(i - 1) + c.lunchMinutes, t + gap);
        session = 'pm';
      }
    } else t += gap;
    out.push({ start: t, session });
    t += len + c.intervalMinutes;
  }
  return out;
}

// 試合ごとの長さ（決勝トーナメントだけ別の時間にしている場合に対応）
export function matchLengthFor(c, m) {
  if (m && m.stage === 'knockout' && c.koTiming && c.koTiming.enabled && c.format === 'league_knockout') {
    return matchLength({ ...c, ...c.koTiming });
  }
  return matchLength(c);
}
