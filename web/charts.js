/* Tiny dependency-free SVG charts: line/band, columns, sparkline, network map. */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  let tipEl;
  const tip = (html, ev) => {
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; document.body.appendChild(tipEl); }
    if (!html) { tipEl.style.display = "none"; return; }
    tipEl.innerHTML = html; tipEl.style.display = "block";
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    let x = ev.clientX + 14, y = ev.clientY - h - 10;
    if (x + w > innerWidth - 8) x = ev.clientX - w - 14;
    if (y < 8) y = ev.clientY + 16;
    tipEl.style.left = x + "px"; tipEl.style.top = y + "px";
  };
  const niceMax = (v) => {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  };
  const compact = (v) => {
    const a = Math.abs(v);
    if (a >= 1e7) return (v / 1e7).toFixed(1).replace(/\.0$/, "") + " Cr";
    if (a >= 1e5) return (v / 1e5).toFixed(1).replace(/\.0$/, "") + " L";
    if (a >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return Math.round(v * 10) / 10 + "";
  };
  const shortDate = (s) => {
    const d = new Date(s + "T00:00:00");
    return isNaN(d) ? s : d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  };

  /** line chart with optional uncertainty bands, markers and a "today" divider */
  function line(container, o) {
    container.innerHTML = "";
    const W = Math.max(container.clientWidth || 600, 280), H = o.height || 240;
    const m = { t: 12, r: 14, b: 26, l: 44 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": o.label || "chart" }, container);
    const n = o.labels.length;
    const all = [];
    (o.series || []).forEach((s) => s.values.forEach((v) => v != null && all.push(v)));
    (o.bands || []).forEach((b) => b.hi.forEach((v) => v != null && all.push(v)));
    const yMax = niceMax(Math.max(...all, o.yMinMax || 0) * 1.05);
    const x = (i) => m.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - m.l - m.r));
    const y = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);
    for (let k = 0; k <= 4; k++) {
      const v = (yMax / 4) * k;
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid-line" }, svg);
      el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = (o.yFmt || compact)(v);
    }
    const step = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - 80) / 70))));
    o.labels.forEach((lb, i) => {
      if ((i % step && i !== n - 1) || (i !== n - 1 && n - 1 - i < step * 0.6)) return;
      el("text", { x: x(i), y: H - 8, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, svg).textContent = o.xFmt ? o.xFmt(lb) : shortDate(lb);
    });
    if (o.divider != null) {
      const dx = x(o.divider);
      el("rect", { x: dx, y: m.t, width: W - m.r - dx, height: H - m.t - m.b, fill: "#f1f5fb" }, svg);
      el("line", { x1: dx, x2: dx, y1: m.t, y2: H - m.b, stroke: "#9fb0c6", "stroke-dasharray": "3 3" }, svg);
      el("text", { x: dx + 6, y: m.t + 12, "font-weight": 600 }, svg).textContent = o.dividerLabel || "Forecast";
    }
    (o.bands || []).forEach((b) => {
      let d = "", started = false; const pts = [];
      b.hi.forEach((v, i) => { if (v != null && b.lo[i] != null) pts.push(i); });
      if (!pts.length) return;
      pts.forEach((i, k) => { d += (k ? "L" : "M") + x(i) + "," + y(b.hi[i]); });
      [...pts].reverse().forEach((i) => { d += "L" + x(i) + "," + y(b.lo[i]); });
      el("path", { d: d + "Z", fill: b.color, opacity: b.opacity || 0.18 }, svg);
    });
    (o.series || []).forEach((s) => {
      let d = "", pen = false;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1); pen = true;
      });
      if (s.area) {
        const idx = s.values.map((v, i) => (v != null ? i : null)).filter((i) => i != null);
        if (idx.length) el("path", { d: d + `L${x(idx[idx.length - 1])},${y(0)}L${x(idx[0])},${y(0)}Z`, fill: s.color, opacity: 0.08 }, svg);
      }
      el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2.2, "stroke-dasharray": s.dash ? "5 4" : null, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      if (s.markers) s.markers.forEach((on, i) => { if (on && s.values[i] != null) el("circle", { cx: x(i), cy: y(s.values[i]), r: 3.6, fill: "#fff", stroke: "#d92d20", "stroke-width": 2 }, svg); });
    });
    const hover = el("line", { y1: m.t, y2: H - m.b, stroke: "#94a3b8", opacity: 0 }, svg);
    const ov = el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" }, svg);
    ov.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / (W - m.l - m.r)) * (n - 1))));
      hover.setAttribute("x1", x(i)); hover.setAttribute("x2", x(i)); hover.setAttribute("opacity", 1);
      let h = `<b>${o.xFmt ? o.xFmt(o.labels[i]) : "Week of " + shortDate(o.labels[i])}</b>`;
      (o.series || []).forEach((s) => { if (s.values[i] != null) h += `<br><span style="color:${s.color}">●</span> ${s.name}: <b>${(o.tipFmt || compact)(s.values[i])}</b>`; });
      (o.bands || []).forEach((b) => { if (b.hi[i] != null) h += `<br><span class="k">${b.name}: ${(o.tipFmt || compact)(b.lo[i])} – ${(o.tipFmt || compact)(b.hi[i])}</span>`; });
      if (o.extraTip) h += o.extraTip(i);
      tip(h, ev);
    });
    ov.addEventListener("mouseleave", () => { hover.setAttribute("opacity", 0); tip(null); });
  }

  /** vertical columns (single or grouped) */
  function columns(container, o) {
    container.innerHTML = "";
    const W = Math.max(container.clientWidth || 500, 260), H = o.height || 200, m = { t: 10, r: 8, b: 26, l: 44 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart" }, container);
    const groups = o.series.length, n = o.labels.length;
    const yMax = o.yMax || niceMax(Math.max(...o.series.flatMap((s) => s.values), 0.0001) * 1.08);
    const bw = (W - m.l - m.r) / n, y = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);
    for (let k = 0; k <= 4; k++) {
      const v = (yMax / 4) * k;
      el("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: "grid-line" }, svg);
      el("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end" }, svg).textContent = (o.yFmt || compact)(v);
    }
    const step = Math.max(1, Math.ceil(n / Math.floor((W - 60) / 46)));
    o.labels.forEach((lb, i) => {
      if (i % step === 0) el("text", { x: m.l + bw * i + bw / 2, y: H - 8, "text-anchor": "middle" }, svg).textContent = o.xFmt ? o.xFmt(lb) : lb;
      o.series.forEach((s, g) => {
        const inner = (bw * 0.72) / groups, x0 = m.l + bw * i + bw * 0.14 + inner * g, v = s.values[i] || 0;
        const r = el("rect", { x: x0, y: y(v), width: Math.max(inner - 1.5, 1), height: Math.max(H - m.b - y(v), 0), rx: 2.5, fill: s.color }, svg);
        r.addEventListener("mousemove", (ev) => tip(`<b>${o.xFmt ? o.xFmt(lb) : lb}</b><br>${s.name}: <b>${(o.tipFmt || compact)(v)}</b>`, ev));
        r.addEventListener("mouseleave", () => tip(null));
      });
    });
  }

  function spark(values, color = "#1f6feb", w = 96, h = 26) {
    const v = values.map((x) => x || 0), mx = Math.max(...v, 1), n = v.length;
    const pts = v.map((x, i) => `${((i / Math.max(n - 1, 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - (x / mx) * (h - 4)).toFixed(1)}`).join(" ");
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }

  function hull(points) {
    const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  /** network map: state regions (padded hulls of district points) + location bubbles */
  function map(container, pts, o = {}) {
    container.innerHTML = "";
    const W = Math.max(container.clientWidth || 520, 300), H = o.height || 380;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart" }, container);
    const lon0 = 88.2, lon1 = 96.6, lat0 = 22.6, lat1 = 28.4;
    const sc = Math.min((W - 30) / (lon1 - lon0), (H - 30) / ((lat1 - lat0) * 1.08));
    const ox = (W - sc * (lon1 - lon0)) / 2, oy = (H - sc * (lat1 - lat0) * 1.08) / 2;
    const X = (lon) => ox + (lon - lon0) * sc, Y = (lat) => oy + (lat1 - lat) * sc * 1.08;
    const byState = {}, labels = [];
    pts.forEach((p) => (byState[p.state] = byState[p.state] || []).push([X(p.lon), Y(p.lat)]));
    Object.entries(byState).forEach(([st, ps]) => {
      const cx = ps.reduce((a, b) => a + b[0], 0) / ps.length, cy = ps.reduce((a, b) => a + b[1], 0) / ps.length;
      const pad = 18, ring = [];
      ps.forEach(([px, py]) => { for (let a = 0; a < 12; a++) ring.push([px + pad * Math.cos((a * Math.PI) / 6), py + pad * Math.sin((a * Math.PI) / 6)]); });
      const h = hull(ring);
      el("path", { d: "M" + h.map((q) => q.join(",")).join("L") + "Z", class: "state" }, svg);
      labels.push([cx, cy - pad - 6 < 10 ? cy + pad + 14 : cy - pad - 6, st === "Arunachal Pradesh" ? "Arunachal" : st]);
    });
    const vmax = Math.max(...pts.map((p) => p.value || 0), 1);
    [...pts].sort((a, b) => (b.value || 0) - (a.value || 0)).forEach((p) => {
      const r = 4 + Math.sqrt((p.value || 0) / vmax) * 12;
      const color = p.urgent > 6 ? "#d92d20" : p.urgent > 2 ? "#e0882b" : "#0f9d8a";
      const c = el("circle", { cx: X(p.lon), cy: Y(p.lat), r, fill: color, "fill-opacity": 0.78, stroke: "#fff", "stroke-width": 1.5, class: "pt" }, svg);
      c.addEventListener("mousemove", (ev) => tip(`<b>${p.name}</b><br><span class="k">${p.district}, ${p.state}${p.hill ? " · hill route" : ""}</span><br>Sales (4 wks): <b>${o.money ? o.money(p.value) : compact(p.value)}</b><br>Urgent actions: <b>${p.urgent}</b>`, ev));
      c.addEventListener("mouseleave", () => tip(null));
      if (o.onClick) c.addEventListener("click", () => { tip(null); o.onClick(p); });
    });
    labels.forEach(([lx, ly, t]) => { el("text", { x: lx, y: ly, "text-anchor": "middle", class: "state-label", stroke: "#fff", "stroke-width": 3, "paint-order": "stroke" }, svg).textContent = t; });
  }

  window.Charts = { line, columns, spark, map, compact, shortDate, tip };
})();
