/* NE Pharma Supply Planner - single-page app (vanilla JS, no build step). */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = { uid: localStorage.getItem("nepd.user") || "U2", state: localStorage.getItem("nepd.state") || "", lists: {}, offline: false };

  // ------------------------------------------------------------------ formatting
  const nf = new Intl.NumberFormat("en-IN");
  const num = (v, d = 0) => (v == null || isNaN(v) ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d }));
  const inr = (v) => {
    if (v == null || isNaN(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e7) return "₹" + (v / 1e7).toFixed(2) + " Cr";
    if (a >= 1e5) return "₹" + (v / 1e5).toFixed(2) + " L";
    return "₹" + nf.format(Math.round(v));
  };
  const pct = (v, d = 1) => (v == null || isNaN(v) ? "—" : (v * 100).toFixed(d) + "%");
  const dt = (s) => (s ? new Date(s.slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const dts = (s) => (s ? new Date(s.slice(0, 10) + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—");
  const initials = (n) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const delta = (cur, prev, goodUp = true) => {
    if (!prev || cur == null) return "";
    const d = (cur - prev) / prev;
    const cls = Math.abs(d) < 0.005 ? "flat" : (d > 0) === goodUp ? "up" : "down";
    return `<span class="delta ${cls}">${d > 0 ? "▲" : d < 0 ? "▼" : "•"} ${Math.abs(d * 100).toFixed(1)}%</span>`;
  };
  const PR = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };
  const STATUS = { open: "Open", awaiting_approval: "Awaiting approval", approved: "Approved", modified: "Approved (changed)", rejected: "Rejected", postponed: "Postponed", dispatched: "Dispatched", in_transit: "In transit", delayed: "Delayed", received: "Received" };
  const pill = (cls, text) => `<span class="pill ${esc(cls)}">${esc(text ?? cls)}</span>`;
  const KIND = { stockout: ["Out of stock", "red", "⛔"], stockout_risk: ["Stock-out risk", "amber", "⚠"], expiry: ["Expiry risk", "violet", "⏳"], overstock: ["Overstock", "blue", "▣"], delay: ["Delivery delay", "amber", "🚚"], demand_spike: ["Demand change", "blue", "↗"] };
  const can = (action) => {
    const r = S.user?.role;
    if (S.offline) return false;
    if (action === "decide") return r !== "viewer";
    if (action === "settings") return r === "head";
    return r !== "viewer";
  };

  // ------------------------------------------------------------------ API with offline cache
  async function api(path, opts = {}) {
    const init = { ...opts, headers: { "X-User": S.uid, ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) } };
    if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string") init.body = JSON.stringify(opts.body);
    const key = "nepd.cache." + S.uid + "." + path;
    try {
      const res = await fetch(path, init);
      setOffline(false);
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).detail || msg; } catch (_) {}
        throw Object.assign(new Error(msg), { status: res.status });
      }
      const data = await res.json();
      if (!opts.method || opts.method === "GET") { try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), data })); } catch (_) {} }
      return data;
    } catch (e) {
      if (e.status) throw e;
      const cached = localStorage.getItem(key);
      setOffline(true);
      if ((!opts.method || opts.method === "GET") && cached) return JSON.parse(cached).data;
      throw new Error("You are offline and this page has not been saved on this device yet.");
    }
  }
  function setOffline(v) {
    if (S.offline === v) return;
    S.offline = v;
    $("#offline").classList.toggle("hidden", !v);
  }
  const q = (params) => {
    const p = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
    return p.length ? "?" + p.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&") : "";
  };

  // ------------------------------------------------------------------ UI primitives
  function toast(msg, kind = "ok") {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.textContent = msg;
    $("#toasts").appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }
  function openDrawer(html) {
    const d = $("#drawer");
    d.innerHTML = html;
    d.classList.add("open");
    $("#drawerBackdrop").classList.remove("hidden");
    $(".close-x", d)?.addEventListener("click", closeDrawer);
    return d;
  }
  function closeDrawer() {
    $("#drawer").classList.remove("open");
    $("#drawerBackdrop").classList.add("hidden");
    Charts.tip(null);
  }
  function modal({ title, body, ok = "Confirm", okClass = "primary", onOk }) {
    const m = $("#modal");
    m.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${esc(title)}</h3><div class="mb">${body}</div>
      <div class="mf"><button class="btn" data-x>Cancel</button><button class="btn ${okClass}" data-ok>${esc(ok)}</button></div></div>`;
    m.classList.remove("hidden");
    const close = () => m.classList.add("hidden");
    $("[data-x]", m).onclick = close;
    m.onclick = (e) => { if (e.target === m) close(); };
    $("[data-ok]", m).onclick = async () => { if ((await onOk(m)) !== false) close(); };
    setTimeout(() => $("input,textarea,select", m)?.focus(), 30);
  }
  const card = (title, body, { sub = "", tools = "", cls = "", flush = false } = {}) =>
    `<section class="card ${cls}"><div class="card-h"><h3>${title}</h3><span class="spacer"></span>${tools}${sub ? `<p>${sub}</p>` : ""}</div><div class="card-b ${flush ? "flush" : ""}">${body}</div></section>`;
  const kpi = (label, value, sub = "", { dot, onclick } = {}) =>
    `<div class="card kpi ${onclick ? "clickable" : ""}" ${onclick ? `data-go="${onclick}"` : ""}><div class="lbl">${dot ? `<span class="dot" style="background:${dot}"></span>` : ""}${label}</div><div class="val">${value}</div><div class="sub">${sub}</div></div>`;
  const legend = (items) => `<div class="legend">${items.map(([c, t, k = ""]) => `<span><i class="${k}" style="background:${c};color:${c}"></i>${t}</span>`).join("")}</div>`;
  const coverBar = (days, lead) => {
    const max = Math.max(lead * 3, 21), w = Math.min(days / max, 1) * 70, color = days < lead ? "#d92d20" : days < lead + 7 ? "#e0882b" : "#0f9d8a";
    return `<span class="cover"><i style="width:${Math.max(w, 2)}px;background:${color}"></i><span class="num">${days < 0.5 ? '<b style="color:var(--red)">Out</b>' : num(days) + " days"}</span></span>`;
  };

  /** sortable, paginated table */
  function table(container, o) {
    const st = { sort: o.sort || null, dir: o.dir || -1, page: 0, size: o.pageSize || 25 };
    const sel = o.selected || null;
    function draw() {
      let rows = [...o.rows];
      if (st.sort) {
        const col = o.columns.find((c) => c.k === st.sort);
        const val = col?.val || ((r) => r[st.sort]);
        rows.sort((a, b) => { const x = val(a), y = val(b); return (x == null) - (y == null) || (x > y ? 1 : x < y ? -1 : 0) * st.dir; });
      }
      const pages = Math.max(1, Math.ceil(rows.length / st.size));
      st.page = Math.min(st.page, pages - 1);
      const view = rows.slice(st.page * st.size, (st.page + 1) * st.size);
      const head = (sel ? `<th style="width:34px"><input type="checkbox" data-all aria-label="Select all"></th>` : "") +
        o.columns.map((c) => `<th class="${c.r ? "r" : ""} ${c.sort === false ? "" : "sortable"}" data-k="${c.k}">${c.label}${st.sort === c.k ? `<span class="arr">${st.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("");
      const body = view.length ? view.map((r) => `<tr class="${o.onRow ? "click" : ""} ${sel?.has(r[o.key]) ? "sel" : ""}" data-id="${esc(r[o.key])}">` +
        (sel ? `<td><input type="checkbox" data-sel ${sel.has(r[o.key]) ? "checked" : ""} aria-label="Select row"></td>` : "") +
        o.columns.map((c) => `<td class="${c.r ? "r num" : ""}">${c.render ? c.render(r) : esc(r[c.k])}</td>`).join("") + "</tr>").join("")
        : `<tr><td colspan="${o.columns.length + (sel ? 1 : 0)}"><div class="empty">${o.empty || "Nothing to show."}</div></td></tr>`;
      container.innerHTML = `<div class="tbl-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
        (rows.length > st.size ? `<div class="pager"><span>${st.page * st.size + 1}–${Math.min((st.page + 1) * st.size, rows.length)} of ${nf.format(rows.length)}</span>
          <button class="btn sm" data-p="-1" ${st.page === 0 ? "disabled" : ""}>‹ Prev</button><button class="btn sm" data-p="1" ${st.page >= pages - 1 ? "disabled" : ""}>Next ›</button></div>` : "");
      $$("th.sortable", container).forEach((th) => th.onclick = () => { const k = th.dataset.k; st.dir = st.sort === k ? -st.dir : -1; st.sort = k; draw(); });
      $$("[data-p]", container).forEach((b) => b.onclick = () => { st.page += +b.dataset.p; draw(); });
      if (o.onRow) $$("tbody tr[data-id]", container).forEach((tr) => tr.addEventListener("click", (e) => {
        if (e.target.closest("input,button,a,select")) return;
        o.onRow(o.rows.find((r) => String(r[o.key]) === tr.dataset.id));
      }));
      if (sel) {
        $$("[data-sel]", container).forEach((cb) => cb.onchange = () => { const id = cb.closest("tr").dataset.id; cb.checked ? sel.add(id) : sel.delete(id); cb.closest("tr").classList.toggle("sel", cb.checked); o.onSelect?.(); });
        const all = $("[data-all]", container);
        if (all) all.onchange = () => { view.forEach((r) => all.checked ? sel.add(String(r[o.key])) : sel.delete(String(r[o.key]))); draw(); o.onSelect?.(); };
      }
      o.actions?.(container);
    }
    draw();
    return { redraw: draw, set rows(r) { o.rows = r; st.page = 0; draw(); } };
  }

  // ------------------------------------------------------------------ navigation
  const NAV = [
    ["Plan", [["overview", "▦", "Overview"], ["plan", "✓", "Replenishment plan", "recs"], ["forecast", "∿", "Demand forecast"], ["whatif", "⇄", "What-if planner"]]],
    ["Stock", [["inventory", "▤", "Inventory"], ["expiry", "⏳", "Batches & expiry"], ["orders", "🚚", "Orders & transfers"], ["alerts", "🔔", "Alerts", "alerts"]]],
    ["Network", [["network", "⌖", "Locations"], ["medicines", "✚", "Medicines"]]],
    ["Results", [["impact", "◎", "Impact & pilot"], ["data", "⇪", "Data import"], ["admin", "⚙", "Users & settings"]]],
  ];
  const ROUTES = {};
  function renderNav() {
    const c = S.counts || {};
    $("#nav").innerHTML = NAV.map(([cap, items]) => `<div class="cap">${cap}</div>` + items.map(([id, ico, label, badge]) =>
      `<a href="#/${id}" data-nav="${id}"><span class="ico">${ico}</span>${label}${badge && c[badge] ? `<span class="badge ${badge === "alerts" ? "soft" : ""}">${c[badge] > 999 ? "999+" : c[badge]}</span>` : ""}</a>`).join("")).join("");
  }
  async function route() {
    const [path, qs] = (location.hash.slice(2) || "overview").split("?");
    const params = Object.fromEntries(new URLSearchParams(qs || ""));
    const r = ROUTES[path] || ROUTES.overview;
    $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === (ROUTES[path] ? path : "overview")));
    $("#pageTitle").textContent = r.title;
    $("#pageSub").textContent = typeof r.sub === "function" ? r.sub() : r.sub || "";
    document.title = r.title + " · NE Pharma Supply Planner";
    const v = $("#view");
    v.innerHTML = `<div class="grid g4">${'<div class="skeleton"></div>'.repeat(4)}</div><div class="skeleton" style="height:320px;margin-top:16px"></div>`;
    closeDrawer();
    $("#sidebar").classList.remove("open"); $("#backdrop").classList.remove("on");
    try { await r.render(v, params); } catch (e) { console.error(e); v.innerHTML = `<div class="card"><div class="empty"><b>Could not load this page.</b><br>${esc(e.message)}</div></div>`; }
    v.focus({ preventScroll: true });
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]");
    if (go) location.hash = "#/" + go.dataset.go;
  });

  // ------------------------------------------------------------------ session
  async function loadSession() {
    const s = await api("/api/session");
    Object.assign(S, { user: s.user, users: s.users, meta: s.meta, states: s.states, counts: s.counts });
    if (S.state && !s.states.includes(S.state)) S.state = "";
    $("#stateFilter").innerHTML = `<option value="">${s.user.states ? "All my states" : "All states"}</option>` + s.states.map((x) => `<option ${x === S.state ? "selected" : ""}>${esc(x)}</option>`).join("");
    $("#freshness").textContent = "Data to " + dt(s.meta.as_of_date);
    $("#userChip").innerHTML = `<span class="avatar">${initials(s.user.name)}</span><span class="who"><b>${esc(s.user.name)}</b><small>${esc(s.user.title)}</small></span>`;
    $("#userMenu").innerHTML = `<div class="cap">Switch demo user (role-based access)</div>` + s.users.map((u) =>
      `<button data-uid="${u.user_id}" class="${u.user_id === S.uid ? "on" : ""}"><span class="avatar">${initials(u.name)}</span><span><b>${esc(u.name)}</b><small>${esc(u.title)}${u.scope !== "ALL" ? " · " + esc(u.scope.split(",").length) + " states" : ""}</small></span></button>`).join("");
    renderNav();
  }
  async function refreshCounts() {
    try { const s = await api("/api/session"); S.counts = s.counts; renderNav(); $$("#nav a").forEach((a) => a.classList.toggle("active", location.hash.includes(a.dataset.nav))); } catch (_) {}
  }
  $("#userChip").onclick = (e) => { e.stopPropagation(); $("#userMenu").classList.toggle("hidden"); };
  $("#userMenu").onclick = async (e) => {
    const b = e.target.closest("[data-uid]");
    if (!b) return;
    S.uid = b.dataset.uid; localStorage.setItem("nepd.user", S.uid);
    $("#userMenu").classList.add("hidden");
    S.lists = {};
    await loadSession();
    toast("Signed in as " + S.user.name + " - " + S.user.title);
    route();
  };
  document.addEventListener("click", (e) => { if (!e.target.closest("#userMenu,#userChip")) $("#userMenu").classList.add("hidden"); if (!e.target.closest(".search,#searchResults")) $("#searchResults").classList.add("hidden"); });
  $("#stateFilter").onchange = (e) => { S.state = e.target.value; localStorage.setItem("nepd.state", S.state); route(); };
  $("#menuBtn").onclick = () => { $("#sidebar").classList.add("open"); $("#backdrop").classList.add("on"); };
  $("#backdrop").onclick = () => { $("#sidebar").classList.remove("open"); $("#backdrop").classList.remove("on"); };
  $("#drawerBackdrop").onclick = closeDrawer;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeDrawer(); $("#modal").classList.add("hidden"); }
    if (e.key === "/" && !e.target.closest("input,textarea,select")) { e.preventDefault(); $("#search").focus(); }
  });

  // global search
  async function lists() {
    if (!S.lists.meds) {
      const [m, l] = await Promise.all([api("/api/medicines"), api("/api/locations")]);
      S.lists = { meds: m, locs: l };
    }
    return S.lists;
  }
  $("#search").addEventListener("input", async (e) => {
    const t = e.target.value.trim().toLowerCase(), box = $("#searchResults");
    if (t.length < 2) { box.classList.add("hidden"); return; }
    const { meds, locs } = await lists();
    const hits = [...meds.filter((m) => (m.name + m.category).toLowerCase().includes(t)).slice(0, 6).map((m) => ({ t: "med", id: m.sku_id, name: m.name, sub: m.category })),
      ...locs.filter((l) => (l.name + l.state + l.district).toLowerCase().includes(t)).slice(0, 6).map((l) => ({ t: "loc", id: l.location_id, name: l.name, sub: l.state }))];
    box.innerHTML = hits.length ? hits.map((h) => `<button data-t="${h.t}" data-id="${h.id}"><span>${h.t === "med" ? "✚" : "⌖"}</span><span>${esc(h.name)}</span><small>${esc(h.sub)}</small></button>`).join("") : `<div class="empty" style="padding:14px">No matches</div>`;
    box.classList.remove("hidden");
    $$("button", box).forEach((b) => b.onclick = () => { box.classList.add("hidden"); e.target.value = ""; b.dataset.t === "med" ? medicineDrawer(b.dataset.id) : locationDrawer(b.dataset.id); });
  });

  // ================================================================== OVERVIEW
  ROUTES.overview = {
    title: "Overview", sub: () => `Network status for the week starting ${dt(S.meta?.next_week)}`,
    async render(v) {
      const d = await api("/api/overview" + q({ state: S.state }));
      const k = d.kpi, r = d.recs, imp = Object.fromEntries(d.impact.map((x) => [x.metric, x]));
      v.innerHTML = `
      <div class="stack">
        <div class="hero">
          <div><h2>This week's replenishment plan is ready</h2>
            <p>${num(r.urgent)} medicine–location pairs will run out before a normal delivery can arrive, and ${num(r.high)} more need ordering this week. Every suggestion comes with a plain-language reason and needs a person to approve it.</p></div>
          <div class="hero-stats"><div><b>${num(r.urgent)}</b><small>Urgent</small></div><div><b>${num(r.open)}</b><small>Open suggestions</small></div><div><b>${num(r.awaiting)}</b><small>Awaiting approval</small></div></div>
          <button class="btn" data-go="plan">Review plan →</button>
        </div>
        <div class="grid g6">
          ${kpi("Sales value · last 4 weeks", inr(k.sales4), `${delta(k.sales4, k.sales4_prev)} vs previous 4 weeks`, { dot: "#1f6feb", onclick: "medicines" })}
          ${kpi("Stock value on hand", inr(d.inventory.stock_value), `${num(d.inventory.units)} units across the network`, { dot: "#0f9d8a", onclick: "inventory" })}
          ${kpi("Stock-out rate · 4 weeks", pct(k.stockout4), `${delta(k.stockout4, k.stockout4_prev, false)} share of medicine–location weeks`, { dot: "#d92d20", onclick: "inventory?status=out" })}
          ${kpi("Order fill rate · 4 weeks", pct(k.fill4), "Units supplied ÷ units requested", { dot: "#8a63d2" })}
          ${kpi("Expiring within 180 days", inr(d.inventory.exp180), "Value of batches to sell or move first", { dot: "#e0882b", onclick: "expiry" })}
          ${kpi("Suggested orders value", inr(r.value), `${num(r.open)} open suggestions`, { dot: "#13315c", onclick: "plan" })}
        </div>
        <div class="grid g-main">
          ${card("Network demand: last 26 weeks and next 8 weeks", `<div id="ovTrend"></div><div style="margin-top:8px">${legend([["#1f6feb", "Units sold"], ["#0f9d8a", "Forecast (most likely)", "dash"], ["#0f9d8a", "Likely range (80%)", "band"]])}</div>`, { sub: "Forecast from the demand model, summed over all medicines and locations in view." })}
          ${card("Challenge targets (NESFIC-I-09)", scorecard(d.impact), { sub: "Year-long simulation: today's manual ordering vs this planner on the same demand.", tools: `<button class="btn sm" data-go="impact">Details</button>` })}
        </div>
        <div class="grid g3">
          ${card("Distribution network", `<div class="map-wrap" id="ovMap"></div><div style="margin-top:6px">${legend([["#0f9d8a", "On track", "sq"], ["#e0882b", "3–6 urgent", "sq"], ["#d92d20", "7+ urgent", "sq"]])}</div>`, { sub: "Bubble size = sales in the last 4 weeks. Click a location for details." })}
          ${card("Most urgent actions", `<div class="list">${d.actions.map((a) => `<div class="li click" data-rec="${a.rec_id}"><div class="ic red">!</div><div class="body"><b>${esc(a.medicine)}</b><span>${esc(a.location)} · ${a.cover_days < 1 ? "out of stock" : "stock lasts " + num(a.cover_days) + " days"}, delivery ${num(a.lead_days)} days</span></div><div class="end"><b>${num(a.suggested_qty)}</b> units${a.transfer_qty ? `<br>+${num(a.transfer_qty)} transfer` : ""}</div></div>`).join("") || `<div class="empty">No urgent actions</div>`}</div>`, { flush: true, tools: `<button class="btn sm" data-go="plan">All</button>` })}
          ${card("Needs attention", `<div class="list">${d.alerts.map(alertLi).join("") || `<div class="empty">No open alerts</div>`}</div>`, { flush: true, tools: `<button class="btn sm" data-go="alerts">All alerts</button>` })}
        </div>
        <div class="grid g2">
          ${card("Sales by state · last 4 weeks", hbars(d.by_state.map((s) => [s.state, s.value, inr(s.value)]), "#1f6feb"))}
          ${card("Highest-demand medicines · last 4 weeks", hbars(d.top_medicines.map((m) => [m.name, m.units, num(m.units) + " units"]), "#0f9d8a"))}
        </div>
      </div>`;
      const labels = [...d.trend.map((t) => t.week_start), ...d.forecast.map((f) => f.week_start)];
      const nH = d.trend.length;
      Charts.line($("#ovTrend"), {
        labels, height: 380, divider: nH - 1, dividerLabel: "Forecast →",
        series: [{ name: "Units sold", values: [...d.trend.map((t) => t.units), ...d.forecast.map(() => null)], color: "#1f6feb", area: true },
          { name: "Forecast", values: [...d.trend.map((t, i) => (i === nH - 1 ? t.units : null)), ...d.forecast.map((f) => f.p50)], color: "#0f9d8a", dash: true }],
        bands: [{ name: "Likely range", lo: [...d.trend.map(() => null), ...d.forecast.map((f) => f.p10)], hi: [...d.trend.map(() => null), ...d.forecast.map((f) => f.p90)], color: "#0f9d8a" }],
      });
      Charts.map($("#ovMap"), d.points, { height: 330, money: inr, onClick: (p) => locationDrawer(p.location_id) });
      $$("[data-rec]", v).forEach((x) => x.onclick = () => recDrawer(x.dataset.rec));
      bindAlertLis(v);
    },
  };
  function hbars(items, color) {
    const mx = Math.max(...items.map((i) => i[1] || 0), 1);
    return items.map(([n, val, lbl]) => `<div class="hbar"><span class="name" title="${esc(n)}">${esc(n)}</span><div class="bar-track"><div class="bar-fill" style="width:${((val || 0) / mx) * 100}%;background:${color}"></div></div><span class="v">${lbl}</span></div>`).join("");
  }
  function scorecard(impact) {
    const show = ["forecast_error", "stockout", "excess", "expiry", "fill"];
    const goal = { forecast_error: -0.2, stockout: -0.2, excess: -0.15, expiry: -0.15, fill: 0.1 };
    return impact.filter((m) => show.includes(m.metric)).map((m) => {
      const isPP = m.metric === "fill";
      const ch = isPP ? m.planner - m.manual : (m.planner - m.manual) / m.manual;
      const g = goal[m.metric], prog = Math.min(Math.abs(ch) / (Math.abs(g) * 2), 1);
      const f = m.unit === "inr" ? inr : (x) => pct(x);
      const short = { forecast_error: "Forecast error", stockout: "Stock-outs", excess: "Excess inventory", expiry: "Expiry losses", fill: "Fill rate" }[m.metric];
      return `<div class="score"><div><div class="nm">${short} ${m.met ? pill("met", "Target met") : pill("notmet", "Below target")}</div><div class="tg">Target ${esc(m.target)}</div></div>
        <div class="chg" style="color:${m.met ? "var(--green)" : "var(--amber)"}">${isPP ? (ch >= 0 ? "+" : "") + (ch * 100).toFixed(1) + " pp" : (ch >= 0 ? "+" : "") + (ch * 100).toFixed(0) + "%"}</div>
        <div class="meter"><i style="width:${prog * 100}%;background:${m.met ? "#12b76a" : "#f79009"}"></i><b style="left:50%"></b></div>
        <div class="fromto">${f(m.manual)} today → ${f(m.planner)} with planner</div></div>`;
    }).join("");
  }
  function alertLi(a) {
    const [lbl, color, ico] = KIND[a.kind] || [a.kind, "blue", "•"];
    return `<div class="li click" data-alert-loc="${esc(a.location_id || "")}" data-alert-sku="${esc(a.sku_id || "")}" data-kind="${a.kind}"><div class="ic ${color}">${ico}</div><div class="body"><b>${lbl}</b><span>${esc(a.message)}</span></div></div>`;
  }
  function bindAlertLis(root) {
    $$("[data-alert-loc]", root).forEach((x) => x.onclick = () => {
      if (x.dataset.kind === "expiry") location.hash = "#/expiry";
      else if (x.dataset.alertSku && x.dataset.alertLoc) location.hash = `#/forecast?sku=${x.dataset.alertSku}&loc=${x.dataset.alertLoc}`;
      else if (x.dataset.alertLoc) locationDrawer(x.dataset.alertLoc);
    });
  }

  // ================================================================== REPLENISHMENT PLAN
  ROUTES.plan = {
    title: "Replenishment plan", sub: () => `Suggested orders and transfers for the week starting ${dt(S.meta?.next_week)} · approve, change, postpone or reject`,
    async render(v, p) {
      const st = { status: p.status || "open", priority: p.priority || "", q: "" };
      const sel = new Set();
      v.innerHTML = `<div class="stack">
        <div class="note info">The planner reviews every medicine at every location each week. It forecasts demand, allows for the delivery time on that route (with extra buffer on hill routes during the monsoon), adds safety stock based on how uncertain the forecast is, and avoids ordering more than can be sold before expiry. Where another location has spare stock of the same medicine, it suggests a transfer first. <b>Orders above ${inr(S.meta.approval_limit)} need the Head of Supply Chain's approval.</b></div>
        <section class="card"><div class="card-h" style="padding-bottom:12px">
          <div class="seg" id="segStatus">${[["open", "To review"], ["awaiting_approval", "Awaiting approval"], ["done", "Decided"]].map(([k, l]) => `<button data-s="${k}" class="${st.status === k ? "on" : ""}">${l}</button>`).join("")}</div>
          <div class="seg" id="segPr">${[["", "All"], ["urgent", "Urgent"], ["high", "High"], ["normal", "Normal"], ["low", "Low"]].map(([k, l]) => `<button data-p="${k}" class="${st.priority === k ? "on" : ""}">${l}<span class="n" data-n="${k}"></span></button>`).join("")}</div>
          <span class="spacer"></span>
          <input class="input" id="planQ" placeholder="Filter medicine or location" style="width:220px">
          <button class="btn" id="exportRecs">⇩ CSV</button>
          <button class="btn primary" id="bulkBtn" disabled>Approve selected</button>
        </div><div id="planTbl"></div></section></div>`;
      let all = [];
      const tbl = table($("#planTbl"), {
        rows: [], key: "rec_id", pageSize: 30, selected: can("decide") ? sel : null,
        onSelect: () => { $("#bulkBtn").disabled = !sel.size; $("#bulkBtn").textContent = sel.size ? `Approve ${sel.size} selected` : "Approve selected"; },
        onRow: (r) => recDrawer(r.rec_id, r, () => load()),
        columns: [
          { k: "priority", label: "Priority", val: (r) => ({ urgent: 0, high: 1, normal: 2, low: 3 }[r.priority]), render: (r) => pill(r.priority, PR[r.priority]) },
          { k: "medicine", label: "Medicine", render: (r) => `<div class="t1">${esc(r.medicine)}</div><div class="t2">${esc(r.category)}</div>` },
          { k: "location", label: "Location", render: (r) => `<div class="t1">${esc(r.location)}</div><div class="t2">${esc(r.state)}${r.hill ? ' · <span class="tag">hill route</span>' : ""}</div>` },
          { k: "on_hand", label: "On hand", r: true, render: (r) => num(r.on_hand) + (r.on_order ? `<div class="t2">+${num(r.on_order)} coming</div>` : "") },
          { k: "cover_days", label: "Stock lasts", render: (r) => coverBar(r.cover_days, r.lead_days) + `<div class="t2">delivery ${num(r.lead_days)} days</div>` },
          { k: "forecast_week", label: "Forecast / wk", r: true, render: (r) => num(r.forecast_week, r.forecast_week < 10 ? 1 : 0) + `<div class="t2">${num(r.forecast_low, r.forecast_low < 10 ? 1 : 0)}–${num(r.forecast_high, r.forecast_high < 10 ? 1 : 0)}</div>` },
          { k: "suggested_qty", label: "Order", r: true, render: (r) => `<b>${num(r.decided_qty ?? r.suggested_qty)}</b>` + (r.transfer_qty ? `<div class="t2">+${num(r.transfer_qty)} transfer</div>` : "") },
          { k: "value", label: "Value", r: true, render: (r) => inr(r.value) + (r.needs_approval ? `<div class="t2">needs approval</div>` : "") },
          { k: "status", label: "Status", render: (r) => pill(r.status, STATUS[r.status]) + (r.decided_by ? `<div class="t2">${esc(r.decided_by)}</div>` : "") },
        ],
        empty: "No suggestions in this view.",
      });
      async function load() {
        all = await api("/api/recommendations" + q({ state: S.state, status: st.status }));
        const counts = { "": all.length };
        all.forEach((r) => counts[r.priority] = (counts[r.priority] || 0) + 1);
        $$("[data-n]", v).forEach((s) => s.textContent = counts[s.dataset.n] || 0);
        sel.clear(); $("#bulkBtn").disabled = true; $("#bulkBtn").textContent = "Approve selected";
        apply();
        refreshCounts();
      }
      function apply() {
        const t = st.q.toLowerCase();
        tbl.rows = all.filter((r) => (!st.priority || r.priority === st.priority) && (!t || (r.medicine + " " + r.location).toLowerCase().includes(t)));
      }
      $("#segStatus").onclick = (e) => { const b = e.target.closest("[data-s]"); if (!b) return; st.status = b.dataset.s; $$("#segStatus button").forEach((x) => x.classList.toggle("on", x === b)); load(); };
      $("#segPr").onclick = (e) => { const b = e.target.closest("[data-p]"); if (!b) return; st.priority = b.dataset.p; $$("#segPr button").forEach((x) => x.classList.toggle("on", x === b)); apply(); };
      $("#planQ").oninput = (e) => { st.q = e.target.value; apply(); };
      $("#exportRecs").onclick = () => window.open(`/api/export/recommendations.csv${q({ x_user: S.uid, state: S.state })}`);
      $("#bulkBtn").onclick = () => {
        const ids = [...sel];
        const value = all.filter((r) => sel.has(r.rec_id)).reduce((a, r) => a + (r.value || 0), 0);
        modal({ title: `Approve ${ids.length} suggestions?`, ok: "Approve", body: `<p>This creates ${ids.length} dispatch orders worth about <b>${inr(value)}</b>. Items above ${inr(S.meta.approval_limit)} will be sent to the Head of Supply Chain instead.</p>`,
          onOk: async () => {
            const res = await api("/api/recommendations/bulk", { method: "POST", body: { ids, action: "approve" } });
            const vals = Object.values(res);
            toast(`${vals.filter((x) => x === "approved").length} approved · ${vals.filter((x) => x === "awaiting_approval").length} sent for approval · ${vals.filter((x) => String(x).startsWith("skipped")).length} skipped`);
            load();
          } });
      };
      if (!can("decide")) $("#bulkBtn").classList.add("hidden");
      await load();
    },
  };

  async function recDrawer(id, row, onDone) {
    if (!row) {
      const all = await api("/api/recommendations" + q({ status: "open" }));
      row = all.find((r) => r.rec_id === id);
      if (!row) { toast("This suggestion has already been decided", "warn"); return; }
    }
    const r = row, open = ["open", "awaiting_approval"].includes(r.status);
    const headApprove = r.status === "awaiting_approval";
    const d = openDrawer(`
      <div class="drawer-h"><div><div class="row">${pill(r.priority, PR[r.priority])} ${pill(r.status, STATUS[r.status])}</div><h2 style="margin-top:6px">${esc(r.medicine)}</h2><p>${esc(r.location)} · ${esc(r.district)}, ${esc(r.state)}${r.hill ? " · hill route" : ""}</p></div><button class="close-x" aria-label="Close">✕</button></div>
      <div class="drawer-b">
        <div class="facts">
          <div class="fact"><small>On hand</small><b>${num(r.on_hand)}</b></div>
          <div class="fact"><small>Already on the way</small><b>${num(r.on_order)}</b></div>
          <div class="fact"><small>Stock lasts</small><b style="color:${r.cover_days < r.lead_days ? "var(--red)" : "inherit"}">${num(r.cover_days)} days</b></div>
          <div class="fact"><small>Delivery time</small><b>${num(r.lead_days)} days</b></div>
          <div class="fact"><small>Forecast / week</small><b>${num(r.forecast_week, 1)}</b><small>range ${num(r.forecast_low, 1)}–${num(r.forecast_high, 1)}</small></div>
          <div class="fact"><small>Target stock</small><b>${num(r.target_stock)}</b></div>
        </div>
        <div><div class="muted" style="font-size:12px;font-weight:600;margin-bottom:6px">WHY THIS SUGGESTION</div><div class="reason">${esc(r.reason)}</div></div>
        <section class="card"><div class="card-h"><h3>Sales and forecast at this location</h3></div><div class="card-b"><div id="recChart"></div>${legend([["#1f6feb", "Units sold"], ["#d92d20", "Stock-out week", "sq"], ["#0f9d8a", "Forecast", "dash"], ["#0f9d8a", "Likely range", "band"]])}</div></section>
        ${open && can("decide") ? `<section class="card"><div class="card-b stack" style="gap:12px">
          <div class="form-grid">
            <div class="field"><label>Order quantity (units)</label><input class="input" id="qty" type="number" min="0" step="1" value="${r.decided_qty ?? r.suggested_qty}"><small class="muted">Pack size ${r.velocity === "slow" ? 10 : r.case_pack}. Value ${inr(r.cost * (r.decided_qty ?? r.suggested_qty))}</small></div>
            <div class="field"><label>Reason / note ${headApprove ? "" : "(needed if you change, postpone or reject)"}</label><input class="input" id="note" placeholder="e.g. Field team reports a new hospital tender"></div>
          </div>
          ${r.transfer_qty ? `<label class="check"><input type="checkbox" id="useTr" checked> Also transfer <b>&nbsp;${num(r.transfer_qty)}&nbsp;</b> units from ${esc(r.transfer_from_name)}</label>` : ""}
          ${r.needs_approval && S.user.role !== "head" && !headApprove ? `<div class="note warn">Value is above ${inr(S.meta.approval_limit)} - approving will send this to the Head of Supply Chain.</div>` : ""}
          ${headApprove ? `<div class="note warn">Submitted by ${esc(r.decided_by)}: ${esc(r.decision_note || "")}</div>` : ""}
        </div></section>` : r.decided_by ? `<div class="note">Decided by <b>${esc(r.decided_by)}</b> on ${esc((r.decided_at || "").replace("T", " "))}${r.decision_note ? ` - “${esc(r.decision_note)}”` : ""}</div>` : ""}
      </div>
      ${open && can("decide") ? `<div class="drawer-f"><button class="btn primary" data-a="approve">${headApprove ? "Approve order" : "Approve"}</button><button class="btn" data-a="modify">Approve with my quantity</button><button class="btn" data-a="postpone">Postpone</button><button class="btn danger" data-a="reject">Reject</button><span class="spacer"></span><a class="btn sm" href="#/whatif?sku=${r.sku_id}&loc=${r.location_id}&qty=${r.suggested_qty}">Test in what-if</a></div>` :
        `<div class="drawer-f"><a class="btn" href="#/forecast?sku=${r.sku_id}&loc=${r.location_id}">Open forecast</a><a class="btn" href="#/whatif?sku=${r.sku_id}&loc=${r.location_id}&qty=${r.suggested_qty}">Test in what-if</a></div>`}`);
    $$("[data-a]", d).forEach((b) => b.onclick = async () => {
      const action = b.dataset.a, qty = +$("#qty").value, note = $("#note").value.trim();
      try {
        const res = await api(`/api/recommendations/${r.rec_id}/decision`, { method: "POST", body: { action, qty: action === "modify" ? qty : undefined, note, use_transfer: $("#useTr") ? $("#useTr").checked : true } });
        toast({ approved: "Approved - dispatch order created", modified: "Approved with your quantity - order created", awaiting_approval: "Sent to the Head of Supply Chain for approval", postponed: "Postponed to next week's review", rejected: "Rejected - reason recorded" }[res.status] || res.status, res.status === "rejected" ? "warn" : "ok");
        closeDrawer();
        onDone ? onDone() : route();
      } catch (e) { toast(e.message, "err"); }
    });
    const f = await api(`/api/forecast?sku=${r.sku_id}&loc=${r.location_id}`);
    forecastChart($("#recChart"), f, 210, 20);
  }

  // ================================================================== FORECAST
  function forecastChart(el, f, height = 300, last = 52) {
    const h = f.history.slice(-last), fu = f.future;
    const labels = [...h.map((x) => x.week_start), ...fu.map((x) => x.week_start)];
    const pad = (arr, n) => [...arr, ...Array(n).fill(null)];
    const pre = (n, arr) => [...Array(n).fill(null), ...arr];
    const adj = fu.some((x) => x.adjusted != null);
    Charts.line(el, {
      labels, height, divider: h.length - 1, dividerLabel: "Next 8 weeks",
      series: [
        { name: "Units sold", values: pad(h.map((x) => x.sales), fu.length), color: "#1f6feb", markers: pad(h.map((x) => !!x.stockout), fu.length) },
        { name: "Model forecast (made 1 week before)", values: pad(h.map((x) => x.p50), fu.length), color: "#0f9d8a", width: 1.6, dash: true },
        { name: "8-week average (today's method)", values: pad(h.map((x) => x.ma8), fu.length), color: "#98a2b3", width: 1.4, dash: true },
        { name: "Forecast", values: [...h.map((x, i) => (i === h.length - 1 ? (x.stockout ? x.p50 : x.sales) : null)), ...fu.map((x) => x.p50)], color: "#0f9d8a", width: 2.6 },
        ...(adj ? [{ name: "Planner-adjusted", values: pre(h.length, fu.map((x) => x.adjusted)), color: "#8a63d2", width: 2.2 }] : []),
      ],
      bands: [{ name: "Likely range (80%)", lo: [...h.map((x) => x.p10), ...fu.map((x) => x.p10)], hi: [...h.map((x) => x.p90), ...fu.map((x) => x.p90)], color: "#0f9d8a", opacity: 0.13 }],
      extraTip: (i) => (i < h.length && h[i].stockout ? `<br><span style="color:#fca5a5">Stock-out this week - sales understate demand</span>` : ""),
    });
  }
  ROUTES.forecast = {
    title: "Demand forecast", sub: "Weekly demand by medicine and location, with a likely range and an accuracy check against today's method",
    async render(v, p) {
      const { meds, locs } = await lists();
      const sku = p.sku || meds[0].sku_id, loc = p.loc || "";
      v.innerHTML = `<div class="stack">
        <section class="card"><div class="card-b row">
          <div class="field" style="min-width:260px"><label>Medicine</label><select id="fSku">${meds.map((m) => `<option value="${m.sku_id}" ${m.sku_id === sku ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
          <div class="field" style="min-width:260px"><label>Location</label><select id="fLoc"><option value="">Whole network (all locations in view)</option>${locs.map((l) => `<option value="${l.location_id}" ${l.location_id === loc ? "selected" : ""}>${esc(l.name)} - ${esc(l.state)}</option>`).join("")}</select></div>
          <span class="spacer"></span>
          <a class="btn" id="toWhatif">⇄ What-if</a>
        </div></section>
        <div class="grid g4" id="fKpis"></div>
        <div class="grid g-main">
          ${card("Sales, past forecasts and next 8 weeks", `<div id="fChart"></div><div style="margin-top:8px">${legend([["#1f6feb", "Units sold"], ["#d92d20", "Stock-out week", "sq"], ["#0f9d8a", "Model forecast", "dash"], ["#98a2b3", "8-week average (today)", "dash"], ["#0f9d8a", "Likely range", "band"]])}</div>`, { sub: "Dashed lines show what each method predicted one week ahead, so you can see which tracked actual sales better." })}
          <div class="stack">${card("What drives this forecast", `<div id="fDrivers"></div>`)}<div id="fAdjust"></div></div>
        </div>
        ${card("Next 8 weeks", `<div id="fTable"></div>`, { flush: true })}
        ${card("Where predictions are less reliable", `<div id="fRel"></div>`, { flush: true, sub: "Medicine–location pairs with the highest forecast error in the last year (in-stock weeks only). Review these with the field team." })}
      </div>`;
      const go = () => location.hash = `#/forecast?sku=${$("#fSku").value}${$("#fLoc").value ? "&loc=" + $("#fLoc").value : ""}`;
      $("#fSku").onchange = go; $("#fLoc").onchange = go;
      $("#toWhatif").href = `#/whatif?sku=${sku}&loc=${loc || "LOC01"}`;
      const f = await api("/api/forecast" + q({ sku, loc }));
      const a = f.accuracy;
      $("#fKpis").innerHTML = kpi("Model accuracy · last year", pct(a.model), `1 − weighted error, ${num(a.weeks)} in-stock weeks`, { dot: "#0f9d8a" }) +
        kpi("Today's method (8-week average)", pct(a.baseline), `Error ${a.baseline < a.model ? "reduced by " + pct(1 - (1 - a.model) / (1 - a.baseline), 0) : "not reduced"}`, { dot: "#98a2b3" }) +
        kpi("Actual sales inside likely range", pct(a.interval_hit, 0), "Target ≈ 80% for an 80% range", { dot: "#8a63d2" }) +
        kpi("Next 4 weeks (most likely)", num(f.future.slice(0, 4).reduce((s, x) => s + x.p50, 0)), `range ${num(f.future.slice(0, 4).reduce((s, x) => s + x.p10, 0))}–${num(f.future.slice(0, 4).reduce((s, x) => s + x.p90, 0))} units`, { dot: "#1f6feb" });
      forecastChart($("#fChart"), f, 430);
      $("#fDrivers").innerHTML = `<div class="list">${f.drivers.map((x) => `<div class="li" style="padding:8px 0"><div class="ic blue">•</div><div class="body"><span style="color:var(--ink-2)">${esc(x)}</span></div></div>`).join("")}</div>`;
      table($("#fTable"), {
        rows: f.future, key: "week", pageSize: 8, columns: [
          { k: "week_start", label: "Week starting", render: (x) => dt(x.week_start) },
          { k: "p10", label: "Low (10%)", r: true, render: (x) => num(x.p10, 1) },
          { k: "p50", label: "Most likely", r: true, render: (x) => `<b>${num(x.p50, 1)}</b>` },
          { k: "p90", label: "High (90%)", r: true, render: (x) => num(x.p90, 1) },
          ...(f.future.some((x) => x.adjusted != null) ? [{ k: "adjusted", label: "Planner-adjusted", r: true, render: (x) => num(x.adjusted, 1) }] : []),
        ] });
      if (loc) {
        $("#fAdjust").innerHTML = card("Adjust this forecast", `
          ${f.adjustments.length ? `<div class="note" style="margin-bottom:10px">Current adjustment <b>${f.adjustments[0].pct > 0 ? "+" : ""}${f.adjustments[0].pct}%</b> by ${esc(f.adjustments[0].user)}: “${esc(f.adjustments[0].reason)}”</div>` : ""}
          <div class="stack" style="gap:10px"><div class="field"><label>Change (%)</label><div class="range-row"><input type="range" id="adjPct" min="-50" max="100" step="5" value="0"><b id="adjV">0%</b></div></div>
          <div class="field"><label>Reason (required)</label><input class="input" id="adjWhy" placeholder="e.g. School health camp in the district next month"></div>
          <button class="btn primary" id="adjBtn" ${can("decide") ? "" : "disabled"}>Save adjustment</button></div>`, { sub: "Use local knowledge the model cannot see. Every change is logged with a reason." });
        $("#adjPct").oninput = (e) => $("#adjV").textContent = (e.target.value > 0 ? "+" : "") + e.target.value + "%";
        $("#adjBtn").onclick = async () => {
          try { await api("/api/forecast/adjust", { method: "POST", body: { sku, loc, pct: +$("#adjPct").value, reason: $("#adjWhy").value.trim() } }); toast("Forecast adjustment saved"); route(); } catch (e) { toast(e.message, "err"); }
        };
      } else $("#fAdjust").innerHTML = `<div class="note">Choose a single location to adjust its forecast.</div>`;
      const rel = await api("/api/forecast/reliability");
      table($("#fRel"), {
        rows: rel, key: "location_id", pageSize: 10, sort: "wape_model", onRow: (x) => location.hash = `#/forecast?sku=${x.sku_id}&loc=${x.location_id}`,
        columns: [
          { k: "medicine", label: "Medicine" }, { k: "location", label: "Location", render: (x) => `${esc(x.location)}<div class="t2">${esc(x.state)}</div>` },
          { k: "wape_model", label: "Model error", r: true, render: (x) => pct(x.wape_model) }, { k: "wape_base", label: "Today's method", r: true, render: (x) => pct(x.wape_base) },
          { k: "bias", label: "Tends to", render: (x) => Math.abs(x.bias) < 0.03 ? `<span class="muted">balanced</span>` : x.bias > 0 ? "over-forecast" : "under-forecast" },
          { k: "units", label: "Units (yr)", r: true, render: (x) => num(x.units) },
        ] });
    },
  };

  // ================================================================== WHAT-IF
  ROUTES.whatif = {
    title: "What-if planner", sub: "Test a decision before you make it: demand changes, late deliveries, road closures, order size and timing",
    async render(v, p) {
      const { meds, locs } = await lists();
      const saved = JSON.parse(sessionStorage.getItem("nepd.scen") || "[]");
      const sku = p.sku || "SKU001", loc = p.loc || locs.find((l) => l.hill)?.location_id || locs[0].location_id;
      v.innerHTML = `<div class="grid" style="grid-template-columns:minmax(0,360px) minmax(0,1fr)">
        <section class="card"><div class="card-h"><h3>Scenario</h3><p>Results update as you change the inputs.</p></div><div class="card-b stack" style="gap:12px">
          <div class="field"><label>Medicine</label><select id="wSku">${meds.map((m) => `<option value="${m.sku_id}" ${m.sku_id === sku ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
          <div class="field"><label>Location</label><select id="wLoc">${locs.map((l) => `<option value="${l.location_id}" ${l.location_id === loc ? "selected" : ""}>${esc(l.name)} - ${esc(l.state)}</option>`).join("")}</select></div>
          ${rng("demand_pct", "Demand change", -50, 150, 5, 0, "%")}
          ${rng("delay_days", "Delivery delay (road closure, landslide)", 0, 21, 1, 0, " days")}
          <div class="form-grid"><div class="field"><label>Order quantity</label><input class="input" id="w_order_qty" type="number" min="0" step="10" value="${p.qty || 0}"></div>
          <div class="field"><label>Order in (days)</label><input class="input" id="w_order_in_days" type="number" min="0" max="28" value="0"></div></div>
          ${rng("supply_pct", "Supplier delivers", 30, 100, 5, 100, "%")}
          <div class="field"><label>Transfer in from another location (units)</label><input class="input" id="w_transfer_qty" type="number" min="0" step="10" value="0"></div>
          <div class="row"><button class="btn" id="wSave">Save as plan ${String.fromCharCode(65 + saved.length % 26)}</button><button class="btn" id="wClear">Clear saved</button></div>
        </div></section>
        <div class="stack"><div class="grid g4" id="wKpis"></div>
          ${card("Projected stock for the next 8 weeks", `<div id="wChart"></div><div style="margin-top:8px">${legend([["#1f6feb", "Projected stock (most likely)"], ["#1f6feb", "Range across 2,000 simulated futures", "band"], ["#e0882b", "Forecast demand / week", "dash"]])}</div>`)}
          <div class="grid g2">${card("Chance of running out, by week", `<div id="wRisk"></div>`)}${card("Assumptions", `<ul id="wAssume" style="margin:0;padding-left:18px;color:var(--ink-2)"></ul>`)}</div>
          <div id="wCompare"></div></div></div>`;
      function rng(k, label, min, max, step, val, unit) {
        return `<div class="field"><label>${label}</label><div class="range-row"><input type="range" id="w_${k}" min="${min}" max="${max}" step="${step}" value="${val}" data-unit="${unit}"><b id="w_${k}_v">${val}${unit}</b></div></div>`;
      }
      let last;
      const body = () => ({ sku: $("#wSku").value, loc: $("#wLoc").value, demand_pct: +$("#w_demand_pct").value, delay_days: +$("#w_delay_days").value, order_qty: +$("#w_order_qty").value, order_in_days: +$("#w_order_in_days").value, supply_pct: +$("#w_supply_pct").value, transfer_qty: +$("#w_transfer_qty").value });
      let timer;
      async function run() {
        const b = body();
        const r = await api("/api/whatif", { method: "POST", body: b });
        last = { b, r };
        const s = r.summary;
        $("#wKpis").innerHTML = kpi("Chance of a stock-out", pct(s.prob_any_stockout, 0), "in the next 8 weeks", { dot: s.prob_any_stockout > 0.3 ? "#d92d20" : "#0f9d8a" }) +
          kpi("Expected fill rate", pct(s.fill_rate), `${num(s.expected_lost_units)} units may go unsupplied`, { dot: "#8a63d2" }) +
          kpi("Stock left after 8 weeks", num(s.end_cover_weeks, 1) + " wks", `Expiry/overstock risk: ${s.expiry_risk}`, { dot: s.expiry_risk === "high" ? "#e0882b" : "#0f9d8a" }) +
          kpi("Cost of this plan", inr(s.order_cost + s.holding_cost), `+ ${inr(s.lost_margin)} margin lost on missed sales`, { dot: "#13315c" });
        Charts.line($("#wChart"), { labels: r.weeks, height: 250, series: [{ name: "Projected stock", values: r.stock_p50, color: "#1f6feb", area: true }, { name: "Demand / week", values: r.demand, color: "#e0882b", dash: true }],
          bands: [{ name: "Stock range", lo: r.stock_p10, hi: r.stock_p90, color: "#1f6feb" }],
          extraTip: (i) => (r.arrivals[i] ? `<br>Arrives this week: <b>${num(r.arrivals[i])}</b>` : "") + `<br>Chance of stock-out: <b>${pct(r.stockout_prob[i], 0)}</b>` });
        Charts.columns($("#wRisk"), { labels: r.weeks.map(dts), height: 170, yMax: 1, series: [{ name: "Chance of stock-out", values: r.stockout_prob, color: "#d92d20" }], yFmt: (x) => Math.round(x * 100) + "%", tipFmt: (x) => Math.round(x * 100) + "%" });
        $("#wAssume").innerHTML = r.assumptions.map((x) => `<li>${esc(x)}</li>`).join("");
        compare();
      }
      function compare() {
        const sc = JSON.parse(sessionStorage.getItem("nepd.scen") || "[]");
        $("#wSave").textContent = "Save as plan " + String.fromCharCode(65 + sc.length % 26);
        if (!sc.length) { $("#wCompare").innerHTML = ""; return; }
        const rowsC = [["Medicine / location", (x) => esc(x.label)], ["Demand change", (x) => x.b.demand_pct + "%"], ["Delay", (x) => x.b.delay_days + " days"], ["Order", (x) => num(x.b.order_qty) + (x.b.order_in_days ? ` in ${x.b.order_in_days}d` : "")],
          ["Chance of stock-out", (x) => pct(x.s.prob_any_stockout, 0)], ["Fill rate", (x) => pct(x.s.fill_rate)], ["Stock left (weeks)", (x) => num(x.s.end_cover_weeks, 1)], ["Plan cost", (x) => inr(x.s.order_cost + x.s.holding_cost)], ["Lost margin", (x) => inr(x.s.lost_margin)]];
        $("#wCompare").innerHTML = card("Compare saved plans", `<div class="tbl-wrap"><table><thead><tr><th></th>${sc.map((x, i) => `<th>Plan ${String.fromCharCode(65 + i)}</th>`).join("")}</tr></thead><tbody>${rowsC.map(([l, f]) => `<tr><td class="muted">${l}</td>${sc.map((x) => `<td class="num">${f(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`, { flush: true });
      }
      $$("input,select", v).forEach((i) => i.addEventListener("input", () => {
        if (i.type === "range") $(`#${i.id}_v`).textContent = i.value + i.dataset.unit;
        clearTimeout(timer); timer = setTimeout(run, 180);
      }));
      $("#wSave").onclick = () => {
        const sc = JSON.parse(sessionStorage.getItem("nepd.scen") || "[]");
        sc.push({ b: last.b, s: last.r.summary, label: `${$("#wSku").selectedOptions[0].text} @ ${$("#wLoc").selectedOptions[0].text.split(" - ")[0]}` });
        sessionStorage.setItem("nepd.scen", JSON.stringify(sc.slice(-4)));
        compare(); toast("Scenario saved for comparison");
      };
      $("#wClear").onclick = () => { sessionStorage.removeItem("nepd.scen"); compare(); };
      await run();
    },
  };

  // ================================================================== INVENTORY
  ROUTES.inventory = {
    title: "Inventory", sub: "Stock of every medicine at every location, how long it will last and what is on the way",
    async render(v, p) {
      const d = await api("/api/inventory" + q({ state: S.state }));
      let status = p.status || "", t = "";
      const sm = d.summary;
      v.innerHTML = `<div class="stack"><div class="grid g4">
        ${kpi("Out of stock", num(sm.out), "medicine–location pairs with demand", { dot: "#d92d20" })}
        ${kpi("Low (under 2 weeks)", num(sm.low), "order or transfer soon", { dot: "#e0882b" })}
        ${kpi("Healthy", num(sm.ok), "2–12 weeks of stock", { dot: "#0f9d8a" })}
        ${kpi("Excess (over 12 weeks)", num(sm.excess), "cash tied up; transfer candidates", { dot: "#8a63d2" })}</div>
        <section class="card"><div class="card-h" style="padding-bottom:12px"><div class="seg" id="iSeg">${[["", "All", d.items.length], ["out", "Out", sm.out], ["low", "Low", sm.low], ["ok", "Healthy", sm.ok], ["excess", "Excess", sm.excess]].map(([k, l, n]) => `<button data-s="${k}" class="${status === k ? "on" : ""}">${l}<span class="n">${num(n)}</span></button>`).join("")}</div>
        <span class="spacer"></span><input class="input" id="iQ" placeholder="Filter medicine or location" style="width:240px"><button class="btn" id="iExp">⇩ CSV</button></div><div id="iTbl"></div></section></div>`;
      const tbl = table($("#iTbl"), {
        rows: [], key: "key", pageSize: 40, onRow: (r) => location.hash = `#/forecast?sku=${r.sku_id}&loc=${r.location_id}`,
        columns: [
          { k: "status", label: "Status", val: (r) => ({ out: 0, low: 1, excess: 2, ok: 3 }[r.status]), render: (r) => pill(r.status === "low" ? "low-stock" : r.status, { out: "Out of stock", low: "Low", ok: "Healthy", excess: "Excess" }[r.status]) },
          { k: "medicine", label: "Medicine", render: (r) => `<div class="t1">${esc(r.medicine)}</div><div class="t2">${esc(r.category)} · ${r.velocity}</div>` },
          { k: "location", label: "Location", render: (r) => `<div class="t1">${esc(r.location)}</div><div class="t2">${esc(r.state)}</div>` },
          { k: "on_hand", label: "On hand", r: true, render: (r) => num(r.on_hand) },
          { k: "on_order", label: "On the way", r: true, render: (r) => (r.on_order ? num(r.on_order) : `<span class="muted">—</span>`) },
          { k: "forecast_week", label: "Forecast / wk", r: true, render: (r) => num(r.forecast_week, 1) },
          { k: "cover_weeks", label: "Weeks of stock", r: true, render: (r) => `<div class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${Math.min(r.cover_weeks / 16, 1) * 100}%;background:${r.status === "out" || r.status === "low" ? "#d92d20" : r.status === "excess" ? "#8a63d2" : "#0f9d8a"}"></div></div><span>${num(Math.min(r.cover_weeks, 99), 1)}</span></div>` },
          { k: "days_to_expiry", label: "Nearest expiry", r: true, render: (r) => (r.days_to_expiry == null ? "—" : `${num(r.days_to_expiry)} days`) },
          { k: "stock_value", label: "Value", r: true, render: (r) => inr(r.stock_value) },
        ] });
      d.items.forEach((r) => r.key = r.sku_id + r.location_id);
      const apply = () => { const x = t.toLowerCase(); tbl.rows = d.items.filter((r) => (!status || r.status === status) && (!x || (r.medicine + r.location).toLowerCase().includes(x))); };
      $("#iSeg").onclick = (e) => { const b = e.target.closest("[data-s]"); if (!b) return; status = b.dataset.s; $$("#iSeg button").forEach((y) => y.classList.toggle("on", y === b)); apply(); };
      $("#iQ").oninput = (e) => { t = e.target.value; apply(); };
      $("#iExp").onclick = () => window.open(`/api/export/inventory.csv${q({ x_user: S.uid, state: S.state })}`);
      apply();
    },
  };

  // ================================================================== EXPIRY
  ROUTES.expiry = {
    title: "Batches & expiry", sub: () => `Batches that may expire before they are sold, with a suggested action. Stock with under ${S.meta?.min_shelf_days || 91} days left is not dispatched.`,
    async render(v) {
      const d = await api("/api/expiry" + q({ state: S.state }));
      const tot = d.buckets.reduce((a, b) => a + (b.at_risk_value || 0), 0);
      v.innerHTML = `<div class="stack">
        <div class="grid g-main">
          ${card("Value at risk by time to expiry", `<div id="eChart"></div><div class="row" style="margin-top:6px">${d.buckets.map((b) => `<span class="tag">${b.bucket} days: ${b.batches} batches · ${inr(b.value)}</span>`).join("")}</div>`, { sub: "“At risk” = units the local forecast says will not sell before the batch becomes undispatchable." })}
          <div class="stack">${kpi("Value likely to expire unsold", inr(tot), "within the next 12 months, if nothing is done", { dot: "#e0882b" })}
            <div class="card"><div class="card-b"><div class="steps">
              <div><span><b>Sell first (FEFO).</b> Issue the earliest-expiring batch first at every location.</span></div>
              <div><span><b>Move it.</b> Transfer to a location where the same medicine is running short.</span></div>
              <div><span><b>Return early.</b> Send back to the depot while there is still shelf life left.</span></div></div></div></div></div>
        </div>
        <section class="card"><div class="card-h" style="padding-bottom:12px"><h3>Batches needing action</h3><span class="spacer"></span><div class="seg" id="eSeg"><button class="on" data-r="1">At risk only</button><button data-r="0">All batches</button></div><button class="btn" id="eExp">⇩ CSV</button></div><div id="eTbl"></div></section></div>`;
      Charts.columns($("#eChart"), { labels: d.buckets.map((b) => b.bucket + " days"), height: 220, yFmt: Charts.compact, tipFmt: inr,
        series: [{ name: "Likely unsold before expiry", values: d.buckets.map((b) => b.at_risk_value), color: "#e0882b" }] });
      const tbl = table($("#eTbl"), { rows: [], key: "batch_id", pageSize: 30, onRow: (r) => location.hash = `#/forecast?sku=${r.sku_id}&loc=${r.location_id}`,
        columns: [
          { k: "batch_id", label: "Batch", render: (r) => `<div class="t1">${esc(r.batch_id)}</div><div class="t2">mfg ${dts(r.mfg_date)}</div>` },
          { k: "medicine", label: "Medicine" }, { k: "location", label: "Location", render: (r) => `${esc(r.location)}<div class="t2">${esc(r.state)}</div>` },
          { k: "qty", label: "Units", r: true, render: (r) => num(r.qty) },
          { k: "days_to_expiry", label: "Expires", r: true, render: (r) => `${dt(r.expiry_date)}<div class="t2">${num(r.days_to_expiry)} days · sellable ${num(r.sellable_days)}</div>` },
          { k: "projected_sales", label: "Will sell", r: true, render: (r) => num(r.projected_sales) },
          { k: "at_risk_value", label: "At risk", r: true, render: (r) => (r.at_risk_units ? `<b style="color:var(--amber)">${inr(r.at_risk_value)}</b><div class="t2">${num(r.at_risk_units)} units</div>` : `<span class="muted">—</span>`) },
          { k: "action", label: "Suggested action", sort: false, render: (r) => `<span class="tag">${esc(r.action)}</span>` },
        ] });
      let only = true;
      const apply = () => tbl.rows = d.items.filter((r) => !only || r.at_risk_units > 0);
      $("#eSeg").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; only = b.dataset.r === "1"; $$("#eSeg button").forEach((y) => y.classList.toggle("on", y === b)); apply(); };
      $("#eExp").onclick = () => window.open(`/api/export/expiry.csv${q({ x_user: S.uid, state: S.state })}`);
      apply();
    },
  };

  // ================================================================== ORDERS
  ROUTES.orders = {
    title: "Orders & transfers", sub: "Dispatches from the Rani C&F depot and transfers between locations - from approval to receipt",
    async render(v, p) {
      let st = p.status || "", kind = "";
      v.innerHTML = `<div class="stack"><div class="grid g4" id="oKpis"></div>
        <section class="card"><div class="card-h" style="padding-bottom:12px"><div class="seg" id="oSeg"></div><div class="seg" id="oKind"><button class="on" data-k="">All</button><button data-k="replenishment">Depot dispatch</button><button data-k="transfer">Transfers</button></div><span class="spacer"></span><button class="btn" id="oExp">⇩ CSV</button></div><div id="oTbl"></div></section></div>`;
      let data;
      const tbl = table($("#oTbl"), { rows: [], key: "order_id", pageSize: 30,
        columns: [
          { k: "order_id", label: "Order", render: (r) => `<div class="t1">${esc(r.order_id)}</div><div class="t2">${r.kind === "transfer" ? "Transfer" : "Depot dispatch"}${r.origin === "planner" ? " · from plan" : ""}</div>` },
          { k: "medicine", label: "Medicine" },
          { k: "location", label: "To", render: (r) => `${esc(r.location)}<div class="t2">from ${esc(r.source_name)}</div>` },
          { k: "qty", label: "Units", r: true, render: (r) => num(r.qty) }, { k: "value", label: "Value", r: true, render: (r) => inr(r.value) },
          { k: "order_date", label: "Ordered", render: (r) => dts(r.order_date) + (r.created_by && r.created_by !== "system" ? `<div class="t2">${esc(r.created_by)}</div>` : "") },
          { k: "eta", label: "Expected", render: (r) => dts(r.eta) + (r.note ? `<div class="t2">${esc(r.note)}</div>` : "") },
          { k: "status", label: "Status", render: (r) => pill(r.status, STATUS[r.status]) },
          { k: "act", label: "", sort: false, render: (r) => (r.status !== "received" && can("decide") ? `<button class="btn sm" data-adv="${r.order_id}">${{ approved: "Mark dispatched", dispatched: "Mark in transit", in_transit: "Mark received", delayed: "Mark received" }[r.status]}</button>` : "") },
        ],
        actions: (c) => $$("[data-adv]", c).forEach((b) => b.onclick = async () => {
          const o = data.items.find((x) => x.order_id === b.dataset.adv);
          const doIt = async (body = {}) => { try { const r = await api(`/api/orders/${o.order_id}/advance`, { method: "POST", body }); toast(`${o.order_id} → ${STATUS[r.status]}${r.status === "received" ? " · stock updated" : ""}`); load(); } catch (e) { toast(e.message, "err"); } };
          if (["in_transit", "delayed"].includes(o.status)) modal({ title: `Receive ${o.order_id}`, ok: "Confirm receipt", body: `<div class="field"><label>Units received</label><input class="input" id="rq" type="number" value="${o.qty}"></div><p class="muted">Record a lower number for short or damaged deliveries. Stock is added as a new batch.</p>`, onOk: (m) => doIt({ received_qty: +$("#rq", m).value }) });
          else doIt();
        }) });
      async function load() {
        data = await api("/api/orders" + q({ kind }));
        const sm = Object.fromEntries(data.summary.map((s) => [s.status, s]));
        $("#oKpis").innerHTML = kpi("Approved, not dispatched", num(sm.approved?.n || 0), inr(sm.approved?.value || 0), { dot: "#0f9d8a" }) + kpi("In transit", num((sm.in_transit?.n || 0) + (sm.dispatched?.n || 0)), inr((sm.in_transit?.value || 0) + (sm.dispatched?.value || 0)), { dot: "#1f6feb" }) +
          kpi("Delayed on route", num(sm.delayed?.n || 0), "landslides / road closures", { dot: "#e0882b", onclick: "orders?status=delayed" }) + kpi("Received (last 16 weeks)", num(sm.received?.n || 0), inr(sm.received?.value || 0), { dot: "#98a2b3" });
        const counts = { "": data.items.length };
        data.items.forEach((o) => counts[o.status] = (counts[o.status] || 0) + 1);
        $("#oSeg").innerHTML = [["", "All"], ["approved", "Approved"], ["in_transit", "In transit"], ["delayed", "Delayed"], ["received", "Received"]].map(([k, l]) => `<button data-s="${k}" class="${st === k ? "on" : ""}">${l}<span class="n">${counts[k] || 0}</span></button>`).join("");
        tbl.rows = data.items.filter((o) => !st || o.status === st || (st === "in_transit" && o.status === "dispatched"));
      }
      $("#oSeg").onclick = (e) => { const b = e.target.closest("[data-s]"); if (!b) return; st = b.dataset.s; load(); };
      $("#oKind").onclick = (e) => { const b = e.target.closest("[data-k]"); if (!b) return; kind = b.dataset.k; $$("#oKind button").forEach((y) => y.classList.toggle("on", y === b)); load(); };
      $("#oExp").onclick = () => window.open(`/api/export/orders.csv${q({ x_user: S.uid })}`);
      await load();
    },
  };

  // ================================================================== ALERTS
  ROUTES.alerts = {
    title: "Alerts", sub: "Shortages, expiry risk, delivery delays and unusual demand - assign, resolve or open the record",
    async render(v) {
      let kind = "", status = "open";
      v.innerHTML = `<section class="card"><div class="card-h" style="padding-bottom:12px"><div class="seg" id="aKind"></div><span class="spacer"></span><div class="seg" id="aSt"><button class="on" data-s="open">Open</button><button data-s="resolved">Resolved</button></div></div><div id="aList" class="list"></div></section>`;
      async function load() {
        const all = await api("/api/alerts" + q({ status }));
        const c = { "": all.length };
        all.forEach((a) => c[a.kind] = (c[a.kind] || 0) + 1);
        $("#aKind").innerHTML = [["", "All"], ...Object.entries(KIND).map(([k, [l]]) => [k, l])].map(([k, l]) => `<button data-k="${k}" class="${kind === k ? "on" : ""}">${l}<span class="n">${c[k] || 0}</span></button>`).join("");
        const items = all.filter((a) => !kind || a.kind === kind).slice(0, 200);
        $("#aList").innerHTML = items.map((a) => {
          const [lbl, color, ico] = KIND[a.kind] || [a.kind, "blue", "•"];
          return `<div class="li"><div class="ic ${color}">${ico}</div><div class="body"><b>${lbl} ${pill(a.severity)}</b><span>${esc(a.message)}</span>${a.assigned_to ? `<div class="t2" style="font-size:12px;color:var(--teal)">Assigned to ${esc(a.assigned_to)}</div>` : ""}</div>
            <div class="end row" style="gap:6px">${a.sku_id && a.location_id ? `<a class="btn sm" href="#/forecast?sku=${a.sku_id}&loc=${a.location_id}">Open</a>` : a.location_id ? `<button class="btn sm" data-loc="${a.location_id}">Open</button>` : ""}
            ${status === "open" && can("decide") ? `<button class="btn sm" data-me="${a.alert_id}">Assign to me</button><button class="btn sm" data-res="${a.alert_id}">Resolve</button>` : ""}</div></div>`;
        }).join("") || `<div class="empty">No alerts here.</div>`;
        $$("[data-res]", v).forEach((b) => b.onclick = async () => { await api(`/api/alerts/${b.dataset.res}`, { method: "POST", body: { status: "resolved" } }); toast("Alert resolved"); load(); refreshCounts(); });
        $$("[data-me]", v).forEach((b) => b.onclick = async () => { await api(`/api/alerts/${b.dataset.me}`, { method: "POST", body: { assigned_to: S.user.name } }); toast("Assigned to you"); load(); });
        $$("[data-loc]", v).forEach((b) => b.onclick = () => locationDrawer(b.dataset.loc));
      }
      $("#aKind").onclick = (e) => { const b = e.target.closest("[data-k]"); if (!b) return; kind = b.dataset.k; load(); };
      $("#aSt").onclick = (e) => { const b = e.target.closest("[data-s]"); if (!b) return; status = b.dataset.s; $$("#aSt button").forEach((y) => y.classList.toggle("on", y === b)); load(); };
      await load();
    },
  };

  // ================================================================== NETWORK / LOCATIONS
  ROUTES.network = {
    title: "Locations", sub: "Stockists, hospitals, retail chains and institutions across the eight Northeast states",
    async render(v) {
      const L = await api("/api/locations" + q({ state: S.state }));
      v.innerHTML = `<div class="stack"><div class="grid g-main">
        ${card("Network map", `<div class="map-wrap" id="nMap"></div>`, { sub: "Bubble size = sales in the last 4 weeks; colour = number of urgent actions." })}
        ${card("Location types", `<div id="nTypes"></div><div style="margin-top:14px" class="note">${L.filter((l) => l.hill).length} of ${L.length} locations are on hill routes with 5–8 day deliveries and monsoon landslide risk.</div>`)}</div>
        <section class="card"><div class="card-h" style="padding-bottom:12px"><h3>All locations</h3><span class="spacer"></span><input class="input" id="nQ" placeholder="Filter" style="width:220px"></div><div id="nTbl"></div></section></div>`;
      Charts.map($("#nMap"), L.map((l) => ({ ...l, value: l.sales_value })), { height: 380, money: inr, onClick: (p) => locationDrawer(p.location_id) });
      const types = {};
      L.forEach((l) => types[l.type] = (types[l.type] || 0) + 1);
      $("#nTypes").innerHTML = hbars(Object.entries(types).map(([k, n]) => [{ stockist: "Stockists", retail_chain: "Retail chains", hospital: "Hospitals", institution: "Institutions" }[k], n, n]), "#13315c");
      const tbl = table($("#nTbl"), { rows: L, key: "location_id", pageSize: 40, onRow: (r) => locationDrawer(r.location_id), sort: "sales_value",
        columns: [
          { k: "name", label: "Location", render: (r) => `<div class="t1">${esc(r.name)}</div><div class="t2">${esc(r.district)}, ${esc(r.state)}</div>` },
          { k: "type", label: "Type", render: (r) => `<span class="tag">${esc(r.type.replace("_", " "))}</span>${r.hill ? ' <span class="tag">hill</span>' : ""}` },
          { k: "lead_days", label: "Delivery", r: true, render: (r) => r.lead_days + " d" },
          { k: "sales_value", label: "Sales (4 wks)", r: true, render: (r) => inr(r.sales_value) },
          { k: "growth", label: "Trend", r: true, val: (r) => r.units / (r.units_prev || 1), render: (r) => delta(r.units, r.units_prev) },
          { k: "stockout_rate", label: "Stock-outs (12 wks)", r: true, render: (r) => pct(r.stockout_rate) },
          { k: "stock_value", label: "Stock value", r: true, render: (r) => inr(r.stock_value) },
          { k: "urgent", label: "Urgent", r: true, render: (r) => (r.urgent ? `<b style="color:var(--red)">${r.urgent}</b>` : "0") },
        ] });
      $("#nQ").oninput = (e) => { const t = e.target.value.toLowerCase(); tbl.rows = L.filter((l) => (l.name + l.state).toLowerCase().includes(t)); };
    },
  };
  async function locationDrawer(id) {
    const d = await api("/api/locations/" + id), i = d.info;
    openDrawer(`<div class="drawer-h"><div><h2>${esc(i.name)}</h2><p>${esc(i.district)}, ${esc(i.state)} · ${esc(i.type.replace("_", " "))}${i.hill ? " · hill route" : ""}</p></div><button class="close-x">✕</button></div>
      <div class="drawer-b">
        <div class="facts"><div class="fact"><small>Sales · 4 weeks</small><b>${inr(i.sales_value)}</b></div><div class="fact"><small>Stock value</small><b>${inr(i.stock_value)}</b></div><div class="fact"><small>Stock-out rate · 12 wks</small><b>${pct(i.stockout_rate)}</b></div>
          <div class="fact"><small>Normal delivery</small><b>${i.lead_days} days</b></div><div class="fact"><small>On-time deliveries</small><b>${pct(d.delivery.rate, 0)}</b><small>avg ${num(d.delivery.avg_days, 1)} days</small></div><div class="fact"><small>Open alerts</small><b>${i.alerts}</b></div></div>
        ${card("Units sold · last 26 weeks", `<div id="lChart"></div>`)}
        ${card("Top medicines · 12 weeks", d.top_medicines.map((m) => `<div class="hbar"><span class="name">${esc(m.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${(m.units / d.top_medicines[0].units) * 100}%"></div></div><span class="v">${num(m.units)}${m.stockout_weeks ? ` <span style="color:var(--red)">· ${m.stockout_weeks} out</span>` : ""}</span></div>`).join(""))}
        ${card("Open suggestions", `<div class="list">${d.recs.map((r) => `<div class="li click" data-rec="${r.rec_id}"><div class="ic ${r.priority === "urgent" ? "red" : r.priority === "high" ? "amber" : "blue"}">✓</div><div class="body"><b>${esc(r.medicine)}</b><span>${r.cover_days < 1 ? "Out of stock" : "Lasts " + num(r.cover_days) + " days"} · order ${num(r.suggested_qty)}</span></div><div class="end">${pill(r.priority, PR[r.priority])}</div></div>`).join("") || `<div class="empty">Nothing to order here this week</div>`}</div>`, { flush: true })}
      </div>`);
    Charts.line($("#lChart"), { labels: d.trend.map((t) => t.week_start), height: 190, series: [{ name: "Units", values: d.trend.map((t) => t.units), color: "#1f6feb", area: true }] });
    $$("[data-rec]", $("#drawer")).forEach((x) => x.onclick = () => recDrawer(x.dataset.rec));
  }

  // ================================================================== MEDICINES
  ROUTES.medicines = {
    title: "Medicines", sub: "Catalogue with demand, growth and stock position for each medicine",
    async render(v) {
      const M = await api("/api/medicines" + q({ state: S.state }));
      v.innerHTML = `<section class="card"><div class="card-h" style="padding-bottom:12px"><h3>${M.length} medicines</h3><span class="spacer"></span><input class="input" id="mQ" placeholder="Filter by name or category" style="width:240px"></div><div id="mTbl"></div></section>`;
      const tbl = table($("#mTbl"), { rows: M, key: "sku_id", pageSize: 30, onRow: (r) => medicineDrawer(r.sku_id), sort: "units",
        columns: [
          { k: "name", label: "Medicine", render: (r) => `<div class="t1">${esc(r.name)}</div><div class="t2">${esc(r.sku_id)} · ${esc(r.form)}</div>` },
          { k: "category", label: "Category", render: (r) => `<span class="tag">${esc(r.category)}</span>` },
          { k: "velocity", label: "Moves", render: (r) => ({ fast: "Fast", med: "Medium", slow: "Slow" }[r.velocity]) },
          { k: "season", label: "Season", render: (r) => (r.season === "flat" ? `<span class="muted">steady</span>` : r.season) },
          { k: "units", label: "Units (4 wks)", r: true, render: (r) => num(r.units) },
          { k: "growth", label: "Trend", r: true, val: (r) => r.units / (r.units_prev || 1), render: (r) => delta(r.units, r.units_prev) },
          { k: "forecast4", label: "Forecast (next 4)", r: true, render: (r) => num(r.forecast4) },
          { k: "on_hand", label: "On hand", r: true, render: (r) => num(r.on_hand) },
          { k: "stockout_rate", label: "Stock-outs", r: true, render: (r) => pct(r.stockout_rate) },
          { k: "shelf_life_months", label: "Shelf life", r: true, render: (r) => r.shelf_life_months + " mo" },
        ] });
      $("#mQ").oninput = (e) => { const t = e.target.value.toLowerCase(); tbl.rows = M.filter((m) => (m.name + m.category).toLowerCase().includes(t)); };
    },
  };
  async function medicineDrawer(id) {
    const d = await api("/api/medicines/" + id), i = d.info;
    openDrawer(`<div class="drawer-h"><div><h2>${esc(i.name)}</h2><p>${esc(i.sku_id)} · ${esc(i.form)} · ${esc(i.category)} · shelf life ${i.shelf_life_months} months</p></div><button class="close-x">✕</button></div>
      <div class="drawer-b">
        <div class="facts"><div class="fact"><small>MRP</small><b>${i.mrp == null ? "—" : "₹" + i.mrp}</b></div><div class="fact"><small>Case pack</small><b>${i.case_pack}</b></div><div class="fact"><small>Demand pattern</small><b>${{ fast: "Fast", med: "Medium", slow: "Slow" }[i.velocity]}</b><small>${i.season === "flat" ? "steady" : i.season + " peak"}</small></div></div>
        ${card("Network demand · 52 weeks + forecast", `<div id="mChart"></div>`)}
        ${card("Where it sells", `<div id="mMk"></div>`, { flush: true })}
        <div class="row"><a class="btn" href="#/forecast?sku=${i.sku_id}">Open full forecast</a></div>
      </div>`);
    const labels = [...d.trend.map((t) => t.week_start), ...d.forecast.map((f) => f.week_start)], n = d.trend.length;
    Charts.line($("#mChart"), { labels, height: 210, divider: n - 1, series: [{ name: "Units sold", values: [...d.trend.map((t) => t.units), ...d.forecast.map(() => null)], color: "#1f6feb" }, { name: "Forecast", values: [...d.trend.map((t, k) => (k === n - 1 ? t.units : null)), ...d.forecast.map((f) => f.p50)], color: "#0f9d8a", dash: true }],
      bands: [{ name: "Likely range", lo: [...d.trend.map(() => null), ...d.forecast.map((f) => f.p10)], hi: [...d.trend.map(() => null), ...d.forecast.map((f) => f.p90)], color: "#0f9d8a" }] });
    table($("#mMk"), { rows: d.markets, key: "location_id", pageSize: 8, onRow: (r) => location.hash = `#/forecast?sku=${i.sku_id}&loc=${r.location_id}`,
      columns: [{ k: "name", label: "Location", render: (r) => `${esc(r.name)}<div class="t2">${esc(r.state)}</div>` }, { k: "units", label: "Units (4 wks)", r: true, render: (r) => num(r.units) }, { k: "forecast_week", label: "Forecast / wk", r: true, render: (r) => num(r.forecast_week, 1) }, { k: "on_hand", label: "On hand", r: true, render: (r) => num(r.on_hand) }] });
  }

  // ================================================================== IMPACT & PILOT
  ROUTES.impact = {
    title: "Impact & pilot", sub: "How the planner performs against the NESFIC-I-09 targets, how it was measured, and the proposed pilot",
    async render(v) {
      const d = await api("/api/impact"), m = d.meta;
      const f = (x, u) => (u === "inr" ? inr(x) : u === "pct" ? pct(x) : num(x, 2));
      v.innerHTML = `<div class="stack">
        <div class="note info"><b>How these numbers were produced.</b> A synthetic network of 60 medicines × 40 locations was simulated for 104 weeks, including monsoon seasonality, festivals, two disease outbreaks, hill-route landslides, supplier short-supply and depot stock that arrives part-way through its shelf life. Year 1 was used to train the model. Year 2 was replayed twice over <b>exactly the same demand and disruptions</b>: once with today's manual ordering and once with this planner. These are simulation results, not GRD data; the pilot will re-establish the baseline on real data.</div>
        <div class="grid g-main">
          ${card("Results against the challenge targets", `<div class="tbl-wrap"><table><thead><tr><th>Measure</th><th class="r">Today (manual)</th><th class="r">With planner</th><th class="r">Change</th><th>Target</th><th></th></tr></thead><tbody>${d.metrics.map((x) => {
            const ch = x.unit === "pct" && x.metric === "fill" ? ((x.planner - x.manual) * 100).toFixed(1) + " pp" : ((x.planner - x.manual) / x.manual * 100).toFixed(0) + "%";
            return `<tr><td><div class="t1">${esc(x.label)}</div><div class="t2">${esc(x.note)}</div></td><td class="r num">${f(x.manual, x.unit)}</td><td class="r num"><b>${f(x.planner, x.unit)}</b></td><td class="r num">${ch.startsWith("-") ? ch : "+" + ch}</td><td>${esc(x.target)}</td><td>${x.met == null ? "" : x.met ? pill("met", "Met") : pill("notmet", "Not met")}</td></tr>`;
          }).join("")}</tbody></table></div>`, { flush: true })}
          ${card("Honest reading of the results", `<div class="steps">
            <div><span><b>Forecast error falls by about 20%</b>, right at the target. Most of the gain comes from treating stock-out weeks as unknown demand and pooling patterns across locations.</span></div>
            <div><span><b>Stock-outs, excess stock and expiry losses</b> beat their targets by a wide margin. Part of this comes from planning-policy changes (weekly review, smaller boxes for slow movers, transfers) and not from the model alone.</span></div>
            <div><span><b>Fill rate does not reach +10 points</b> here, because the simulated baseline is already ${pct(d.metrics.find((x) => x.metric === "fill").manual)}. The real baseline will be measured in pilot weeks 1–3.</span></div>
            <div><span><b>Trade-off:</b> weekly review roughly doubles dispatch frequency. The pilot should agree consolidated dispatch days per route.</span></div></div>`)}
        </div>
        <div class="grid g2">
          ${card("Stock-out rate by week · evaluation year", `<div id="impSo"></div>${legend([["#98a2b3", "Today (manual)"], ["#0f9d8a", "With planner"]])}`)}
          ${card("Inventory value by week · evaluation year", `<div id="impInv"></div>${legend([["#98a2b3", "Today (manual)"], ["#0f9d8a", "With planner"]])}`)}
        </div>
        <div class="grid g2">
          ${card("How the planner decides (every week)", `<div class="steps">
            <div><span><b>Forecast</b> demand for the next 1–8 weeks for each medicine at each location, with a likely range (gradient-boosted model, ${nf.format(m.train_rows)} training rows).</span></div>
            <div><span><b>Delivery time</b> for that route; hill routes get +${m.monsoon_buffer_days} days in the monsoon.</span></div>
            <div><span><b>Target stock</b> = forecast demand until the next delivery and review + safety stock (${m.safety_factor} × forecast uncertainty).</span></div>
            <div><span><b>Transfer first</b> if another location holds more than 8 weeks of the same medicine.</span></div>
            <div><span><b>Order</b> the rest in dispatch packs, capped at what can be sold before expiry (no dispatch under ${m.min_shelf_days} days of shelf life).</span></div>
            <div><span><b>A person approves</b>: planners up to ${inr(m.approval_limit)}, the Head of Supply Chain above that. Every decision and reason is logged.</span></div></div>`)}
          ${card("Proposed pilot · 12–16 weeks (Guwahati / Rani + selected Assam stockists)", `<div class="timeline">
            <div><b>Weeks 1–3 · Baseline</b>Connect ERP and stockist exports, clean the data, measure today's accuracy, stock-outs, excess stock, expiry and fill rate.</div>
            <div><b>Weeks 4–6 · Shadow</b>The planner runs alongside today's process. Compare suggestions with actual decisions and tune with the sales and supply teams.</div>
            <div><b>Weeks 7–14 · Live</b>Planners approve suggestions for the selected products and stockists. Weekly review with GRD.</div>
            <div><b>Weeks 15–16 · Measure</b>Independent before/after on the 5 KPIs, a total-cost-of-ownership note and a scale-up plan for the other NE states.</div></div>
            <div class="note" style="margin-top:14px">Runs on one small cloud server hosted in India, on a laptop or on GRD's own server. Uses existing Excel/CSV exports, and no special hardware is needed.</div>`)}
        </div>
        ${card("Decisions recorded in this demo", `<div class="row">${["approved", "modified", "awaiting", "postponed", "rejected"].map((k) => `<div class="fact" style="min-width:130px"><small>${{ approved: "Approved", modified: "Approved with changes", awaiting: "Awaiting approval", postponed: "Postponed", rejected: "Rejected" }[k]}</small><b>${num(d.decisions[k] || 0)}</b></div>`).join("")}</div><p class="muted" style="margin-bottom:0">In the pilot, the share of suggestions approved unchanged is tracked as a trust and adoption measure.</p>`)}
      </div>`;
      const wk = d.weekly.map((x) => x.week_start);
      Charts.line($("#impSo"), { labels: wk, height: 220, yFmt: (x) => Math.round(x * 100) + "%", tipFmt: (x) => (x * 100).toFixed(1) + "%", series: [{ name: "Manual", values: d.weekly.map((x) => x.stockout_manual), color: "#98a2b3" }, { name: "Planner", values: d.weekly.map((x) => x.stockout_planner), color: "#0f9d8a" }] });
      Charts.line($("#impInv"), { labels: wk, height: 220, tipFmt: inr, series: [{ name: "Manual", values: d.weekly.map((x) => x.inventory_manual), color: "#98a2b3" }, { name: "Planner", values: d.weekly.map((x) => x.inventory_planner), color: "#0f9d8a" }] });
    },
  };

  // ================================================================== DATA IMPORT
  ROUTES.data = {
    title: "Data import", sub: "Bring in sales, stock and medicine data from Excel/CSV - checked before it is used",
    async render(v) {
      const d = await api("/api/uploads");
      v.innerHTML = `<div class="stack"><div class="grid g-main">
        ${card("Upload a file", `<div class="stack" style="gap:12px">
          <div class="row"><div class="field"><label>File type</label><select id="upKind"><option value="sales">Weekly sales & closing stock</option><option value="stock">Batch & expiry register</option><option value="medicines">Medicine catalogue</option></select></div>
          <span class="spacer"></span><a class="btn sm" id="tplLink" href="/api/templates/sales.csv">⇩ Download template</a></div>
          <label class="drop" id="drop"><input type="file" id="upFile" accept=".csv,text/csv" hidden><b>Drop a CSV file here or click to choose</b><br><span class="muted">Columns, codes, numbers, dates, duplicates and expiry are checked before anything is accepted.</span></label>
          <div id="upResult"></div></div>`, { sub: "Excel users: File → Save As → CSV. Templates include a few deliberate mistakes so you can see the checks." })}
        ${card("Data sources", `<div class="tbl-wrap"><table><thead><tr><th>Source</th><th>Updated</th><th>Frequency</th><th>Status</th></tr></thead><tbody>${d.sources.map((s) => `<tr><td>${esc(s.source)}</td><td>${s.last ? dt(s.last) : "—"}</td><td>${esc(s.frequency)}</td><td>${pill(s.status === "ok" ? "ok" : "lowp", s.status === "ok" ? "Up to date" : s.status)}</td></tr>`).join("")}</tbody></table></div>`, { flush: true })}</div>
        ${card("Import history", `<div id="upHist"></div>`, { flush: true })}</div>`;
      $("#upKind").onchange = (e) => $("#tplLink").href = `/api/templates/${e.target.value}.csv`;
      const drop = $("#drop");
      ["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
      ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove("over")));
      drop.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) send(e.dataTransfer.files[0]); });
      $("#upFile").onchange = (e) => e.target.files[0] && send(e.target.files[0]);
      async function send(file) {
        if (!can("decide")) { toast("Your role is read-only", "warn"); return; }
        const fd = new FormData(); fd.append("kind", $("#upKind").value); fd.append("file", file);
        try {
          const r = await api("/api/upload", { method: "POST", body: fd });
          $("#upResult").innerHTML = `<div class="note ${r.errors ? "warn" : "info"}"><b>${esc(file.name)}</b>: ${num(r.rows)} rows · ${r.errors} errors · ${r.warnings} warnings → ${pill(r.status, r.status.replace("_", " "))}<br>${r.errors ? "Fix the errors below and upload again. Rows with errors are not used." : "Accepted. The file will be included in the next weekly planning run."}</div>` +
            (r.issues.length ? `<div class="tbl-wrap" style="margin-top:10px;max-height:300px;overflow:auto"><table><thead><tr><th>Row</th><th>Level</th><th>Field</th><th>Problem</th></tr></thead><tbody>${r.issues.map((i) => `<tr><td>${i.row}</td><td>${pill(i.level === "error" ? "urgent" : "high", i.level)}</td><td>${esc(i.field)}</td><td>${esc(i.message)}</td></tr>`).join("")}</tbody></table></div>` : "");
          toast(r.errors ? "File checked - needs attention" : "File accepted", r.errors ? "warn" : "ok");
          hist();
        } catch (e) { toast(e.message, "err"); }
      }
      async function hist() {
        const h = (await api("/api/uploads")).uploads;
        table($("#upHist"), { rows: h, key: "upload_id", pageSize: 10, empty: "No files imported yet.", columns: [
          { k: "ts", label: "When", render: (r) => esc(r.ts.replace("T", " ")) }, { k: "filename", label: "File" }, { k: "kind", label: "Type" }, { k: "user", label: "By" },
          { k: "rows", label: "Rows", r: true }, { k: "errors", label: "Errors", r: true }, { k: "warnings", label: "Warnings", r: true }, { k: "status", label: "Result", render: (r) => pill(r.status, r.status.replace("_", " ")) }] });
      }
      hist();
    },
  };

  // ================================================================== ADMIN
  ROUTES.admin = {
    title: "Users & settings", sub: "Roles, approval rules, planning thresholds and the audit trail",
    async render(v) {
      const [set, aud] = await Promise.all([api("/api/settings"), api("/api/audit")]);
      v.innerHTML = `<div class="stack"><div class="grid g2">
        ${card("Users and roles", `<div class="tbl-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Can see</th><th>Can do</th></tr></thead><tbody>${S.users.map((u) => `<tr><td><div class="row" style="gap:8px"><span class="avatar">${initials(u.name)}</span><div><div class="t1">${esc(u.name)}</div><div class="t2">${esc(u.title)}</div></div></div></td><td><span class="tag">${u.role}</span></td><td>${u.scope === "ALL" ? "All states" : esc(u.scope.replaceAll(",", ", "))}</td><td class="t2">${{ head: "Approve any order, change settings", planner: `Approve up to ${inr(set.approval_limit)}`, regional: `Approve in own states up to ${inr(set.approval_limit)}`, viewer: "View only; costs hidden" }[u.role]}</td></tr>`).join("")}</tbody></table></div>`, { flush: true, sub: "Use the profile menu (top right) to switch users and see how access changes." })}
        ${card("Planning settings", `<div class="stack" style="gap:12px">
          <div class="form-grid"><div class="field"><label>Approval limit per order (₹)</label><input class="input" id="sLim" type="number" value="${set.approval_limit}"></div>
          <div class="field"><label>Minimum shelf life to dispatch (days)</label><input class="input" id="sShelf" type="number" value="${set.min_shelf_days}"></div>
          <div class="field"><label>Expiry alert window (days)</label><input class="input" id="sExp" type="number" value="${set.expiry_alert_days}"></div>
          <div class="field"><label>Safety stock factor / monsoon buffer</label><input class="input" value="${set.safety_factor} × uncertainty · +${set.monsoon_buffer_days} days" disabled></div></div>
          <div class="row"><button class="btn primary" id="sSave" ${can("settings") ? "" : "disabled"}>Save settings</button>${can("settings") ? "" : `<span class="muted">Only the Head of Supply Chain can change settings.</span>`}</div></div>`)}
      </div>
        ${card("Security, privacy and compliance", `<div class="grid g3">
          <div class="steps"><div><span><b>Data stays in India.</b> One server in an Indian cloud region or on GRD's own premises. No data is sent to outside AI services.</span></div><div><span><b>DPDP Act 2023 ready.</b> No patient data is needed, only medicine, location, sales and stock.</span></div></div>
          <div class="steps"><div><span><b>Role-based access.</b> Regional managers see only their states; viewers cannot see costs.</span></div><div><span><b>Full audit trail.</b> Every approval, change, upload and setting is logged with who, when and why.</span></div></div>
          <div class="steps"><div><span><b>Batch and expiry control.</b> Earliest-expiry stock is issued first (FEFO), short-dated stock is blocked from dispatch, and every batch is traceable to its location.</span></div><div><span><b>Low connectivity.</b> Installs like an app. The last data stays viewable offline.</span></div></div></div>`)}
        ${card("Audit trail", `<div id="audTbl"></div>`, { flush: true })}</div>`;
      $("#sSave").onclick = async () => {
        try { await api("/api/settings", { method: "POST", body: { approval_limit: +$("#sLim").value, min_shelf_days: +$("#sShelf").value, expiry_alert_days: +$("#sExp").value } }); toast("Settings saved"); await loadSession(); route(); } catch (e) { toast(e.message, "err"); }
      };
      table($("#audTbl"), { rows: aud, key: "ts", pageSize: 15, columns: [{ k: "ts", label: "When", render: (r) => esc(r.ts.replace("T", " ")) }, { k: "user", label: "Who" }, { k: "action", label: "Action", render: (r) => `<span class="tag">${esc(r.action)}</span>` }, { k: "entity", label: "Record" }, { k: "detail", label: "Detail", render: (r) => `<span class="t2">${esc(r.detail)}</span>` }] });
    },
  };

  // ------------------------------------------------------------------ boot
  (async function boot() {
    try { await loadSession(); }
    catch (e) { $("#view").innerHTML = `<div class="card"><div class="empty"><b>Cannot reach the planner.</b><br>${esc(e.message)}</div></div>`; return; }
    route();
    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});
    let rt, lastW = innerWidth;
    addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (Math.abs(innerWidth - lastW) > 80 && !$("#drawer").classList.contains("open")) { lastW = innerWidth; route(); } }, 400); });
  })();
})();
