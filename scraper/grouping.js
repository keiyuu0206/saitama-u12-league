export const groupLabel = (i) => String.fromCharCode(65 + i); // A, B, C...

export function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 円環方式の総当たり。戻り値は節（ラウンド）ごとの対戦ペア配列
export function roundRobin(ids) {
  const t = [...ids];
  if (t.length % 2) t.push(null);
  const n = t.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = t[i];
      const b = t[n - 1 - i];
      if (a && b) pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    t.splice(1, 0, t.pop());
  }
  return rounds;
}

/**
 * 制約付きランダム組み分け
 * teams: [{id, name, club}]
 * opts: { groups, fixed: {teamId: 'A'}, separate: [[id, id], ...] }
 * 同じクラブ名のチームは自動的に別の組にする
 */
export function assignGroups(teams, { groups, fixed = {}, separate = [] }, rnd = Math.random) {
  const G = Math.max(1, groups);
  const labels = Array.from({ length: G }, (_, i) => groupLabel(i));
  const base = Math.floor(teams.length / G);
  const extra = teams.length % G;

  const conflicts = (a, b) => {
    if (a.club && b.club && a.club.trim() && a.club.trim() === b.club.trim()) return true;
    return separate.some(([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id));
  };

  let best = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    // 人数の多い組をランダムに決める
    const capOrder = shuffle(labels, rnd);
    const cap = Object.fromEntries(labels.map((l) => [l, base + (capOrder.indexOf(l) < extra ? 1 : 0)]));
    const members = Object.fromEntries(labels.map((l) => [l, []]));
    let penalty = 0;

    const fixedTeams = teams.filter((t) => fixed[t.id] && labels.includes(fixed[t.id]));
    for (const t of fixedTeams) {
      const g = fixed[t.id];
      if (members[g].length >= cap[g]) {
        // 固定先が満員なら枠を融通する
        const donor = labels.find((l) => l !== g && cap[l] > members[l].length && cap[l] > base);
        if (donor) { cap[donor]--; cap[g]++; }
      }
      members[g].push(t);
    }

    const rest = shuffle(teams.filter((t) => !fixedTeams.includes(t)), rnd);
    // 制約の多いチームから先に置く
    const weight = (t) => separate.filter((p) => p.includes(t.id)).length + (t.club ? teams.filter((o) => o !== t && o.club && o.club === t.club).length : 0);
    rest.sort((a, b) => weight(b) - weight(a));

    for (const t of rest) {
      const open = labels.filter((l) => members[l].length < cap[l]);
      const clean = open.filter((l) => !members[l].some((m) => conflicts(m, t)));
      const pool = clean.length ? clean : open;
      if (!clean.length) penalty++;
      const minSize = Math.min(...pool.map((l) => members[l].length));
      const cands = pool.filter((l) => members[l].length === minSize);
      const g = cands[Math.floor(rnd() * cands.length)];
      members[g].push(t);
    }

    if (!best || penalty < best.penalty) best = { penalty, members };
    if (penalty === 0) break;
  }

  const assignment = {};
  for (const [g, list] of Object.entries(best.members)) for (const t of list) assignment[t.id] = g;

  const warnings = [];
  for (const [g, list] of Object.entries(best.members)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (conflicts(list[i], list[j])) warnings.push(`${list[i].name} と ${list[j].name} が同じ${g}組になりました`);
      }
    }
  }
  return { assignment, warnings };
}
