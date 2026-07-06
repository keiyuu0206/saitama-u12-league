# -*- coding: utf-8 -*-
"""
埼玉県U-12サッカー連盟 第4種リーグ 収集スクリプト

1. /league/ からカテゴリ別のリーグ一覧を取得
2. 各詳細ページから出場チームとPDF URLを取得
3. PDFのSHA-256を前回と比較し、変更があったものだけ再解析(差分検出)
4. site/data/ に leagues.json / hashes.json / history.json を出力
"""
import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from parser import parse_pdf

BASE = "https://www.saitama-u12.com"
INDEX_URL = f"{BASE}/league/"
JST = timezone(timedelta(hours=9))

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "site" / "data"
PDF_CACHE = ROOT / ".pdf_cache"

CATEGORIES = ["県", "東部", "西部", "南部", "北部", "少女"]

session = requests.Session()
session.headers.update({
    "User-Agent": "saitama-u12-league-viewer/1.0 (standings aggregator; polite crawler)"
})
REQUEST_INTERVAL = 1.0  # サーバー負荷への配慮


def get(url, **kw):
    time.sleep(REQUEST_INTERVAL)
    r = session.get(url, timeout=30, **kw)
    r.raise_for_status()
    return r


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8"
    )


def fetch_league_index():
    """一覧ページからカテゴリごとのリーグ(名前, id, URL)を取得"""
    soup = BeautifulSoup(get(INDEX_URL).text, "html.parser")
    leagues = []
    current_cat = None
    # 見出し(県/東部/...)の後に続くリンク一覧、という構造。
    # 見出しタグの種類(h2〜h5等)に依存しないよう、文書順に走査して
    # 「直前に現れたカテゴリ見出し」で分類する。
    for el in soup.find_all(True):
        txt = el.get_text(strip=True) if el.name in (
            "h2", "h3", "h4", "h5", "dt", "caption") else None
        if txt in CATEGORIES:
            current_cat = txt
        elif txt in ("大会情報一覧", "メニュー一覧"):
            current_cat = None
        elif el.name == "a" and current_cat:
            href = el.get("href", "")
            m = re.search(r"/league/detail/id=(\d+)", href)
            if m:
                leagues.append({
                    "id": m.group(1),
                    "name": el.get_text(strip=True),
                    "category": current_cat,
                    "url": urljoin(BASE, href),
                })
    # 重複除去(同一idが複数箇所に出る場合)
    seen, uniq = set(), []
    for lg in leagues:
        if lg["id"] not in seen:
            seen.add(lg["id"])
            uniq.append(lg)
    return uniq


def fetch_league_detail(url):
    """詳細ページから出場チーム一覧とPDF URLを取得"""
    soup = BeautifulSoup(get(url).text, "html.parser")
    teams = []
    # 「出場チーム」見出しの次の要素群にチーム名が改行区切りで入っている
    for h in soup.find_all(["h3", "h4"]):
        if "出場チーム" in h.get_text():
            node = h.find_next_sibling()
            while node and node.name not in ("h3", "h4"):
                text = node.get_text("\n", strip=True)
                for line in text.split("\n"):
                    line = line.strip()
                    if line and "http" not in line and len(line) < 60:
                        teams.append(line)
                node = node.find_next_sibling()
            break

    pdf_url = None
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.lower().endswith(".pdf") and "/files/topics/" in href:
            pdf_url = urljoin(BASE, href)
            break
    if not pdf_url:
        # gview埋め込みリンクからの抽出をフォールバックとして試す
        m = re.search(r"url=(https?://[^\s\"'&]+\.pdf)", soup.decode())
        if m:
            pdf_url = m.group(1)
    return teams, pdf_url


def main():
    now = datetime.now(JST)
    today = now.strftime("%Y-%m-%d")

    prev_hashes = load_json(DATA_DIR / "hashes.json", {})
    prev_leagues = {
        lg["id"]: lg
        for lg in load_json(DATA_DIR / "leagues.json", {}).get("leagues", [])
    }
    history = load_json(DATA_DIR / "history.json", [])

    PDF_CACHE.mkdir(exist_ok=True)

    print("リーグ一覧を取得中...")
    index = fetch_league_index()
    print(f"  {len(index)} リーグを検出")

    new_hashes = {}
    leagues_out = []
    changes = []

    for lg in index:
        lid = lg["id"]
        print(f"[{lg['category']}] {lg['name']} (id={lid})")
        try:
            teams, pdf_url = fetch_league_detail(lg["url"])
        except Exception as e:
            print(f"  ! 詳細ページ取得失敗: {e}")
            if lid in prev_leagues:  # 前回データを維持
                leagues_out.append(prev_leagues[lid])
                new_hashes[lid] = prev_hashes.get(lid, {})
            continue

        entry = {**lg, "teams": teams, "pdf_url": pdf_url}

        if not pdf_url:
            entry.update(status="no_pdf", standings=None, pdf_date=None)
            leagues_out.append(entry)
            new_hashes[lid] = {"sha256": None}
            continue

        try:
            pdf_bytes = get(pdf_url).content
        except Exception as e:
            print(f"  ! PDF取得失敗: {e}")
            if lid in prev_leagues:
                leagues_out.append(prev_leagues[lid])
                new_hashes[lid] = prev_hashes.get(lid, {})
            continue

        sha = hashlib.sha256(pdf_bytes).hexdigest()
        prev = prev_hashes.get(lid, {})
        unchanged = prev.get("sha256") == sha and lid in prev_leagues

        new_hashes[lid] = {
            "sha256": sha,
            "pdf_url": pdf_url,
            "last_changed": prev.get("last_changed", today) if unchanged else today,
        }

        if unchanged:
            # 変更なし → 前回の解析結果を再利用(差分検出の要)
            cached = prev_leagues[lid]
            cached.update(name=lg["name"], category=lg["category"], teams=teams)
            leagues_out.append(cached)
            continue

        # 変更あり → 解析
        pdf_path = PDF_CACHE / f"{lid}.pdf"
        pdf_path.write_bytes(pdf_bytes)
        result = parse_pdf(str(pdf_path), entry_teams=teams)

        if result["standings"]:
            entry.update(
                status="ok" if result.get("confident") else "low_confidence",
                standings=result["standings"],
                pdf_date=result["pdf_date"],
            )
        else:
            entry.update(status="parse_failed", standings=None,
                         pdf_date=result["pdf_date"])
            print("  ! 解析失敗(PDFリンクのみ表示)")

        entry["last_changed"] = today
        leagues_out.append(entry)

        # 差分内容(勝点変動)の算出
        diff = describe_diff(prev_leagues.get(lid), entry)
        changes.append({
            "id": lid,
            "name": lg["name"],
            "category": lg["category"],
            "type": "new" if lid not in prev_leagues else "updated",
            "detail": diff,
        })

    # カテゴリ順・掲載順を保つ
    order = {lid: i for i, lid in enumerate(l["id"] for l in index)}
    leagues_out.sort(key=lambda l: order.get(l["id"], 999))

    if changes:
        history.insert(0, {"date": today, "time": now.strftime("%H:%M"),
                           "changes": changes})
        history = history[:60]  # 直近60回分を保持

    save_json(DATA_DIR / "leagues.json", {
        "generated_at": now.isoformat(),
        "source": INDEX_URL,
        "leagues": leagues_out,
    })
    save_json(DATA_DIR / "hashes.json", new_hashes)
    save_json(DATA_DIR / "history.json", history)

    print(f"\n完了: {len(leagues_out)} リーグ / 更新 {len(changes)} 件")
    return 0


def describe_diff(old, new):
    """前回との勝点差分を人間可読な短文リストで返す"""
    if not old or not old.get("standings") or not new.get("standings"):
        return []
    old_pts = {s["team"]: s.get("points") for s in old["standings"]}
    notes = []
    for s in new["standings"]:
        before = old_pts.get(s["team"])
        after = s.get("points")
        if before is not None and after is not None and before != after:
            notes.append(f"{s['team']} 勝点 {before}→{after}")
    return notes[:10]


if __name__ == "__main__":
    sys.exit(main())
