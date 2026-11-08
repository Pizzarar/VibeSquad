// Injected into the page as a function expression: (opts) => { hits, texts, counts }.
// Geometry-based checks for one surface. `texts` are boxes the node side samples pixels for
// (contrast vs the real rendered background, plus background steps/lines crossing the text).
(function auditPage(opts) {
  const TOL = opts.tolerance ?? 2;
  // opts.rootSelectors: audit only elements inside these roots (decor owners may live anywhere on the page).
  const roots = opts.rootSelectors ? opts.rootSelectors.flatMap((q) => [...document.querySelectorAll(q)]) : [document.body];
  if (!roots.length) return { hits: [], texts: [], missing: true, counts: {} };
  const root = document.body;
  const vw = innerWidth, vh = innerHeight;
  const INTERACTIVE = "button,a[href],input,select,textarea,[role=button],[role=tab],[role=menuitem],summary";
  const style = (el, pseudo) => getComputedStyle(el, pseudo);

  const cssPath = (el) => {
    const parts = [];
    for (let n = el, d = 0; n && n.nodeType === 1 && n !== document.body && d < 4; n = n.parentElement, d++) {
      let s = n.tagName.toLowerCase();
      const tid = n.getAttribute("data-testid");
      if (tid) { parts.unshift(`${s}[data-testid="${tid}"]`); break; }
      const cls = [...n.classList].slice(0, 2);
      if (cls.length) s += "." + cls.join(".");
      parts.unshift(s);
    }
    return parts.join(" > ");
  };
  const rectOf = (r) => ({ x: r.left, y: r.top, w: r.width, h: r.height });
  const short = (el, n = 60) => (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, n);

  const visible = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = style(n);
      if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
      if (parseFloat(s.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const inViewport = (r) => r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;

  // True when some sample point of `box` hits `el` (or a relative) rather than another layer (modal, overlay).
  const onTop = (el, box) => {
    if (style(el).pointerEvents === "none") return true;
    for (const fx of [0.5, 0.2, 0.8]) {
      for (const fy of [0.5, 0.25, 0.75]) {
        const x = Math.min(vw - 1, Math.max(0, box.left + box.width * fx)), y = Math.min(vh - 1, Math.max(0, box.top + box.height * fy));
        const t = document.elementFromPoint(x, y);
        if (t && (el.contains(t) || t.contains(el))) return true;
      }
    }
    return false;
  };
  // The part of `box` that survives the overflow clipping of el's containing-block ancestors (null when fully clipped).
  const cbParentOf = (el) => {
    const pos = style(el).position;
    if (pos === "fixed") return null;
    if (pos === "absolute") return el.offsetParent;
    return el.parentElement;
  };
  const clipBox = (el, b) => {
    let l = b.left, t = b.top, r = b.right, bt = b.bottom;
    for (let n = cbParentOf(el); n && n !== document.documentElement && n !== document.body; n = cbParentOf(n)) {
      const s = style(n);
      const a = n.getBoundingClientRect();
      if (s.overflowX !== "visible") { l = Math.max(l, a.left); r = Math.min(r, a.right); }
      if (s.overflowY !== "visible") { t = Math.max(t, a.top); bt = Math.min(bt, a.bottom); }
    }
    if (r - l <= 0 || bt - t <= 0) return null;
    return { left: l, top: t, right: r, bottom: bt, width: r - l, height: bt - t };
  };

  // Union of the range rects of an element's own text nodes.
  const textBoxOf = (el) => {
    let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity, str = "", any = false;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.nodeValue.trim()) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) {
        if (r.width <= 0 || r.height <= 0) continue;
        any = true;
        l = Math.min(l, r.left); t = Math.min(t, r.top); rr = Math.max(rr, r.right); b = Math.max(b, r.bottom);
      }
      str += n.nodeValue;
    }
    if (!any) return null;
    return { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t, text: str.replace(/\s+/g, " ").trim() };
  };

  const SKIP = new Set(["script", "style", "path", "option", "br", "canvas", "g", "defs", "use", "rect", "circle", "line", "polygon", "polyline", "text"]);
  const allEls = [...root.querySelectorAll("*")].filter((el) => !SKIP.has(el.tagName.toLowerCase()) && visible(el));
  const els = opts.rootSelectors ? allEls.filter((el) => roots.some((r) => r.contains(el))) : allEls;

  const hits = [];
  const add = (kind, split, el, other, detail, box) => hits.push({
    kind, split, selector: cssPath(el), classes: [...el.classList], tag: el.tagName.toLowerCase(), text: short(el),
    other: other ? { selector: cssPath(other), classes: [...other.classList], text: short(other, 40) } : null,
    detail, box: box || rectOf(el.getBoundingClientRect()),
  });

  const cands = [];
  const textLeaves = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (el.matches(INTERACTIVE) && !(el.tagName === "INPUT" && el.type === "hidden") && inViewport(r) && onTop(el, r)) cands.push({ el, box: r, kind: "interactive" });
    if (el.matches("img,canvas,[role=img]") && r.width >= 6 && r.height >= 6 && inViewport(r) && onTop(el, r)) cands.push({ el, box: r, kind: "art" });
    const raw = textBoxOf(el);
    const tb = raw && inViewport(raw) && onTop(el, raw) ? raw : null;
    if (tb) {
      const vis = clipBox(el, tb);
      if (vis) {
        textLeaves.push({ el, tb, vis: { ...vis, text: tb.text } });
        if (!el.closest(INTERACTIVE)) cands.push({ el, box: vis, kind: "text", raw: tb });
      }
    }
  }

  // 1. Intersecting boxes: non-ancestor pairs, >TOL px on both axes, both genuinely painted there.
  const seen = new Set();
  for (let i = 0; i < cands.length; i++) {
    for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i], b = cands[j];
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ow = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const oh = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (ow <= TOL || oh <= TOL) continue;
      const cx = Math.max(a.box.left, b.box.left) + ow / 2, cy = Math.max(a.box.top, b.box.top) + oh / 2;
      const top = document.elementFromPoint(cx, cy);
      if (!top || (!a.el.contains(top) && !b.el.contains(top) && !top.contains(a.el) && !top.contains(b.el))) continue;
      const key = cssPath(a.el) + "|" + cssPath(b.el);
      if (seen.has(key)) continue;
      seen.add(key);
      const sib = a.el.parentElement === b.el.parentElement;
      add("overlap", "ours", a.el, b.el, `${a.kind}/${b.kind}${sib ? " siblings" : ""} intersect ${ow.toFixed(1)}x${oh.toFixed(1)}px`,
        { x: Math.max(a.box.left, b.box.left), y: Math.max(a.box.top, b.box.top), w: ow, h: oh });
    }
  }

  // 2. Text overflow, text outside its container, short-label truncation.
  for (const { el, tb, vis } of textLeaves) {
    const s = style(el);
    // text-overflow only paints "…" on block containers; on flex/grid containers the text is hard-clipped.
    const ellipsis = s.textOverflow === "ellipsis" && !/flex|grid/.test(s.display);
    const clipsX = s.overflowX !== "visible";
    if (el.clientWidth >= 8 && el.scrollWidth > el.clientWidth + 1 && s.display !== "inline") {
      if (ellipsis && clipsX) {
        if (tb.text.length <= 14) add("truncated", "ours", el, null, `short label ellipsized: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      } else if (clipsX && !["auto", "scroll"].includes(s.overflowX)) {
        add("text-overflow", "ours", el, null, `clipped without ellipsis: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      } else if (!clipsX && s.whiteSpace === "nowrap" && el.scrollWidth > el.clientWidth + TOL + 2) {
        add("text-overflow", "ours", el, null, `nowrap text spills: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
      }
    }
    if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 2 && ["hidden", "clip"].includes(s.overflowY) && !ellipsis && !/^[1-9]/.test(s.webkitLineClamp)) {
      add("text-overflow", "ours", el, null, `vertical clip: scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight}`);
    }
    const p = el.parentElement;
    if (p && p !== document.body && style(p).display !== "contents" && !["auto", "scroll"].includes(style(p).overflowX)) {
      const pr = p.getBoundingClientRect();
      const out = Math.max(pr.left - vis.left, vis.right - pr.right, pr.top - vis.top, vis.bottom - pr.bottom);
      if (pr.width > 0 && out > TOL + 1) add("text-outside-container", "ours", el, p, `text box pokes ${out.toFixed(1)}px outside parent ${cssPath(p)}`, rectOf(vis));
    }
  }

  // 3. Edge clipping: box partly beyond an overflow-clipping ancestor in its containing-block chain.
  const cbParent = (el) => {
    const pos = style(el).position;
    if (pos === "fixed") return null;
    if (pos === "absolute") return el.offsetParent;
    return el.parentElement;
  };
  const seenClip = new Set();
  for (const c of cands) {
    const r = c.raw ?? c.box;
    let ellipsisSeen = style(c.el).textOverflow === "ellipsis" && !/flex|grid/.test(style(c.el).display);
    for (let n = cbParent(c.el), d = 0; n && n !== document.documentElement && n !== document.body && d < 14; n = cbParent(n), d++) {
      const s = style(n);
      const xClip = s.overflowX === "hidden" || s.overflowX === "clip";
      const yClip = s.overflowY === "hidden" || s.overflowY === "clip";
      if (!xClip && !yClip) continue;
      if (c.kind === "text" && (ellipsisSeen || /^[1-9]/.test(s.webkitLineClamp))) break;
      const a = n.getBoundingClientRect();
      if (a.width === 0 || a.height === 0) continue;
      const ow = Math.min(r.right, a.right) - Math.max(r.left, a.left), oh = Math.min(r.bottom, a.bottom) - Math.max(r.top, a.top);
      if (ow <= 0 || oh <= 0) continue; // fully outside = collapsed on purpose
      const worst = Math.max(xClip ? a.left - r.left : 0, xClip ? r.right - a.right : 0, yClip ? a.top - r.top : 0, yClip ? r.bottom - a.bottom : 0);
      if (worst > TOL) {
        const key = cssPath(c.el) + "|" + cssPath(n);
        if (!seenClip.has(key)) {
          seenClip.add(key);
          add("edge-clip", "ours", c.el, n, `box clipped ${worst.toFixed(1)}px by overflow:hidden ancestor ${cssPath(n)}`, rectOf(r));
        }
        break;
      }
    }
  }

  // 3b. Painted title-bar strips: a url() background layer that spans the element (repeat-x / full width) but is shorter than
  // it (skin title bars, banners). Text or controls that straddle the strip's top/bottom edge, or are taller than it, are
  // misaligned against the art (SETTINGS above its bar, chip hanging off the bar).
  const splitTop = (v) => {
    const out = []; let depth = 0, cur = "";
    for (const ch of v) {
      if (ch === "(") depth++; else if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const stripCache = new Map();
  const stripsOf = (n) => {
    if (stripCache.has(n)) return stripCache.get(n);
    const out = [];
    const s = style(n);
    if (s.backgroundImage && s.backgroundImage.includes("url(")) {
      const imgs = splitTop(s.backgroundImage), sizes = splitTop(s.backgroundSize), poss = splitTop(s.backgroundPosition), reps = splitTop(s.backgroundRepeat);
      const r = n.getBoundingClientRect();
      const bl = parseFloat(s.borderLeftWidth) || 0, bt = parseFloat(s.borderTopWidth) || 0;
      imgs.forEach((img, i) => {
        if (!img.startsWith("url(")) return;
        const sz = (sizes[i % sizes.length] || "").split(/\s+/), ps = (poss[i % poss.length] || "").split(/\s+/);
        const rep = reps[i % reps.length] || "repeat";
        const w = parseFloat(sz[0]), h = parseFloat(sz[1]), py = parseFloat(ps[1]);
        if (!(h > 0) || isNaN(py) || /repeat-y|^repeat$|^repeat repeat/.test(rep)) return;
        if (!(/repeat-x/.test(rep) || w >= r.width * 0.9)) return;
        if (h >= r.height - 2) return; // strip fills the element: nothing can poke out
        out.push({ top: r.top + bt + py, bottom: r.top + bt + py + h, left: r.left + bl, right: r.right, owner: n, h, ownerH: r.height });
      });
    }
    stripCache.set(n, out);
    return out;
  };
  const seenBar = new Set();
  const barCheck = (el, b, what) => {
    let n = el, d = 0;
    for (; n && n !== document.body && d < 5; n = n.parentElement, d++) {
      for (const st of stripsOf(n)) {
        const hMid = (b.left + b.right) / 2;
        if (hMid < st.left || hMid > st.right) continue;
        const inside = Math.min(b.bottom, st.bottom) - Math.max(b.top, st.top);
        const tall = b.bottom - b.top;
        const above = st.top - b.top, below = b.bottom - st.bottom;
        // straddling an edge, or text/box nearly entirely off the strip while the strip sits inside the owner
        // only bar-like owners (strip ~ the owner's height) and only boxes that straddle the strip edge
        if (st.ownerH > st.h * 2.2 || st.h > 120) continue;
        if ((above > TOL || below > TOL) && inside > 0) {
          const key = cssPath(el) + "|" + cssPath(st.owner);
          if (seenBar.has(key)) return;
          seenBar.add(key);
          add("bar-misalign", "ours", el, st.owner, `${what} box y ${b.top.toFixed(0)}-${b.bottom.toFixed(0)} vs painted bar strip y ${st.top.toFixed(0)}-${st.bottom.toFixed(0)} of ${cssPath(st.owner)} (${above > TOL ? `${above.toFixed(1)}px above` : ""}${above > TOL && below > TOL ? ", " : ""}${below > TOL ? `${below.toFixed(1)}px below` : ""} the bar)`, { x: b.left, y: Math.min(b.top, st.top), w: Math.max(b.right - b.left, 8), h: Math.max(b.bottom, st.bottom) - Math.min(b.top, st.top) });
          return;
        }
      }
    }
  };
  for (const { el, vis } of textLeaves) barCheck(el, vis, "text");
  for (const c of cands) if (c.kind === "interactive") barCheck(c.el, c.box, "control");

  // 4. Decorative lines through text: border edges, pseudo-element boxes, repeating gradients vs text boxes.
  const decor = [];
  for (const el of allEls) {
    const r = el.getBoundingClientRect();
    if (!inViewport(r) || (r.width > vw * 1.2 && r.height > vh * 1.2)) continue;
    const s = style(el);
    const edges = [
      ["top", r.left, r.top, r.width, parseFloat(s.borderTopWidth), s.borderTopStyle, s.borderTopColor],
      ["bottom", r.left, r.bottom - parseFloat(s.borderBottomWidth), r.width, parseFloat(s.borderBottomWidth), s.borderBottomStyle, s.borderBottomColor],
      ["left", r.left, r.top, parseFloat(s.borderLeftWidth), r.height, s.borderLeftStyle, s.borderLeftColor],
      ["right", r.right - parseFloat(s.borderRightWidth), r.top, parseFloat(s.borderRightWidth), r.height, s.borderRightStyle, s.borderRightColor],
    ];
    for (const [side, x, y, w, h, bst, bcol] of edges) {
      const thick = side === "top" || side === "bottom" ? h : w;
      if (!(thick > 0) || bst === "none" || bst === "hidden" || /, 0\)$|transparent/.test(bcol)) continue;
      decor.push({ el, what: `border-${side}`, x, y, w, h, from: "border" });
    }
    for (const ps of ["::before", "::after"]) {
      const p = style(el, ps);
      if (!p || p.content === "none" || p.content === "normal" || p.display === "none") continue;
      const bg = p.backgroundImage !== "none" || !/, 0\)$|transparent/.test(p.backgroundColor);
      const bord = ["Top", "Right", "Bottom", "Left"].some((k) => parseFloat(p[`border${k}Width`]) > 0 && p[`border${k}Style`] !== "none");
      if (!bg && !bord) continue;
      let w = parseFloat(p.width), h = parseFloat(p.height), x, y;
      if (p.position === "absolute" || p.position === "fixed") {
        const host = p.position === "fixed" ? null : (style(el).position !== "static" ? el : el.offsetParent || document.body);
        let cb = { left: 0, top: 0, right: vw, bottom: vh };
        if (host) {
          const hr = host.getBoundingClientRect(), hs = style(host);
          cb = { left: hr.left + parseFloat(hs.borderLeftWidth), top: hr.top + parseFloat(hs.borderTopWidth), right: hr.right - parseFloat(hs.borderRightWidth), bottom: hr.bottom - parseFloat(hs.borderBottomWidth) };
        }
        const L = parseFloat(p.left), T = parseFloat(p.top), R = parseFloat(p.right), B = parseFloat(p.bottom);
        if (isNaN(w) && !isNaN(L) && !isNaN(R)) w = cb.right - cb.left - L - R;
        if (isNaN(h) && !isNaN(T) && !isNaN(B)) h = cb.bottom - cb.top - T - B;
        x = !isNaN(L) ? cb.left + L : (!isNaN(R) && !isNaN(w) ? cb.right - R - w : NaN);
        y = !isNaN(T) ? cb.top + T : (!isNaN(B) && !isNaN(h) ? cb.bottom - B - h : NaN);
        if (isNaN(x)) x = r.left; if (isNaN(y)) y = r.top;
        if (isNaN(w)) w = r.width; if (isNaN(h)) h = r.height;
      } else {
        if (isNaN(w)) w = r.width;
        if (isNaN(h)) h = parseFloat(p.lineHeight) || 0;
        x = r.left; y = ps === "::before" ? r.top : r.bottom - h;
      }
      if (w <= 0 || h <= 0) continue;
      decor.push({ el, what: ps, x, y, w, h, from: "pseudo", repeating: /repeating-/.test(p.backgroundImage) });
    }
    if (/repeating-(linear|radial)-gradient/.test(s.backgroundImage)) decor.push({ el, what: "bg-repeating-gradient", x: r.left, y: r.top, w: r.width, h: r.height, from: "bg", repeating: true });
  }
  const seenDecor = new Set();
  for (const d of decor) {
    const horizThin = d.h <= 6 && d.w >= 8, vertThin = d.w <= 6 && d.h >= 8;
    if (d.onTop === undefined) d.onTop = onTop(d.el, d.el.getBoundingClientRect());
    if (!d.onTop) continue;
    for (const { el, vis: tb } of textLeaves) {
      if (el === d.el && d.from === "border") continue;
      const ox = Math.min(d.x + d.w, tb.right) - Math.max(d.x, tb.left);
      const oy = Math.min(d.y + d.h, tb.bottom) - Math.max(d.y, tb.top);
      if (ox <= TOL || oy <= 0) continue;
      let crosses = false, why = "";
      if (horizThin) {
        const mid = d.y + d.h / 2;
        crosses = mid > tb.top + tb.height * 0.2 && mid < tb.bottom - tb.height * 0.2 && ox >= Math.min(8, tb.width * 0.5);
        why = `horizontal ${d.h.toFixed(1)}px line at y=${mid.toFixed(0)} through text line box ${tb.top.toFixed(0)}-${tb.bottom.toFixed(0)}`;
      } else if (vertThin) {
        const mid = d.x + d.w / 2;
        crosses = mid > tb.left + tb.width * 0.05 && mid < tb.right - tb.width * 0.05 && oy >= Math.min(6, tb.height * 0.5);
        why = `vertical ${d.w.toFixed(1)}px line at x=${mid.toFixed(0)} through text`;
      } else if (d.repeating && d.from !== "border") {
        crosses = ox > 4 && oy > 4;
        why = `repeating-gradient scanline covers text ${ox.toFixed(0)}x${oy.toFixed(0)}`;
      }
      if (!crosses) continue;
      const cx = Math.min(vw - 1, Math.max(0, Math.max(d.x, tb.left) + ox / 2)), cy = Math.min(vh - 1, Math.max(0, Math.max(d.y, tb.top) + oy / 2));
      const topAt = document.elementFromPoint(cx, cy);
      if (!topAt || (!el.contains(topAt) && !topAt.contains(el))) continue; // text not visible at the crossing (covered by an opaque layer)
      const key = cssPath(d.el) + d.what + "|" + cssPath(el);
      if (seenDecor.has(key)) continue;
      seenDecor.add(key);
      add("decor-line", "art", el, d.el, `${d.what} of ${cssPath(d.el)}: ${why}`, { x: Math.max(d.x, tb.left), y: Math.max(d.y, tb.top), w: Math.max(ox, 2), h: Math.max(oy, 2) });
    }
  }

  // Text samples for the node side (pixel contrast + background steps through the text line).
  const texts = [];
  for (const { el, vis: tb } of textLeaves) {
    const s = style(el);
    if (el.disabled || el.closest("[disabled],[aria-disabled=true]")) continue;
    if (tb.width < 4 || tb.height < 4) continue;
    const top = document.elementFromPoint(Math.min(vw - 1, Math.max(0, tb.left + tb.width / 2)), Math.min(vh - 1, Math.max(0, tb.top + tb.height / 2)));
    if (!top || (!el.contains(top) && !top.contains(el))) continue; // covered by another layer (modal, sprite): not readable text there anyway
    let opa = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) opa *= parseFloat(style(n).opacity);
    const fill = s.webkitTextFillColor && !/^currentcolor$/i.test(s.webkitTextFillColor) ? s.webkitTextFillColor : s.color;
    texts.push({ sel: cssPath(el), classes: [...el.classList], tag: el.tagName.toLowerCase(), text: tb.text.slice(0, 50), color: fill, opacity: opa,
      box: { x: tb.left, y: tb.top, w: tb.width, h: tb.height } });
  }
  return { hits, texts, counts: { els: els.length, cands: cands.length, texts: texts.length, decor: decor.length } };
})
