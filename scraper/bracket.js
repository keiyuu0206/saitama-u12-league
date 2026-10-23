import { groupLabel } from './grouping.js';

// 参照(ref)の形式
//   {t:'team', id}          確定したチーム
//   {t:'grp', g:'A', r:1}   A組1位
//   {t:'win', m:'K3'}       試合K3の勝者
//   {t:'lose', m:'K3'}      試合K3の敗者

const isPow2 = (n) => n >= 2 && (n & (n - 1)) === 0;
const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };

export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

const mainName = (size) => (size === 2 ? '決勝' : size === 4 ? '準決勝' : size === 8 ? '準々決勝' : null);

/**
 * クロス方式の1回戦の並び。隣り合う2つが対戦し、勝者同士も隣から当たる。
 * k=2: [A1,B2, C1,D2, | B1,A2, D1,C2] → 同組の1位と2位は決勝まで当たらない
 * k=1: [A1,B1, C1,D1]
 */
export function crossEntrants(G, k, rankOffset = 0) {
  const L = Array.from({ length: G }, (_, i) => groupLabel(i));
  const r1 = rankOffset + 1;
  const r2 = rankOffset + 2;
  const out = [];
  if (k === 1) {
    for (const g of L) out.push({ t: 'grp', g, r: r1 });
    return out;
  }
  for (let i = 0; i < G / 2; i++) out.push({ t: 'grp', g: L[2 * i], r: r1 }, { t: 'grp', g: L[2 * i + 1], r: r2 });
  for (let i = 0; i < G / 2; i++) out.push({ t: 'grp', g: L[2 * i + 1], r: r1 }, { t: 'grp', g: L[2 * i], r: r2 });
  return out;
}

// 2チームが最も早く当たるラウンド（大きいほど後で当たる）
const meetRound = (p, q) => Math.floor(Math.log2(p ^ q)) + 1;

/**
 * 同じ組のチームができるだけ後で当たるように枠へ配置する。
 * refs は強い順（1位の組 → 2位の組 …）。上位ほど小さいシード番号（不戦はシード上位に入る）。
 * 戻り値は枠の並び（不戦の枠は null）
 */
export function seedPositions(refs) {
  const N = refs.length;
  const S = nextPow2(N);
  const order = seedOrder(S);
  const slots = new Array(S).fill(null);
  const open = new Set(order.map((seed, pos) => (seed <= N ? pos : -1)).filter((p) => p >= 0));
  const placed = [];
  for (const ref of refs) {
    let best = null;
    for (const pos of open) {
      const same = placed.filter((x) => x.ref.g === ref.g);
      const sep = same.length ? Math.min(...same.map((x) => meetRound(pos, x.pos))) : Infinity;
      const cand = { pos, sep, seed: order[pos] };
      if (!best || cand.sep > best.sep || (cand.sep === best.sep && cand.seed < best.seed)) best = cand;
    }
    open.delete(best.pos);
    slots[best.pos] = ref;
    placed.push({ ref, pos: best.pos });
  }
  return slots;
}

class Builder {
  constructor() { this.matches = []; this.n = 0; }
  add(m) {
    // リーグ戦の段の試合は R、トーナメントは K で始まるコードにする
    const code = `${m.league ? 'R' : 'K'}${++this.n}`;
    this.matches.push({ code, seq: this.n, ...m });
    return code;
  }

  // 勝ち上がり方式（1〜3位）。entrants には不戦（null）を含められる
  // prefix: 複数トーナメントのときの名前、offset: 全体順位へのずらし幅
  single(entrants, mode, prefix = '', offset = 0, bracket = null) {
    const L = (x) => (prefix ? `${prefix} ${x}` : x);
    let cur = entrants;
    let level = 0;
    let roundIdx = 1;
    let semis = [];
    while (cur.length > 1) {
      const size = cur.length;
      const name = L(mainName(size) || `${roundIdx}回戦`);
      const next = [];
      const codes = [];
      for (let i = 0; i < size; i += 2) {
        const a = cur[i];
        const b = cur[i + 1];
        if (!a && !b) next.push(null);
        else if (!a) next.push(b);
        else if (!b) next.push(a);
        else {
          const final = size === 2;
          const code = this.add({ home: a, away: b, label: name, level, base: offset + 1, bracket, place_w: final ? offset + 1 : null, place_l: final ? offset + 2 : null });
          codes.push(code);
          next.push({ t: 'win', m: code });
        }
      }
      if (size === 4) semis = codes;
      cur = next;
      level++;
      roundIdx++;
    }
    const byCode = (c) => this.matches.find((m) => m.code === c);
    if (mode === 'top3' && semis.length === 2) {
      this.add({ home: { t: 'lose', m: semis[0] }, away: { t: 'lose', m: semis[1] }, label: L('3位決定戦'), level: level - 1, base: offset + 3, bracket, place_w: offset + 3, place_l: offset + 4 });
    } else if (semis.length) {
      for (const c of semis) byCode(c).place_l = offset + 3;
    }
  }

  // 全順位決定。不戦（null）があっても順位を決める（試合をしない枠は、相手側の結果で順位を割り当てる）
  placement(entrants, base, level, prefix = '', offset = 0, bracket = null) {
    const L = (x) => (prefix ? `${prefix} ${x}` : x);
    const size = entrants.length;
    const real = entrants.filter(Boolean);
    if (!real.length) return;
    if (size === 2) {
      if (real.length === 2) {
        this.add({ home: entrants[0], away: entrants[1], label: L(base === 1 ? '決勝' : `${base}位決定戦`), level, base: offset + base, bracket, place_w: offset + base, place_l: offset + base + 1 });
      } else {
        this.assignPlace(real[0], offset + base);
      }
      return;
    }
    const round = mainName(size) || '1回戦';
    const label = L(base === 1 ? round : `${base}〜${base + size - 1}位 ${round}`);
    const winners = [];
    const losers = [];
    for (let i = 0; i < size; i += 2) {
      const a = entrants[i];
      const b = entrants[i + 1];
      if (a && b) {
        const code = this.add({ home: a, away: b, label, level, base: offset + base, bracket });
        winners.push({ t: 'win', m: code });
        losers.push({ t: 'lose', m: code });
      } else {
        winners.push(a || b || null);
        losers.push(null);
      }
    }
    this.placement(winners, base, level + 1, prefix, offset, bracket);
    this.placement(losers, base + size / 2, level + 1, prefix, offset, bracket);
  }

  // 試合をせずに順位が決まるとき（相手が不戦）、その順位を元の試合の勝者・敗者に付ける
  assignPlace(ref, place) {
    if (!ref || (ref.t !== 'win' && ref.t !== 'lose')) return;
    const m = this.matches.find((x) => x.code === ref.m);
    if (!m) return;
    if (ref.t === 'win') m.place_w = place;
    else m.place_l = place;
  }

  finish() {
    const count = {};
    for (const m of this.matches) if (!m.league) count[m.label] = (count[m.label] || 0) + 1;
    const seen = {};
    for (const m of this.matches) {
      if (count[m.label] > 1) {
        seen[m.label] = (seen[m.label] || 0) + 1;
        m.label = `${m.label} ${seen[m.label]}`;
      }
    }
    // 消化順: 段階が浅い順、同じ段階では下位の順位決定から（全体の決勝を最後に）
    return this.matches.sort((a, b) => a.level - b.level || b.base - a.base || a.seq - b.seq);
  }
}

export const MODE_LABEL = { top3: '1〜3位を決める（3位決定戦あり）', top3_shared: '1〜3位を決める（3位は2チーム）', all: '全順位を決める（順位決定戦）' };
export const PLAN_LABEL = { top: '上位チームだけでトーナメント', all: '全チームで1つのトーナメント', split: '上位トーナメントと下位トーナメント', split3: '上位・中位・下位トーナメント', byrank: '同じ順位どうしでトーナメント', custom: '自由に設定する' };

/**
 * 決勝トーナメントの構成を、実際の組の人数に合わせて展開する
 * plan: { type, k, mode, brackets: [{name, from, to, mode}] }
 */
export function expandPlan(plan, maxRank) {
  const k = Math.max(1, Math.min(maxRank, Number(plan.k) || 2));
  const mode = plan.mode || 'top3';
  let list;
  if (plan.type === 'all') list = [{ name: '決勝トーナメント', from: 1, to: maxRank }];
  else if (plan.type === 'split') list = [{ name: '上位トーナメント', from: 1, to: k }, { name: '下位トーナメント', from: k + 1, to: maxRank }];
  else if (plan.type === 'split3') {
    // 各組 1〜k位 が上位、k+1〜k+m位 が中位、それより下が下位
    const m = Math.max(1, Math.min(maxRank, Number(plan.m) || k));
    list = [{ name: '上位トーナメント', from: 1, to: k }, { name: '中位トーナメント', from: k + 1, to: k + m }, { name: '下位トーナメント', from: k + m + 1, to: maxRank }];
  }
  else if (plan.type === 'byrank') list = Array.from({ length: maxRank }, (_, i) => ({ name: `${i + 1}位トーナメント`, from: i + 1, to: i + 1 }));
  // 自由に設定：各段の名前・範囲・順位の決め方・形式（トーナメント／リーグ戦）をそのまま使う
  else if (plan.type === 'custom') list = (plan.brackets || []).map((b, i) => ({ name: b.name || `トーナメント${i + 1}`, from: Number(b.from) || 1, to: Number(b.to) || 1, mode: b.mode, format: b.format }));
  else list = [{ name: '決勝トーナメント', from: 1, to: k }];
  // 段ごとに「トーナメント」か「リーグ戦」かを選べる（plan.formats[段の番号] = 'league'）。リーグ戦なら名前も「〜リーグ」に
  const formats = plan.formats || {};
  return list.map((b, i) => {
    const format = (plan.type === 'custom' ? b.format || formats[i] : formats[i]) === 'league' ? 'league' : 'knockout';
    const name = format === 'league' && plan.type !== 'custom' ? b.name.replace(/トーナメント$/, 'リーグ') : b.name;
    return { ...b, name, format };
  }).filter((b) => b.from <= b.to && b.from <= maxRank).map((b) => ({ ...b, to: Math.min(b.to, maxRank), mode: b.mode || mode }));
}

// リーグ戦の段の試合か（予選の後に、順位の枠どうしで総当たりをする）
export const isRankLeague = (m) => m && m.stage === 'knockout' && /^R\d/.test(m.code || '');

// 総当たりの組み合わせ（サークル方式。奇数なら1チームずつ休み）
function roundRobinIdx(n) {
  const t = Array.from({ length: n }, (_, i) => i);
  if (t.length % 2) t.push(null);
  const m = t.length;
  const rounds = [];
  for (let r = 0; r < m - 1; r++) {
    const pairs = [];
    for (let i = 0; i < m / 2; i++) {
      const a = t[i], b = t[m - 1 - i];
      if (a != null && b != null) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    t.splice(1, 0, t.pop());
  }
  return rounds;
}

/**
 * ctx.format = 'knockout' のとき ctx.teamIds（抽選済みの並び）
 * ctx.format = 'league_knockout' のとき ctx.groupSizes（{A:4, B:4,...}）
 */
export function buildKnockout(cfg, ctx) {
  const b = new Builder();

  if (ctx.format === 'knockout') {
    const mode = cfg.rankMode;
    const n = ctx.teamIds.length;
    if (n < 2) return { matches: [], error: 'トーナメントには2チーム以上が必要です' };
    const size = nextPow2(n);
    const order = seedOrder(size);
    const entrants = order.map((seed) => (seed <= n ? { t: 'team', id: ctx.teamIds[seed - 1] } : null));
    if (mode === 'all') b.placement(entrants, 1, 0);
    else b.single(entrants, mode);
    return { matches: b.finish() };
  }

  const groups = Object.keys(ctx.groupSizes).sort();
  const G = groups.length;
  const maxRank = Math.max(...Object.values(ctx.groupSizes));
  const brackets = expandPlan(cfg.knockoutPlan || {}, maxRank);
  if (!brackets.length) return { matches: [], error: '決勝トーナメントの設定を確認してください' };
  const multi = brackets.length > 1;
  let offset = 0;
  let built = 0;
  for (const br of brackets) {
    const refs = [];
    for (let r = br.from; r <= br.to; r++) for (const g of groups) if (ctx.groupSizes[g] >= r) refs.push({ t: 'grp', g, r });
    const N = refs.length;
    if (N < 2) { offset += N; continue; }
    const k = br.to - br.from + 1;
    const cross = [2, 4, 8].includes(G) && k <= 2 && groups.every((g) => ctx.groupSizes[g] >= br.to);
    const entrants = cross ? crossEntrants(G, k, br.from - 1) : seedPositions(refs);
    const prefix = multi ? br.name : '';
    const tag = multi ? br.name : null;
    if (br.format === 'league') {
      // リーグ戦の段：順位の枠どうしの総当たり。第n節を段（level）として日程に並べる
      roundRobinIdx(N).forEach((pairs, r) => pairs.forEach(([i, j]) => {
        b.add({ home: refs[i], away: refs[j], label: `${br.name} 第${r + 1}節`, level: r, base: offset + 1, bracket: br.name, league: true });
      }));
      offset += N;
      built++;
      continue;
    }
    if (br.mode === 'all') b.placement(entrants, 1, 0, prefix, offset, tag);
    else b.single(entrants, br.mode, prefix, offset, tag);
    offset += N;
    built++;
  }
  if (!built) return { matches: [], error: 'トーナメントに進むチームが2チーム未満です' };
  return { matches: b.finish() };
}

export function refText(ref, byCode) {
  if (!ref) return '未定';
  if (ref.t === 'grp') return `${ref.g}組${ref.r}位`;
  if (ref.t === 'win' || ref.t === 'lose') {
    const m = byCode && byCode[ref.m];
    return `${m ? m.label : ref.m}の${ref.t === 'win' ? '勝者' : '敗者'}`;
  }
  return '未定';
}
