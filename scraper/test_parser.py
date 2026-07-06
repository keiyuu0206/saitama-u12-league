# -*- coding: utf-8 -*-
"""実PDF(星取表)のレイアウトを再現してパーサーを検証する"""
from reportlab.lib.pagesizes import landscape, A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

from parser import parse_pdf

pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
F = "HeiseiKakuGo-W5"

TEAMS = [
    # (名称, 所在地, 結果9試合, 勝点, 順位[Noneなら空欄])
    ("レジスタFC", "八潮市", "●●△○●○○○○", 16, None),
    ("RB大宮アルディージャU-12", "さいたま市", "○△●○○○○○○", 22, None),
    ("上尾朝日FCスポーツ少年団", "上尾市", "○△○△●○○○○", 20, None),
    ("エクセレントフィートFC", "さいたま市", "△○●○●○○○○", 19, None),
    ("新座片山フットボールクラブ少年団", "新座市", "●●△●●●●△△", 3, None),
    ("浦和レッドダイヤモンズジュニア", "さいたま市", "○●○○○○○○○", 24, None),
    ("FCアビリスタ", "川口市", "●●●●○●●○○", 9, None),
    ("1FC川越水上公園", "川越市", "●●●●○●○●●", 6, None),
    ("江南南サッカー少年団", "熊谷市", "●●●●△●●○●", 4, None),
    ("ヴィオレータフットボールクラブ", "さいたま市", "●●●●△●●○○", 7, None),
]

ENTRY = [t[0] for t in TEAMS]


def build_pdf(path, with_rank):
    c = canvas.Canvas(path, pagesize=landscape(A4))
    W, H = landscape(A4)
    c.setFont(F, 12)
    c.drawString(40, H - 40, "２０２６年度　埼玉県第４種サッカーリーグ戦　勝敗表")
    c.setFont(F, 9)
    c.drawString(40, H - 58, "県Ｓ１リーグ")
    c.drawRightString(W - 40, H - 40, "2026/6/14 現在")

    grid_x, pts_x, rank_x = 260, 640, 700
    top_y, row_h, cell_w = H - 90, 30, 40

    c.setFont(F, 7)
    for j, t in enumerate(TEAMS):
        c.drawCentredString(grid_x + j * cell_w + cell_w / 2, top_y, t[0][:4])
    c.drawCentredString(pts_x, top_y, "勝点")
    c.drawCentredString(rank_x, top_y, "順位")

    ranks_sorted = sorted(TEAMS, key=lambda t: -t[3])
    rank_of = {t[0]: i + 1 for i, t in enumerate(ranks_sorted)}

    for i, (name, city, marks, pts, _) in enumerate(TEAMS):
        y = top_y - (i + 1) * row_h
        c.setFont(F, 8)
        c.drawString(40, y + 6, name)
        c.setFont(F, 6)
        c.drawString(40, y - 4, f"({city})")
        c.setFont(F, 9)
        k = 0
        for j in range(len(TEAMS)):
            if j == i:
                c.drawCentredString(grid_x + j * cell_w + cell_w / 2, y, "✳")
                continue
            c.drawCentredString(grid_x + j * cell_w + cell_w / 2, y, marks[k])
            k += 1
        c.drawCentredString(pts_x, y, str(pts))
        if with_rank:
            c.drawCentredString(rank_x, y, str(rank_of[name]))
    c.save()


def check(path, expect_rank_from_pdf):
    res = parse_pdf(path, entry_teams=ENTRY)
    st = res["standings"]
    assert st, "解析結果が空"
    assert len(st) == 10, f"行数 {len(st)} != 10"
    assert res["pdf_date"] == "2026-06-14", res["pdf_date"]
    assert res["confident"], "妥当性チェック不合格"
    by_team = {s["team"]: s for s in st}
    urawa = by_team["浦和レッドダイヤモンズジュニア"]
    assert urawa["points"] == 24 and urawa["rank"] == 1, urawa
    assert urawa["win"] == 8 and urawa["loss"] == 1 and urawa["draw"] == 0
    katayama = by_team["新座片山フットボールクラブ少年団"]
    assert katayama["points"] == 3 and katayama["rank"] == 10, katayama
    regista = by_team["レジスタFC"]
    assert regista["points"] == 16 and regista["played"] == 9
    if not expect_rank_from_pdf:
        assert all(s.get("rank_estimated") for s in st)
    print(f"OK: {path}  (1位: {st[0]['team']} 勝点{st[0]['points']})")


if __name__ == "__main__":
    build_pdf("/tmp/test_with_rank.pdf", with_rank=True)
    build_pdf("/tmp/test_no_rank.pdf", with_rank=False)
    check("/tmp/test_with_rank.pdf", expect_rank_from_pdf=True)
    check("/tmp/test_no_rank.pdf", expect_rank_from_pdf=False)
    print("全テスト合格")
