import { h, mount, closeOverlays } from './web-ui.js';

const root = document.getElementById('app');

// 今表示している画面のURL（ポップアップを開いたまま「戻る」を押されたときに、元のURLに戻すため）
let shownUrl = location.href;

async function route() {
  shownUrl = location.href;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  document.body.classList.remove('has-bottom-nav');
  const navigate = (to) => { history.pushState(null, '', to); route(); window.scrollTo(0, 0); };
  try {
    if (path.startsWith('/admin')) {
      const { admin } = await import('./web-admin.js');
      return await admin(root, path, navigate);
    }
    let m = path.match(/^\/t\/([^/]+)$/);
    if (m) {
      const { viewer } = await import('./web-viewer.js');
      return await viewer(root, m[1]);
    }
    m = path.match(/^\/r\/([^/]+)$/);
    if (m) {
      const { relative } = await import('./web-relative.js');
      return await relative(root, m[1]);
    }
    home();
  } catch (e) {
    console.error(e);
    // どのファイルで失敗したかを表示し、古いファイルを捨てて読み直せるようにする
    mount(root, h('div', { class: 'wrap', style: { marginTop: '40px' } }, h('div', { class: 'panel stack' },
      h('h2', null, '画面を表示できませんでした'),
      h('p', { style: { margin: 0 } }, '更新の直後は、古いファイルが残っていることがあります。下のボタンで読み直してください。'),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: () => {
        const u = new URL(location.href);
        u.searchParams.set('r', Date.now());
        location.replace(u.toString());
      } }, 'もう一度読み込む'),
      h('p', { class: 'muted small', style: { margin: 0, overflowWrap: 'anywhere' } }, `原因：${e && e.message ? e.message : String(e)}`))));
  }
}

function home() {
  mount(root,
    h('header', { class: 'site-head' }, h('div', { class: 'wrap' }, h('h1', null, '少年サッカー 大会運営'))),
    h('main', { class: 'wrap stack', style: { marginTop: '24px' } },
      h('p', null, '試合結果は、大会本部から共有されたURLで見られます。'),
      h('a', { class: 'btn btn-primary', href: '/admin' }, '大会運営者のログイン')));
}

// 「戻る」：ポップアップが開いていれば閉じるだけにして、裏の画面はそのままにする（URLも元に戻す）
window.addEventListener('popstate', () => {
  if (closeOverlays()) { history.pushState(null, '', shownUrl); return; }
  route();
});
route();
