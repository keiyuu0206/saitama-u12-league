/* 埼玉県第4種サッカーリーグ 順位ボード */
const $ = (s, el = document) => el.querySelector(s);
const REGIONS = ["東部", "西部", "南部", "北部", "少女"];
let DATA = null;
let currentTab = "東部";
let recentIds = new Set();

const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const jpDate = iso => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
const pdfDate = s => s ? esc(s.replaceAll("-", "/")) : "";

async function init() {
  try {
    const [lg, hist] = await Promise.all([
      fetch("data/leagues.json").then(r => r.json()),
      fetch("data/history.json").then(r => r.json()).catch(() => []),
    ]);
    DATA = lg;
    if (Array.isArray(hist) && hist[0]) hist[0].changes.forEach(c => recentIds.add(c.id));
    $("#updated").innerHTML =
      `最終更新 <b>${jpDate(lg.generated_at)}</b> ／ 全${lg.leagues.length}リーグ`;
    renderHero();
    renderTabs();
    renderLeagues();
    renderHistory(Array.isArray(hist) ? hist : []);
    $("#search").addEventListener("input", onSearch);
  } catch (e) {
    $("#updated").textContent = "データを読み込めませんでした。時間をおいて再読み込みしてください。";
  }
}

/* ---------- 県リーグ(S1/S2)ヒーロー ---------- */
function renderHero() {
  const hero = $("#hero");
  const pref = DATA.leagues.filter(l => l.category === "県");
  if (!pref.length) { hero.innerHTML = ""; return; }
  const cards = pref.map(l => {
    const nn = l.name.normalize("NFKC");
    const tier = /S?1|Ｓ1/.test(nn) ? "s1" : /S?2|Ｓ2/.test(nn) ? "s2" : "";
    const tierLabel = tier ? tier.toUpperCase() : "県";
    return `
      <article class="flagship">
        <div class="flag-head ${tier}">
          <span class="flag-tier">${tierLabel}</span>
          <span class="flag-meta">
            <span class="flag-name">${esc(l.name)}</span>
            ${l.pdf_date ? `<span class="flag-date">${pdfDate(l.pdf_date)} 時点</span>` : ""}
          </span>
        </div>
        ${standingsTable(l)}
        ${l.standings ? "" : links(l)}
      </article>`;
  }).join("");
  hero.innerHTML = `<p class="sec-label">県リーグ</p><div class="flagships">${cards}</div>`;
}

/* ---------- 地域タブ ---------- */
function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = REGIONS.map(r => {
    const n = DATA.leagues.filter(l => l.category === r).length;
    return `<button role="tab" aria-selected="${r === currentTab}" data-r="${r}">
      ${r}<span class="cnt">${n}</span></button>`;
  }).join("");
  tabs.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    currentTab = b.dataset.r;
    [...tabs.children].forEach(x => x.setAttribute("aria-selected", x === b));
    renderLeagues();
  });
}

/* ---------- リーグ一覧 ---------- */
function renderLeagues(query = "") {
  const sec = $("#leagues");
  const q = query.trim();
  let list;
  if (q) {
    list = DATA.leagues.filter(l => matches(l, q));
    $("#tabs").classList.add("hidden");
  } else {
    list = DATA.leagues.filter(l => l.category === currentTab);
    $("#tabs").classList.remove("hidden");
  }
  sec.innerHTML = list.length
    ? list.map(l => leagueCard(l, q)).join("")
    : `<p class="note-legend">「${esc(q)}」に一致するリーグ・チームは見つかりませんでした。</p>`;
  bindTeamButtons(sec);
}

function matches(l, q) {
  const nq = q.normalize("NFKC").toLowerCase();
  if (l.name.normalize("NFKC").toLowerCase().includes(nq)) return true;
  const teams = (l.standings?.map(s => s.team) || []).concat(l.teams || []);
  return teams.some(t => t.normalize("NFKC").toLowerCase().includes(nq));
}

function leagueCard(l, q) {
  const open = q ? " open" : "";
  const upd = recentIds.has(l.id) ? `<span class="badge-upd">更新</span>` : "";
  return `
  <details class="league"${open} data-league="${esc(l.id)}">
    <summary>
      <span class="chip">${esc(l.category)}</span>
      <span class="lg-name">${hl(esc(l.name), q)}</span> ${upd}
      <span class="lg-date">${l.pdf_date ? pdfDate(l.pdf_date) : ""}</span>
      <svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    ${standingsTable(l, q)}
    ${l.standings ? "" : links(l)}
  </details>`;
}

/* ---------- 順位表 ---------- */
function standingsTable(l, q = "") {
  if (!l.standings) {
    return `<div class="lg-warn">この星取表は現在のレイアウトでは自動で読み取れませんでした。
      <a href="${esc(l.pdf_url || l.url)}" target="_blank" rel="noopener">公式PDFを開く</a></div>`;
  }
  const lid = esc(l.id);
  const rows = l.standings.map((s, i) => {
    const hit = q && s.team.normalize("NFKC").toLowerCase()
      .includes(q.normalize("NFKC").toLowerCase());
    const rc = s.rank <= 3 ? ` r${s.rank}` : "";
    const hasH2h = Array.isArray(s.h2h) && s.h2h.some(x => x && x.length);
    const tag = s.note === "mismatch"
      ? ` <span class="note-tag note-mismatch">要確認</span>`
      : s.note === "tiebreak"
      ? ` <span class="note-tag note-tiebreak">勝点同数</span>` : "";
    const chev = hasH2h
      ? `<svg class="mini-chev" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      : "";
    const nameCell = hasH2h
      ? `<button class="team-btn" data-league="${lid}" data-idx="${i}" aria-expanded="false">
           <span class="rank-plate${rc}">${s.rank ?? "-"}</span>
           <span class="tname">${hl(esc(s.team), q)}${tag}</span>${chev}
         </button>`
      : `<div class="team-btn" style="cursor:default">
           <span class="rank-plate${rc}">${s.rank ?? "-"}</span>
           <span class="tname">${hl(esc(s.team), q)}${tag}</span>
         </div>`;
    return `<tr${hit ? ' class="hit"' : ""} data-row="${i}">
      <td class="c-team">${nameCell}</td>
      <td class="c-num"><div class="cell">${s.played}</div></td>
      <td class="c-num"><div class="cell">${s.win}</div></td>
      <td class="c-num"><div class="cell">${s.draw}</div></td>
      <td class="c-num"><div class="cell">${s.loss}</div></td>
      <td class="c-pts"><div class="cell">${s.points ?? "-"}</div></td>
    </tr>`;
  }).join("");

  // 注記凡例(要確認・勝点同数のみ。暫定表記は表示しない)
  const kinds = new Set(l.standings.map(s => s.note).filter(Boolean));
  const items = [];
  if (kinds.has("mismatch"))
    items.push(`<span class="note-tag note-mismatch">要確認</span> 勝点と勝敗数が一致しません。公式PDFの数値をご確認ください。`);
  if (kinds.has("tiebreak"))
    items.push(`<span class="note-tag note-tiebreak">勝点同数</span> 勝点が同じチームがあります。順位は連盟の確定順位(得失点差等)に準拠しています。`);
  const legend = items.length
    ? `<div class="note-legend">${items.map(t => `<p>${t}</p>`).join("")}</div>` : "";

  return `<div class="tbl-wrap"><table>
    <thead><tr>
      <th class="th-team">順位・チーム</th>
      <th>試合</th><th>勝</th><th>分</th><th>敗</th><th>勝点</th>
    </tr></thead>
    <tbody>${rows}</tbody></table></div>${legend}`;
}

/* ---------- 対戦成績の展開 ---------- */
function bindTeamButtons(root) {
  root.querySelectorAll("button.team-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleH2h(btn));
  });
}

function toggleH2h(btn) {
  const lid = btn.dataset.league;
  const idx = +btn.dataset.idx;
  const tr = btn.closest("tr");
  const next = tr.nextElementSibling;
  // 既に開いていれば閉じる
  if (next && next.classList.contains("h2h-row")) {
    next.remove();
    tr.classList.remove("open-row");
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  // 同リーグの他の展開を閉じる
  const tbody = tr.parentElement;
  tbody.querySelectorAll(".h2h-row").forEach(r => r.remove());
  tbody.querySelectorAll(".open-row").forEach(r => {
    r.classList.remove("open-row");
    const b = r.querySelector(".team-btn");
    if (b) b.setAttribute("aria-expanded", "false");
  });

  const league = DATA.leagues.find(l => String(l.id) === String(lid));
  const s = league?.standings?.[idx];
  if (!s) return;
  const colspan = 6;
  const row = document.createElement("tr");
  row.className = "h2h-row";
  row.innerHTML = `<td colspan="${colspan}">${h2hPanel(s, league)}</td>`;
  tr.after(row);
  tr.classList.add("open-row");
  btn.setAttribute("aria-expanded", "true");
}

function h2hPanel(s, league) {
  const labels = s.opp_labels || [];
  const items = [];
  (s.h2h || []).forEach((res, i) => {
    if (res === null) return;                 // 自分自身
    const opp = labels[i] || `相手${i + 1}`;
    let marks;
    if (!res || !res.length) {
      marks = `<span class="rmark none">—</span>`;
    } else {
      marks = res.map(r => {
        const label = { win: "○", draw: "△", loss: "●" }[r];
        return `<span class="rmark ${r}">${label}</span>`;
      }).join("");
    }
    const played = res && res.length;
    items.push(`<div class="h2h-item">
      <span class="h2h-opp">${esc(opp)}</span>
      <span class="h2h-marks">${marks}</span>
    </div>`);
  });
  const body = items.length
    ? `<div class="h2h-list">${items.join("")}</div>`
    : `<p class="h2h-empty">対戦結果の記録がありません。</p>`;
  const pdf = league.pdf_url
    ? `<a class="h2h-pdf" href="${esc(league.pdf_url)}" target="_blank" rel="noopener">公式PDF</a>` : "";
  return `<div class="h2h-panel">
    <p class="h2h-title"><span class="pill">${esc(s.team)}</span>の対戦成績</p>
    ${body}
    <div class="h2h-sum">
      <span>${s.played}試合　<b>${s.win}</b>勝 <b>${s.draw}</b>分 <b>${s.loss}</b>敗　勝点 <b>${s.points ?? "-"}</b></span>
      ${pdf}
    </div>
  </div>`;
}

function links(l) {
  return `<div class="lg-links">
    ${l.pdf_url ? `<a href="${esc(l.pdf_url)}" target="_blank" rel="noopener">公式PDF(星取表)</a>` : ""}
    <a href="${esc(l.url)}" target="_blank" rel="noopener">連盟サイトのリーグページ</a>
  </div>`;
}

/* ---------- 検索 ---------- */
function onSearch(e) {
  const q = e.target.value;
  renderLeagues(q);
  const meta = $("#searchMeta");
  if (q.trim()) {
    const hits = DATA.leagues.filter(l => matches(l, q)).length;
    meta.textContent = `全カテゴリから ${hits} リーグがヒット`;
    meta.hidden = false;
    $("#hero").classList.add("hidden");
    $("#historySec").classList.add("hidden");
  } else {
    meta.hidden = true;
    $("#hero").classList.remove("hidden");
    $("#historySec").classList.remove("hidden");
  }
}

function hl(escaped, q) {
  if (!q || !q.trim()) return escaped;
  const nq = q.normalize("NFKC");
  try {
    const re = new RegExp(nq.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return escaped.replace(re, m => `<mark>${m}</mark>`);
  } catch { return escaped; }
}

/* ---------- 更新履歴 ---------- */
function renderHistory(hist) {
  const el = $("#history");
  if (!hist.length) {
    el.innerHTML = `<p class="note-legend">まだ更新履歴はありません。日々の集計で変更が出ると、ここに差分が記録されます。</p>`;
    return;
  }
  el.innerHTML = hist.slice(0, 15).map(h => `
    <div class="h-entry">
      <span class="h-date">${esc(h.date)}</span>
      <ul>${h.changes.map(c => `
        <li>[${esc(c.category)}] ${esc(c.name)}${c.type === "new" ? "(初回掲載)" : ""}
          ${c.detail?.length ? `<div class="d">${c.detail.map(esc).join(" ／ ")}</div>` : ""}
        </li>`).join("")}
      </ul>
    </div>`).join("");
}

init();
