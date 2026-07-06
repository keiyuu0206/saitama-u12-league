# -*- coding: utf-8 -*-
"""
埼玉県第4種リーグ 星取表PDFパーサー

PDFの単純なテキスト抽出では列の対応(勝点・順位)が崩れるため、
pdfplumber の単語座標を用いて行(チーム)と列(勝点/順位)を照合する。
"""
import re
import unicodedata

import pdfplumber

MARK_WIN = "○"
MARK_DRAW = "△"
MARK_LOSS = "●"
MARKS = {MARK_WIN, MARK_DRAW, MARK_LOSS}

DATE_RE = re.compile(r"(20\d{2})\s*[/年]\s*(\d{1,2})\s*[/月]\s*(\d{1,2})")


def normalize(s: str) -> str:
    """全角/半角・空白・記号ゆれを吸収した比較用文字列を返す"""
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"\s+", "", s)
    s = s.replace("－", "-").replace("ー", "-").replace("−", "-")
    return s.upper()


def _digits(text: str):
    """✳等の装飾を除いた数値を取り出す。数値でなければNone"""
    m = re.search(r"\d+", unicodedata.normalize("NFKC", text))
    return int(m.group()) if m else None


def _find_column_band(words, label):
    """ヘッダー語(勝点/順位)のx範囲を返す。見つからなければNone"""
    cands = [w for w in words if label in w["text"]]
    if not cands:
        return None
    w = cands[0]
    cx = (w["x0"] + w["x1"]) / 2
    width = max(w["x1"] - w["x0"], 20)
    return (cx - width, cx + width)


def _rows_from_marks(words, tol=6):
    """○△●マークのy座標をクラスタリングして行を推定する"""
    ys = sorted(
        (w["top"] + w["bottom"]) / 2
        for w in words
        if any(c in MARKS for c in w["text"])
    )
    rows = []
    for y in ys:
        if rows and abs(rows[-1][-1] - y) <= tol:
            rows[-1].append(y)
        else:
            rows.append([y])
    return [sum(r) / len(r) for r in rows]


def parse_page(page, entry_teams=None):
    """1ページ分の星取表を解析して standings のリストを返す"""
    words = page.extract_words(extra_attrs=["size"])
    if not words:
        return None

    pts_band = _find_column_band(words, "勝点") or _find_column_band(words, "勝ち点")
    rank_band = _find_column_band(words, "順位")
    if pts_band is None and rank_band is None:
        return None  # 星取表ページではない

    row_ys = _rows_from_marks(words)
    if not row_ys:
        return None

    row_h = 14
    if len(row_ys) > 1:
        gaps = [b - a for a, b in zip(row_ys, row_ys[1:])]
        row_h = max(min(gaps) * 0.45, 6)

    norm_entries = [(normalize(t), t) for t in (entry_teams or [])]
    standings = []

    for y in row_ys:
        in_row = [w for w in words if abs((w["top"] + w["bottom"]) / 2 - y) <= row_h]
        if not in_row:
            continue
        in_row.sort(key=lambda w: w["x0"])

        # 勝敗マーク
        marks = "".join(c for w in in_row for c in w["text"] if c in MARKS)
        win, draw, loss = (marks.count(m) for m in (MARK_WIN, MARK_DRAW, MARK_LOSS))

        # チーム名: マーク列より左のテキスト(括弧書きの市町村名は除外)
        first_mark_x = min(
            (w["x0"] for w in in_row if any(c in MARKS for c in w["text"])),
            default=page.width,
        )
        def is_name_word(w):
            if w["x1"] > first_mark_x:
                return False
            t = w["text"]
            if re.fullmatch(r"[（(].*[)）]?", t):  # (八潮市) 等の所在地
                return False
            n = unicodedata.normalize("NFKC", t)
            # 数字・記号のみの語(順位や勝点の混入)は除外。ただし名称中の数字は許容
            return bool(re.search(r"[^\d\s✳*.,\-]", n))

        raw_name = "".join(w["text"] for w in in_row if is_name_word(w)).strip()

        # 出場チームリストと照合して正式名称に寄せる
        team = raw_name
        if norm_entries and raw_name:
            n = normalize(raw_name)
            best = None
            for nn, original in norm_entries:
                if n == nn or n in nn or nn in n:
                    best = original
                    break
            if best:
                team = best

        def in_band(w, band):
            if band is None:
                return False
            cx = (w["x0"] + w["x1"]) / 2
            return band[0] <= cx <= band[1]

        points = next(
            (_digits(w["text"]) for w in in_row
             if in_band(w, pts_band) and _digits(w["text"]) is not None),
            None,
        )
        rank = next(
            (_digits(w["text"]) for w in in_row
             if in_band(w, rank_band) and _digits(w["text"]) is not None),
            None,
        )

        if not team and points is None and not marks:
            continue

        standings.append({
            "team": team,
            "win": win, "draw": draw, "loss": loss,
            "played": win + draw + loss,
            "points": points,
            "rank": rank,
        })

    if not standings:
        return None

    # 勝点が取れなかった行は 3勝点方式で補完(マークがあれば)
    for s in standings:
        if s["points"] is None and s["played"] > 0:
            s["points"] = 3 * s["win"] + s["draw"]
            s["points_estimated"] = True

    # 順位列が無い場合は勝点降順で付与(同点は同順位)
    if all(s["rank"] is None for s in standings):
        ordered = sorted(
            standings, key=lambda s: (-(s["points"] or 0), -s["win"]),
        )
        last_pts, last_rank = None, 0
        for i, s in enumerate(ordered, 1):
            if s["points"] != last_pts:
                last_rank, last_pts = i, s["points"]
            s["rank"] = last_rank
            s["rank_estimated"] = True

    standings.sort(key=lambda s: (s["rank"] is None, s["rank"] or 999, -(s["points"] or 0)))
    return standings


def parse_pdf(path, entry_teams=None):
    """
    PDF全体を解析する。星取表を含むページのうち
    最も多くの行が取れたページの結果を採用する。
    戻り値: {"standings": [...], "pdf_date": "YYYY-MM-DD"|None, "pages": n}
    """
    best = None
    pdf_date = None
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            m = DATE_RE.search(text)
            if m and not pdf_date:
                y, mo, d = m.groups()
                pdf_date = f"{y}-{int(mo):02d}-{int(d):02d}"
            try:
                st = parse_page(page, entry_teams)
            except Exception:
                st = None
            if st and (best is None or len(st) > len(best)):
                best = st
        n_pages = len(pdf.pages)

    if not best:
        return {"standings": None, "pdf_date": pdf_date, "pages": n_pages}

    # 妥当性チェック: 勝点 = 3勝 + 分 が過半数で成立していれば信頼できる
    ok = sum(
        1 for s in best
        if s["points"] is not None and s["points"] == 3 * s["win"] + s["draw"]
    )
    confident = ok >= max(1, len(best) // 2)
    return {
        "standings": best,
        "pdf_date": pdf_date,
        "pages": n_pages,
        "confident": confident,
    }
