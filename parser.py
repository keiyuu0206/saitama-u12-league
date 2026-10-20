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


RESULT_OF = {MARK_WIN: "win", MARK_DRAW: "draw", MARK_LOSS: "loss"}


def _opponent_columns(words, pts_band):
    """対戦相手の列ヘッダーを x 範囲付きで返す [{x0,x1,cx,label}, ...]。

    勝点ヘッダーと同じ行にある、チーム名列より右・勝点列より左の短縮チーム名。
    pts_band[0] は勝点ヘッダー x0 から pad を引いた値なので、ここでは
    pad を戻した実際の勝点ヘッダー左端(pts_band[0] + pad相当)を右境界に使う。
    """
    hdr_top = pts_band[2]
    pts_left = pts_band[0] + 8  # _band の pad=8 を戻す
    cols = []
    for w in sorted(words, key=lambda w: w["x0"]):
        if abs(w["top"] - hdr_top) <= 5 and w["x0"] > NAME_X_MAX \
                and (w["x0"] + w["x1"]) / 2 < pts_left:
            # ヘッダー語そのもの(勝点/順位/勝ち点)は除外
            if unicodedata.normalize("NFKC", w["text"]).strip() in (
                    "勝点", "勝ち点", "順位"):
                continue
            cols.append({
                "x0": w["x0"], "x1": w["x1"],
                "cx": (w["x0"] + w["x1"]) / 2,
                "label": w["text"].strip(),
            })
    return cols


def _match_entry(raw_name, norm_entries):
    """PDFから読んだチーム名を、連盟サイトの出場チーム名に照合する。

    1) 正規化後に完全一致するものを最優先
    2) なければ部分一致する候補のうち、文字数の差が最小のもの
    3) どれにも当たらなければ PDF の読み取り名をそのまま使う
    """
    if not raw_name or not norm_entries:
        return raw_name
    n = normalize(raw_name)
    for nn, original in norm_entries:
        if n == nn:
            return original
    best, best_diff = None, None
    for nn, original in norm_entries:
        if len(n) >= 3 and (n in nn or nn in n):
            diff = abs(len(nn) - len(n))
            if best_diff is None or diff < best_diff:
                best, best_diff = original, diff
    return best or raw_name


def parse_page(page, entry_teams=None):
    """1ページ分の星取表を解析して standings のリストを返す。

    勝点列の数字を各チームのアンカーとし、その上下の帯からマーク・チーム名・
    順位・対戦成績を集める。1段組・2段組いずれのレイアウトにも対応する。
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

    opp_cols = _opponent_columns(words, pts_band)

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
    n_rows = len(anchors)

    for row_idx, ((atop, pts), (y0, y1)) in enumerate(zip(anchors, bounds)):
        cells = [w for w in words if y0 <= w["top"] < y1]

        # 対戦成績: 列ごとに、その x 範囲に入るマークを集める
        h2h = []
        if opp_cols:
            for col_idx, col in enumerate(opp_cols):
                if col_idx == row_idx:
                    h2h.append(None)  # 自チーム(✳)
                    continue
                res = []
                for w in cells:
                    cx = (w["x0"] + w["x1"]) / 2
                    if col["x0"] - 4 <= cx <= col["x1"] + 4:
                        for c in w["text"]:
                            if c in MARKS:
                                res.append(RESULT_OF[c])
                h2h.append(res)  # [] は未対戦、['win'] や ['win','loss'] など

        # 勝敗マーク(チーム名列より右)
        marks = "".join(
            c for w in cells if w["x0"] > NAME_X_MAX
            for c in w["text"] if c in MARKS
        )
        win, draw, loss = (marks.count(m) for m in (MARK_WIN, MARK_DRAW, MARK_LOSS))

        # チーム名(x0が名前列内・日本語/英字を含む・括弧書きや数値は除外)
        name_words = []
        # 同じ行の語は左から順に読む。アクセント付き文字(ě など)は
        # わずかに上にずれて抽出されるため、top の差が小さい語は同一行とみなす。
        name_cells = sorted((c for c in cells if c["x0"] < NAME_X_MAX),
                            key=lambda w: w["top"])
        lines = []
        for w in name_cells:
            if lines and abs(w["top"] - lines[-1][0]["top"]) <= 4:
                lines[-1].append(w)
            else:
                lines.append([w])
        ordered_words = [w for line in lines for w in sorted(line, key=lambda w: w["x0"])]
        for w in ordered_words:
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

        # 出場チームリストと照合して正式名称に寄せる。
        # 「FCチベッタ」と「FCチベッタ深谷」のように一方が他方を含む名前があるため、
        # 最初に見つかった部分一致ではなく、完全一致を最優先し、
        # 次に文字数の差が最も小さい(=最も近い)候補を選ぶ。
        team = _match_entry(raw_name, norm_entries)

        # 順位
        rank = None
        if rank_band:
            for w in cells:
                cx = (w["x0"] + w["x1"]) / 2
                if rank_band[0] <= cx <= rank_band[1] and _digits(w["text"]) is not None:
                    rank = _digits(w["text"])
                    break

        played = win + draw + loss
        standings.append({
            "team": team,
            "win": win, "draw": draw, "loss": loss,
            "played": played,
            # 勝点はアプリ側で計算した値(3勝+分)を正とする
            "points": 3 * win + draw,
            # PDFに記載されていた勝点(照合用。食い違えば要確認表示)
            "pdf_points": pts,
            "rank": rank,
            "h2h": h2h,  # opp_labels と同じ並び。None=自分, []=未対戦
        })

    if not standings:
        return None

    # 対戦相手ラベル(短縮名)を正式チーム名に寄せて全チーム共通で保持
    if opp_cols:
        labels = [c["label"] for c in opp_cols]
        full_names = [s["team"] for s in standings]
        # 列数と行数が一致する場合、列ラベルは各チームの短縮名に対応する
        resolved = []
        for i, lab in enumerate(labels):
            if i < len(full_names) and full_names[i]:
                resolved.append(full_names[i])
            else:
                resolved.append(lab)
        for s in standings:
            s["opp_labels"] = resolved

    # ---- 順位の決定 ----------------------------------------------------
    # 勝点(アプリ計算値)の高い順に並べ、勝点が同じチームの間だけ
    # PDFの順位(得失点差等を反映した連盟の判断)で上下を決める。
    # PDFの順位が勝点と整合していれば結果はPDFと同一になり、
    # PDF側が矛盾している場合のみアプリの計算が優先される。
    for s in standings:
        s["pdf_rank"] = s["rank"]  # PDF記載の順位(照合・表示用)

    ordered = sorted(
        standings,
        key=lambda s: (-(s["points"] or 0),
                       s["pdf_rank"] if s["pdf_rank"] is not None else 999),
    )
    prev_key, prev_rank = None, 0
    for i, s in enumerate(ordered, 1):
        # 勝点もPDF順位も同じ(またはPDF順位なし)なら同順位
        key = (s["points"], s["pdf_rank"])
        if key != prev_key:
            prev_rank, prev_key = i, key
        s["rank"] = prev_rank

    standings[:] = ordered
    _annotate(standings)
    return standings


def _annotate(standings):
    """各行に表示用の注記リスト notes を付ける(該当するものすべて)。

      "mismatch"  … PDF記載の勝点と、アプリ計算の勝点(3勝+分)が食い違う
      "rankdiff"  … PDF記載の順位と、表示している順位が食い違う
      "tiebreak"  … 勝点が同じチームがおり、その間の上下はPDF順位で決めている

    互換のため、最も重要な1つを note にも入れる。
    """
    from collections import Counter
    pts_count = Counter(s["points"] for s in standings if s["points"] is not None)

    for s in standings:
        notes = []
        pdf_pts = s.get("pdf_points")
        if pdf_pts is not None and s["points"] is not None and pdf_pts != s["points"]:
            notes.append("mismatch")
        pdf_rank = s.get("pdf_rank")
        if pdf_rank is not None and s["rank"] is not None and pdf_rank != s["rank"]:
            notes.append("rankdiff")
        if s["points"] is not None and pts_count[s["points"]] >= 2:
            notes.append("tiebreak")
        s["notes"] = notes
        s["note"] = notes[0] if notes else None


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

    # 妥当性チェック: PDF記載の勝点とアプリ計算値(3勝+分)が
    # 過半数で一致していれば、PDFを正しく読めたと判断する。
    checkable = [s for s in best if s.get("pdf_points") is not None]
    ok = sum(1 for s in checkable if s["pdf_points"] == s["points"])
    confident = (not checkable) or ok >= max(1, len(checkable) // 2)
    return {
        "standings": best,
        "pdf_date": pdf_date,
        "pages": n_pages,
        "confident": confident,
    }
