/* 歷代通鑑纂要 閱讀前端。無依賴、無構建；數據由 tools/build.py 生成在 data/ 下。
   路由： #/                首頁（卷目）
          #/j/<卷>/<頁>/<句>  閱讀（頁 = 該冊 PDF 頁序）
          #/s/<檢索詞>         全文檢索 */
(() => {
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k in e && k !== "list") e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wide = () => window.matchMedia("(min-width: 1000px)").matches;

const LS_SET = "tjzy.settings", LS_LAST = "tjzy.last";
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 隱私模式 */ } },
};

const S = {
  toc: null,
  byId: new Map(),
  docs: new Map(),
  doc: null,          // 當前卷
  rendered: "",       // 當前已渲染的「卷+正文來源」
  curP: null,
  idx: null,          // 檢索索引 Map<卷, [{p,i,t}]>
  idxPromise: null,
  vmap: null,         // 字 -> 異體字組
  scan: null,
  set: Object.assign({ fs: 19, theme: "auto", src: "best", all: false, side: true, caveat: true, scan: true }, store.get(LS_SET, {})),
};
const main = $("#main");

/* ------------------------------------------------------------ 數據 */

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}：${r.status}`);
  return r.json();
}
async function loadDoc(id) {
  if (!S.docs.has(id)) S.docs.set(id, await getJSON(`data/j/${id}.json`));
  return S.docs.get(id);
}
async function loadVariants() {
  if (S.vmap) return;
  S.vmap = new Map();
  try {
    for (const g of await getJSON("data/variants.json")) for (const c of g) S.vmap.set(c, g);
  } catch { /* 沒有異體表也能檢索，只是不互通 */ }
}

/* ------------------------------------------------------------ 路由 */

function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").map(decodeURIComponent);
  const q = new URLSearchParams(query).get("q") || "";
  if (parts[0] === "j" && parts[1]) {
    return { view: "j", id: parts[1], p: parts[2] ? +parts[2] : null, s: parts[3] != null ? +parts[3] : null, q };
  }
  if (parts[0] === "s") return { view: "s", q: parts.slice(1).join("/") };
  return { view: "home" };
}

async function route() {
  const r = parseHash();
  closePopover();
  document.body.classList.toggle("is-home", r.view === "home");
  document.body.classList.toggle("is-search", r.view === "s");
  // 掃描圖默認打開；屏幕不夠寬時三欄太擠，目錄先收起（按 T 或點左上角仍可打開）
  const crowded = S.set.scan && innerWidth < 1500;
  setSide(r.view !== "home" && wide() && S.set.side && !crowded, false);
  try {
    if (r.view === "j") await showJuan(r);
    else if (r.view === "s") await showSearch(r.q);
    else showHome();
  } catch (e) {
    console.error(e);
    S.rendered = "";
    main.replaceChildren(el("div", { class: "msg" },
      el("p", { text: "這一頁沒能載入。" }),
      el("p", { text: String(e.message || e) }),
      el("p", {}, el("a", { href: "#/", text: "回到卷目" }))));
  }
}

/* ------------------------------------------------------------ 首頁 */

function showHome() {
  S.doc = null; S.rendered = "home"; closeScan();
  document.title = "歷代通鑑纂要";
  $("#where").replaceChildren();
  setProgress(0);
  markCurrentJuan(null);
  setOutline(null);

  const juan = S.toc.juan;
  const pages = juan.reduce((n, j) => n + j.to - j.from + 1, 0);
  const proof = juan.reduce((n, j) => n + j.proof, 0);
  const revPages = juan.reduce((n, j) => n + (j.rev || 0), 0);
  const chars = juan.reduce((n, j) => n + j.chars, 0);
  const last = store.get(LS_LAST, null);
  const lastJ = last && S.byId.get(last.id);

  const eras = [];
  for (const j of juan) {
    if (!eras.length || eras.at(-1).name !== j.era) eras.push({ name: j.era, list: [] });
    eras.at(-1).list.push(j);
  }

  main.replaceChildren(el("div", { class: "home" },
    el("div", { class: "slip" }, "歷代通鑑纂要", el("small", { text: "明正德二年內府刻本" })),
    el("div", { class: "home-body" },
      el("p", { class: "lede" },
        "明李東陽、焦芳、王鏊等奉敕撰，九十二卷。撮《通鑑綱目》之要，上起伏羲，下訖元末，通為一書。",
        "這裡把維基文庫的整理本、機器標點和逐句白話解釋合在一起：點任意一句看解釋，點頁碼看掃描原圖。"),
      lastJ && el("a", { class: "resume", href: `#/j/${last.id}/${last.p}` },
        `接著讀 ${lastJ.label}`, el("span", { text: `第 ${last.p} 頁` })),
      el("ul", { class: "eras", "aria-label": "按時代跳轉" },
        eras.map((e, i) => el("li", {}, el("a", { href: `#era-${i}`, text: e.name, onclick: (ev) => {
          ev.preventDefault(); $(`#era-${i}`).scrollIntoView({ behavior: "smooth" });
        } })))),
      eras.map((e, i) => el("section", { class: "era", id: `era-${i}` },
        el("h2", {}, e.name, el("small", { text: e.list.length > 1 ? `${e.list.length} 卷` : "" })),
        e.list.map((j) => el("a", { href: `#/j/${j.id}` },
          el("b", { text: j.label }),
          el("span", { class: "d", text: j.desc }),
          el("span", { class: "m" }, `第 ${j.vol} 冊　${j.to - j.from + 1} 頁`,
            j.proof ? el("span", { class: "ok", text: `　已校 ${j.proof}` }) : null,
            j.rev ? el("span", { class: "ok", text: `　人工校訂 ${j.rev}` }) : null))))),
      el("div", { class: "about" },
        el("h2", { text: "文本來源與可靠程度" },),
        el("p", {},
          "卷次與已校對的文字取自", el("a", { href: "https://zh.wikisource.org/wiki/" + encodeURIComponent(S.toc.work), target: "_blank", rel: "noopener", text: "維基文庫《歷代通鑑纂要》" }),
          `（${S.toc.fetched} 抓取，全書 ${pages.toLocaleString()} 頁中已校對 ${proof} 頁，頁碼旁標「校」）。`,
          revPages ? `另有 ${revPages} 頁經人工對照原圖校訂，分出了小注，頁碼旁標「訂」。` : "",
          "其餘頁面是中華古籍智慧化服務平台的機器識別和自動標點，沒有人工校對，錯字、斷句錯誤都不少。",
          "白話解釋由同一平台的 AI 生成，時有臆造和張冠李戴，只能幫助理解大意，不可引用。",
          `全書約 ${Math.round(chars / 10000)} 萬字。`),
        el("p", {},
          el("a", { href: "full-site-download.zip", download: "", text: "下載整站離線包（zip）" }),
          "，內含本站全部頁面、各卷正文與解釋的數據，解壓後按包內 README.txt 的說明即可離線閱讀；掃描原圖不在包內。")))));
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------ 閱讀 */

const useWs = (pg) => S.set.src === "best" && pg.w;
const segKey = (p, i) => `${p}-${i}`;

function explBox(pg, i, withOrig) {
  const seg = pg.m[i];
  if (!seg || !seg[1]) return null;
  return el("div", { class: "x", "data-x": segKey(pg.p, i) },
    withOrig ? el("span", { class: "xo", text: "機器標點：" + plain(seg[0]) }) : null, seg[1]);
}

/* 正文裡的兩種標記：<small>…</small> 是雙行小注，句首的「（干支）」是欄外所標紀年。
   逐段建成節點，數據不會被當作 HTML 解釋。 */
const GZ_RE = /^（([甲乙丙丁戊己已巳庚辛壬癸][子丑寅卯辰巳已午未申酉戌戍亥])）/;
const plain = (t) => t.replace(/<\/?small>/g, "");
function rich(t) {
  const out = [];
  const gz = GZ_RE.exec(t);
  if (gz) { out.push(el("span", { class: "gz", text: gz[1] })); t = t.slice(gz[0].length); }
  t.split(/<small>(.*?)<\/small>/).forEach((part, k) => {
    if (part) out.push(k % 2 ? el("small", { class: "nt", text: part }) : part);
  });
  return out;
}

function pageMarker(doc, pg, shownWs) {
  const blank = !pg.m.length && !pg.w;
  return el("div", { class: "pm" + (shownWs ? " ws" : "") + (pg.h ? " rev" : "") + (blank ? " blank" : ""), id: "p" + pg.p },
    el("button", {
      "data-scan": pg.p, text: String(pg.p),
      title: `第 ${doc.vol} 冊第 ${pg.p} 頁` + (shownWs ? "，維基文庫已校對" : pg.h ? "，人工校訂" : "，機器標點") + "。點按看掃描原圖",
    }));
}

function buildText(doc) {
  const frag = document.createDocumentFragment();
  let openPara = null; // 上一頁末尾未結束的校本段落（及其解釋容器）
  for (const pg of doc.pages) {
    const ws = useWs(pg);
    if (!ws) {
      openPara = null;
      frag.append(pageMarker(doc, pg, false));
      pg.m.forEach((seg, i) => {
        frag.append(el("div", { class: "seg" + (seg[2] ? " k-" + seg[2] : ""), id: "s" + segKey(pg.p, i) },
          el("p", { class: "o", "data-s": segKey(pg.p, i) }, rich(seg[0])),
          explBox(pg, i, false)));
      });
      continue;
    }
    const emitted = new Set();
    pg.w.b.forEach(([kind, runs], bi) => {
      let para, xs;
      if (bi === 0 && pg.w.c && openPara) {
        // 段落跨頁：接在上一頁的段落後面，頁碼標在行內
        [para, xs] = openPara;
        para.append(el("button", { class: "pmi", id: "p" + pg.p, "data-scan": pg.p, text: String(pg.p),
          title: `第 ${doc.vol} 冊第 ${pg.p} 頁，維基文庫已校對。點按看掃描原圖` }));
      } else {
        if (bi === 0) frag.append(pageMarker(doc, pg, true));
        para = el(kind === "h" ? "h3" : "p", { class: kind === "h" ? "wh" : kind === "c" ? "wc" : "wp" });
        xs = el("div", { class: "xs" });
        frag.append(para, xs);
      }
      for (const [t, si, note] of runs) {
        const has = si >= 0 && pg.m[si] && pg.m[si][1];
        para.append(el("span", { class: "r" + (note ? " n" : ""), "data-s": has ? segKey(pg.p, si) : null, text: t }));
        if (has && !emitted.has(si)) { emitted.add(si); xs.append(explBox(pg, si, true)); }
      }
      openPara = kind === "p" ? [para, xs] : null;
    });
  }
  return frag;
}

async function showJuan(r) {
  const meta = S.byId.get(r.id);
  if (!meta) throw new Error(`沒有「${r.id}」這一卷`);
  const key = r.id + "|" + S.set.src;
  if (S.rendered !== key) {
    if (S.rendered.split("|")[0] !== r.id) {
      // 先放下舊卷的狀態：載入期間的滾動事件不該再按舊卷改寫地址
      S.doc = null; S.markers = []; S.curP = null;
      main.replaceChildren(el("div", { class: "msg", text: `正在載入${meta.label}…` }));
      closeScan();
    }
    const doc = await loadDoc(r.id);
    if (parseHash().id !== r.id) return; // 載入期間用戶已經去了別處
    S.doc = doc; S.rendered = key; S.curP = null;
    document.title = `${doc.label} ${doc.desc} － 歷代通鑑纂要`;

    const wsUrl = `https://zh.wikisource.org/wiki/${encodeURIComponent(S.toc.work + "/" + doc.sub)}`;
    const proof = doc.pages.filter((p) => p.w).length;
    const rev = doc.pages.filter((p) => p.h).length;
    const text = el("div", { class: "text" }, buildText(doc));
    main.replaceChildren(el("article", { class: "col" },
      el("header", { class: "j-head" },
        el("h1", { text: doc.label }),
        el("p", { class: "desc", text: doc.desc }),
        el("p", { class: "meta" }, `第 ${doc.vol} 冊第 ${doc.from}–${doc.to} 頁　`,
          rev ? `人工校訂 ${rev} 頁　` : proof ? `維基文庫已校對 ${proof} 頁　` : "機器標點，未經校對　",
          el("a", { href: wsUrl, target: "_blank", rel: "noopener", text: "在維基文庫查看本卷" }))),
      S.set.caveat && el("div", { class: "caveat" },
        el("p", { text: "點任意一句顯示白話解釋，點頁碼看掃描原圖。正文多為機器識別、機器標點，解釋為 AI 生成，錯誤不少，僅供參考。" }),
        el("button", { text: "知道了", onclick: (e) => { e.target.closest(".caveat").remove(); saveSet({ caveat: false }); } })),
      text,
      el("nav", { class: "j-foot", "aria-label": "相鄰各卷" },
        doc.prev && el("a", { class: "prev", href: `#/j/${doc.prev.id}` }, el("small", { text: "上一卷" }), el("b", { text: doc.prev.label })),
        doc.next && el("a", { class: "next", href: `#/j/${doc.next.id}` }, el("small", { text: "下一卷" }), el("b", { text: doc.next.label })))));

    markCurrentJuan(r.id);
    setOutline(doc);
    S.markers = $$("[id^='p']", text).filter((e) => /^p\d+$/.test(e.id));
  }

  if (S.set.scan && wide() && !S.scan) openScan(r.p ?? S.doc.from, { auto: true });

  // 定位
  let target = null;
  if (r.p != null && r.s != null) target = $(`#s${segKey(r.p, r.s)}`) || $(`[data-s="${segKey(r.p, r.s)}"]`);
  if (!target && r.p != null) target = $(`#p${r.p}`);
  if (target) {
    target.scrollIntoView({ block: "start" });
    if (r.s != null) {
      const o = target.matches(".seg") ? $(".o", target) : target;
      if (r.q && o.matches(".o")) markMatches(o, r.q);
      o.classList.remove("flash"); void o.offsetWidth; o.classList.add("flash");
    }
  } else {
    window.scrollTo(0, 0);
  }
  if (r.p != null && target && S.scan) { openScan(r.p, { auto: true }); pinScan(); }
  onScroll();
}

async function markMatches(node, q) {
  await loadVariants();
  const re = buildRe(q);
  if (!re) return;
  // 逐個文本節點標記，保留句內的小注、干支等結構
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const texts = [];
  while (walker.nextNode()) texts.push(walker.currentNode);
  for (const tn of texts) {
    const t = tn.nodeValue, parts = [];
    let last = 0;
    for (const m of t.matchAll(re)) {
      if (!m[0]) continue;
      if (m.index > last) parts.push(t.slice(last, m.index));
      parts.push(el("mark", { text: m[0] }));
      last = m.index + m[0].length;
    }
    if (!parts.length) continue;
    if (last < t.length) parts.push(t.slice(last));
    tn.replaceWith(...parts);
  }
}

/* 點句顯示/收起解釋 */
main.addEventListener("click", (e) => {
  const scanBtn = e.target.closest("[data-scan]");
  if (scanBtn) { saveSet({ scan: true }); openScan(+scanBtn.dataset.scan); return; }
  const s = e.target.closest("[data-s]");
  if (!s || String(window.getSelection()) !== "") return; // 正在選字時不打擾
  const id = s.dataset.s;
  const box = $(`.x[data-x="${id}"]`, main);
  if (!box) return;
  const open = !s.classList.contains("on");
  for (const n of $$(`[data-s="${id}"]`, main)) n.classList.toggle("on", open);
  box.classList.toggle("open", open);
});

/* 滾動時更新當前頁、進度、綱目高亮，並記住位置 */
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const doc = S.doc;
    if (!doc || parseHash().view !== "j" || !S.markers?.length) return;
    const line = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) + 40;
    let lo = 0, hi = S.markers.length - 1, cur = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (S.markers[mid].getBoundingClientRect().top <= line) { cur = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const m = S.markers[cur], p = +m.id.slice(1);
    if (p !== S.curP) {
      S.curP = p;
      if (S.scan && wide() && S.scan.p !== p && !pinned()) followScan(p);
      $$(".pm.cur", main).forEach((n) => n.classList.remove("cur"));
      m.classList.add("cur");
      $("#where").replaceChildren(el("b", { text: doc.label }), el("span", { class: "d", text: doc.desc }),
        el("span", { class: "pg", text: `第 ${doc.vol} 冊 ${p} 頁` }));
      store.set(LS_LAST, { id: doc.id, p });
      const r = parseHash();
      if (r.p !== p && (r.p != null || scrollY > 200)) {
        history.replaceState(null, "", `#/j/${doc.id}/${p}`);
      }
    }
    const total = document.documentElement.scrollHeight - innerHeight;
    setProgress(total > 0 ? scrollY / total : 0);
    spyOutline(line);
  });
}
addEventListener("scroll", onScroll, { passive: true });
addEventListener("resize", onScroll, { passive: true });
const setProgress = (f) => { $("#progress").style.width = (f * 100).toFixed(2) + "%"; };

/* ------------------------------------------------------------ 側欄：卷目與綱目 */

function buildJuanList() {
  const pane = $("#pane-juan");
  let era = null;
  for (const j of S.toc.juan) {
    if (j.era !== era) { era = j.era; pane.append(el("h2", { text: era })); }
    pane.append(el("a", { class: "j", href: `#/j/${j.id}`, "data-id": j.id },
      el("b", { text: j.label }), el("span", { text: j.desc })));
  }
}
// 只滾動側欄自己（scrollIntoView 會連帶滾動整個頁面，打斷閱讀位置）
function revealCurrentJuan() {
  const pane = $("#pane-juan"), a = $("a[aria-current]", pane);
  if (!a || pane.hidden) return;
  const r = a.getBoundingClientRect(), pr = pane.getBoundingClientRect();
  if (r.top < pr.top + 40 || r.bottom > pr.bottom - 10) pane.scrollTop += r.top - pr.top - pr.height / 3;
}
function markCurrentJuan(id) {
  for (const a of $$("#pane-juan a.j")) {
    if (a.dataset.id === id) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  revealCurrentJuan();
}
function selectTab(name) {
  for (const n of ["juan", "outline"]) {
    $(`#tab-${n}`).setAttribute("aria-selected", String(n === name));
    $(`#pane-${n}`).hidden = n !== name;
  }
  if (name === "juan") revealCurrentJuan(); else onScroll();
}
$("#tab-juan").onclick = () => selectTab("juan");
$("#tab-outline").onclick = () => selectTab("outline");

let outlineLinks = [];
function setOutline(doc) {
  const list = $("#outline-list"), tab = $("#tab-outline");
  $("#outline-filter").value = "";
  outlineLinks = [];
  updateSrcHint();
  tab.disabled = !doc;
  if (!doc) { list.replaceChildren(); selectTab("juan"); return; }
  if (!doc.outline.length) {
    list.replaceChildren(el("p", { class: "none", text: "這一卷沒有綱目。" }));
    selectTab("juan");
    return;
  }
  list.replaceChildren(...doc.outline.map(([lv, title, p, i]) => {
    const a = el("a", { class: "l" + lv, href: `#/j/${doc.id}/${p}` + (i >= 0 ? `/${i}` : ""), text: title });
    const target = (i >= 0 && ($(`#s${segKey(p, i)}`) || $(`[data-s="${segKey(p, i)}"]`))) || $(`#p${p}`);
    outlineLinks.push({ a, target, text: title });
    return a;
  }));
  selectTab("outline");
}
function spyOutline(line) {
  if (!outlineLinks.length || $("#pane-outline").hidden || !document.body.classList.contains("side-open")) return;
  let lo = 0, hi = outlineLinks.length - 1, cur = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, t = outlineLinks[mid].target;
    if (t && t.getBoundingClientRect().top <= line + 60) { cur = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const now = cur >= 0 ? outlineLinks[cur].a : null;
  const old = $("#outline-list a.cur");
  if (old === now) return;
  old?.classList.remove("cur");
  if (now) {
    now.classList.add("cur");
    const pane = $("#pane-outline"), r = now.getBoundingClientRect(), pr = pane.getBoundingClientRect();
    if (r.top < pr.top + 50 || r.bottom > pr.bottom - 20) pane.scrollTop += r.top - pr.top - pr.height / 3;
  }
}
$("#outline-filter").addEventListener("input", (e) => {
  const re = buildRe(e.target.value);
  for (const { a, text } of outlineLinks) a.hidden = !!re && !(re.lastIndex = 0, re.test(text));
});

function setSide(open, remember = true) {
  document.body.classList.toggle("side-open", !!open);
  $("#btn-side").setAttribute("aria-expanded", String(!!open));
  $("#scrim").hidden = !open || wide();
  if (remember && wide() && parseHash().view !== "home") saveSet({ side: !!open });
  if (open) { revealCurrentJuan(); onScroll(); }
}
$("#btn-side").onclick = () => setSide(!document.body.classList.contains("side-open"));
$("#scrim").onclick = () => setSide(false, false);
$("#side").addEventListener("click", (e) => { if (e.target.closest("a") && !wide()) setSide(false, false); });

/* ------------------------------------------------------------ 檢索 */

const GAP = "[^\\p{L}\\p{N}]{0,3}"; // 允許中間夾標點，因為機器標點並不可靠
function buildRe(q) {
  const chars = [...(q || "")].filter((c) => /[\p{L}\p{N}]/u.test(c));
  if (!chars.length) return null;
  const cls = (c) => {
    const g = S.vmap?.get(c);
    return g ? `[${g}]` : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };
  return new RegExp(chars.map(cls).join(GAP), "gu");
}

function loadIndex(onProgress) {
  if (S.idx) return Promise.resolve();
  if (!S.idxPromise) {
    const idx = new Map(), queue = S.toc.juan.map((j) => j.id);
    let done = 0;
    const total = queue.length;
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        const text = await (await fetch(`data/s/${id}.txt`)).text();
        idx.set(id, text ? text.split("\n").map((l) => {
          const a = l.indexOf("\t"), b = l.indexOf("\t", a + 1);
          return { p: +l.slice(0, a), i: +l.slice(a + 1, b), t: l.slice(b + 1) };
        }) : []);
        S.onIdxProgress?.(++done / total);
      }
    };
    S.idxPromise = Promise.all([loadVariants(), ...Array.from({ length: 8 }, worker)])
      .then(() => { S.idx = idx; })
      .catch((e) => { S.idxPromise = null; throw e; });
  }
  S.onIdxProgress = onProgress;
  return S.idxPromise;
}

let searchSeq = 0;
async function showSearch(q) {
  const seq = ++searchSeq;
  S.doc = null; S.rendered = "search"; closeScan();
  markCurrentJuan(null); setOutline(null); setProgress(0);
  document.title = `檢索「${q}」－ 歷代通鑑纂要`;
  $("#where").replaceChildren(el("b", { text: "全文檢索" }));
  if ($("#q").value !== q && document.activeElement !== $("#q")) $("#q").value = q;

  const info = el("p", { text: q ? "正在載入全書索引…" : "輸入要找的字句。繁體、簡體、異體字都能互相匹配，標點可以不管。" });
  const bar = el("div", { class: "s-bar" }, el("i"));
  const jump = el("div", { class: "s-jump" });
  const out = el("div");
  main.replaceChildren(el("div", { class: "col" },
    el("header", { class: "s-head" }, el("h1", { text: q ? `「${q}」` : "全文檢索" }), info, S.idx || !q ? null : bar, jump),
    out));
  window.scrollTo(0, 0);
  if (!q) return;

  await loadIndex((f) => { bar.firstChild.style.width = f * 100 + "%"; });
  if (seq !== searchSeq) return;
  bar.remove();

  const re = buildRe(q);
  if (!re) { info.textContent = "檢索詞裡沒有可以查找的文字。"; return; }
  const groups = [];
  let lines = 0, hits = 0;
  for (const j of S.toc.juan) {
    const g = [];
    for (const row of S.idx.get(j.id) || []) {
      re.lastIndex = 0;
      const m = re.exec(row.t);
      if (!m) continue;
      let n = 1;
      while (re.exec(row.t)) n++;
      hits += n;
      g.push({ row, at: m.index, len: m[0].length });
    }
    if (g.length) { groups.push({ j, g }); lines += g.length; }
  }
  if (!lines) {
    info.textContent = "全書沒有找到。可以試試縮短檢索詞；機器識別的錯字也可能讓原文對不上。";
    return;
  }
  info.textContent = `${groups.length} 卷、${lines.toLocaleString()} 句中出現 ${hits.toLocaleString()} 次。`;

  const BATCH = 300;
  let gi = 0, shown = 0;
  const more = el("button", { class: "more", text: "顯示更多" });
  const snippet = ({ row, at, len }) => {
    const t = row.t;
    let a = Math.max(0, at - 26), b = Math.min(t.length, at + len + 44);
    if (a > 0 && t.charCodeAt(a) >= 0xdc00 && t.charCodeAt(a) <= 0xdfff) a--;
    if (b < t.length && t.charCodeAt(b) >= 0xdc00 && t.charCodeAt(b) <= 0xdfff) b++;
    re.lastIndex = 0;
    return (a > 0 ? "…" : "") + esc(t.slice(a, b)).replace(re, (m) => `<mark>${m}</mark>`) + (b < t.length ? "…" : "");
  };
  const renderMore = (untilGroup = -1) => {
    const stop = shown + BATCH;
    while (gi < groups.length && (shown < stop || gi <= untilGroup)) {
      const { j, g } = groups[gi];
      out.append(el("section", { class: "s-group", id: `g-${j.id}` },
        el("h2", {}, el("a", { href: `#/j/${j.id}`, text: j.label, style: "color:inherit;text-decoration:none" }),
          el("small", { text: `${j.desc}　${g.length} 句` })),
        g.map((h) => {
          const a = el("a", { class: "s-hit", href: `#/j/${j.id}/${h.row.p}/${h.row.i}?q=${encodeURIComponent(q)}` });
          a.innerHTML = `<span>${snippet(h)}</span><span class="at">${h.row.p} 頁</span>`;
          return a;
        })));
      shown += g.length; gi++;
    }
    more.hidden = gi >= groups.length;
    more.textContent = `顯示更多（還有 ${(lines - shown).toLocaleString()} 句）`;
  };
  more.onclick = () => renderMore();
  if (groups.length > 1) {
    // 命中的卷很多時按時代歸併，免得跳轉鏈接本身成了一堵牆
    const chips = [];
    groups.forEach(({ j, g }, k) => {
      const name = groups.length > 24 ? j.era : j.label;
      if (chips.at(-1)?.name === name) chips.at(-1).n += g.length;
      else chips.push({ name, n: g.length, k, id: j.id });
    });
    jump.replaceChildren(...chips.map((c) => el("a", {
      href: `#g-${c.id}`, text: `${c.name} ${c.n}`,
      onclick: (e) => { e.preventDefault(); renderMore(c.k); $(`#g-${c.id}`).scrollIntoView(); },
    })));
  }
  renderMore();
  main.firstChild.append(more);
}

let typing = 0;
$("#q").addEventListener("input", (e) => {
  clearTimeout(typing);
  typing = setTimeout(() => {
    const q = e.target.value.trim();
    if (parseHash().view === "s") { history.replaceState(null, "", "#/s/" + encodeURIComponent(q)); showSearch(q); }
    else if (q) location.hash = "#/s/" + encodeURIComponent(q);
  }, 350);
});
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  clearTimeout(typing);
  const q = $("#q").value.trim(), h = "#/s/" + encodeURIComponent(q);
  if (location.hash !== h) location.hash = h; else showSearch(q);
  if (!wide()) $("#q").blur();
});

/* ------------------------------------------------------------ 掃描原圖 */

let followTimer = 0;
/* 用戶指定了某一頁（點頁碼、在圖上翻頁、打開帶頁碼的鏈接）時把圖「釘」在那一頁，
   直到他自己滾動正文為止。卷末幾頁滾不到頂，不釘住的話圖會被拉回前一頁。 */
let pin = null;
function pinScan() { pin = { y: scrollY }; clearTimeout(followTimer); }
function pinned() {
  if (pin && Math.abs(scrollY - pin.y) > innerHeight * 0.5) pin = null; // 拖動滾動條也算
  return !!pin;
}
for (const type of ["wheel", "touchmove", "keydown"]) {
  addEventListener(type, (e) => {
    if (type !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) pin = null;
  }, { passive: true });
}
function followScan(p) {
  // 快速滾動時不必每一頁都載入圖片，停下來再換
  clearTimeout(followTimer);
  followTimer = setTimeout(() => { if (S.scan && S.doc && S.curP === p) openScan(p, { auto: true }); }, 220);
}
function openScan(p, { auto = false } = {}) {
  const doc = S.doc;
  if (!doc) return;
  if (!auto) requestAnimationFrame(pinScan); // 等這次定位滾動完成後再記位置
  if (S.scan && S.scan.vol === doc.vol && S.scan.p === p && !$("#scan").hidden) return;
  S.scan = { vol: doc.vol, p };
  const file = S.toc.files[doc.vol];
  const pg = doc.pages.find((x) => x.p === p);
  const index = S.toc.index[doc.vol];
  const wsPage = index && `https://zh.wikisource.org/wiki/${encodeURIComponent(`Page:${index}/${p}`)}`;
  $("#scan-title").textContent = `第 ${doc.vol} 冊第 ${p} 頁`;
  $("#scan-prev").disabled = p <= 1;
  $("#scan-next").disabled = file?.pagecount ? p >= file.pagecount : false;
  const status = pg && pg.q != null ? ["沒有文字", "未校對", "有問題", "已校對", "已核對"][pg.q] || "" : "";
  $("#scan-links").replaceChildren(
    pg ? el("a", { href: `#/j/${doc.id}/${p}`, text: "回到正文這一頁" }) : null,
    wsPage ? el("a", { href: wsPage, target: "_blank", rel: "noopener",
      text: status ? `在維基文庫校對（${status}）` : "在維基文庫錄入這一頁" }) : null);
  const body = $("#scan-body");
  body.classList.remove("zoom");
  if (file) {
    const img = el("img", { alt: `第 ${doc.vol} 冊第 ${p} 頁掃描圖`, src: file.thumb.replace("{p}", p) });
    img.onclick = () => body.classList.toggle("zoom");
    img.onerror = () => body.replaceChildren(el("p", { text: "掃描圖沒能載入，可能是網絡不通，或維基共享資源暫時不可用。" }));
    body.replaceChildren(img);
    body.scrollTop = 0;
  } else {
    body.replaceChildren(el("p", { text: `沒有取到第 ${doc.vol} 冊掃描本的地址。重新運行 tools/fetch_wikisource.py 和 build.py 後再試。` }));
  }
  if ($("#scan").hidden) {
    // 版面變窄會讓正文重排：打開後把點的那一頁留在視野裡
    $("#scan").hidden = false;
    document.body.classList.add("scan-open");
    if (wide() && !auto) $(`#p${p}`)?.scrollIntoView({ block: "start" });
  }
  $("#btn-scan").setAttribute("aria-pressed", "true");
}
function closeScan() {
  $("#btn-scan").setAttribute("aria-pressed", "false");
  clearTimeout(followTimer);
  if (!S.scan) return;
  S.scan = null;
  const p = S.doc && S.curP;
  $("#scan").hidden = true;
  document.body.classList.remove("scan-open");
  if (p != null && wide()) $(`#p${p}`)?.scrollIntoView({ block: "start" });
}
// 用戶主動開關才記住偏好；換卷、回首頁時的自動關閉不算
function toggleScan(open = !S.scan) {
  saveSet({ scan: open });
  if (!open) closeScan();
  else if (S.doc) openScan(S.curP ?? S.doc.from);
}
$("#scan-close").onclick = () => toggleScan(false);
$("#btn-scan").onclick = () => toggleScan();
// 在掃描圖上翻頁：正文跟著跳到那一頁；翻出本卷範圍就進入同一冊裡相鄰的卷
function flipScan(step) {
  if (!S.scan || !S.doc) return;
  const p = S.scan.p + step, doc = S.doc;
  if (p >= doc.from && p <= doc.to) {
    openScan(p, { auto: true });
    $(`#p${p}`)?.scrollIntoView({ block: "start" });
    pinScan();
    return;
  }
  const other = S.toc.juan.find((j) => j.vol === doc.vol && p >= j.from && p <= j.to);
  if (other) location.hash = `#/j/${other.id}/${p}`;
  else openScan(p, { auto: true }); // 封面、空白頁等不屬於任何卷，只換圖
}
$("#scan-prev").onclick = () => flipScan(-1);
$("#scan-next").onclick = () => flipScan(1);

/* ------------------------------------------------------------ 設置 */

function saveSet(patch) {
  Object.assign(S.set, patch);
  store.set(LS_SET, S.set);
}
/* 「校本優先 / 機器標點」只在有已校對頁的卷裡才有區別；沒有時停用並說明原因 */
function updateSrcHint() {
  const hint = $("#src-hint");
  const n = S.doc ? S.doc.pages.filter((p) => p.w).length : null;
  const useless = n === 0;
  for (const b of $$("#src-ctl button")) b.disabled = useless;
  hint.hidden = n == null;
  if (n == null) return;
  hint.textContent = useless
    ? `${S.doc.label}在維基文庫還沒有已校對的頁，全卷都是機器標點，這個選項在本卷沒有區別。`
    : `${S.doc.label}有 ${n} 頁已校對（頁碼旁標「校」），只有這些頁會隨選項變化。`;
}
function applySet() {
  const root = document.documentElement;
  if (S.set.theme === "auto") delete root.dataset.theme; else root.dataset.theme = S.set.theme;
  root.style.setProperty("--fs", S.set.fs + "px");
  document.body.classList.toggle("all-x", !!S.set.all);
  $("#fs-out").textContent = S.set.fs;
  $("#btn-expl").setAttribute("aria-pressed", String(!!S.set.all));
  $("#btn-expl").title = S.set.all ? "只在點句時顯示解釋（E）" : "顯示全部解釋（E）";
  for (const b of $$("#theme-ctl button")) b.setAttribute("aria-pressed", String(b.dataset.theme === S.set.theme));
  for (const b of $$("#src-ctl button")) b.setAttribute("aria-pressed", String(b.dataset.src === S.set.src));
  updateSrcHint();
  for (const b of $$("#expl-ctl button")) b.setAttribute("aria-pressed", String(!!+b.dataset.all === !!S.set.all));
}
/* 版面會變動的設置：改完後回到原來讀到的那一頁 */
function keepPlace(fn) {
  const p = S.doc && S.curP;
  fn();
  if (p != null) requestAnimationFrame(() => { $(`#p${p}`)?.scrollIntoView({ block: "start" }); onScroll(); });
}
function toggleAll(v = !S.set.all) { keepPlace(() => { saveSet({ all: v }); applySet(); }); }

function closePopover() { $("#settings").hidden = true; $("#btn-set").setAttribute("aria-expanded", "false"); }
$("#btn-set").onclick = (e) => {
  e.stopPropagation();
  const pop = $("#settings");
  pop.hidden = !pop.hidden;
  $("#btn-set").setAttribute("aria-expanded", String(!pop.hidden));
};
document.addEventListener("click", (e) => { if (!e.target.closest("#settings")) closePopover(); });
$("#btn-expl").onclick = () => toggleAll();
$("#settings").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.fs) keepPlace(() => { saveSet({ fs: Math.min(30, Math.max(14, S.set.fs + +b.dataset.fs)) }); applySet(); });
  else if (b.dataset.theme) { saveSet({ theme: b.dataset.theme }); applySet(); }
  else if (b.dataset.all) toggleAll(!!+b.dataset.all);
  else if (b.dataset.src && b.dataset.src !== S.set.src) {
    saveSet({ src: b.dataset.src }); applySet();
    if (S.doc) showJuan({ id: S.doc.id, p: S.curP, s: null });
  }
});

/* ------------------------------------------------------------ 鍵盤 */

addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("#settings").hidden) closePopover();
    else if (S.scan) toggleScan(false);
    else if (document.activeElement === $("#q")) $("#q").blur();
    else if (!wide()) setSide(false, false);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select")) return;
  if (e.key === "/") { e.preventDefault(); $("#q").focus(); $("#q").select(); }
  else if (e.key === "e" || e.key === "E") toggleAll();
  else if (e.key === "t" || e.key === "T") $("#btn-side").click();
  else if ((e.key === "i" || e.key === "I") && S.doc) toggleScan();
  else if (S.doc && e.key === "ArrowLeft" && S.doc.prev) location.hash = `#/j/${S.doc.prev.id}`;
  else if (S.doc && e.key === "ArrowRight" && S.doc.next) location.hash = `#/j/${S.doc.next.id}`;
});

/* ------------------------------------------------------------ 啟動 */

(async () => {
  applySet();
  try {
    S.toc = await getJSON("data/toc.json");
  } catch (e) {
    main.replaceChildren(el("div", { class: "msg" },
      el("p", { text: "沒有找到數據文件。請先在項目根目錄運行 python3 tools/build.py，再用本地服務器打開（python3 -m http.server -d site）。" })));
    return;
  }
  for (const j of S.toc.juan) S.byId.set(j.id, j);
  buildJuanList();
  loadVariants();
  addEventListener("hashchange", route);
  route();
})();
})();
