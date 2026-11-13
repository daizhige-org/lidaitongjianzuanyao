#!/usr/bin/env python3
"""把三種來源合併成前端用的靜態數據（site/data/）。

    來源                         提供
    .src/wikisource.json        92 卷目錄、各卷頁碼範圍、已錄入/校對的頁面文本、掃描圖
    .src/帶標點/NN.md            每頁的機器標點文本（逐句）
    .src/AI生成解釋/NN.md        每句的白話解釋

三者以「第 N 冊 PDF 第 M 頁」為共同座標。只用標準庫：python3 tools/build.py
"""
import json
import re
import shutil
import sys
import zipfile
from difflib import SequenceMatcher
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / ".src"
OUT = ROOT / "site" / "data"
ZIP = ROOT / "site" / "full-site-download.zip"
ZIP_NOTE = """《歷代通鑑纂要》在線閱讀站 離線包

在線地址：https://lidaitongjianzuanyao.daizhige.org/

用法：解壓後在這個目錄裡開一個本地網頁服務器，例如

    python3 -m http.server 8765

然後用瀏覽器打開 http://127.0.0.1:8765/ 。
直接雙擊 index.html 不行，瀏覽器不允許本地文件讀取 data/ 裡的數據。
也可以把整個目錄原樣上傳到任何靜態網站託管。

掃描原圖不在包內，閱讀時從維基共享資源在線載入，需要聯網。

data/j/<卷>.json 是各卷正文與解釋，data/s/<卷>.txt 是檢索用的純文本
（每行：頁碼、句序、文本，以製表符分隔），data/toc.json 是卷目。

文本來源：維基文庫校本（CC BY-SA）；其餘頁面為機器識別與自動標點，
白話解釋由 AI 生成，均未經人工校對，不可引用。
"""


def make_zip():
    """把整個 site/ 打成一個包，供人下載離線使用。時間戳固定，內容不變則包不變。"""
    site = ZIP.parent
    files = sorted(f for f in site.rglob("*") if f.is_file() and f != ZIP and f.name != ".DS_Store")
    with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        def add(name, data):
            info = zipfile.ZipInfo("lidaitongjianzuanyao/" + name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
        add("README.txt", ZIP_NOTE.encode("utf-8"))
        for f in files:
            add(f.relative_to(site).as_posix(), f.read_bytes())
    return len(files), ZIP.stat().st_size
PAGE_RE = re.compile(r"^〔第(\d+)頁〕$")
BLANK = "（空白頁）"
OPENERS = "「『《〈（“‘【〔［"
PROOFREAD = 3  # 維基文庫校對等級 ≥3（已校對/已核對）才優先於機器標點

# 目錄分組（按各卷主體所屬時代，僅為導航方便）
ERAS = [("上古", 1, 1), ("夏", 2, 2), ("商", 3, 3), ("周", 4, 8), ("秦", 9, 9), ("漢", 10, 20),
        ("三國", 21, 23), ("晉", 24, 30), ("南北朝", 31, 42), ("隋", 43, 44), ("唐", 45, 60),
        ("五代", 61, 66), ("宋", 67, 88), ("元", 89, 92)]


GANZHI = "[甲乙丙丁戊己巳已庚辛壬癸][子丑寅卯辰巳午未申酉戌戍亥]"
QUOTES = str.maketrans("“”‘’", "「」『』")
PUNCT_RUN_RE =re.compile(r"[，。：？、；！]{2,}")


def clean_line(t):
    """機器標點裡的括號幾乎都不成對（「乙丑，）」「（章明也」），標點也常疊在一起。

    - 多餘的「）」刪去；
    - 行首沒有閉合的「（」刪去；行中沒有閉合的「（」是小注的起點，在行末補上「）」；
    - 疊在一起的標點只留一個；
    - 只剩干支的行（欄外紀年）去掉尾隨標點。
    """
    out, depth = [], 0
    for ch in t:
        if ch == "（":
            depth += 1
        elif ch == "）":
            if depth == 0:
                continue
            depth -= 1
        out.append(ch)
    t = "".join(out)
    if depth:
        if t.startswith("（") and "）" not in t:
            t = t[1:]
        else:
            m = re.search(r"[，。：？、；！]+$", t)
            t = (t[:m.start()] + "）" * depth + t[m.start():]) if m else t + "）" * depth
    t = PUNCT_RUN_RE.sub(lambda m: "。" if "。" in m.group(0) else m.group(0)[0], t)
    t = re.sub(r"（[，。：？、；！]+", "（", t).replace("（）", "")
    t = re.sub(r"^[，。：？、；！）]+", "", t)
    if re.fullmatch(GANZHI, re.sub(r"[\W_]", "", t)):   # 干支之外只剩標點、引號
        t = re.sub(r"[\W_]", "", t)
    return t


def clean_page(page, stats):
    """逐句清理；欄外的干支若緊接著它所屬的紀年句，就併成「（干支）某年……」。"""
    year_keys = {norm(t) for _, t in page["heads"] if re.match("（?" + GANZHI, t)}
    segs = []
    for seg in page["segs"]:
        raw = seg[0].translate(QUOTES)      # 引號統一為「」『』，原文和解釋都改
        seg[1] = seg[1].translate(QUOTES)
        seg[0] = clean_line(raw)
        stats["cleaned"] += seg[0] != raw
        if not seg[0]:
            stats["dropped"] += 1
            continue
        prev = segs[-1] if segs else None
        if prev and re.fullmatch(GANZHI, prev[0]) and any(
                k.startswith(prev[0]) and norm(seg[0])[:3] in k for k in year_keys):
            seg[0] = f"（{prev[0]}）{seg[0]}"
            segs.pop()
            stats["merged"] += 1
        segs.append(seg)
    page["segs"] = segs


def norm(s):
    """只留文字，去掉標點、括號、空白 —— 用於不同版本之間的比對。"""
    return re.sub(r"[\W_]", "", s)


# ---------------------------------------------------------------- 本地文件

def parse_local(vol):
    """返回 {頁: {"segs": [[原文, 解釋], ...], "heads": [(級別, 標題), ...]}}。

    書籤標題（#…）在文件中位於所屬頁的頁碼標記之前。
    """
    name = f"{vol:02d}.md"
    pages, cur, pending = {}, None, []
    for line in (SRC / "帶標點" / name).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        m = PAGE_RE.match(line)
        if m:
            cur = pages.setdefault(int(m.group(1)), {"segs": [], "heads": []})
            cur["heads"] += pending
            pending = []
        elif line.startswith("#"):
            level, _, title = line.partition(" ")
            if len(level) > 1:
                pending.append((len(level), title.strip()))
        elif line and line != BLANK and cur is not None:
            cur["segs"].append([line, ""])
    if pending and cur is not None:
        cur["heads"] += pending

    # 解釋：引用塊是原文，其後直到下一個引用塊/標題/頁碼都是解釋
    expl, cur, last = {}, None, None
    for line in (SRC / "AI生成解釋" / name).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        m = PAGE_RE.match(line)
        if m:
            cur, last = expl.setdefault(int(m.group(1)), []), None
        elif line.startswith("#"):
            last = None
        elif line.startswith(">"):
            if cur is not None:
                last = [line[1:].strip(), ""]
                cur.append(last)
        elif line and line != BLANK and last is not None:
            last[1] = (last[1] + "\n" + line).strip()

    missing = 0
    for p, page in pages.items():
        pool = expl.get(p, [])
        same = len(pool) == len(page["segs"])
        lookup = {}
        for t, x in pool:
            lookup.setdefault(t, []).append(x)
        for i, seg in enumerate(page["segs"]):
            if same and pool[i][0] == seg[0]:
                seg[1] = pool[i][1]
            elif lookup.get(seg[0]):
                seg[1] = lookup[seg[0]].pop(0)
            if not seg[1]:
                missing += 1
    return pages, missing


# ---------------------------------------------------------------- 維基文庫

class WsParser(HTMLParser):
    """把一卷渲染後的 HTML（頁碼已壓成 <pb n/>）拆成逐頁的塊。

    結果 self.pages = {頁: {"c": 是否接續上一頁的段落, "b": [[類型, [[文字, 是否小注], ...]], ...]}}
    類型：h 標題、c 居中、p 段落。
    """
    BLOCK = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dd", "dt", "tr", "center",
             "blockquote", "table", "ul", "ol", "dl"}
    VOID = {"br", "hr", "img", "link", "meta", "input", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.pages, self.page, self.block, self.stack = {}, None, None, []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "pb":
            cont = bool(self.block and self.block[1])   # 段落寫到一半就換頁
            kind = self.block[0] if cont else None
            self.page = self.pages.setdefault(int(a["n"]), {"c": int(cont), "b": []})
            self.block = None
            if cont:
                self.block = [kind, []]
                self.page["b"].append(self.block)
            return
        if tag in self.VOID:
            if tag == "br":
                self.block = None
            return
        style, cls = (a.get("style") or "").replace(" ", "").lower(), a.get("class") or ""
        flags = {"tag": tag}
        if tag in ("style", "script") or "font-size:0" in style or "display:none" in style:
            flags["skip"] = True
        if tag == "small":
            flags["note"] = True
        if re.fullmatch(r"h[1-6]", tag) or ("font-weight:800" in style and "text-align:center" in style):
            flags["kind"] = "h"
        elif tag == "center" or "center" in cls.split() or "text-align:center" in style:
            flags["kind"] = "c"
        if tag in self.BLOCK:
            self.block = None
        self.stack.append(flags)
        fix = re.fullmatch(r"應校正為「(.+)」", a.get("title") or "")
        if fix:                                         # {{校|誤|正}}：採用校正後的字
            self.handle_data(fix.group(1))
            flags["skip"] = True

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i]["tag"] == tag:
                del self.stack[i:]
                break
        if tag in self.BLOCK:
            self.block = None

    def handle_data(self, data):
        text = data.replace("\n", "").replace("\u200b", "")
        if not text.strip() or self.page is None or any(f.get("skip") for f in self.stack):
            return
        if self.block is None:
            kind = next((f["kind"] for f in reversed(self.stack) if "kind" in f), "p")
            self.block = [kind, []]
            self.page["b"].append(self.block)
        note = int(any(f.get("note") for f in self.stack))
        runs = self.block[1]
        if runs and runs[-1][1] == note:
            runs[-1][0] += text
        else:
            runs.append([text, note])


def parse_ws(html_text):
    parser = WsParser()
    parser.feed(html_text)
    parser.close()
    for page in parser.pages.values():
        page["b"] = [b for b in page["b"] if b[1]]
        if not page["b"] or page["b"][0][0] != "p":
            page["c"] = 0
    return parser.pages


def align_ws(blocks, segs):
    """把機器標點的分句邊界映射到維基文庫文本上，使每段文字知道自己對應哪一句解釋。

    返回 [[類型, [[文字, 句序號, 是否小注], ...]], ...]；對不上時句序號為 -1。
    """
    a_chars = []  # 文庫文本中的「文字」字符
    for bi, (_, runs) in enumerate(blocks):
        for ri, (t, _) in enumerate(runs):
            for ci, ch in enumerate(t):
                if norm(ch):
                    a_chars.append((bi, ri, ci))
    b_seg = []
    b_str = []
    for si, seg in enumerate(segs):
        n = norm(seg[0])
        b_str.append(n)
        b_seg += [si] * len(n)
    a_str = "".join(blocks[bi][1][ri][0][ci] for bi, ri, ci in a_chars)
    b_str = "".join(b_str)

    seg_of = {}
    ok = bool(a_str and b_str)
    if ok:
        sm = SequenceMatcher(None, a_str, b_str, autojunk=False)
        ok = sm.ratio() >= 0.5
        if ok:
            # 每句在文庫文本中的起點 = 該句（或其後）第一個匹配上的字
            b2a = [None] * (len(b_str) + 1)
            for blk in sm.get_matching_blocks():
                for k in range(blk.size):
                    b2a[blk.b + k] = blk.a + k
            nxt = len(a_str)
            for j in range(len(b_str), -1, -1):
                if b2a[j] is None:
                    b2a[j] = nxt
                else:
                    nxt = b2a[j]
            starts, seen = [], set()
            for j, si in enumerate(b_seg):
                if si not in seen:
                    seen.add(si)
                    starts.append((b2a[j], si))
            cur, k = (starts[0][1] if starts else -1), 0
            for ai, key in enumerate(a_chars):
                while k < len(starts) and starts[k][0] <= ai:
                    cur = starts[k][1]
                    k += 1
                seg_of[key] = cur

    out = []
    for bi, (kind, runs) in enumerate(blocks):
        new_runs = []
        for ri, (t, note) in enumerate(runs):
            ids = [seg_of.get((bi, ri, ci)) if ok and norm(ch) else None for ci, ch in enumerate(t)]
            # 標點跟隨相鄰文字：開引號類跟後一字，其餘跟前一字
            prev = None
            for ci, ch in enumerate(t):
                if ids[ci] is None and ch not in OPENERS:
                    ids[ci] = prev
                prev = ids[ci] if ids[ci] is not None else prev
            nxt = None
            for ci in range(len(t) - 1, -1, -1):
                if ids[ci] is None:
                    ids[ci] = nxt
                nxt = ids[ci] if ids[ci] is not None else nxt
            start = 0
            for ci in range(1, len(t) + 1):
                if ci == len(t) or ids[ci] != ids[start]:
                    sid = ids[start]
                    new_runs.append([t[start:ci], -1 if sid is None else sid, note])
                    start = ci
        out.append([kind, new_runs])
    return out, ok


# ---------------------------------------------------------------- 綱目標題

COMMENT_RE = re.compile(r"^(?:臣）?等謹按|\S{1,3}[氏子]\S{0,4}曰[：:，])")
YEAR_RE = re.compile(r"^（?[甲乙丙丁戊己巳已庚辛壬癸][子丑寅卯辰巳午未申酉戌戍亥]")
GANZHI_RE = re.compile(r"^[甲乙丙丁戊己巳已庚辛壬癸][子丑寅卯辰巳午未申酉戌戍亥]")


def place_heads(pages, plist):
    """書籤標題只精確到頁；在該頁（及鄰頁）的句子裡找到它，得到精確錨點並標記句子類型。

    句子類型：t 卷題/起訖，y 帝王或紀年，g 綱（事目）。
    """
    heads = [(p, lv, t) for p in plist for lv, t in pages[p]["heads"]]
    # 書籤的四、五級層次並不穩定：以「干支」開頭的視為紀年；四級標題很少的卷，四級即帝王
    few4 = sum(1 for _, lv, _ in heads if lv == 4) <= 12
    used, outline, hit = set(), [], 0
    for p, lv, title in heads:
        if lv <= 3:
            kind, level = "t", 0
        elif YEAR_RE.match(title) or (lv == 4 and few4):
            kind, level = "y", 1
        else:
            kind, level = "g", 2
        key = norm(title)
        keys = {key, norm(re.sub(r"^（[^）]*）", "", title))}
        if GANZHI_RE.match(key):
            keys.add(key[2:])      # 干支常刻在欄外，OCR 正文裡沒有
        keys = sorted((k for k in keys if k), key=len, reverse=True)
        found = None
        for q in (p, p + 1, p - 1):
            if q not in pages:
                continue
            for i, seg in enumerate(pages[q]["segs"]):
                if (q, i) in used:
                    continue
                n = norm(seg[0])
                if not n:
                    continue
                for k in keys:
                    if (n == k or (n.startswith(k) and len(n) <= len(k) + 2)
                            or (n.endswith(k) and len(n) <= len(k) + 12)
                            or (len(n) >= 5 and k.startswith(n))):   # 標題跨頁被截斷
                        found = (q, i, True)
                    elif n.startswith(k) or (len(k) > 6 and n.startswith(k[:-2])):
                        found = (q, i, False)
                    if found:
                        break
                if found:
                    break
            if found:
                break
        if found:
            q, i, whole = found
            used.add((q, i))
            if whole:
                pages[q]["segs"][i].append(kind)
            hit += 1
            if level:
                outline.append([level, title, q, i])
        elif level:
            outline.append([level, title, p, -1])
    return outline, hit, len(heads)


# ---------------------------------------------------------------- 人工校訂

NOTE_RE = re.compile(r"<small>[^<>]+</small>")
KINDS = {"", "t", "y", "g", "c"}


def plain(t):
    """去掉小注標記，得到純文本。"""
    return t.replace("<small>", "").replace("</small>", "")


def load_revision(me, plist):
    """讀取 .src/校訂/<卷>.json：某一卷經人工校訂後的全部句子與綱目，整卷取代機器標點。

    格式同 site/data/j/<卷>.json 裡的 pages[].m 與 outline。正文裡只允許一種標記：
    <small>…</small> 表示雙行小注；句首的「（干支）」表示欄外所標紀年。
    其他任何尖括號都會報錯，前端不會把數據當 HTML 解釋。
    """
    f = SRC / "校訂" / f"{me}.json"
    if not f.exists():
        return None
    rev = json.loads(f.read_text(encoding="utf-8"))
    pages = {pg["p"]: pg["m"] for pg in rev["pages"]}
    if sorted(pages) != plist:
        sys.exit(f"{f.name}：頁碼應為 {plist[0]}–{plist[-1]} 且不重不漏")
    for p, m in pages.items():
        for i, seg in enumerate(m):
            where = f"{f.name} 第 {p} 頁第 {i + 1} 句"
            if len(seg) != 3 or seg[2] not in KINDS or not all(isinstance(x, str) for x in seg):
                sys.exit(f"{where}：應為 [原文, 解釋, 類型]，類型為 t/y/g/c 或空")
            if re.search(r"[<>&]", NOTE_RE.sub("", seg[0])) or re.search(r"[<>&]", seg[1]):
                sys.exit(f"{where}：只允許成對且不嵌套的 <small>…</small>：{seg[0][:40]}")
    for lv, title, p, i in rev["outline"]:
        if lv not in (1, 2) or p not in pages or not 0 <= i < len(pages[p]):
            sys.exit(f"{f.name} 綱目「{title}」指向不存在的句子（第 {p} 頁第 {i + 1} 句）")
    return pages, rev["outline"]


# ---------------------------------------------------------------- 主流程

def main():
    ws = json.loads((SRC / "wikisource.json").read_text(encoding="utf-8"))
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "j").mkdir(parents=True)
    (OUT / "s").mkdir()

    local, stats = {}, {"missing_expl": 0, "cleaned": 0, "merged": 0, "dropped": 0}
    for vol in range(1, 31):
        local[vol], miss = parse_local(vol)
        stats["missing_expl"] += miss
        for page in local[vol].values():
            clean_page(page, stats)

    def jid(sub):
        return {"卷首": "shou", "目錄": "mulu"}.get(sub) or sub.replace("卷", "")

    toc, covered = [], set()
    hit_total = head_total = ws_shown = ws_bad = 0
    juan = ws["juan"]
    for idx, j in enumerate(juan):
        if not j["ranges"]:
            continue
        r = j["ranges"][0]
        vol, pages = r["vol"], local[r["vol"]]
        plist = [p for p in range(r["from"], r["to"] + 1)]
        for p in plist:
            pages.setdefault(p, {"segs": [], "heads": []})
            covered.add((vol, p))
        me = jid(j["sub"])
        rev = load_revision(me, plist)
        if rev:
            outline = rev[1]
            for p in plist:
                pages[p]["segs"] = rev[0][p]
        else:
            outline, hit, total = place_heads(pages, plist)
            hit_total += hit
            head_total += total

        out_pages, search_lines, n_chars, n_proof, n_rev = [], [], 0, 0, 0
        quality = j.get("quality", {})
        ws_pages = parse_ws(j.get("html", ""))
        prev_shown = None
        for p in plist:
            segs = pages[p]["segs"]
            for seg in segs:
                if len(seg) == 2:
                    seg.append("c" if COMMENT_RE.match(seg[0]) else "")
            entry = {"p": p, "m": segs}
            q = quality.get(str(p))
            if q is not None:
                entry["q"] = q
            wp = ws_pages.get(p)
            if rev:
                # 人工校訂的頁不再疊加維基文庫校本：校訂稿帶小注與解釋，已是更完整的一份
                if segs:
                    entry["h"] = 1
                    n_rev += 1
            elif wp and wp["b"] and (q or 0) >= PROOFREAD:
                aligned, ok = align_ws(wp["b"], segs)
                entry["w"] = {"c": int(bool(wp["c"] and prev_shown == p - 1)), "b": aligned}
                prev_shown = p
                ws_shown += 1
                ws_bad += not ok
                n_proof += 1
            out_pages.append(entry)
            for i, seg in enumerate(segs):
                n_chars += len(norm(plain(seg[0])))
                search_lines.append(f"{p}\t{i}\t{plain(seg[0])}")

        nav = lambda k: ({"id": jid(juan[k]["sub"]), "label": juan[k]["label"]}
                         if 0 <= k < len(juan) else None)
        doc = {"id": me, "label": j["label"], "desc": j["desc"], "sub": j["sub"], "vol": vol,
               "from": r["from"], "to": r["to"], "prev": nav(idx - 1), "next": nav(idx + 1),
               "outline": outline, "pages": out_pages}
        (OUT / "j" / f"{me}.json").write_text(
            json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        (OUT / "s" / f"{me}.txt").write_text("\n".join(search_lines), encoding="utf-8")

        num = int(me) if me.isdigit() else 0
        era = next((name for name, a, b in ERAS if a <= num <= b), "卷首")
        toc.append({"id": me, "label": j["label"], "desc": j["desc"], "era": era, "vol": vol,
                    "from": r["from"], "to": r["to"], "chars": n_chars, "proof": n_proof, "rev": n_rev,
                    "ws": len(quality)})

    # 未被任何卷收錄、卻有文字的頁（封面、牌記等），僅報告
    stray = [(v, p) for v in local for p, pg in local[v].items()
             if pg["segs"] and (v, p) not in covered]

    (OUT / "toc.json").write_text(json.dumps({
        "fetched": ws["fetched"], "work": ws["work"], "index": ws["index"],
        "files": ws["files"], "juan": toc,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    shutil.copy(SRC / "variants.json", OUT / "variants.json")

    size = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"{len(toc)} 卷，{sum(t['to'] - t['from'] + 1 for t in toc)} 頁，"
          f"{sum(t['chars'] for t in toc):,} 字，輸出 {size / 1e6:.1f} MB -> {OUT.relative_to(ROOT)}")
    print(f"綱目標題定位：{hit_total}/{head_total}；缺解釋的句子：{stats['missing_expl']}")
    print(f"清理括號/標點殘片 {stats['cleaned']} 句，欄外干支併入紀年 {stats['merged']} 處，清空刪除 {stats['dropped']} 句")
    print(f"人工校訂：{sum(1 for t in toc if t['rev'])} 卷 {sum(t['rev'] for t in toc)} 頁")
    print(f"採用維基文庫校對文本的頁：{ws_shown}（其中與機器標點對不上的 {ws_bad} 頁）")
    n, zsize = make_zip()
    print(f"離線包：{n} 個文件，{zsize / 1e6:.1f} MB -> {ZIP.relative_to(ROOT)}")
    if stray:
        print(f"未歸入任何卷的有字頁 {len(stray)} 個：", stray[:12], file=sys.stderr)


if __name__ == "__main__":
    main()
