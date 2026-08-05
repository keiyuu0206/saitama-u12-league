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


def _band(words, label, pad=8):
    """ヘッダー語(勝点/順位)のx範囲を返す。見つからなければNone。

    PDFによっては「勝点」が1語で入る場合と1文字ずつ分離する場合があるため、
    まず1語一致を試し、なければ同じ行で label の各文字が連続する箇所を探す。
    """
    for w in words:
        if label in w["text"]:
            return (w["x0"] - pad, w["x1"] + pad, w["top"])

    # 1文字ずつ分離しているケース: 同一行(top±4)で label の文字が順に並ぶ範囲を探す
    chars = list(label)
    for w0 in words:
        if w0["text"] != chars[0]:
            continue
        row = sorted(
            (w for w in words if abs(w["top"] - w0["top"]) <= 4),
            key=lambda w: w["x0"],
        )
        seq = "".join(w["text"] for w in row)
        idx = seq.find(label)
        if idx == -1:
            continue
        # label に対応する単語群の x 範囲を求める
        pos, matched = 0, []
        for w in row:
            wlen = len(w["text"])
            if pos < idx + len(label) and pos + wlen > idx:
                matched.append(w)
            pos += wlen
        if matched:
            return (min(m["x0"] for m in matched) - pad,
                    max(m["x1"] for m in matched) + pad,
                    w0["top"])
    return None


NAME_X_MAX = 160  # チーム名列の右端の目安(x0がこれ未満なら名前列とみなす)
HEADER_WORDS = {"勝点", "勝ち点", "順位", "現在"}


def _points_anchors(words, pts_band, header_bottom):
    """
    勝点列の数字を各チームの縦アンカーとして返す [(top, points), ...]。
    2段組でもチーム1つにつき勝点は1つなので、行分裂に強い。
    """
    anchors = []
    lo, hi = pts_band[0], pts_band[1]
    for w in words:
        cx = (w["x0"] + w["x1"]) / 2
        if lo <= cx <= hi and w["top"] > header_bottom:
            v = _digits(w["text"])
            if v is not None and not (1900 <= v <= 2100):  # 日付(2026等)を除外
                anchors.append((w["top"], v))
    anchors.sort()
    return anchors


def parse_page(page, entry_teams=None):
    """1ページ分の星取表を解析して standings のリストを返す。

    勝点列の数字を各チームのアンカーとし、その上下の帯からマーク・チーム名・
    順位を集める。1段組・2段組いずれのレイアウトにも対応する。
    """
    words = page.extract_words()
    if not words:
        return None

    pts_band = _band(words, "勝点") or _band(words, "勝ち点")
    rank_band = _band(words, "順位")
    if pts_band is None:
        return None  # 星取表(勝点列)が無いページ

    header_bottom = pts_band[2] + 12
    anchors = _points_anchors(words, pts_band, header_bottom)
    if not anchors:
        return None

    # 各チームの担当y区間 = 隣接アンカーの中点。名前は勝点より少し上に出るため
    # 上側は広め(-0.62)、下側はやや狭め(0.55)に取る。
    bounds = []
    for i, (top_i, _) in enumerate(anchors):
        if i > 0:
            up = top_i - (top_i - anchors[i - 1][0]) * 0.62
        else:
            up = top_i - 44
        if i < len(anchors) - 1:
            dn = top_i + (anchors[i + 1][0] - top_i) * 0.55
        else:
            dn = top_i + 44
        bounds.append((up, dn))

    norm_entries = [(normalize(t), t) for t in (entry_teams or [])]
    standings = []

    for (atop, pts), (y0, y1) in zip(anchors, bounds):
        cells = [w for w in words if y0 <= w["top"] < y1]

        # 勝敗マーク(チーム名列より右)
        marks = "".join(
            c for w in cells if w["x0"] > NAME_X_MAX
            for c in w["text"] if c in MARKS
        )
        win, draw, loss = (marks.count(m) for m in (MARK_WIN, MARK_DRAW, MARK_LOSS))

        # チーム名(x0が名前列内・日本語/英字を含む・括弧書きや数値は除外)
        name_words = []
        for w in sorted((c for c in cells if c["x0"] < NAME_X_MAX),
                        key=lambda w: (w["top"], w["x0"])):
            t = w["text"]
            tn = unicodedata.normalize("NFKC", t)
            if tn in HEADER_WORDS:
                continue
            if re.fullmatch(r"[（(].*[)）]?", t):  # (さいたま市) 等
                continue
            if _digits(t) is not None and not re.search(r"[一-龥ぁ-んァ-ヶA-Za-z]", tn):
                continue
            if not re.search(r"[一-龥ぁ-んァ-ヶA-Za-zＡ-Ｚａ-ｚ]", tn):
                continue
            name_words.append(t)
        raw_name = "".join(name_words).strip()

        # 出場チームリストと照合して正式名称に寄せる
        team = raw_name
        if norm_entries and raw_name:
            n = normalize(raw_name)
            for nn, original in norm_entries:
                if n == nn or (len(n) >= 3 and (n in nn or nn in n)):
                    team = original
                    break

        # 順位
        rank = None
        if rank_band:
            for w in cells:
                cx = (w["x0"] + w["x1"]) / 2
                if rank_band[0] <= cx <= rank_band[1] and _digits(w["text"]) is not None:
                    rank = _digits(w["text"])
                    break

        standings.append({
            "team": team,
            "win": win, "draw": draw, "loss": loss,
            "played": win + draw + loss,
            "points": pts,
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

    _annotate(standings)
    return standings


def _annotate(standings):
    """各行に表示用の注記フラグ note を付ける。

    note の値(いずれか / 複数該当時は優先度の高いものを1つ):
      "mismatch"   … 勝点と勝敗数(3勝+分)が食い違う → 読み取り異常の可能性
      "estimated"  … 順位がサイト側の暫定算出(PDFに順位列が無い・得失点差未反映)
      "tiebreak"   … PDF順位に準拠しているが、同勝点で前後している箇所
    """
    # 同勝点グループを把握(tiebreak判定用)
    from collections import Counter
    pts_count = Counter(s["points"] for s in standings if s["points"] is not None)

    for s in standings:
        note = None
        # 1) 勝点と勝敗が不整合(最優先。データ異常の疑い)
        if s["points"] is not None and s["played"] > 0 \
                and s["points"] != 3 * s["win"] + s["draw"]:
            note = "mismatch"
        # 2) 順位がサイト側の暫定算出
        elif s.get("rank_estimated"):
            note = "estimated"
        # 3) PDF順位に従っているが、同勝点のチームが他にもいる
        elif s["points"] is not None and pts_count[s["points"]] >= 2:
            note = "tiebreak"
        s["note"] = note


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
