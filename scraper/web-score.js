// スコア管理者の画面：結果の承認だけを行う（主にスマートフォン）
import { api } from './web-api.js';
import { h, mount, modal, confirmDialog, toast, run, markFetched, refreshButton, toHHMM, formatDate, sheet, store, formatUpdated, MANUALS } from './web-ui.js';
import { teamMap, codeMap, sideInfo, courtName, dayOf, dayTotal, dayLabel, absMin, crest } from './web-views.js';

const STATUS = { published: '公開中', live: '開催中', finished: '終了' };

export async function scoreApp(root, me) {
  const st = { tid: store.get('score:tid'), catId: null, tab: 'pending', data: null, rev: null, stop: null };

  const header = () => h('header', { class: 'site-head sc-head' }, h('div', { class: 'wrap' },
    h('div', { class: 'sc-who' }, h('strong', null, '結果の承認'), h('small', null, `${me.name}（${me.region || me.parentName || ''}）`)),
    h('span', { class: 'spacer' }),
    h('a', { class: 'sc-mini', href: MANUALS.scorer.href, target: '_blank', rel: 'noopener', style: { textDecoration: 'none' } }, '使い方'),
    h('button', { class: 'sc-mini', type: 'button', onclick: changePassword }, 'パスワード変更'),
    h('button', { class: 'sc-mini', type: 'button', onclick: async () => { await api('POST', '/api/admin/logout'); location.href = '/admin'; } }, 'ログアウト')));

  // ---------- 大会の一覧 ----------
  async function list() {
    if (st.stop) { st.stop(); st.stop = null; }
    const { tournaments } = await api('GET', '/api/score/tournaments');
    if (tournaments.length === 1 && !st.listShown) return open(tournaments[0].id);
    mount(root, header(), h('main', { class: 'wrap sc-main' },
      h('h2', { class: 'sc-title' }, '担当する大会'),
      tournaments.length ? tournaments.map((t) => h('button', { class: 'sc-tcard', type: 'button', onclick: () => open(t.id) },
        h('div', null, h('strong', null, t.name), h('small', null, [t.date ? formatDate(t.date) : '', STATUS[t.status]].filter(Boolean).join('　'))),
        t.pending ? h('span', { class: 'sc-badge' }, `承認待ち ${t.pending}`) : h('span', { class: 'sc-badge zero' }, '承認待ちなし')))
        : h('p', { class: 'empty' }, '担当する大会はまだ公開されていません。公開されると、ここに表示されます。')));
  }

  // ---------- 大会の画面 ----------
  async function open(tid) {
    st.tid = tid; store.set('score:tid', tid); st.rev = null;
    if (!(await load())) return;
    draw();
    // 自動更新はしない。最新の情報は「更新」ボタン（取得した時刻つき）で読み込む
  }

  // 新しい仮登録を読み込む（ボタン・画面に戻ってきたとき）
  async function refresh(fromButton = true) {
    if (document.querySelector('.modal-back, .sheet-back')) return false;
    const before = pendingCount();
    const changed = await load();
    if (changed) {
      draw();
      const after = pendingCount();
      if (after > before) { toast(`新しい仮登録が${after - before}件あります`); return fromButton ? 'quiet' : true; }
    }
    return changed;
  }

  async function load() {
    try {
      const r = await api('GET', `/api/score/tournaments/${st.tid}${st.rev != null ? `?rev=${st.rev}` : ''}`);
      markFetched();
      if (r.unchanged) return false;
      st.data = r; st.rev = r.rev;
      if (!st.catId || !r.categories.some((c) => c.id === st.catId)) st.catId = r.categories[0] && r.categories[0].id;
      return true;
    } catch (e) {
      toast(e.message, true);
      st.listShown = true; store.set('score:tid', null);
      list();
      return false;
    }
  }

  const pendingCount = () => (st.data ? st.data.categories.reduce((a, c) => a + c.matches.filter((m) => m.status === 'provisional').length, 0) : 0);
  const reload = async () => { st.rev = null; if (await load()) draw(); };

  function draw() {
    const { tournament: t, categories } = st.data;
    const cat = categories.find((c) => c.id === st.catId);
    const pendAll = pendingCount();
    mount(root, header(), h('main', { class: 'wrap sc-main' },
      h('div', { class: 'sc-thead' },
        h('div', null, h('strong', null, t.name), h('small', null, STATUS[t.status] || '')),
        h('button', { class: 'sc-mini dark', type: 'button', onclick: () => { st.listShown = true; list(); } }, '大会を選ぶ')),
      categories.length > 1 ? h('div', { class: 'chips' }, categories.map((c) => {
        const n = c.matches.filter((m) => m.status === 'provisional').length;
        return h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(c.id === st.catId), onclick: () => { st.catId = c.id; draw(); } },
          c.name, n ? h('span', { class: 'tag alert', style: { marginLeft: '6px' } }, n) : null);
      })) : null,
      h('div', { class: 'sc-tabs', role: 'tablist' },
        [['pending', `承認待ち（${cat ? cat.matches.filter((m) => m.status === 'provisional').length : 0}）`], ['all', '試合一覧']].map(([k, l]) =>
          h('button', { type: 'button', role: 'tab', 'aria-selected': String(st.tab === k), onclick: () => { st.tab = k; draw(); } }, l))),
      !cat ? h('p', { class: 'empty' }, 'カテゴリがありません')
        : st.tab === 'pending' ? pendingView(t, cat) : allView(t, cat),
      h('p', { class: 'sc-foot muted small' }, `この大会の承認待ち：全${pendAll}件　新しい仮登録は「更新」を押すと表示されます`),
      refreshButton(async () => { const r = await refresh(); return r === 'quiet' ? true : r; })));
  }

  const cacheOf = (cat) => ({ teams: teamMap(cat), codes: codeMap(cat) });
  const when = (t, cat, m) => `${dayTotal(cat.config) > 1 ? `${dayLabel(cat, dayOf(cat.config, m.slot), t, true)} ` : ''}${toHHMM(m.start_min)}　${courtName(cat.config, m.court)}`;
  const teamLine = (cat, cache, m, side, score, pk) => {
    const info = sideInfo(m, side, cat, cache);
    return h('div', { class: 'sc-team' }, crest(info.team, 26), h('span', { class: 'sc-tname' }, info.text),
      h('span', { class: 'sc-score' }, score ?? '–', pk != null ? h('small', null, `PK ${pk}`) : null));
  };

  // 承認待ち
  function pendingView(t, cat) {
    const cache = cacheOf(cat);
    const list = cat.matches.filter((m) => m.status === 'provisional').sort((a, b) => absMin(cat.config, a) - absMin(cat.config, b));
    if (!list.length) return h('p', { class: 'empty' }, '承認待ちの結果はありません。関係者が仮登録すると、ここに表示されます。');
    return h('div', null,
      list.length > 1 ? h('button', { class: 'btn btn-block sc-bulk', type: 'button', onclick: async () => {
        if (!(await confirmDialog(`${list.length}試合をまとめて承認します`, '表示中の仮登録の結果を、そのまま確定します。PK戦の結果が必要な試合は承認されません。', 'まとめて承認'))) return;
        const r = await run(() => api('POST', `/api/admin/categories/${cat.id}/confirm`, { matchIds: list.map((m) => m.id) }));
        if (r) { toast(`${r.confirmed}試合を承認しました${r.skipped ? `（PKの結果が必要な${r.skipped}試合を除く）` : ''}`); reload(); }
      } }, `表示中の${list.length}試合をまとめて承認`) : null,
      list.map((m) => h('article', { class: 'sc-card' },
        h('div', { class: 'sc-meta' }, h('span', null, when(t, cat, m)), h('span', null, m.label)),
        teamLine(cat, cache, m, 'home', m.home_score, m.home_pk),
        teamLine(cat, cache, m, 'away', m.away_score, m.away_pk),
        m.updated_by ? h('div', { class: 'sc-by' }, `仮登録：${m.updated_by}${m.updated_at ? `（${formatUpdated(m.updated_at)}）` : ''}`) : null,
        h('div', { class: 'sc-actions' },
          h('button', { class: 'btn btn-primary sc-ok', type: 'button', onclick: async () => {
            const r = await run(() => api('POST', `/api/admin/matches/${m.id}/result`, { home_score: m.home_score, away_score: m.away_score, home_pk: m.home_pk, away_pk: m.away_pk, confirm: true }), '承認しました');
            if (r) reload();
          } }, '承認'),
          h('button', { class: 'btn', type: 'button', onclick: () => editor(t, cat, m) }, '修正して承認'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
            if (!(await confirmDialog('差し戻します', '仮登録の結果を取り消して「未登録」に戻します。関係者に入力し直してもらってください。', '差し戻す', true))) return;
            if (await run(() => api('POST', `/api/admin/matches/${m.id}/clear`), '差し戻しました')) reload();
          } }, '差し戻し')))));
  }

  // 試合一覧（未登録の試合の入力にも使う）
  function allView(t, cat) {
    const cache = cacheOf(cat);
    const list = [...cat.matches].sort((a, b) => absMin(cat.config, a) - absMin(cat.config, b));
    if (!list.length) return h('p', { class: 'empty' }, '日程はまだありません');
    const LBL = { none: '未登録', provisional: '承認待ち', confirmed: '確定' };
    return h('div', { class: 'sc-all' }, list.map((m) => {
      const ready = m.home_team_id && m.away_team_id;
      const can = ready && m.status !== 'confirmed';
      return h('button', { class: `sc-row ${m.status}`, type: 'button', disabled: !can, onclick: () => editor(t, cat, m) },
        h('span', { class: 'sc-rtime' }, toHHMM(m.start_min), h('small', null, courtName(cat.config, m.court))),
        h('span', { class: 'sc-rteams' },
          h('span', null, sideInfo(m, 'home', cat, cache).text), h('span', null, sideInfo(m, 'away', cat, cache).text)),
        h('span', { class: 'sc-rscore' }, m.home_score != null ? `${m.home_score} - ${m.away_score}` : ''),
        h('span', { class: `sc-rstat ${m.status}` }, ready ? LBL[m.status] : '対戦未定'));
    }));
  }

  // スコアの入力・修正（＋−で数える）して承認
  function editor(t, cat, m) {
    const cache = cacheOf(cat);
    const v = { h: m.home_score ?? 0, a: m.away_score ?? 0, hp: m.home_pk ?? 0, ap: m.away_pk ?? 0 };
    const ko = m.stage === 'knockout';
    const body = h('div');
    const step = (key, label) => h('div', { class: 'sc-step' },
      h('span', { class: 'sc-step-name' }, label),
      h('button', { type: 'button', class: 'sc-pm', 'aria-label': `${label}を1減らす`, onclick: () => { v[key] = Math.max(0, v[key] - 1); draw2(); } }, '−'),
      h('output', null, v[key]),
      h('button', { type: 'button', class: 'sc-pm plus', 'aria-label': `${label}を1増やす`, onclick: () => { v[key] = Math.min(99, v[key] + 1); draw2(); } }, '＋'));
    const draw2 = () => mount(body, h('div', { class: 'stack' },
      h('div', { class: 'sc-meta' }, h('span', null, when(t, cat, m)), h('span', null, m.label)),
      step('h', sideInfo(m, 'home', cat, cache).text),
      step('a', sideInfo(m, 'away', cat, cache).text),
      ko && v.h === v.a ? h('div', { class: 'sc-pk' }, h('div', { class: 'small', style: { fontWeight: 700 } }, '同点のときはPK戦の結果'),
        step('hp', `${sideInfo(m, 'home', cat, cache).text}（PK）`), step('ap', `${sideInfo(m, 'away', cat, cache).text}（PK）`)) : null,
      h('button', { class: 'btn btn-primary btn-block sc-ok', type: 'button', onclick: async () => {
        const tie = ko && v.h === v.a;
        if (tie && v.hp === v.ap) return toast('PK戦の結果で勝敗が決まるように入力してください', true);
        const r = await run(() => api('POST', `/api/admin/matches/${m.id}/result`, { home_score: v.h, away_score: v.a, home_pk: tie ? v.hp : null, away_pk: tie ? v.ap : null, confirm: true }), 'この結果で承認しました');
        if (r) { document.querySelector('.sheet-back')?.remove(); reload(); }
      } }, 'この結果で承認（確定）')));
    draw2();
    sheet({ title: m.status === 'provisional' ? '修正して承認' : '結果を入力して確定', content: body });
  }

  function changePassword() {
    const f = { current: '', next: '', again: '' };
    const inp = (k, label, ac) => h('label', { class: 'field' }, h('span', null, label), h('input', { type: 'password', autocomplete: ac, oninput: (e) => { f[k] = e.target.value; } }));
    modal({
      title: 'パスワードを変更',
      content: h('div', { class: 'stack' }, inp('current', '今のパスワード', 'current-password'), inp('next', '新しいパスワード（10文字以上）', 'new-password'), inp('again', '新しいパスワード（確認）', 'new-password')),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '変更する', kind: 'btn-primary', onClick: async () => {
        if (f.next !== f.again) { toast('新しいパスワードが一致しません', true); return true; }
        return (await run(() => api('POST', '/api/admin/password', { current: f.current, next: f.next }), 'パスワードを変更しました')) ? undefined : true;
      } }],
    });
  }

  if (st.tid) await open(st.tid); else await list();
}
