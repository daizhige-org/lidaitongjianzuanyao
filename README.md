# 歷代通鑑纂要 閱讀前端

把[維基文庫《歷代通鑑纂要》](https://zh.wikisource.org/wiki/歷代通鑑纂要)的卷次與校對文本，同機器標點（`.src/帶標點/`）和 AI 白話解釋（`.src/AI生成解釋/`）按「第 N 冊 PDF 第 M 頁」對齊，做成一個純靜態的閱讀站。

在線閱讀：<https://lidaitongjianzuanyao.daizhige.org/>

## 使用

```sh
python3 tools/build.py                  # 生成 site/data/（只用標準庫，不到一秒）
python3 -m http.server -d site 8765     # 然後打開 http://127.0.0.1:8765/
```

`site/` 是發佈產物，已隨版本庫提交，克隆後不必構建即可直接部署到任何靜態託管。構建時會順帶把整個站打成 `site/full-site-download.zip`（不入版本庫），部署後可從 `/full-site-download.zip` 下載。

推到 GitHub 後，在 Settings → Pages 把 Source 選為 **GitHub Actions**，`.github/workflows/pages.yml` 會在每次推送 `main` 時重新構建並發佈 `site/`（含離線包）。

維基文庫有了新的校對進度後：

```sh
python3 tools/fetch_wikisource.py       # 更新 .src/wikisource.json
python3 tools/build.py
```

## 結構

| 路徑 | 內容 |
| --- | --- |
| `.src/帶標點/`、`.src/AI生成解釋/` | 原始材料，每冊一個文件，以 `〔第N頁〕` 分頁 |
| `.src/wikisource.json` | 維基文庫快照：目錄、各卷頁碼範圍、各卷渲染後的 HTML（含逐頁標記與校對等級）、30 冊掃描圖地址。按卷抓取，約一百次請求 |
| `.src/variants.json` | 檢索用的繁簡、異體字組（`tools/make_variants.py` 由 Unihan 生成） |
| `tools/build.py` | 合併三種來源，輸出每卷一個 JSON 和檢索用文本 |
| `tools/fetch_wikisource.py`、`tools/make_variants.py` | 更新上面兩個 JSON |
| `site/` | 發佈產物。前端 `index.html`、`style.css`、`app.js`（無依賴、無構建）和 `tools/build.py` 生成的 `data/` |

## 合併規則

- 卷的劃分以維基文庫各卷的 `<pages from= to=>` 為準。
- 校對等級達到「已校對」的頁顯示維基文庫文本，其餘顯示機器標點；設置裡可改為全部用機器標點。
- 解釋是掛在機器標點的句子上的。對已校對的頁，`build.py` 用逐字比對把機器分句的邊界映射到校對文本上，所以點校對文本同樣能看到對應的解釋。
- 機器標點裡的括號幾乎都不成對（「乙丑，）」「（章明也」）。構建時統一清理：刪去多餘的「）」，給小注補上閉括號，疊在一起的標點只留一個，欄外的干支併入它所屬的紀年句（「（甲申）四十一載……」）。只改輸出，不動 `.src/帶標點/` 裡的原始文件。
- 原始文件裡的書籤標題只精確到頁，構建時在該頁的句子裡找到它們，用來生成「本卷綱目」並把紀年、綱、論贊排成不同層次。

## 來源與可靠性

- 卷次與已校對的文字取自維基文庫，依 CC BY-SA 授權。
- 其餘頁面是機器識別加自動標點，白話解釋由 AI 生成，均未經人工校對，不可引用。
- 掃描原圖不在版本庫內，閱讀時從維基共享資源在線載入。
