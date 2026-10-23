// 大会要項：項目の編集、プリセット、PDF出力
import { api } from './web-api.js';
import { h, mount, modal, toast, confirmDialog, run, formatDate, resizeBanner, icon } from './web-ui.js';
import { dayTotal, dayDate, TIEBREAK_LABEL, matchLength, matchLengthFor, planBrackets } from './web-views.js';
import { openPreview, periodText, qrBlock, viewerUrl } from './web-print.js';

// ---------- 初期値（サンプルの要項と同じ構成） ----------

export function defaultOutline(t) {
  return {
    title: t.name || '',
    subtitle: '',
    catch: '',
    info: [
      { label: '大会名', value: '', auto: 'name' },
      { label: '主催・運営', value: '' },
      { label: '協賛', value: '', auto: 'sponsors' },
      { label: '開催日時', value: '', auto: 'dates' },
      { label: '会場', value: '', auto: 'venue' },
      { label: '参加チーム', value: '', auto: 'teams' },
      { label: '表彰', value: '' },
      { label: '副賞', value: '' },
    ],
    sections: [
      { title: '競技規則', auto: '', body: '●日本サッカー協会競技規則に準ずる\n●８人制', images: [] },
      { title: '競技日程', auto: 'schedule', body: '', images: [] },
      { title: '順位決定方法', auto: 'ranking', body: '●警告・退場はその試合限りとし累積はしない。（退場は補充可）', images: [] },
      { title: '審判', auto: '', body: '', images: [] },
      { title: '参加費', auto: '', body: '', images: [] },
      { title: '注意・連絡事項', auto: '', body: '', images: [] },
      { title: '施設案内', auto: '', body: '', images: [] },
    ],
  };
}

const AUTO_INFO = { name: '大会名', sponsors: 'スポンサー名', dates: '開催期間', venue: '会場', teams: 'カテゴリとチーム数' };
const AUTO_SECTION = { '': '自分で入力', schedule: '競技日程を自動で作る', ranking: '順位決定方法を自動で作る' };

// ---------- 設定から文章を作る ----------

const md = (date) => { const d = new Date(`${date}T00:00:00`); return `${d.getMonth() + 1}月${d.getDate()}日（${'日月火水木金土'[d.getDay()]}）`; };
const circled = (i) => '①②③④⑤⑥⑦⑧⑨⑩'[i] || `${i + 1}.`;
function timeText(c) {
  const n = c.periods || 2;
  if (n === 1) return `${c.halfMinutes}分（ハーフなし）`;
  if (n === 2) return `${c.halfMinutes}分-${c.halftimeMinutes}分-${c.halfMinutes}分`;
  return `${c.halfMinutes}分×${n}ピリオド（休憩${c.halftimeMinutes}分）`;
}
function groupSizes(cat) {
  const sizes = {};
  for (const x of cat.teams) if (x.group_label) sizes[x.group_label] = (sizes[x.group_label] || 0) + 1;
  if (Object.keys(sizes).length) return sizes;
  const G = Math.max(1, cat.config.groups || 1);
  const n = Math.max(cat.teams.length, G * 2);
  return Object.fromEntries(Array.from({ length: G }, (_, i) => [String.fromCharCode(65 + i), Math.floor(n / G) + (i < n % G ? 1 : 0)]));
}

export function autoInfo(key, t, cats) {
  if (key === 'name') return t.name || '';
  if (key === 'venue') return t.venue || '';
  if (key === 'sponsors') return (t.sponsors || []).map((x) => x.name).join(' / ');
  if (key === 'teams') return cats.map((c) => `カテゴリー${c.name} / ${c.teams.length}チーム`).join('\n');
  if (key === 'dates') {
    if (!t.date) return '';
    const days = [];
    for (let i = 0; i < 4; i++) {
      const d = new Date(`${t.date}T00:00:00`); d.setDate(d.getDate() + i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (i > 0 && (!t.end_date || iso > t.end_date)) break;
      days.push(iso);
    }
    return days.length > 1 ? `${formatDate(days[0])} 〜 ${days.slice(1).map(md).join('・')}` : formatDate(days[0]);
  }
  return '';
}

export function autoSection(key, t, cats) {
  const lines = [];
  for (const cat of cats) {
    const cfg = cat.config;
    if (cats.length > 1) lines.push(`【${cat.name}】`);
    if (key === 'schedule') {
      const sizes = groupSizes(cat);
      const G = Object.keys(sizes).length;
      const sz = [...new Set(Object.values(sizes))].sort((a, b) => b - a).join('・');
      const hasLeague = cfg.format !== 'knockout';
      const hasKo = cfg.format !== 'league';
      const koTime = cfg.format === 'league_knockout' && cfg.koTiming && cfg.koTiming.enabled ? { ...cfg, ...cfg.koTiming } : cfg;
      const days = dayTotal(cfg);
      // 日ごとに、予選とトーナメントのどちらがあるか（日程を作っていれば実際の日程から）
      const perDay = Array.from({ length: days }, () => new Set());
      if (cat.matches.length) {
        for (const m of cat.matches) perDay[(cfg.dayBreakSlots || []).filter((b) => m.slot >= b).length]?.add(m.stage);
      } else if (days === 1) { if (hasLeague) perDay[0].add('league'); if (hasKo) perDay[0].add('knockout'); }
      else { if (hasLeague) perDay[0].add('league'); if (hasKo) perDay[days - 1].add('knockout'); }
      for (let d = 0; d < days; d++) {
        const date = dayDate(cat, d, t);
        const head = days > 1 ? `●${d + 1}日目${date ? ` ${md(date)}` : ''}：` : '●';
        const parts = [];
        if (perDay[d].has('league')) parts.push(`予選リーグ：${timeText(cfg)}`);
        if (perDay[d].has('knockout')) parts.push(`${cfg.format === 'knockout' ? 'トーナメント' : planBrackets(cat).some((b) => b.format === 'league') ? '決勝トーナメント・順位決定戦' : '決勝トーナメント・順位トーナメント'}：${timeText(koTime)}`);
        if (parts.length) lines.push(head + parts.join(' ／ '));
        if (perDay[d].has('league') && G) lines.push(`　${Object.keys(sizes).sort().join('.')}の${G}ブロック${sz}チームのリーグ戦`);
      }
      if (hasLeague && hasKo) {
        for (const b of planBrackets(cat)) {
          if (b.n < 2) continue;
          const range = b.from === b.to ? `${b.from}位` : `${b.from}〜${b.to}位`;
          lines.push(b.format === 'league' ? `※${b.name}　予選${range}のチームによる総当たり（全${b.n}チーム）` : `※${b.name}　予選${range}のチームが進出（全${b.n}チーム）`);
        }
      } else if (cfg.format === 'knockout') lines.push(`※${cat.teams.length}チームによるトーナメント`);
    }
    if (key === 'ranking') {
      if (cfg.format !== 'knockout') {
        lines.push('●予選は勝ち点による順位決定　勝ち：３点 / 引き分け：１点 / 負け：０点');
        const order = (cfg.tiebreak || []).filter((k) => k !== 'points');
        if (order.length) {
          lines.push('勝ち点が同じ場合は以下の優先順位で順位を決定する。');
          lines.push(order.map((k, i) => `${circled(i)}${k === 'h2h' ? '当該チームの勝敗' : TIEBREAK_LABEL[k]}`).join(' '));
          if (!order.some((k) => k === 'lottery' || k === 'janken')) lines.push('上記で決まらない場合は本部で決定する。');
        }
      }
      if (cfg.format !== 'league') lines.push('●トーナメントで同点の場合はPK戦で勝敗を決定する。');
    }
  }
  return lines.join('\n');
}

// ---------- 要項のPDF ----------

// 本文を行ごとに整形（【】は小見出し、●は箇条書き、※は注記）
function bodyBlocks(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^【.*】$/.test(line.trim())) out.push(h('h4', { class: 'ol-h4' }, line.trim().slice(1, -1)));
    else if (/^[●・◆■]/.test(line.trim())) out.push(h('p', { class: 'ol-li' }, line.trim().slice(1).trim()));
    else if (/^※/.test(line.trim())) out.push(h('p', { class: 'ol-note' }, line.trim()));
    else out.push(h('p', { class: `ol-p${/^\s/.test(raw) ? ' ind' : ''}` }, line.trim()));
  }
  return out;
}

export function printOutline(t, cats, outline, opts = {}) {
  const o = outline || defaultOutline(t);
  const info = (o.info || []).map((r) => ({ label: r.label, value: (r.value || '').trim() || (r.auto ? autoInfo(r.auto, t, cats) : '') })).filter((r) => r.label && r.value);
  const doc = h('div', { class: 'pd ol' },
    h('header', { class: 'ol-hero' },
      t.logo ? h('img', { class: 'ol-logo', src: t.logo, alt: '' }) : null,
      h('div', { class: 'ol-hero-t' },
        h('div', { class: 'ol-kicker' }, '大会要項'),
        h('h1', null, o.title || t.name),
        o.subtitle ? h('div', { class: 'ol-sub' }, o.subtitle) : null,
        o.catch ? h('div', { class: 'ol-catch' }, o.catch) : null)),
    info.length ? h('table', { class: 'ol-info' }, h('tbody', null, info.map((r) => h('tr', null, h('th', null, r.label), h('td', null, r.value.split('\n').map((v, i) => [i ? h('br') : null, v])))))) : null,
    opts.qr && t.slug ? h('div', { class: 'ol-qr' }, qrBlock(t, '', 'ol-qr-img'),
      h('div', null, h('strong', null, '大会当日の試合結果・速報はこちら'), h('p', null, 'スマートフォンで読み取ると、日程・結果・順位表・トーナメント表をいつでも確認できます。'), h('small', null, viewerUrl(t)))) : null,
    (o.sections || []).map((sec) => {
      const text = [sec.auto ? autoSection(sec.auto, t, cats) : '', sec.body || ''].filter((x) => x.trim()).join('\n');
      const imgs = sec.images || [];
      if (!text.trim() && !imgs.length) return null;
      return h('section', { class: 'ol-sec' },
        h('h2', null, sec.title),
        bodyBlocks(text),
        imgs.length ? h('div', { class: `ol-imgs n${Math.min(imgs.length, 2)}` }, imgs.map((im) => h('figure', null, h('img', { src: `/img/a/${im.id}`, alt: im.caption || '' }), im.caption ? h('figcaption', null, im.caption) : null))) : null);
    }),
    opts.sponsors && (t.sponsors || []).length ? h('div', { class: 'ol-sponsors' }, h('span', null, 'ご協賛'), h('div', null, t.sponsors.map((sp) => h('img', { src: sp.img, alt: sp.name })))) : null,
    h('footer', { class: 'ol-foot' }, `${t.name}　大会要項`));
  openPreview({ doc, title: `${t.name}_大会要項`, pageCss: '@page { @bottom-center { content: counter(page) " / " counter(pages); font-size: 8pt; color: #666; } }', kind: 'outline' });
}

// 要項のPDF出力（含めるカテゴリを選ぶ）
export function openOutlineDialog(t, categories, outline) {
  const st = { cats: new Set(categories.map((c) => c.id)), sponsors: true, qr: true };
  const body = h('div', { class: 'stack' },
    h('div', null, h('div', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, '要項に含めるカテゴリ'),
      categories.map((c) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { if (e.target.checked) st.cats.add(c.id); else st.cats.delete(c.id); } }), `${c.name}（${c.teams.length}チーム）`))),
    (t.sponsors || []).length ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { st.sponsors = e.target.checked; } }), '最後に協賛スポンサーのバナーを入れる') : null,
    t.slug ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { st.qr = e.target.checked; } }), '閲覧ページのQRコードを入れる') : null,
    h('p', { class: 'muted small', style: { margin: 0 } }, '参加チーム・競技日程・順位決定方法の自動の文章は、選んだカテゴリから作られます。'));
  modal({ title: '大会要項をPDFで出力', content: body, actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: 'PDFを作成', kind: 'btn-primary', onClick: () => {
    const cats = categories.filter((c) => st.cats.has(c.id));
    if (!cats.length) { toast('カテゴリを1つ以上選んでください', true); return true; }
    setTimeout(() => printOutline(t, cats, outline, { sponsors: st.sponsors, qr: st.qr }), 50);
  } }] });
}

// ---------- 要項の編集（大会の要項／プリセットの両方で使う） ----------

/**
 * target: { kind: 'tournament', id } または { kind: 'preset', id, name }
 * onSave(outline): 保存処理（呼び出し側で API を呼ぶ）
 */
export function openOutlineEditor({ t, categories, outline, target, onSave }) {
  const o = JSON.parse(JSON.stringify(outline || defaultOutline(t)));
  const owner = target.kind === 'preset' ? `preset:${target.id}` : target.id;
  const back = h('div', { class: 'ol-editor', role: 'dialog', 'aria-label': '大会要項の編集' });
  let dirty = false;
  const close = async () => {
    if (dirty && !(await confirmDialog('保存していない変更があります', '閉じると変更は失われます。', '閉じる', true))) return;
    back.remove(); document.body.style.overflow = '';
  };
  const touch = () => { dirty = true; };
  const move = (arr, i, d) => { [arr[i], arr[i + d]] = [arr[i + d], arr[i]]; touch(); draw(); };
  const area = (value, onInput, rows = 3, ph = '') => {
    const el = h('textarea', { rows, placeholder: ph, oninput: (e) => { onInput(e.target.value); touch(); autoGrow(e.target); } });
    el.value = value || '';
    setTimeout(() => autoGrow(el), 0);
    return el;
  };
  // 入力した行数に合わせて高さを変える（空欄なら1行分）
  const autoGrow = (el) => { el.style.height = 'auto'; if (el.value) el.style.height = `${Math.max(el.scrollHeight + 2, 44)}px`; };

  const draw = () => mount(back,
    h('div', { class: 'ol-bar' },
      h('strong', null, target.kind === 'preset' ? `プリセットの編集：${target.name}` : '大会要項の編集'),
      h('span', { class: 'spacer' }),
      target.kind === 'tournament' ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openPresetList({ t, categories, current: o, onApply: (applied) => { Object.assign(o, applied); dirty = false; draw(); } }) }, 'プリセット') : null,
      target.kind === 'tournament' ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => saveAsPreset(o) }, 'プリセットとして保存') : null,
      target.kind === 'tournament' ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openOutlineDialog(t, categories, o) }, 'PDFで確認') : null,
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: async () => { if (await onSave(o)) { dirty = false; toast('保存しました'); } } }, '保存'),
      h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '閉じる', onclick: close }, icon('close'))),
    h('div', { class: 'ol-body' },
      h('section', { class: 'panel' }, h('h2', { style: { marginBottom: '10px' } }, '表紙'),
        h('label', { class: 'field' }, h('span', null, '大会名（表紙の大きな文字）'), h('input', { type: 'text', value: o.title, oninput: (e) => { o.title = e.target.value; touch(); } })),
        h('div', { class: 'grid-form', style: { marginTop: '10px' } },
          h('label', { class: 'field' }, h('span', null, 'サブタイトル（例：U9静岡大会）'), h('input', { type: 'text', value: o.subtitle, oninput: (e) => { o.subtitle = e.target.value; touch(); } })),
          h('label', { class: 'field' }, h('span', null, 'キャッチコピー'), h('input', { type: 'text', value: o.catch, oninput: (e) => { o.catch = e.target.value; touch(); } })))),
      h('section', { class: 'panel' },
        h('h2', null, '基本情報'),
        h('p', { class: 'muted small' }, '「自動」の項目は、空欄のままにすると大会の設定から入ります。入力すると、その文章が優先されます。'),
        h('div', { class: 'stack' }, o.info.map((r, i) => h('div', { class: 'ol-row' },
          h('input', { type: 'text', class: 'ol-label', value: r.label, 'aria-label': '項目名', oninput: (e) => { r.label = e.target.value; touch(); } }),
          area(r.value, (v) => { r.value = v; }, 1, r.auto ? `自動：${autoInfo(r.auto, t, categories) || `（${AUTO_INFO[r.auto]}）`}` : ''),
          h('div', { class: 'ol-tools' },
            r.auto ? h('span', { class: 'tag done' }, '自動') : null,
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '上へ', disabled: i === 0, onclick: () => move(o.info, i, -1) }, '↑'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '下へ', disabled: i === o.info.length - 1, onclick: () => move(o.info, i, 1) }, '↓'),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '削除', onclick: () => { o.info.splice(i, 1); touch(); draw(); } }, '×'))))),
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { o.info.push({ label: '', value: '' }); touch(); draw(); } }, '＋ 項目を追加'),
          h('select', { style: { width: 'auto' }, 'aria-label': '自動の項目を追加', onchange: (e) => { if (e.target.value) { o.info.push({ label: AUTO_INFO[e.target.value], value: '', auto: e.target.value }); touch(); draw(); } } },
            h('option', { value: '' }, '自動の項目を追加…'), Object.entries(AUTO_INFO).map(([k, l]) => h('option', { value: k }, l))))),
      o.sections.map((sec, i) => h('section', { class: 'panel' },
        h('div', { class: 'row' },
          h('input', { type: 'text', class: 'ol-sec-title', value: sec.title, 'aria-label': '見出し', oninput: (e) => { sec.title = e.target.value; touch(); } }),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '上へ', disabled: i === 0, onclick: () => move(o.sections, i, -1) }, '↑'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': '下へ', disabled: i === o.sections.length - 1, onclick: () => move(o.sections, i, 1) }, '↓'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => { if (await confirmDialog(`「${sec.title || '見出しなし'}」を削除します`, '本文と画像も削除されます。', '削除する', true)) { o.sections.splice(i, 1); touch(); draw(); } } }, '削除')),
        h('label', { class: 'field', style: { marginTop: '8px' } }, h('span', null, '内容の作り方'), h('select', { onchange: (e) => { sec.auto = e.target.value; touch(); draw(); } },
          Object.entries(AUTO_SECTION).map(([k, l]) => h('option', { value: k, selected: (sec.auto || '') === k }, l)))),
        sec.auto ? h('pre', { class: 'ol-auto' }, autoSection(sec.auto, t, categories) || '（カテゴリを登録すると自動で作られます）') : null,
        h('label', { class: 'field', style: { marginTop: '8px' } }, h('span', null, sec.auto ? '自動の文章の後に続ける内容' : '本文'),
          area(sec.body, (v) => { sec.body = v; }, 4, '1行ごとに入力。行頭に●を付けると箇条書き、【】で囲むと小見出し、※で始めると注記になります')),
        h('div', { class: 'ol-imgs-edit' },
          (sec.images || []).map((im, j) => h('figure', null,
            h('img', { src: `/img/a/${im.id}`, alt: '' }),
            h('input', { type: 'text', placeholder: '画像の説明（例：駐車場の地図）', value: im.caption || '', oninput: (e) => { im.caption = e.target.value; touch(); } }),
            h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { sec.images.splice(j, 1); touch(); draw(); } }, '画像を外す'))),
          h('label', { class: 'btn btn-sm' }, '＋ 画像を添付', h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async (e) => {
            const img = await run(() => resizeBanner(e.target.files[0], 1600, 1600));
            if (!img) return;
            const r = await run(() => api('POST', '/api/admin/assets', { owner, image: img }));
            if (r) { (sec.images ||= []).push({ id: r.id, caption: '' }); touch(); draw(); }
          } }))))),
      h('button', { class: 'btn', type: 'button', onclick: () => { o.sections.push({ title: '新しい見出し', auto: '', body: '', images: [] }); touch(); draw(); } }, '＋ 見出しを追加')));

  const saveAsPreset = (cur) => {
    const nm = h('input', { type: 'text', placeholder: '例：交流大会（静岡）の要項' });
    modal({ title: 'プリセットとして保存', content: h('label', { class: 'field' }, h('span', null, 'プリセット名'), nm),
      actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '保存', kind: 'btn-primary', onClick: async () => {
        const r = await run(() => api('POST', '/api/admin/presets', { kind: 'outline', name: nm.value, data: cur }), 'プリセットとして保存しました');
        return r ? undefined : true;
      } }] });
  };

  draw();
  document.body.append(back);
  document.body.style.overflow = 'hidden';
}

// ---------- プリセットの一覧（読み込み・編集・名前変更・削除） ----------

export async function openPresetList({ t, categories, onApply }) {
  const r = await run(() => api('GET', '/api/admin/presets?kind=outline'));
  if (!r) return;
  const list = h('div', { class: 'stack' });
  const dlg = modal({ title: '要項のプリセット', content: list, actions: [{ label: '閉じる', kind: 'btn-ghost' }] });
  const draw = (presets) => mount(list, presets.length ? presets.map((p) => h('div', { class: 'ol-preset' },
    h('div', null, h('strong', null, p.name), ' ', p.common ? (window.__ycRole === 'super'
      ? h('label', { class: 'check share-check' }, h('input', { type: 'checkbox', checked: !!p.published, onchange: async (e) => {
        const on = e.target.checked;
        if (await run(() => api('PATCH', `/api/admin/presets/${p.id}`, { shared: on }), on ? '地域管理者に公開しました' : '非公開にしました')) p.published = on;
      } }), '地域管理者に公開')
      : h('span', { class: 'tag done' }, '共通')) : null,
      h('div', { class: 'muted small' }, `更新：${formatDate(p.updated_at.slice(0, 10))}　見出し${(p.data.sections || []).length}件`)),
    h('div', { class: 'row' },
      onApply ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: async () => {
        if (!(await confirmDialog(`「${p.name}」を読み込みます`, '今の要項の内容は、プリセットの内容に置き換わります（大会名などの自動の項目は、この大会の設定から入ります）。', '読み込む'))) return;
        const res = await run(() => api('POST', `/api/admin/tournaments/${t.id}/apply-preset`, { presetId: p.id }), '読み込みました');
        if (res) { dlg.close(); onApply(res.outline); }
      } }, '読み込む') : null,
      p.editable === false ? null : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => {
        dlg.close();
        openOutlineEditor({ t, categories, outline: p.data, target: { kind: 'preset', id: p.id, name: p.name },
          onSave: async (o) => !!(await run(() => api('PATCH', `/api/admin/presets/${p.id}`, { data: o }))) });
      } }, '編集'),
      p.editable === false ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => {
        const nm = h('input', { type: 'text', value: p.name });
        modal({ title: '名前を変更', content: h('label', { class: 'field' }, h('span', null, 'プリセット名'), nm), actions: [{ label: 'キャンセル', kind: 'btn-ghost' }, { label: '保存', kind: 'btn-primary', onClick: async () => {
          if (await run(() => api('PATCH', `/api/admin/presets/${p.id}`, { name: nm.value }), '変更しました')) { p.name = nm.value; draw(presets); }
        } }] });
      } }, '名前変更'),
      p.editable === false ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: async () => {
        if (!(await confirmDialog(`「${p.name}」を削除します`, '添付画像も削除されます。この操作は元に戻せません。', '削除する', true))) return;
        if (await run(() => api('DELETE', `/api/admin/presets/${p.id}`), '削除しました')) draw(presets.filter((x) => x.id !== p.id));
      } }, '削除')))) : h('p', { class: 'muted' }, 'プリセットはまだありません。要項の編集画面の「プリセットとして保存」で作れます。'));
  draw(r.presets);
}
