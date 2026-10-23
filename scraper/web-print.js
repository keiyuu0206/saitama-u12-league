// 組合せ・結果を A4 縦で出力する（ブラウザの印刷から「PDFとして保存」）
import { printPamphlet, THEMES } from './web-pamphlet.js';
import { h, mount, modal, toast, formatDate, toHHMM } from './web-ui.js';
import { qrDataUrl } from './web-qr.js';
import { buildXlsx, downloadBlob } from './web-xlsx.js';
import { teamMap, codeMap, sideInfo, courtName, dayOf, dayTotal, dayLabel, dayDate, absMin, winnerSide, bracketView, bracketNames, TIEBREAK_LABEL, matchLength, isRankLeague } from './web-views.js';

const FORMAT_LABEL = { league: 'リーグ戦', knockout: 'トーナメント', league_knockout: 'リーグ戦＋トーナメント' };

// 閲覧ページのURLとQRコード
export const viewerUrl = (t) => `${location.origin}/t/${t.slug}`;
export function qrBlock(t, caption = '試合結果・速報はこちら', cls = 'pd-qr') {
  if (!t.slug) return null;
  let src;
  try { src = qrDataUrl(viewerUrl(t)); } catch { return null; }
  return h('div', { class: cls }, h('img', { src, alt: '閲覧ページのQRコード' }), h('span', null, caption));
}

export function periodText(t) {
  if (t.end_date && t.end_date > t.date) return `${formatDate(t.date)} 〜 ${formatDate(t.end_date).replace(/^\d+年/, '')}`;
  return formatDate(t.date);
}

export function openPrintDialog(tournament, categories, currentCatId) {
  if (!categories.length) return toast('カテゴリがありません', true);
  const st = {
    cat: currentCatId || categories[0].id,
    sections: { groups: true, schedule: true, league: true, bracket: true, courts: false },
    blank: false,
    day: 'all',
    sponsors: true,
    logos: true,
    mode: 'normal',
    qr: true,
    post: { blocks: true, brackets: true, timeline: true, courts: false },
    xl: { schedule: true, groups: true, standings: true, ranking: true, teams: true },
    pp: { overview: true, courts: true, star: true, ko: true }, // パンフレット（A4横）
    theme: 'red',
  };
  const sponsors = tournament.sponsors || [];
  const hasLogos = categories.some((c) => c.teams.some((x) => x.logo));
  const content = h('div');
  const draw = () => {
    const cats = st.cat === 'all' ? categories : categories.filter((c) => c.id === st.cat);
    const hasLeague = cats.some((c) => c.config.format !== 'knockout');
    const hasKo = cats.some((c) => c.config.format !== 'league');
    const maxDays = Math.max(...cats.map((c) => dayTotal(c.config)));
    const check = (key, label, show = true) => (show ? h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: st.sections[key], onchange: (e) => { st.sections[key] = e.target.checked; } }), label) : null);
    const btn = content.closest('.modal') && content.closest('.modal').querySelector('.btn-primary');
    if (btn) btn.textContent = st.mode === 'xlsx' ? 'Excelを作成' : 'PDFを作成';
    const pcheck = (key, label, show = true) => (show ? h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: st.post[key], onchange: (e) => { st.post[key] = e.target.checked; } }), label) : null);
    mount(content,
      h('div', { class: 'stack' },
        h('div', { class: 'chips', style: { paddingTop: 0 } }, [['normal', '資料（A4縦）'], ['posting', '掲示用（大きく1枚ずつ）'], ['pamphlet', 'パンフレット（A4横）'], ['xlsx', 'スプレッドシート（Excel）']].map(([k, l]) =>
          h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(st.mode === k), onclick: () => { st.mode = k; draw(); } }, l))),
        categories.length > 1 ? h('label', { class: 'field' }, h('span', null, 'カテゴリ'), h('select', { onchange: (e) => { st.cat = e.target.value; draw(); } },
          categories.map((c) => h('option', { value: c.id, selected: st.cat === c.id }, c.name)),
          h('option', { value: 'all', selected: st.cat === 'all' }, 'すべてのカテゴリ'))) : null,
        st.mode === 'pamphlet' ? h('div', null,
          h('div', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, '出力する内容（A4横・デザイン版）'),
          [['overview', '大会概要（大会要項の内容から）'], ['courts', 'コート別タイムスケジュール（1ページに2コート）'], ['star', '予選リーグ星取表（1ページに3組）', hasLeague],
            ['ko', '決勝トーナメントのまとめ（トーナメント表・タイムテーブル・試合番号を1枚に）', hasKo]].map(([k2, l, ok = true]) => ok ? h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: st.pp[k2], onchange: (e) => { st.pp[k2] = e.target.checked; } }), l) : null),
          h('label', { class: 'field', style: { marginTop: '6px' } }, h('span', null, '色のテーマ'), h('select', { onchange: (e) => { st.theme = e.target.value; } },
            Object.entries(THEMES).map(([k2, l]) => h('option', { value: k2, selected: st.theme === k2 }, l)))),
          h('p', { class: 'muted small', style: { margin: '4px 0 0' } }, '星取表の自チームどうしのマスには、大会のロゴが入ります（大会情報でロゴを登録してください）。')) : null,
        st.mode === 'xlsx' ? h('div', null,
          h('div', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, '出力するシート'),
          [['schedule', '日程・結果'], ['groups', '組分け'], ['standings', '順位表'], ['ranking', '最終順位'], ['teams', 'チーム一覧']].map(([k, l]) => h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: st.xl[k], onchange: (e) => { st.xl[k] = e.target.checked; } }), l)),
          h('p', { class: 'muted small', style: { margin: '4px 0 0' } }, 'Excel形式（.xlsx）のファイルを保存します。Excel・Googleスプレッドシート・Numbersで開けます。')) : st.mode === 'normal' ? h('div', null,
          h('div', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, '出力する内容'),
          check('groups', '組分け', hasLeague),
          check('schedule', '組合せ・日程'),
          check('league', '星取表・順位', hasLeague),
          check('bracket', 'トーナメント表', hasKo),
          check('courts', 'コート別の試合一覧')) : st.mode !== 'posting' ? null : h('div', null,
          h('div', { class: 'small', style: { fontWeight: 700, color: 'var(--ink-2)' } }, '掲示する内容'),
          pcheck('blocks', 'リーグ戦（1ブロック1枚・A4縦）', hasLeague),
          pcheck('brackets', 'トーナメント（上位・中位・下位などを1つずつ1枚・A4横）', hasKo),
          pcheck('timeline', '時間別の試合一覧（1日1枚・A4横）'),
          pcheck('courts', 'コート別の試合一覧（1コート1枚・A4縦）'),
          h('p', { class: 'muted small', style: { margin: '4px 0 0' } }, '各用紙に収まるよう自動で縮小します。縦と横が混ざるときは、PCのChrome・Edgeで出力してください（iPhoneでは種類ごとに出力すると確実です）。')),
        maxDays > 1 && st.mode !== 'xlsx' ? h('label', { class: 'field' }, h('span', null, '組合せ・日程の日'), h('select', { onchange: (e) => { st.day = e.target.value; } },
          h('option', { value: 'all', selected: st.day === 'all' }, 'すべての日'),
          Array.from({ length: maxDays }, (_, d) => h('option', { value: String(d), selected: st.day === String(d) }, `${d + 1}日目のみ`)))) : null,
        st.mode === 'xlsx' ? null : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.blank, onchange: (e) => { st.blank = e.target.checked; } }),
          'スコア欄を空欄にする（記入用・貼り出し用）'),
        tournament.slug && st.mode !== 'xlsx' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.qr, onchange: (e) => { st.qr = e.target.checked; } }),
          '閲覧ページのQRコードを入れる') : null,
        hasLogos && st.mode !== 'xlsx' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.logos, onchange: (e) => { st.logos = e.target.checked; } }),
          'チームのロゴを表示する') : null,
        sponsors.length && st.mode === 'normal' ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.sponsors, onchange: (e) => { st.sponsors = e.target.checked; } }),
          `協賛スポンサーを表示する（${sponsors.length}件）`) : null,
        st.mode === 'xlsx' ? null : h('p', { class: 'muted small', style: { margin: 0 } }, (st.mode === 'pamphlet' ? '用紙はA4横です。' : '用紙はA4縦です。') + '印刷の画面が開いたら、送信先で「PDFとして保存」を選んでください（iPhoneは印刷画面の右上の共有ボタン →「"ファイル"に保存」）。')));
  };
  draw();
  modal({
    title: 'PDF・Excelで出力',
    content,
    actions: [
      { label: 'キャンセル', kind: 'btn-ghost' },
      { label: 'PDFを作成', kind: 'btn-primary', onClick: () => {
        if (!Object.values(st.mode === 'posting' ? st.post : st.mode === 'xlsx' ? st.xl : st.mode === 'pamphlet' ? st.pp : st.sections).some(Boolean)) { toast('出力する内容を選んでください', true); return true; }
        if (st.mode === 'pamphlet') {
          const cats = st.cat === 'all' ? categories : categories.filter((c) => c.id === st.cat);
          if (!printPamphlet(tournament, cats, st)) toast('出力できる日程がありません', true);
          return;
        }
        if (st.mode === 'xlsx') {
          const cats = st.cat === 'all' ? categories : categories.filter((c) => c.id === st.cat);
          exportSpreadsheet(tournament, cats, st);
          return;
        }
        const cats = st.cat === 'all' ? categories : categories.filter((c) => c.id === st.cat);
        setTimeout(() => printDocument(tournament, cats, st), 50);
      } },
    ],
  });
}

// ---------- 文書の組み立て ----------

function printRoot() {
  let root = document.getElementById('print-root');
  if (!root) {
    root = h('div', { id: 'print-root' });
    document.body.append(root);
  }
  return root;
}

// 組み立てた文書を印刷する（用紙に合わせた縮小 → 画像の読み込み待ち → 印刷画面）
// 用紙の枠に収まる拡大率を求めて当てはめる（拡大・縮小後にちょうど用紙の幅になるよう、元の幅を逆算して何度か合わせる）
// 掲示用（grow）は余白があれば最大1.8倍まで拡大、それ以外は縮小のみ。戻り値は拡大率
export function fitSheet(sheet) {
  const inner = sheet.firstElementChild;
  inner.style.zoom = '';
  inner.style.width = '';
  const W = sheet.clientWidth - 2;
  const H = sheet.clientHeight - 2;
  const maxZ = sheet.classList.contains('grow') ? 1.8 : 1;
  let z = 1;
  for (let i = 0; i < 5; i++) {
    inner.style.width = `${W / z}px`;
    const nz = Math.max(0.3, Math.min(maxZ, W / Math.max(1, inner.scrollWidth), H / Math.max(1, inner.scrollHeight)));
    if (Math.abs(nz - z) < 0.005) { z = nz; break; }
    z = nz;
  }
  inner.style.width = `${W / z}px`;
  if (inner.scrollHeight * z > H) z = Math.max(0.3, H / inner.scrollHeight);
  inner.style.zoom = String(z);
  // 縮小すると文字の折り返しがわずかに変わることがあるので、実際の大きさを測って、はみ出せばもう少し縮める
  for (let i = 0; i < 4; i++) {
    const r = inner.getBoundingClientRect();
    const k = Math.min(H / Math.max(1, r.height), W / Math.max(1, r.width));
    if (k >= 0.999 || z <= 0.3) break;
    z = Math.max(0.3, z * k * 0.995);
    inner.style.zoom = String(z);
  }
  return z;
}

export function runPrint(doc, fileTitle, pageCss = '', onAfter = null) {
  const root = printRoot();
  mount(root, doc);
  let pageStyle = document.getElementById('print-page-style');
  if (!pageStyle) { pageStyle = h('style', { id: 'print-page-style' }); document.head.append(pageStyle); }
  pageStyle.textContent = pageCss;
  Object.assign(root.style, { display: 'block', position: 'absolute', left: '-10000px', top: '0', width: '300mm' });
  // 1枚ものの用紙（掲示用・駐車券・1まとまり1枚の資料）は、用紙の枠に収まるよう全体を縮小する
  for (const sheet of root.querySelectorAll('.ps-sheet')) fitSheet(sheet);
  root.removeAttribute('style');
  const title = document.title;
  document.title = fileTitle;
  document.body.classList.add('printing');
  window.addEventListener('afterprint', () => { document.title = title; if (onAfter) setTimeout(onAfter, 300); }, { once: true });
  const imgs = [...root.querySelectorAll('img')].filter((img) => !img.complete);
  const loaded = Promise.all(imgs.map((img) => new Promise((ok) => { img.onload = ok; img.onerror = ok; })));
  Promise.race([loaded, new Promise((ok) => setTimeout(ok, 4000))]).then(() => setTimeout(() => window.print(), 120));
}

// 資料の1ページ目の見出し（大会名・開催日・会場・QRコード）と協賛の欄
function docHeaderParts(t, opts) {
  const now = new Date();
  const stamp = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${toHHMM(now.getHours() * 60 + now.getMinutes())}`;
  return [
    h('header', { class: 'pd-head' },
      t.logo ? h('img', { src: t.logo, alt: '' }) : null,
      h('div', { class: 'pd-title' },
        h('h1', null, t.name),
        h('div', { class: 'pd-sub' }, t.date ? h('span', null, `開催日　${periodText(t)}`) : null, t.venue ? h('span', null, `会場　${t.venue}`) : null)),
      h('div', { class: 'pd-out' }, `${stamp} 時点`, h('br'), opts.blank ? '記入用' : '確定した結果のみ掲載'),
      opts.qr ? qrBlock(t) : null),
    opts.sponsors && (t.sponsors || []).length ? h('div', { class: 'pd-sponsors' },
      h('span', { class: 'pd-sp-label' }, '協賛'),
      h('div', { class: 'pd-sp-list' }, t.sponsors.map((sp) => h('img', { src: sp.img, alt: sp.name })))) : null,
  ];
}

function printDocument(t, cats, opts) {
  if (opts.mode === 'posting') return printPosting(t, cats, opts);
  const doc = h('div', { class: `pd${opts.logos ? ' pd-logos' : ''}` },
    ...docHeaderParts(t, opts),
    cats.map((cat, i) => categoryBlock(t, cat, opts, i === 0)));
  // 各ページの上部に大会名、下部にページ番号（対応するブラウザのみ）
  const esc = (x) => String(x || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const pageCss = `@page { @top-left { content: "${esc(t.name)}"; font-size: 7.5pt; color: #777; } @top-right { content: "${esc(t.venue)}"; font-size: 7.5pt; color: #777; } @bottom-center { content: counter(page) " / " counter(pages); font-size: 8pt; color: #555; } }`;
  const title = `${t.name}_${cats.length === 1 ? cats[0].name : '全カテゴリ'}_${opts.blank ? '組合せ' : '結果'}`;
  openPreview({ doc, title, pageCss, kind: 'normal', multiCat: cats.length > 1 });
}

// ======================================================================
// 印刷プレビュー：ページの区切りを確認し、改ページの位置を調整してから印刷する
// ======================================================================

const PX_MM = 96 / 25.4;
const PAGE_W_MM = 188; // A4（210mm）から左右の余白を除いた幅
const PAGE_H_MM = 271; // A4（297mm）から上下の余白を除いた高さ

// ページの区切りを計算する単位（ブロック）と、調整ボタンを出すブロック
const BLOCKS = {
  normal: ['.pd-head', '.pd-sponsors', '.pd-cat-title', '.pd-sec > h2', '.pd-groups', '.pd-day', '.pd-star-wrap', '.pd-sec > .pd-note', '.pd-sec > p',
    '.pd-bracket #bk-rank', '.pd-bracket section.bk-target > .section-title', '.pd-bracket .pd-zoom', '.pd-bracket .tree-others > div'],
  outline: ['.ol-hero', '.ol-info', '.ol-qr', '.ol-sec > h2', '.ol-sec > .ol-h4', '.ol-sec > .ol-li', '.ol-sec > .ol-p', '.ol-sec > .ol-note',
    '.ol-imgs figure', '.ol-sponsors', '.ol-foot'],
};
const CONTROLS = '.pd-sponsors, .pd-cat-title, .pd-sec > h2, .pd-groups, .pd-day, .pd-star-wrap, .pd-bracket #bk-rank, .pd-bracket section.bk-target > .section-title, .pd-bracket .tree-others > div, '
  + '.ol-info, .ol-qr, .ol-sec > h2, .ol-sec > .ol-h4, .ol-imgs figure, .ol-sponsors';
const HEADINGS = '.pd-sec > h2, .pd-cat-title, .pd-bracket section.bk-target > .section-title, .ol-sec > h2, .ol-sec > .ol-h4';
const SPLIT = '.pd-day, .ol-info'; // 行の区切りでページをまたげる表

function markBlocks(doc, kind) {
  for (const el of doc.querySelectorAll(BLOCKS[kind].join(','))) {
    if (!el.parentElement.closest('.pb')) el.classList.add('pb');
  }
  let prev = null;
  doc.querySelectorAll('.pb').forEach((el) => {
    if (el.matches(SPLIT)) el.classList.add('pb-split');
    if (el.matches(HEADINGS)) el.classList.add('pb-head');
    // 見出しの直後のブロックには改ページのボタンを出さない（見出しだけが前のページに残るため）。改ページは見出しの位置で行う
    if (el.matches(CONTROLS) && !(prev && prev.classList.contains('pb-head'))) el.classList.add('pb-ctl');
    prev = el;
  });
  // 「分けない」は表に付けるので、見出しの直後の表でもボタンを出す
  doc.querySelectorAll('.pb-split:not(.pb-ctl)').forEach((el) => el.classList.add('pb-ctl', 'pb-keeponly'));
}

// トーナメント表を用紙の幅に収める
function fitZoom(root) {
  for (const el of root.querySelectorAll('.pd-zoom')) {
    el.style.zoom = '';
    const inner = el.firstElementChild;
    const need = inner ? inner.scrollWidth : el.scrollWidth;
    const scale = Math.min(1, (el.clientWidth - 2) / need);
    if (scale < 1) el.style.zoom = String(Math.max(0.45, scale));
  }
}

// ブラウザの印刷と同じ考え方で、どこでページが変わるかを計算する
function simulate(doc) {
  const H = PAGE_H_MM * PX_MM;
  const top0 = doc.getBoundingClientRect().top;
  const blocks = [...doc.querySelectorAll('.pb')];
  const forcedBreak = (b) => {
    if (getComputedStyle(b).breakBefore === 'page') return true;
    for (let a = b.parentElement; a && a !== doc; a = a.parentElement) {
      if (getComputedStyle(a).breakBefore === 'page' && a.querySelector('.pb') === b) return true;
    }
    return false;
  };
  let shift = 0; // ページ送りで空いた分（画面上の位置 + shift = 用紙上の位置）
  const breaks = []; // { el, y（画面上の位置）, page, reason }
  const tooTall = new Set();
  let prev = null;
  let lastPage = 0; // 直前に置いたものがあるページ（0始まり）
  const pageEnd = (v) => (Math.floor(v / H) + 1) * H;
  // ブロックの上の余白（中の最初の要素の余白と重なる分も含む）
  const marginTop = (el) => {
    let m = parseFloat(getComputedStyle(el).marginTop) || 0;
    // 外側のまとまりの先頭にあるときは、外側の余白も重なって残る（例：要項の見出しを含むセクションの上の余白）
    for (let a = el; a.parentElement && a.parentElement !== doc && a.parentElement.firstElementChild === a; a = a.parentElement) {
      const ps = getComputedStyle(a.parentElement);
      if (parseFloat(ps.paddingTop) || parseFloat(ps.borderTopWidth) || ps.display === 'flex' || ps.display === 'grid') break;
      m = Math.max(m, parseFloat(ps.marginTop) || 0);
    }
    for (let c = el; c.firstElementChild; c = c.firstElementChild) {
      const cs = getComputedStyle(c);
      if (parseFloat(cs.paddingTop) || parseFloat(cs.borderTopWidth) || cs.display === 'flex' || cs.display === 'grid' || cs.display === 'table') break;
      m = Math.max(m, parseFloat(getComputedStyle(c.firstElementChild).marginTop) || 0);
    }
    return m;
  };
  const moveTo = (el, y, reason) => {
    const v = y + shift;
    const forced = reason === 'manual' || reason === 'auto';
    if (forced) {
      // 指定した改ページは「直前の内容があるページの、次のページ」から始める（余白で自然に次のページへ出ていても同じ）
      if (v - lastPage * H < 1) return; // 今のページにまだ何も無い（先頭）
      // ページ先頭でもブロックの上の余白は残る（マイナスの余白は除く）
      shift += (lastPage + 1) * H + Math.max(0, marginTop(el)) - v;
    } else {
      if (v % H < 1) return; // すでにページの先頭
      shift += pageEnd(v) - v;
    }
    lastPage = Math.floor((y + shift) / H);
    breaks.push({ el, y, page: lastPage + 1, reason });
  };
  // 押し出しが無くても、前の内容がページを使い切って自然に次のページから始まる場合も記録する
  const mark = (el, y, isBlock = true) => {
    const pi = Math.floor((y + shift + 0.5) / H);
    if (pi > lastPage) {
      // 印刷ではページ先頭の余白（見出しの上の隙間など）は省かれ、ページの一番上から始まる
      if (isBlock) shift -= (y + shift) - pi * H;
      breaks.push({ el, y, page: pi + 1, reason: 'flow' });
      lastPage = pi;
    }
  };
  let heads = []; // 直前に続いている見出し（見出しだけがページ末尾に残らないよう、まとめて送る）
  let maxBottom = 0; // 用紙上で一番下にある内容の位置（横に並ぶ図があるため、最後のブロックとは限らない）
  const reach = (el) => { maxBottom = Math.max(maxBottom, el.getBoundingClientRect().bottom - top0 + shift); };
  for (const b of blocks) {
    const r = b.getBoundingClientRect();
    const y = r.top - top0;
    const hgt = r.height;
    if (forcedBreak(b)) {
      moveTo(b, y, b.classList.contains('pb-break') ? 'manual' : 'auto'); mark(b, y);
      reach(b);
      heads = b.classList.contains('pb-head') ? [b] : [];
      prev = b; continue;
    }
    const v = y + shift;
    const keep = !b.classList.contains('pb-split') || b.classList.contains('pb-keep');
    if (hgt > H - 2 && keep) tooTall.add(b);
    if (keep && hgt <= H && v + hgt > pageEnd(v) + 0.5) {
      // 見出しだけがページの末尾に残らないよう、同じページにある直前の見出しごと次のページへ
      const sameHeads = heads.filter((x) => Math.floor((x.getBoundingClientRect().top - top0 + shift) / H) === Math.floor(v / H));
      if (sameHeads.length) moveTo(sameHeads[0], sameHeads[0].getBoundingClientRect().top - top0, 'flow');
      else moveTo(b, y, 'flow');
      mark(b, y);
    } else if (!keep) {
      mark(b, y);
      // 表は行の区切りでページをまたぐ（次のページでは見出しの行を繰り返す）
      const thead = b.querySelector('thead');
      const theadH = thead ? thead.getBoundingClientRect().height : 0;
      const first = b.querySelector('tbody tr');
      for (const tr of b.querySelectorAll('tbody tr')) {
        const rr = tr.getBoundingClientRect();
        const ty = rr.top - top0;
        const tv = ty + shift;
        if (tv + rr.height > pageEnd(tv) + 0.5) {
          if (tr === first) {
            // 最初の行が入らないなら、表の見出し（h3 など）ごと次のページへ（直前の見出しも一緒に）
            const sameHeads = heads.filter((x) => Math.floor((x.getBoundingClientRect().top - top0 + shift) / H) === Math.floor((y + shift) / H));
            if (sameHeads.length) moveTo(sameHeads[0], sameHeads[0].getBoundingClientRect().top - top0, 'flow');
            else moveTo(b, y, 'flow');
          } else {
            moveTo(tr, ty, 'flow');
            shift += theadH;
          }
        }
        mark(tr, ty, false);
      }
    } else mark(b, y);
    reach(b);
    heads = b.classList.contains('pb-head') ? [...heads, b] : [];
    prev = b;
  }
  return { breaks, pages: Math.max(1, Math.ceil((maxBottom - 1) / H), lastPage + 1), tooTall };
}

export function openPreview({ doc, title, pageCss = '', kind = 'normal', multiCat = false }) {
  markBlocks(doc, kind);
  document.querySelector('.pv')?.remove();
  const paper = h('div', { class: 'pv-paper' }, doc);
  const layer = h('div', { class: 'pv-layer' });
  const wrap = h('div', { class: 'pv-wrap' }, paper, layer);
  const info = h('span', { class: 'pv-info' });
  const opt = { catBreak: true, secBreak: false, keepAll: false };
  const toggle = (label, key, apply, show = true) => (show ? h('label', { class: 'check pv-opt' },
    h('input', { type: 'checkbox', checked: opt[key], onchange: (e) => { opt[key] = e.target.checked; apply(opt[key]); redraw(); } }), label) : null);
  const ov = h('div', { class: 'pv', role: 'dialog', 'aria-label': '印刷プレビュー' },
    h('div', { class: 'pv-bar' },
      h('div', { class: 'pv-title' }, h('strong', null, '印刷プレビュー'), info),
      h('div', { class: 'pv-opts' },
        toggle('カテゴリごとに新しいページから', 'catBreak', (on) => doc.classList.toggle('no-catbreak', !on), kind === 'normal' && multiCat),
        toggle(kind === 'outline' ? '見出しごとに新しいページから' : '組分け・日程・星取表・トーナメント表を新しいページから', 'secBreak', (on) => doc.classList.toggle('sec-break', on)),
        toggle('表を途中で分けない', 'keepAll', (on) => doc.querySelectorAll('.pb-split').forEach((el) => el.classList.toggle('pb-keep', on)))),
      h('div', { class: 'pv-actions' },
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { doc.querySelectorAll('.pb-break').forEach((el) => el.classList.remove('pb-break')); redraw(); } }, '手動の改ページを解除'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { ov.remove(); document.body.style.overflow = ''; } }, '閉じる'),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => runPrint(doc.cloneNode(true), title, pageCss) }, 'この内容でPDFを作成'))),
    h('p', { class: 'pv-help' }, '赤い線がページの区切りです。左の「ここで改ページ」で、その見出しや表から次のページに送れます（もう一度押すと解除）。表の「分けない」を押すと、その表がページをまたがないようにします。実際の出力とは1〜2行ずれることがあります。'),
    h('div', { class: 'pv-scroll' }, wrap));

  const redraw = () => {
    const res = simulate(doc);
    const wTop = wrap.getBoundingClientRect().top;
    const yOf = (el) => el.getBoundingClientRect().top - wTop;
    const items = [];
    // 1ページ目の表示
    items.push(h('div', { class: 'pv-page', style: { top: `${yOf(doc) - 22}px` } }, '1ページ目'));
    for (const br of res.breaks) {
      items.push(h('div', { class: `pv-break${br.reason === 'manual' ? ' manual' : ''}`, style: { top: `${yOf(br.el) - 4}px` } },
        h('span', null, `${br.page}ページ目${br.reason === 'manual' ? '（手動）' : br.reason === 'auto' ? '（新しいページ）' : ''}`)));
    }
    // 調整ボタン（用紙の左の余白に置くので、印刷物には影響しない）
    const ctls = [...doc.querySelectorAll('.pb-ctl')];
    ctls.forEach((b, i) => {
      if (i === 0 && b.getBoundingClientRect().top - doc.getBoundingClientRect().top < 5) return;
      const on = b.classList.contains('pb-break');
      const split = b.classList.contains('pb-split');
      const keepOn = b.classList.contains('pb-keep');
      items.push(h('div', { class: 'pv-ctl', style: { top: `${yOf(b)}px` } },
        b.classList.contains('pb-keeponly') ? null : h('button', { class: `pv-btn${on ? ' on' : ''}`, type: 'button', title: on ? '改ページを解除' : 'この位置から次のページにする',
          onclick: () => { b.classList.toggle('pb-break'); redraw(); } }, on ? '✓ 改ページ' : 'ここで改ページ'),
        split ? h('button', { class: `pv-btn sub${keepOn ? ' on' : ''}`, type: 'button', title: '表をページの途中で分けない',
          onclick: () => { b.classList.toggle('pb-keep'); redraw(); } }, keepOn ? '✓ 分けない' : '分けない') : null,
        res.tooTall.has(b) ? h('span', { class: 'pv-warn' }, '1ページに収まらない長さです') : null));
    });
    mount(layer, items);
    info.textContent = `全${res.pages}ページ`;
  };

  document.body.append(ov);
  document.body.style.overflow = 'hidden';
  fitZoom(doc);
  redraw();
  // 画像の読み込みや文字の描画で高さが変わったら計算し直す
  doc.querySelectorAll('img').forEach((img) => { if (!img.complete) img.addEventListener('load', redraw, { once: true }); });
  if ('ResizeObserver' in window) {
    let t0 = 0;
    new ResizeObserver(() => { cancelAnimationFrame(t0); t0 = requestAnimationFrame(() => { if (document.body.contains(doc)) redraw(); }); }).observe(doc);
  }
}

function categoryBlock(t, catIn, opts, first) {
  // 記入用は結果を消したコピーで描く
  const cat = opts.blank
    ? { ...catIn, finalRanking: [], matches: catIn.matches.map((m) => ({ ...m, status: 'none', home_score: null, away_score: null, home_pk: null, away_pk: null })) }
    : catIn;
  const cfg = cat.config;
  const groups = [...new Set(cat.teams.map((x) => x.group_label).filter(Boolean))].sort();
  const summary = [FORMAT_LABEL[cfg.format], `${cat.teams.length}チーム`, groups.length > 1 ? `${groups.length}組` : null, `${cfg.courts}面`].filter(Boolean).join('　');
  const s = opts.sections;
  return h('section', { class: `pd-cat${first ? ' first' : ''}` },
    h('div', { class: 'pd-cat-title' }, h('strong', null, cat.name), h('span', null, summary)),
    s.groups && cfg.format !== 'knockout' && groups.length ? groupsSection(cat, groups) : null,
    s.schedule ? scheduleSection(t, cat, opts) : null,
    s.league && cfg.format !== 'knockout' && groups.length ? leagueSection(cat, groups, opts) : null,
    s.bracket && cfg.format !== 'league' && cat.matches.some((m) => m.stage === 'knockout' && !isRankLeague(m)) ? bracketSection(t, cat) : null,
    s.league && Object.values(cat.standings || {}).some((x) => x.placement) ? rankLeagueSection(cat, Object.keys(cat.standings).filter((g) => cat.standings[g].placement), opts) : null,
    s.courts && cat.matches.length ? courtSection(t, cat, opts) : null,
    !cat.matches.length && (s.schedule || s.league || s.bracket) ? h('p', { class: 'pd-note' }, '日程はまだ作成されていません。') : null);
}

// チーム名を1行に収める部品。文字の幅（全角=1、半角=約0.6）を数えておき、
// 印刷時に枠の幅 ÷ 文字数 で文字の大きさが決まるようにする（最小 6pt、それでも入らなければ「…」）
function textEm(text) {
  let n = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (ch === ' ') n += 0.32;
    else if (/[A-Z]/.test(ch)) n += 0.74; // 英大文字は幅が広い
    else if (/[a-z0-9]/.test(ch)) n += 0.6;
    else if (c <= 0xff || (c >= 0xff61 && c <= 0xff9f)) n += 0.5; // 記号・半角カナ
    else n += 1; // 全角
  }
  return Math.max(1, n * 1.06 + 0.4); // 太字の分の余裕
}
// 用紙上で使える幅（mm）に、6.5pt以上で入る表記を選ぶ：正式名称 → 略称 → 括弧書きを省いた名前 → 一番短いもの
const MM_PER_EM = 6.5 * 0.3528;
const stripParen = (x) => String(x || '').replace(/[（(][^（）()]*[)）]\s*$/, '').trim();
function pickName(team, fallback, availMm) {
  if (!team) return fallback;
  const cands = [...new Set([team.name, team.short_name, stripParen(team.name), stripParen(team.short_name)].filter(Boolean))];
  return cands.find((v) => textEm(v) * MM_PER_EM <= availMm) || cands.reduce((a, b) => (textEm(b) < textEm(a) ? b : a));
}

export const fit = (text, cls = '') => h('span', { class: `pd-fit ${cls}`.trim(), style: `--L:${textEm(text).toFixed(2)}` }, h('span', { class: 't' }, text));

// ロゴがあるチームだけ小さな画像を返す（無ければ何も出さない）
const logo = (team) => (team && team.logo ? h('img', { class: 'pd-logo', src: team.logo, alt: '' }) : null);
const named = (team, text) => [logo(team), fit(text)];

function groupsSection(cat, groups) {
  // 組分けは正式名称の確認用。一番長い名前が 7pt 以上で1行に入る列数にする
  const longest = Math.max(...cat.teams.map((x) => textEm(x.name)));
  const cols = Math.max(1, Math.min(4, groups.length, Math.floor(188 / (longest * 7 * 0.3528 + 11))));
  return h('div', { class: 'pd-sec' }, h('h2', null, '組分け'),
    h('div', { class: 'pd-groups', style: { gridTemplateColumns: `repeat(${cols}, 1fr)` } }, groups.map((g) => h('div', { class: 'pd-group' },
      h('strong', null, `${g}組`),
      cat.teams.filter((x) => x.group_label === g).map((x) => h('div', { class: 'pd-named' }, named(x, x.name)))))));
}

function scoreCells(m, side, blank) {
  if (blank || m.status !== 'confirmed' || m.home_score == null) return h('span', { class: 's' }, '');
  const sc = side === 'home' ? m.home_score : m.away_score;
  const pk = m.home_pk != null ? (side === 'home' ? m.home_pk : m.away_pk) : null;
  return h('span', { class: 's' }, sc, pk != null ? h('small', null, `(${pk})`) : null);
}

function matchCell(cat, m, cache, opts, rowTime) {
  const blank = opts.blank;
  // 1マスでチーム名に使える幅 = (188 - 時刻13) / コート数 - 余白・得点欄・ロゴ
  const availMm = ((opts.pageW || 188) - 13) / cat.config.courts - 11.5 - (opts.logos && cat.teams.some((x) => x.logo) ? 5.2 : 0);
  const w = !blank && m.status === 'confirmed' ? winnerSide(m) : null;
  const line = (side) => {
    const info = sideInfo(m, side, cat, cache);
    return h('div', { class: `tr${w ? (w === side ? ' w' : ' l') : ''}` },
      logo(info.team),
      info.placeholder ? h('span', { class: 'n ph' }, info.text) : fit(pickName(info.team, info.text, availMm), 'n'), scoreCells(m, side, blank));
  };
  return h('td', { class: `pd-cell${blank ? ' pd-blank' : ''}` },
    h('div', { class: 'lb' }, h('span', null, m.label), m.start_min !== rowTime ? h('span', null, toHHMM(m.start_min)) : (m.forfeit && !blank ? h('span', null, '不戦勝') : null)),
    line('home'), line('away'));
}

function scheduleSection(t, cat, opts) {
  const cfg = cat.config;
  const cache = { teams: teamMap(cat), codes: codeMap(cat) };
  const days = dayTotal(cfg);
  const dayFilter = opts.day === 'all' ? null : Number(opts.day);
  const list = cat.matches.filter((m) => (dayFilter == null || dayOf(cfg, m.slot) === dayFilter) && (!opts.session || m.session === opts.session) && (!opts.slots || opts.slots.has(m.slot)))
    .sort((a, b) => absMin(cfg, a) - absMin(cfg, b) || a.court - b.court);
  if (!list.length) return h('div', { class: 'pd-sec' }, h('h2', null, '組合せ・日程'), h('p', { class: 'pd-note' }, '該当する試合はありません。'));
  const byDay = {};
  for (const m of list) (byDay[dayOf(cfg, m.slot)] ||= []).push(m);

  const gridTable = (ms) => {
    const slots = [...new Set(ms.map((m) => m.slot))].sort((a, b) => a - b);
    const rows = [];
    let prevSession = null;
    let band = 0;
    for (const sl of slots) {
      const inSlot = ms.filter((m) => m.slot === sl);
      band++;
      const session = inSlot[0].session;
      if (prevSession === 'am' && session === 'pm') rows.push(h('tr', { class: 'pd-lunch' }, h('td', { colspan: cfg.courts + 1 }, '昼休憩')));
      prevSession = session;
      const rowTime = Math.min(...inSlot.map((m) => m.start_min));
      rows.push(h('tr', { class: `pd-slot${band % 2 === 0 ? ' band' : ''}` }, h('td', { class: 'pd-time' }, toHHMM(rowTime)),
        Array.from({ length: cfg.courts }, (_, c) => {
          const m = inSlot.find((x) => x.court === c);
          return m ? matchCell(cat, m, cache, opts, rowTime) : h('td', { class: 'pd-empty' }, '');
        })));
    }
    return h('table', { class: 'pd-t pd-grid' },
      h('colgroup', null, h('col', { style: { width: '13mm' } }), Array.from({ length: cfg.courts }, () => h('col'))),
      h('thead', null, h('tr', null, h('th', null, '時刻'), Array.from({ length: cfg.courts }, (_, c) => h('th', null, courtName(cfg, c))))),
      h('tbody', null, rows));
  };

  // コートが多いときは1試合1行の一覧にする
  let listBand = 0;
  const listTable = (ms) => h('table', { class: 'pd-t pd-list' },
    h('colgroup', null, ['8mm', '13mm', '16mm', '26mm', null, '18mm', null].map((w) => h('col', { style: w ? { width: w } : null }))),
    h('thead', null, h('tr', null, ['No', '時刻', 'コート', '試合', 'チーム', '結果', 'チーム'].map((x) => h('th', null, x)))),
    h('tbody', null, ms.map((m, i) => {
      const first = i === 0 || ms[i - 1].start_min !== m.start_min;
      const listAvail = (188 - 81) / 2 - 3 - (opts.logos && cat.teams.some((x) => x.logo) ? 5.2 : 0);
      const nm = (side) => { const info = sideInfo(m, side, cat, cache); return named(info.team, info.placeholder ? info.text : pickName(info.team, info.text, listAvail)); };
      if (first) listBand++;
      const w = !opts.blank && m.status === 'confirmed' ? winnerSide(m) : null;
      const sc = !opts.blank && m.status === 'confirmed' && m.home_score != null
        ? `${m.home_score} - ${m.away_score}${m.home_pk != null ? `（PK ${m.home_pk}-${m.away_pk}）` : ''}` : '';
      return h('tr', { class: `${first ? 'tfirst' : ''}${listBand % 2 === 0 ? ' band' : ''}` },
        // 同じ時刻の2行目以降も時刻を入れる（印刷で途中から切れても分かるように、薄い文字で）
        h('td', { class: 'c' }, i + 1), h('td', { class: `pd-time${first ? '' : ' pd-time-sub'}` }, toHHMM(m.start_min)), h('td', { class: 'c' }, courtName(cfg, m.court)),
        h('td', { class: 'sm' }, m.label),
        h('td', { class: `r${w === 'home' ? ' b' : ''}` }, h('span', { class: 'pd-named r' }, nm('home'))),
        h('td', { class: `c res${opts.blank ? ' pd-blank-res' : ''}` }, sc),
        h('td', { class: w === 'away' ? 'b' : '' }, h('span', { class: 'pd-named' }, nm('away'))));
    })));

  const table = cfg.courts <= (opts.gridMax || 4) ? gridTable : listTable;
  return h('div', { class: 'pd-sec' }, h('h2', null, '組合せ・日程'),
    Object.keys(byDay).sort((a, b) => a - b).map((d) => h('div', { class: 'pd-day' },
      days > 1 ? h('h3', null, dayLabel(cat, Number(d), t)) : null,
      table(byDay[d]))));
}

// 星取表（名前だけ。横の見出しは入る範囲の表記を選ぶ）
// リーグ戦の段の参加チーム（決まる前は「A組5位」などの枠の名前で表示する）
function rankLeagueSource(cat, g) {
  const st = (cat.standings || {})[g];
  const ms = cat.matches.filter((m) => isRankLeague(m) && m.group_label === g);
  const tm = teamMap(cat);
  const key = (r) => `${r.g}:${r.r}`;
  const slots = [];
  for (const m of ms) for (const [ref, tid] of [[m.home_ref, m.home_team_id], [m.away_ref, m.away_team_id]]) {
    if (ref && !slots.some((x) => x.key === key(ref))) slots.push({ key: key(ref), ref, tid });
    else if (ref && tid) slots.find((x) => x.key === key(ref)).tid = tid;
  }
  slots.sort((a, b) => a.ref.r - b.ref.r || a.ref.g.localeCompare(b.ref.g));
  const order = slots.map((x) => (x.tid && tm[x.tid] ? tm[x.tid] : { id: `slot:${x.key}`, name: `${x.ref.g}組${x.ref.r}位` }));
  // 試合のチームが未定のときは、枠の名前で対戦表を引けるようにする
  const matches = ms.map((m) => ({ ...m,
    home_team_id: m.home_team_id || (m.home_ref ? `slot:${key(m.home_ref)}` : null),
    away_team_id: m.away_team_id || (m.away_ref ? `slot:${key(m.away_ref)}` : null) }));
  return { order, matches, st };
}

function starTable(cat, g, opts, pageW = 188, basePt = 8.5, src = null) {
  const league = src ? src.matches : cat.matches.filter((m) => m.stage === 'league');
  const st = src ? src.st : (cat.standings || {})[g];
  const rows = st ? st.rows : [];
  const order = src ? src.order : cat.teams.filter((x) => x.group_label === g);
  const rowOf = Object.fromEntries(rows.map((r) => [r.teamId, r]));
  const show = !opts.blank;
  const cell = (a, b) => {
    if (a.id === b.id) return h('td', { class: 'diag' });
    const m = league.find((x) => (x.home_team_id === a.id && x.away_team_id === b.id) || (x.home_team_id === b.id && x.away_team_id === a.id));
    if (!m || !show || m.status !== 'confirmed' || m.home_score == null) return h('td', { class: 'pd-blank-res' });
    const mine = m.home_team_id === a.id ? m.home_score : m.away_score;
    const opp = m.home_team_id === a.id ? m.away_score : m.home_score;
    return h('td', null, h('span', { class: 'mk' }, mine > opp ? '○' : mine < opp ? '●' : '△'), `${mine}-${opp}`);
  };
  const n = Math.max(1, order.length);
  const sumW = 40 * (basePt / 8.5);
  // 左端の列幅：一番長いチーム名が入る幅（用紙の4割まで）
  const withLogo = opts.logos && order.some((x) => x.logo);
  const nameMm = Math.min(pageW * 0.3, Math.max(30, Math.ceil(Math.max(...order.map((x) => textEm(x.name)), 4) * basePt * 0.3528 + 6))) + (withLogo ? 5 : 0);
  const avail = (pageW - nameMm - sumW) / n - 3;
  // 横の見出しは入る範囲で名称を入れる（略称・括弧なしを優先し、それでも長ければ入る文字数まで。「…」は付けない）
  const headPt = Math.max(6.5, basePt * 0.82);
  const headLabel = (x) => {
    const label = pickName(x, x.name, avail);
    const maxEm = avail / (headPt * 0.3528);
    if (textEm(label) <= maxEm) return label;
    let out = '';
    for (const ch of label) { if (textEm(out + ch) > maxEm) break; out += ch; }
    return out || [...label][0];
  };
  return h('table', { class: 'pd-t pd-star' },
    h('colgroup', null, h('col', { style: { width: `${nameMm}mm` } }), order.map(() => h('col')), [0, 1, 2, 3].map(() => h('col', { style: { width: `${sumW / 4}mm` } }))),
    h('thead', null, h('tr', null, h('th', null, ''),
      order.map((x) => h('th', { class: 'tn-h', title: x.name }, fit(headLabel(x), 'clip'))),
      ['勝点', '得失', '総得', '順位'].map((x) => h('th', null, x)))),
    h('tbody', null, order.map((a) => {
      const r = rowOf[a.id];
      return h('tr', null, h('td', { class: 'tn' }, h('span', { class: 'pd-named' }, named(a, a.name))), order.map((b) => cell(a, b)),
        h('td', { class: 'b' }, show && r ? r.pts : ''), h('td', null, show && r ? (r.gd > 0 ? `+${r.gd}` : r.gd) : ''), h('td', null, show && r ? r.gf : ''),
        h('td', { class: 'b' }, show && r && r.p ? `${r.rank}${r.tied ? '=' : ''}` : ''));
    })));
}

// コート別の試合一覧：1コート（複数日なら1コート・1日）ずつの表
function courtTables(t, cat, opts, { pageW = 188, big = false } = {}) {
  const cfg = cat.config;
  const cache = { teams: teamMap(cat), codes: codeMap(cat) };
  const days = dayTotal(cfg);
  const out = [];
  for (let c = 0; c < cfg.courts; c++) {
    for (let d = 0; d < days; d++) {
      if (opts.day !== 'all' && opts.day != null && Number(opts.day) !== d) continue;
      const ms = cat.matches.filter((m) => m.court === c && dayOf(cfg, m.slot) === d).sort((a, b) => a.start_min - b.start_min);
      if (!ms.length) continue;
      const avail = (pageW - 18 - 26 - (big ? 28 : 22)) / 2 - 3 - (opts.logos && cat.teams.some((x) => x.logo) ? 5.2 : 0);
      out.push({ court: c, day: d, title: courtName(cfg, c), sub: days > 1 ? dayLabel(cat, d, t) : '',
        table: h('table', { class: `pd-t pd-court${big ? ' ps-matches' : ''}` },
          h('colgroup', null, h('col', { style: { width: '16mm' } }), h('col', { style: { width: '28mm' } }), h('col'), h('col', { style: { width: big ? '28mm' : '20mm' } }), h('col')),
          h('thead', null, h('tr', null, ['時刻', '試合', 'チーム', '結果', 'チーム'].map((x) => h('th', null, x)))),
          h('tbody', null, ms.map((m, i) => {
            const done = !opts.blank && m.status === 'confirmed' && m.home_score != null;
            const w = done ? winnerSide(m) : null;
            const nm = (side) => { const info = sideInfo(m, side, cat, cache); return h('span', { class: `pd-named${side === 'home' ? ' r' : ''}` }, named(info.team, info.placeholder ? info.text : pickName(info.team, info.text, avail))); };
            return h('tr', { class: i % 2 ? 'band' : '' },
              h('td', { class: 'pd-time' }, toHHMM(m.start_min)), h('td', { class: 'sm' }, m.label),
              h('td', { class: `r${w === 'home' ? ' b' : ''}` }, nm('home')),
              h('td', { class: `c res${done ? '' : ' blank'}` }, done ? `${m.home_score} - ${m.away_score}${m.home_pk != null ? `（PK ${m.home_pk}-${m.away_pk}）` : ''}` : '　 - 　'),
              h('td', { class: w === 'away' ? 'b' : '' }, nm('away')));
          }))) });
    }
  }
  return out;
}

function courtSection(t, cat, opts) {
  return h('div', { class: 'pd-sec' }, h('h2', null, 'コート別の試合一覧'),
    courtTables(t, cat, opts).map((x) => h('div', { class: 'pd-day pd-court-wrap' }, h('h3', null, `${x.title}${x.sub ? `　${x.sub}` : ''}`), x.table)));
}

const starNote = (cat) => {
  const order = (cat.config.tiebreak || []).filter((k) => k !== 'points').map((k) => TIEBREAK_LABEL[k]);
  return `○勝ち　●負け　△引き分け（勝ち3点・引き分け1点・負け0点）。${order.length ? `勝点が並んだときは ${order.join('、')} の順で決めます。` : ''}`;
};

function rankLeagueSection(cat, names, opts) {
  return h('div', { class: 'pd-sec' }, h('h2', null, names.length > 1 ? 'リーグ戦（順位決定）' : names[0]),
    names.map((g) => {
      const st = cat.standings[g];
      const show = !opts.blank;
      const src = rankLeagueSource(cat, g);
      return h('div', { class: 'pd-star-wrap' },
        h('h3', null, `${names.length > 1 ? g : ''}${st && st.complete && show ? '' : show ? '（途中経過）' : ''}　全体${(st.offset || 0) + 1}〜${(st.offset || 0) + src.order.length}位を決定`.trim()),
        starTable(cat, g, opts, 188, 8.5, src));
    }),
    h('p', { class: 'pd-note' }, starNote(cat)));
}

function leagueSection(cat, groups, opts) {
  return h('div', { class: 'pd-sec' }, h('h2', null, '星取表・順位'),
    groups.map((g) => {
      const st = (cat.standings || {})[g];
      const show = !opts.blank;
      return h('div', { class: 'pd-star-wrap' },
        h('h3', null, `${g}組${st && st.complete && show ? '' : show ? '（途中経過）' : ''}`),
        starTable(cat, g, opts));
    }),
    h('p', { class: 'pd-note' }, starNote(cat)));
}

function bracketSection(t, cat) {
  const view = bracketView(cat, { tournament: t, myTeam: null, noLeagues: true });
  // 図ごとに幅を合わせて縮小できるよう包む
  for (const sc of view.querySelectorAll('.tree-scroll')) {
    const wrap = h('div', { class: 'pd-zoom' });
    sc.replaceWith(wrap);
    wrap.append(sc);
  }
  return h('div', { class: 'pd-sec pd-bracket' }, h('h2', null, 'トーナメント表'), view);
}


// ======================================================================
// 掲示用（大きな文字で1枚ずつ）
// ======================================================================

const sheet = (orient, ...kids) => h('section', { class: `ps-sheet ps-${orient}` }, h('div', { class: 'ps-inner' }, kids));
const growSheet = (orient, ...kids) => { const el = sheet(orient, ...kids); el.classList.add('grow'); return el; };
let postingQr = true;
const sheetHead = (t, cat, title, sub) => h('header', { class: 'ps-head' },
  t.logo ? h('img', { src: t.logo, alt: '' }) : null,
  h('div', { class: 'ps-head-t' }, h('div', { class: 'ps-tname' }, t.name), h('div', { class: 'ps-tsub' }, [cat.name, periodText(t), t.venue].filter(Boolean).join('　'))),
  h('div', { class: 'ps-title' }, title, sub ? h('small', null, sub) : null),
  postingQr ? qrBlock(t, '結果・速報', 'ps-qr') : null);

const PAGE_PORT = '@page { size: A4 portrait; margin: 8mm; }';
const PAGE_LAND = '@page { size: A4 landscape; margin: 8mm; }';

function printPosting(t, cats, opts) {
  postingQr = opts.qr !== false;
  const sheets = [];
  for (const catIn of cats) {
    const cat = opts.blank ? { ...catIn, finalRanking: [], matches: catIn.matches.map((m) => ({ ...m, status: 'none', home_score: null, away_score: null, home_pk: null, away_pk: null })) } : catIn;
    const cfg = cat.config;
    const cache = { teams: teamMap(cat), codes: codeMap(cat) };
    const groups = [...new Set(cat.teams.map((x) => x.group_label).filter(Boolean))].sort();
    // リーグ戦：1ブロック1枚（星取表＋そのブロックの試合）
    if (opts.post.blocks && cfg.format !== 'knockout') {
      for (const g of groups) {
        const ms = cat.matches.filter((m) => m.stage === 'league' && m.group_label === g).sort((a, b) => absMin(cfg, a) - absMin(cfg, b));
        const multi = dayTotal(cfg) > 1;
        sheets.push(growSheet('port',
          sheetHead(t, cat, `${g}組`, 'リーグ戦'),
          h('div', { class: 'ps-star' }, starTable(cat, g, opts, 194, 11)),
          h('p', { class: 'pd-note' }, starNote(cat)),
          h('h3', { class: 'ps-sub' }, '対戦スケジュール'),
          h('table', { class: 'pd-t ps-matches' },
            h('colgroup', null, h('col', { style: { width: multi ? '30mm' : '18mm' } }), h('col', { style: { width: '20mm' } }), h('col'), h('col', { style: { width: '24mm' } }), h('col')),
            h('thead', null, h('tr', null, ['時刻', 'コート', 'チーム', '結果', 'チーム'].map((x) => h('th', null, x)))),
            h('tbody', null, ms.map((m, i) => {
              const done = !opts.blank && m.status === 'confirmed' && m.home_score != null;
              const w = done ? winnerSide(m) : null;
              const nm = (side) => { const info = sideInfo(m, side, cat, cache); return h('span', { class: `pd-named${side === 'home' ? ' r' : ''}` }, named(info.team, pickName(info.team, info.text, 60))); };
              return h('tr', { class: i % 2 ? 'band' : '' },
                h('td', { class: 'pd-time' }, `${multi ? `${dayOf(cfg, m.slot) + 1}日目 ` : ''}${toHHMM(m.start_min)}`), h('td', { class: 'c' }, courtName(cfg, m.court)),
                h('td', { class: `r${w === 'home' ? ' b' : ''}` }, nm('home')),
                h('td', { class: `c res${done ? '' : ' blank'}` }, done ? `${m.home_score} - ${m.away_score}` : '　 - 　'),
                h('td', { class: w === 'away' ? 'b' : '' }, nm('away')));
            })))));
      }
    }
    // リーグ戦の段（下位リーグなど）：1枚ずつ（星取表＋その段の対戦スケジュール）
    if (opts.post.blocks) {
      for (const g of Object.keys(cat.standings || {}).filter((x) => cat.standings[x].placement)) {
        const src = rankLeagueSource(cat, g);
        const ms = cat.matches.filter((m) => isRankLeague(m) && m.group_label === g).sort((a, b) => absMin(cfg, a) - absMin(cfg, b));
        const multi = dayTotal(cfg) > 1;
        sheets.push(growSheet('port',
          sheetHead(t, cat, g, `全体${(cat.standings[g].offset || 0) + 1}〜${(cat.standings[g].offset || 0) + src.order.length}位`),
          h('div', { class: 'ps-star' }, starTable(cat, g, opts, 194, 11, src)),
          h('p', { class: 'pd-note' }, starNote(cat)),
          h('h3', { class: 'ps-sub' }, '対戦スケジュール'),
          h('table', { class: 'pd-t ps-matches' },
            h('colgroup', null, h('col', { style: { width: multi ? '30mm' : '18mm' } }), h('col', { style: { width: '20mm' } }), h('col'), h('col', { style: { width: '24mm' } }), h('col')),
            h('thead', null, h('tr', null, ['時刻', 'コート', 'チーム', '結果', 'チーム'].map((x) => h('th', null, x)))),
            h('tbody', null, ms.map((m, i) => {
              const done = !opts.blank && m.status === 'confirmed' && m.home_score != null;
              const w = done ? winnerSide(m) : null;
              const nm = (side) => { const info = sideInfo(m, side, cat, cache); return h('span', { class: `pd-named${side === 'home' ? ' r' : ''}` }, named(info.team, pickName(info.team, info.text, 60))); };
              return h('tr', { class: i % 2 ? 'band' : '' },
                h('td', { class: 'pd-time' }, `${multi ? `${dayOf(cfg, m.slot) + 1}日目 ` : ''}${toHHMM(m.start_min)}`), h('td', { class: 'c' }, courtName(cfg, m.court)),
                h('td', { class: `r${w === 'home' ? ' b' : ''}` }, nm('home')),
                h('td', { class: `c res${done ? '' : ' blank'}` }, done ? `${m.home_score} - ${m.away_score}` : '　 - 　'),
                h('td', { class: w === 'away' ? 'b' : '' }, nm('away')));
            })))));
      }
    }
    // トーナメント：上位・中位・下位などを1つずつ1枚に（横向き）
    if (opts.post.brackets && cfg.format !== 'league' && cat.matches.some((m) => m.stage === 'knockout')) {
      for (const name of bracketNames(cat)) {
        sheets.push(growSheet('land', sheetHead(t, cat, name || 'トーナメント表', cfg.format === 'knockout' ? 'トーナメント' : '決勝トーナメント'),
          h('div', { class: 'ps-bracket' }, bracketView(cat, { tournament: t, myTeam: null, only: name }))));
      }
    }
    // コート別の試合一覧：1コート1枚（複数日なら1コート・1日）。コートの横に貼り出す用
    if (opts.post.courts && cat.matches.length) {
      for (const x of courtTables(t, cat, opts, { pageW: 194, big: true })) {
        sheets.push(growSheet('port', sheetHead(t, cat, x.title, x.sub || 'コート別の試合一覧'), h('div', { class: 'ps-court' }, x.table)));
      }
    }
    // 時間別の試合一覧：1日1枚（横向き）
    if (opts.post.timeline && cat.matches.length) {
      const days = dayTotal(cfg);
      for (let d = 0; d < days; d++) {
        if (opts.day !== 'all' && Number(opts.day) !== d) continue;
        const dayMs = cat.matches.filter((m) => dayOf(cfg, m.slot) === d);
        if (!dayMs.length) continue;
        // 時間帯が多い日は、読める大きさを保つため午前・午後の2枚に分ける
        const slots = new Set(dayMs.map((m) => m.slot)).size;
        const sessions = [...new Set(dayMs.map((m) => m.session))];
        const parts = slots > 9 && sessions.length > 1 ? [['am', '午前'], ['pm', '午後']] : [[null, '']];
        for (const [session, label] of parts) {
          const sec = scheduleSection(t, cat, { ...opts, day: String(d), session, pageW: 281, gridMax: 8 });
          sec.querySelectorAll('h2, h3').forEach((x) => x.remove());
          const when = days > 1 ? dayLabel(cat, d, t) : formatDate(dayDate(cat, 0, t));
          sheets.push(growSheet('land', sheetHead(t, cat, `試合スケジュール${label ? `（${label}）` : ''}`, when), h('div', { class: 'ps-time' }, sec)));
        }
      }
    }
  }
  if (!sheets.length) return toast('出力できる内容がありません', true);
  // ブラウザは1回の印刷で縦と横の用紙を正しく混在できないため、向きごとに分けて印刷する
  const port = sheets.filter((x) => x.classList.contains('ps-port'));
  const land = sheets.filter((x) => x.classList.contains('ps-land'));
  const go = (list, css, suffix, after) => {
    list.forEach((x) => x.classList.remove('last'));
    list[list.length - 1].classList.add('last');
    runPrint(h('div', { class: `pd ps${opts.logos ? ' pd-logos' : ''}` }, list), `${t.name}_掲示用${suffix}`, css, after);
  };
  if (port.length && land.length) {
    go(port, PAGE_PORT, '_縦', () => modal({
      title: '続けて横向きの用紙を出力',
      content: h('p', null, `リーグ戦（縦向き ${port.length}枚）を出力しました。続けて、トーナメント・時間別の試合一覧（横向き ${land.length}枚）を出力します。`),
      actions: [{ label: 'あとで', kind: 'btn-ghost' }, { label: '横向きを出力', kind: 'btn-primary', onClick: () => { setTimeout(() => go(land, PAGE_LAND, '_横'), 50); } }],
    }));
  } else if (port.length) go(port, PAGE_PORT, '');
  else go(land, PAGE_LAND, '');
}

// ======================================================================
// 駐車券（A4横）
// ======================================================================

export function printParking(t, cat, team) {
  const p = t.parking || {};
  const n = Math.max(1, Math.min(10, Number(p.perTeam) || 1));
  const valid = p.valid || periodText(t);
  const sheets = Array.from({ length: n }, (_, i) => sheet('land', h('div', { class: 'pk' },
    h('div', { class: 'pk-band' },
      t.logo ? h('img', { src: t.logo, alt: '' }) : null,
      h('div', null, h('div', { class: 'pk-tname' }, t.name), h('div', { class: 'pk-tsub' }, [valid, t.venue].filter(Boolean).join('　'))),
      n > 1 ? h('div', { class: 'pk-no' }, `No.${i + 1} / ${n}`) : null),
    h('div', { class: 'pk-main' },
      h('div', { class: 'pk-title' }, p.title || '駐車証'),
      h('div', { class: 'pk-team' }, fit(team.name, 'pk-team-fit')),
      h('div', { class: 'pk-cat' }, `${cat.name}　参加チーム`)),
    h('div', { class: 'pk-foot' },
      p.place ? h('div', { class: 'pk-place' }, h('span', null, '駐車場所'), h('strong', null, p.place)) : null,
      h('div', { class: 'pk-valid' }, h('span', null, '有効期間'), h('strong', null, valid)),
      p.note ? h('p', { class: 'pk-note' }, p.note) : null,
      h('p', { class: 'pk-hint' }, 'この駐車証は、車外から見えるようにダッシュボードの上に置いてください。')))));
  sheets[sheets.length - 1].classList.add('last');
  runPrint(h('div', { class: 'pd ps' }, sheets), `${t.name}_駐車証_${team.name}`, PAGE_LAND);
}


// ======================================================================
// スプレッドシート（Excel）出力
// ======================================================================

const STATUS_TEXT = { none: '未実施', provisional: '仮登録', confirmed: '確定' };

export function exportSpreadsheet(t, cats, opts) {
  const sheets = [];
  const multi = cats.length > 1;
  const catCol = (cat) => (multi ? [cat.name] : []);
  const catHead = multi ? ['カテゴリ'] : [];
  if (opts.xl.schedule) {
    const rows = [];
    for (const cat of cats) {
      const cfg = cat.config;
      const cache = { teams: teamMap(cat), codes: codeMap(cat) };
      const days = dayTotal(cfg);
      for (const m of [...cat.matches].sort((a, b) => absMin(cfg, a) - absMin(cfg, b) || a.court - b.court)) {
        const d = dayOf(cfg, m.slot);
        const done = m.status === 'confirmed' && m.home_score != null;
        const hasScore = m.home_score != null && m.status !== 'none';
        const w = done ? winnerSide(m) : null;
        const home = sideInfo(m, 'home', cat, cache).text;
        const away = sideInfo(m, 'away', cat, cache).text;
        rows.push([...catCol(cat), days > 1 ? `${d + 1}日目` : '1日目', dayDate(cat, d, t) || '', toHHMM(m.start_min), courtName(cfg, m.court), m.label,
          { v: home, bold: w === 'home' }, hasScore ? m.home_score : null, hasScore ? m.away_score : null, { v: away, bold: w === 'away' },
          m.home_pk != null && hasScore ? `${m.home_pk}-${m.away_pk}` : '', m.forfeit ? '不戦勝' : STATUS_TEXT[m.status] || '', w ? (w === 'home' ? home : away) : '']);
      }
    }
    sheets.push({ name: '日程・結果', header: [...catHead, '日', '日付', '時刻', 'コート', '試合', 'チーム（左）', '得点', '得点', 'チーム（右）', 'PK', '状態', '勝ち'], rows });
  }
  if (opts.xl.groups) {
    const rows = [];
    for (const cat of cats) {
      for (const x of [...cat.teams].filter((y) => y.group_label).sort((a, b) => a.group_label.localeCompare(b.group_label))) {
        rows.push([...catCol(cat), `${x.group_label}組`, x.name, x.short_name || '', x.club || '']);
      }
    }
    sheets.push({ name: '組分け', header: [...catHead, '組', 'チーム', '略称', 'クラブ'], rows });
  }
  if (opts.xl.standings) {
    const rows = [];
    for (const cat of cats) {
      const tm = teamMap(cat);
      const keys = Object.keys(cat.standings || {}).sort((a, b) => (cat.standings[a].placement ? 1 : 0) - (cat.standings[b].placement ? 1 : 0) || a.localeCompare(b));
      for (const g of keys) {
        const st = cat.standings[g];
        for (const r of st.rows) {
          const note = r.lottery ? '抽選・じゃんけん・本部決定' : r.tied && st.complete ? '順位決定待ち' : !st.complete ? '途中経過' : '';
          rows.push([...catCol(cat), st.placement ? g : `${g}組`, r.rank, tm[r.teamId] ? tm[r.teamId].name : '', r.p, r.w, r.d, r.l, r.gf, r.ga, r.gd, r.pts,
            st.placement && st.complete && !r.tied ? (st.offset || 0) + r.rank : null, note]);
        }
      }
    }
    sheets.push({ name: '順位表', header: [...catHead, '組・段', '順位', 'チーム', '試合', '勝', '分', '敗', '得点', '失点', '得失点差', '勝点', '全体順位', '備考'], rows });
  }
  if (opts.xl.ranking) {
    const rows = [];
    for (const cat of cats) {
      const tm = teamMap(cat);
      for (const r of cat.finalRanking || []) rows.push([...catCol(cat), r.rank, tm[r.teamId] ? tm[r.teamId].name : '']);
    }
    sheets.push({ name: '最終順位', header: [...catHead, '順位', 'チーム'], rows });
  }
  if (opts.xl.teams) {
    const rows = [];
    for (const cat of cats) for (const x of cat.teams) rows.push([...catCol(cat), x.name, x.short_name || '', x.group_label ? `${x.group_label}組` : '', x.club || '']);
    sheets.push({ name: 'チーム一覧', header: [...catHead, 'チーム', '略称', '組', 'クラブ'], rows });
  }
  downloadBlob(buildXlsx(sheets), `${t.name}_${multi ? '全カテゴリ' : cats[0].name}.xlsx`);
  toast('Excelファイルを保存しました');
}
