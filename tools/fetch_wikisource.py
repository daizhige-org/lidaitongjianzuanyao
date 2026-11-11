#!/usr/bin/env python3
"""從中文維基文庫抓取《歷代通鑑纂要》，寫入 .src/wikisource.json。
維基文庫有新的校對進度後重新運行本腳本，再運行 tools/build.py。

按卷抓取（約一百次請求）：每卷渲染後的 HTML 裡帶有逐頁標記，
標記上有頁號、校對等級和所屬索引名，不需要逐頁請求 Page: 頁面。

只用標準庫：python3 tools/fetch_wikisource.py
"""
import html
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://zh.wikisource.org/w/api.php"
UA = {"User-Agent": "static-reader-build/0.1 (python-urllib)"}
WORK = "歷代通鑑纂要"
OUT = Path(__file__).resolve().parent.parent / ".src" / "wikisource.json"

PAGENUM_RE = re.compile(
    r'<span><span class="pagenum[^>]*?data-page-number="(\d+)"[^>]*?data-page-name="([^"]*)"[^>]*?>'
    r'.*?</span></span></span>', re.S)
QUALITY_RE = re.compile(r'data-page-quality="(\d+)"')


def api(**kw):
    kw.update(format="json", formatversion="2")
    data = urllib.parse.urlencode(kw).encode()
    for attempt in range(6):
        time.sleep(0.5)  # 對維基服務器客氣一點
        try:
            req = urllib.request.Request(API, data=data, headers=UA)
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(int(e.headers.get("Retry-After") or 5 * (attempt + 1)))
    raise SystemExit("維基文庫限流，請稍後再試")


def wikitext(titles):
    out = {}
    for i in range(0, len(titles), 50):
        d = api(action="query", prop="revisions", rvprop="content", rvslots="main",
                titles="|".join(titles[i:i + 50]))
        for p in d["query"]["pages"]:
            if "revisions" in p:
                out[p["title"]] = p["revisions"][0]["slots"]["main"]["content"]
    return out


def pages_fragment(page_html):
    """取出 <div class="prp-pages-output"> 的內容，並把冗長的頁碼標記壓成 <pb n q/>。

    返回 (簡化後的 HTML, {頁號: 校對等級}, 索引名)。
    """
    start = page_html.find('<div class="prp-pages-output"')
    if start < 0:
        return "", {}, None
    start = page_html.index(">", start) + 1
    depth, end = 1, len(page_html)
    for m in re.finditer(r"<(/?)div\b", page_html[start:]):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            end = start + m.start()
            break
    quality, index = {}, None

    def pb(m):
        nonlocal index
        n, name = m.group(1), html.unescape(m.group(2))
        q = QUALITY_RE.search(m.group(0))
        quality[n] = int(q.group(1)) if q else None
        index = index or name.split(":", 1)[1].rsplit("/", 1)[0]
        return f'<pb n="{n}"/>'

    return PAGENUM_RE.sub(pb, page_html[start:end]).strip(), quality, index


def main():
    # 1. 主頁目錄 -> 各卷標題與起訖說明
    main_page = wikitext([WORK])[WORK]
    juan = []
    for sub, label, desc in re.findall(r"^\*\[\[/([^|\]]+)\|([^\]]+)\]\]\s*(.*)$", main_page, re.M):
        juan.append({"sub": sub, "label": label.strip(), "desc": desc.strip().replace("　", " ")})
    print("目錄條目：", len(juan))

    # 2. 各卷子頁的 wikitext -> 頁碼範圍
    by_title = wikitext([f"{WORK}/{j['sub']}" for j in juan])
    for j in juan:
        w = by_title.get(f"{WORK}/{j['sub']}", "")
        j["ranges"] = [
            {"vol": int(v), "from": int(a), "to": int(b)}
            for v, a, b in re.findall(r'<pages index="[^"]*第(\d+)冊\.pdf"\s+from=(\d+)\s+to=(\d+)', w)
        ]
        if not j["ranges"]:
            print("  ! 沒有找到頁碼範圍：", j["sub"])

    # 3. 各卷渲染後的 HTML -> 逐頁文本、校對等級、索引名
    index, counts = {}, {}
    for n, j in enumerate(juan, 1):
        if not j["ranges"]:
            continue
        d = api(action="parse", page=f"{WORK}/{j['sub']}", prop="text",
                disablelimitreport="1", disableeditsection="1")
        j["html"], j["quality"], name = pages_fragment(d["parse"]["text"])
        if name:
            index[str(j["ranges"][0]["vol"])] = name
        for q in j["quality"].values():
            counts[q] = counts.get(q, 0) + 1
        print(f"\r  {n}/{len(juan)} {j['sub']}", end="", flush=True)
    print("\n各校對等級的頁數：", dict(sorted(counts.items(), key=lambda kv: str(kv[0]))))

    # 4. 掃描 PDF 的縮略圖地址（文件名每冊編號不同，取自上一步的索引名）
    files = {}
    d = api(action="query", prop="imageinfo", iiprop="url|size", iiurlwidth="1280",
            titles="|".join("File:" + name for name in index.values()))
    for p in d["query"]["pages"]:
        ii = (p.get("imageinfo") or [None])[0]
        m = re.search(r"第(\d+)冊\.pdf$", p["title"])
        if ii and m and ii.get("thumburl"):
            thumb = re.sub(r"\?.*$", "", ii["thumburl"])
            thumb = re.sub(r"/page\d+-(\d+)px-", r"/page{p}-\1px-", thumb)
            files[m.group(1)] = {"pagecount": ii.get("pagecount"), "thumb": thumb}
    print(f"索引 {len(index)} 冊，取到掃描圖 {len(files)} 冊")
    if len(files) < len(index):
        print("  ! 沒取到掃描圖的冊：", sorted(set(index) - set(files), key=int))

    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        "fetched": time.strftime("%Y-%m-%d"), "work": WORK,
        "index": index, "files": files, "juan": juan,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print("已寫入", OUT)


if __name__ == "__main__":
    main()
