#!/usr/bin/env python3
"""由 Unicode Unihan 的異體/繁簡關係生成 .src/variants.json（檢索時「歷/歴/历」互通用）。
只保留與本書用字有關的字組。結果已入庫，一般不必重跑。

    python3 tools/make_variants.py            # 自動下載 Unihan.zip
    python3 tools/make_variants.py Unihan_Variants.txt
"""
import io
import json
import re
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KINDS = {"kSimplifiedVariant", "kTraditionalVariant", "kSemanticVariant", "kZVariant"}
# OCR 與刻本中常混用、Unihan 未收的字組
EXTRA = [
    "己巳已", "戌戍", "刺剌", "祇祗衹只", "暦曆歷歴历",
    "德徳", "會㑹", "晉𣈆晋", "能䏻", "遠逺", "改攺", "乘乗", "久乆", "策䇿", "疏䟽疎", "徵徴",
    "懷懐", "陷䧟", "悅恱", "聽聴", "達逹", "邊邉", "寇㓂", "曾曽", "步歩", "拔㧞", "旨㫖",
    "寬寛", "增増", "皆𣅜", "遊逰", "頤頥", "侯矦", "幼㓜", "哉㢤㦲", "準凖", "勳勲", "從徔",
]
MAX_GROUP = 12  # 過大的連通分量多半是鏈式誤連，棄用


def corpus_chars():
    chars = set()
    for d in ("帶標點", "AI生成解釋"):
        for f in (ROOT / ".src" / d).glob("*.md"):
            for line in f.read_text(encoding="utf-8").splitlines():
                if d == "帶標點" or line.startswith(">"):
                    chars.update(line)
    ws = ROOT / ".src" / "wikisource.json"
    if ws.exists():
        for p in json.loads(ws.read_text(encoding="utf-8"))["pages"].values():
            chars.update(p["text"])
    return {c for c in chars if ord(c) >= 0x2E80}


def main():
    if len(sys.argv) > 1:
        text = Path(sys.argv[1]).read_text(encoding="utf-8")
    else:
        req = urllib.request.Request("https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip",
                                     headers={"User-Agent": "static-reader-build/0.1"})
        z = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req, timeout=120).read()))
        text = z.read("Unihan_Variants.txt").decode("utf-8")

    parent = {}

    def find(x):
        while parent.setdefault(x, x) != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for line in text.splitlines():
        if line.startswith("#") or not line.strip():
            continue
        src, kind, val = line.split("\t")
        if kind not in KINDS:
            continue
        a = chr(int(src[2:], 16))
        for code in re.findall(r"U\+([0-9A-F]+)", val):
            parent[find(a)] = find(chr(int(code, 16)))
    for g in EXTRA:
        for c in g[1:]:
            parent[find(g[0])] = find(c)

    groups = {}
    for c in list(parent):
        groups.setdefault(find(c), []).append(c)
    used = corpus_chars()
    out = sorted("".join(sorted(g)) for g in groups.values()
                 if 1 < len(g) <= MAX_GROUP and used.intersection(g))
    dropped = [g for g in groups.values() if len(g) > MAX_GROUP and used.intersection(g)]
    (ROOT / ".src" / "variants.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"{len(out)} 組異體字；棄用過大的 {len(dropped)} 組：", ["".join(g)[:20] for g in dropped][:8])


if __name__ == "__main__":
    main()
