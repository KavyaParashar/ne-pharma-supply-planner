"""NE Pharma Supply Planner - API + static web app.   Run:  uvicorn server.api:app --port 8000

Plain FastAPI over one SQLite file. Role-based scoping by the X-User header (demo sign-in);
every write is recorded in the audit table.
"""
from __future__ import annotations

import csv
import io
import json
import sqlite3
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
from fastapi import Body, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "nepd.db"
WEB = ROOT / "web"
CARRY_RATE = 0.18          # annual inventory carrying cost

app = FastAPI(title="NE Pharma Supply Planner", version="1.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


# ----------------------------------------------------------------------------- helpers
def db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise HTTPException(503, "Database not built yet. Run: python -m server.build")
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def rows(con, sql, args=()):
    return [dict(r) for r in con.execute(sql, args).fetchall()]


def one(con, sql, args=()):
    r = con.execute(sql, args).fetchone()
    return dict(r) if r else None


def meta(con) -> dict:
    return {r["key"]: json.loads(r["value"]) for r in con.execute("SELECT * FROM meta")}


def setting(con, key, default):
    r = con.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return json.loads(r[0]) if r else default


def user_of(con, uid: str | None) -> dict:
    u = one(con, "SELECT * FROM users WHERE user_id=?", (uid or "U2",))
    if not u:
        raise HTTPException(401, "Unknown user")
    u["states"] = None if u["scope"] == "ALL" else u["scope"].split(",")
    return u


def scope_sql(u, alias="l", state: str | None = None):
    """WHERE fragment restricting locations to the user's states (and an optional state filter)."""
    parts, args = [], []
    if u["states"]:
        parts.append(f"{alias}.state IN ({','.join('?' * len(u['states']))})")
        args += u["states"]
    if state:
        parts.append(f"{alias}.state = ?")
        args.append(state)
    return (" AND " + " AND ".join(parts)) if parts else "", args


def audit(con, u, action, entity, detail):
    con.execute("INSERT INTO audit VALUES (?,?,?,?,?)",
                (datetime.now().isoformat(timespec="seconds"), u["name"], action, entity, detail))


def mask(u, items, fields=("value", "stock_value", "cost", "sales_value", "at_risk_value")):
    if u["role"] != "viewer":
        return items
    for it in items:
        for f in fields:
            if f in it:
                it[f] = None
    return items


def today(con) -> date:
    return date.fromisoformat(meta(con)["next_week"])


# ----------------------------------------------------------------------------- session / meta
@app.get("/api/session")
def session(x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    m = meta(con)
    states = [r["state"] for r in con.execute("SELECT DISTINCT state FROM locations ORDER BY state")]
    if u["states"]:
        states = [s for s in states if s in u["states"]]
    m["approval_limit"] = setting(con, "approval_limit", m["approval_limit"])
    counts = one(con, f"""SELECT
        (SELECT COUNT(*) FROM recommendations r JOIN locations l USING(location_id) WHERE r.status IN ('open','awaiting_approval') {scope_sql(u)[0]}) AS recs,
        (SELECT COUNT(*) FROM alerts a JOIN locations l USING(location_id) WHERE a.status='open' {scope_sql(u)[0]}) AS alerts""",
                 scope_sql(u)[1] * 2)
    return {"user": u, "users": rows(con, "SELECT * FROM users"), "meta": m, "states": states, "counts": counts}


# ----------------------------------------------------------------------------- overview
@app.get("/api/overview")
def overview(state: str | None = None, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    m = meta(con)
    w = m["as_of_week"]
    sc, sa = scope_sql(u, "l", state)
    base = f"FROM weekly x JOIN locations l USING(location_id) JOIN medicines d USING(sku_id) WHERE 1=1 {sc}"
    k = one(con, f"""SELECT
        SUM(CASE WHEN x.week>{w}-4 THEN x.sales*d.mrp END) AS sales4, SUM(CASE WHEN x.week BETWEEN {w}-7 AND {w}-4 THEN x.sales*d.mrp END) AS sales4_prev,
        SUM(CASE WHEN x.week>{w}-4 THEN x.sales END) AS units4,
        SUM(CASE WHEN x.week>{w}-4 THEN x.sales END)*1.0/NULLIF(SUM(CASE WHEN x.week>{w}-4 THEN MAX(x.true_demand, x.sales) END),0) AS fill4,
        AVG(CASE WHEN x.week>{w}-4 AND x.true_demand>0 THEN x.stockout END) AS stockout4,
        AVG(CASE WHEN x.week BETWEEN {w}-7 AND {w}-4 AND x.true_demand>0 THEN x.stockout END) AS stockout4_prev
        {base}""", sa)
    inv = one(con, f"""SELECT SUM(b.qty*d.cost) AS stock_value, SUM(b.qty) AS units,
        SUM(CASE WHEN julianday(b.expiry_date)-julianday(?) <= 180 THEN b.qty*d.cost END) AS exp180
        FROM batches b JOIN locations l USING(location_id) JOIN medicines d USING(sku_id) WHERE b.status='usable' {sc}""",
               [m["next_week"]] + sa)
    rec = one(con, f"""SELECT SUM(r.priority='urgent') AS urgent, SUM(r.priority='high') AS high, COUNT(*) AS open,
        SUM(r.status='awaiting_approval') AS awaiting, SUM(r.value) AS value
        FROM recommendations r JOIN locations l USING(location_id) WHERE r.status IN ('open','awaiting_approval') {sc}""", sa)
    trend = rows(con, f"""SELECT x.week, wk.week_start, SUM(x.sales) AS units, SUM(x.sales*d.mrp) AS value,
        SUM(x.stockout) AS stockouts {base.replace('WHERE', 'JOIN weeks wk ON wk.week=x.week WHERE')} AND x.week>{w}-26
        GROUP BY x.week ORDER BY x.week""", sa)
    fut = rows(con, f"""SELECT f.week, wk.week_start, SUM(f.p10) p10, SUM(f.p50) p50, SUM(f.p90) p90
        FROM forecast f JOIN locations l USING(location_id) JOIN weeks wk ON wk.week=f.week WHERE 1=1 {sc}
        GROUP BY f.week ORDER BY f.week""", sa)
    by_state = rows(con, f"""SELECT l.state, SUM(x.sales*d.mrp) AS value, SUM(x.sales) units, AVG(x.stockout) stockout
        {base} AND x.week>{w}-4 GROUP BY l.state ORDER BY value DESC""", sa)
    top_meds = rows(con, f"""SELECT d.sku_id, d.name, d.category, SUM(x.sales) units, SUM(x.sales*d.mrp) value
        {base} AND x.week>{w}-4 GROUP BY d.sku_id ORDER BY units DESC LIMIT 8""", sa)
    points = rows(con, f"""SELECT l.location_id, l.name, l.state, l.district, l.lat, l.lon, l.type, l.hill,
        SUM(CASE WHEN x.week>{w}-4 THEN x.sales*d.mrp END) value,
        (SELECT COUNT(*) FROM recommendations r WHERE r.location_id=l.location_id AND r.priority='urgent' AND r.status='open') urgent
        {base} GROUP BY l.location_id""", sa)
    actions = rows(con, f"""SELECT r.rec_id, r.priority, r.cover_days, r.lead_days, r.suggested_qty, r.transfer_qty, r.value,
        d.name AS medicine, l.name AS location, l.state FROM recommendations r JOIN locations l USING(location_id)
        JOIN medicines d USING(sku_id) WHERE r.status='open' AND r.priority='urgent' {sc}
        ORDER BY r.forecast_week*d.mrp DESC LIMIT 6""", sa)
    alerts = rows(con, f"""SELECT a.*, l.name AS location, d.name AS medicine FROM alerts a LEFT JOIN locations l USING(location_id)
        LEFT JOIN medicines d USING(sku_id) WHERE a.status='open' AND a.kind IN ('delay','expiry','demand_spike') {sc}
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 400""", sa)
    by_kind = {}
    for a in alerts:
        by_kind.setdefault(a["kind"], []).append(a)
    alerts = [a for grp in zip(*[g + [None] * 6 for g in by_kind.values()]) for a in grp if a][:6]
    impact = rows(con, "SELECT * FROM impact")
    return mask(u, [{"kpi": k, "inventory": inv, "recs": rec, "trend": trend, "forecast": fut, "by_state": by_state,
                     "top_medicines": top_meds, "points": points, "actions": actions, "alerts": alerts,
                     "impact": impact, "meta": m}])[0]


# ----------------------------------------------------------------------------- locations & medicines
def _loc_metrics(con, u, state=None, where="", args=()):
    w = meta(con)["as_of_week"]
    sc, sa = scope_sql(u, "l", state)
    return rows(con, f"""SELECT l.*, SUM(CASE WHEN x.week>{w}-4 THEN x.sales*d.mrp END) AS sales_value,
        SUM(CASE WHEN x.week>{w}-4 THEN x.sales END) AS units,
        SUM(CASE WHEN x.week BETWEEN {w}-7 AND {w}-4 THEN x.sales END) AS units_prev,
        AVG(CASE WHEN x.week>{w}-12 AND x.true_demand>0 THEN x.stockout END) AS stockout_rate,
        SUM(CASE WHEN x.week={w} THEN x.closing*d.cost END) AS stock_value,
        (SELECT COUNT(*) FROM alerts a WHERE a.location_id=l.location_id AND a.status='open') AS alerts,
        (SELECT COUNT(*) FROM recommendations r WHERE r.location_id=l.location_id AND r.status='open' AND r.priority='urgent') AS urgent
        FROM locations l JOIN weekly x USING(location_id) JOIN medicines d USING(sku_id)
        WHERE 1=1 {sc} {where} GROUP BY l.location_id ORDER BY sales_value DESC""", sa + list(args))


@app.get("/api/locations")
def locations(state: str | None = None, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    return mask(u, _loc_metrics(con, u, state))


@app.get("/api/locations/{lid}")
def location_detail(lid: str, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    info = _loc_metrics(con, u, None, "AND l.location_id=?", (lid,))
    if not info:
        raise HTTPException(404, "Location not found or outside your area")
    w = meta(con)["as_of_week"]
    trend = rows(con, f"""SELECT x.week, wk.week_start, SUM(x.sales) units, SUM(x.stockout) stockouts FROM weekly x
        JOIN weeks wk ON wk.week=x.week WHERE x.location_id=? AND x.week>{w}-26 GROUP BY x.week""", (lid,))
    top = rows(con, f"""SELECT d.sku_id, d.name, SUM(x.sales) units, SUM(x.stockout) stockout_weeks FROM weekly x
        JOIN medicines d USING(sku_id) WHERE x.location_id=? AND x.week>{w}-12 GROUP BY d.sku_id ORDER BY units DESC LIMIT 8""", (lid,))
    ontime = one(con, """SELECT COUNT(*) n, AVG(CASE WHEN julianday(eta)-julianday(order_date) <= l.lead_days+1 THEN 1.0 ELSE 0 END) rate,
        AVG(julianday(eta)-julianday(order_date)) avg_days FROM orders o JOIN locations l USING(location_id)
        WHERE o.location_id=? AND o.origin='history'""", (lid,))
    recs = rows(con, """SELECT r.*, d.name medicine FROM recommendations r JOIN medicines d USING(sku_id)
        WHERE r.location_id=? AND r.status='open' ORDER BY r.cover_days LIMIT 10""", (lid,))
    alerts = rows(con, "SELECT * FROM alerts WHERE location_id=? AND status='open' LIMIT 10", (lid,))
    return mask(u, [{"info": info[0], "trend": trend, "top_medicines": top, "delivery": ontime, "recs": recs, "alerts": alerts}])[0]


@app.get("/api/medicines")
def medicines(state: str | None = None, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    w = meta(con)["as_of_week"]
    sc, sa = scope_sql(u, "l", state)
    out = rows(con, f"""SELECT d.*, SUM(CASE WHEN x.week>{w}-4 THEN x.sales END) units,
        SUM(CASE WHEN x.week BETWEEN {w}-7 AND {w}-4 THEN x.sales END) units_prev,
        SUM(CASE WHEN x.week>{w}-4 THEN x.sales*d.mrp END) sales_value,
        SUM(CASE WHEN x.week={w} THEN x.closing END) on_hand,
        AVG(CASE WHEN x.week>{w}-12 AND x.true_demand>0 THEN x.stockout END) stockout_rate,
        (SELECT SUM(p50) FROM forecast f JOIN locations l2 USING(location_id) WHERE f.sku_id=d.sku_id AND f.horizon<=4 {sc.replace('l.', 'l2.')}) forecast4
        FROM medicines d JOIN weekly x USING(sku_id) JOIN locations l USING(location_id) WHERE 1=1 {sc}
        GROUP BY d.sku_id ORDER BY units DESC""", sa + sa)
    return mask(u, out)


@app.get("/api/medicines/{sid}")
def medicine_detail(sid: str, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    w = meta(con)["as_of_week"]
    sc, sa = scope_sql(u)
    info = one(con, "SELECT * FROM medicines WHERE sku_id=?", (sid,))
    if not info:
        raise HTTPException(404, "Medicine not found")
    trend = rows(con, f"""SELECT x.week, wk.week_start, SUM(x.sales) units, SUM(x.stockout) stockouts FROM weekly x
        JOIN locations l USING(location_id) JOIN weeks wk ON wk.week=x.week WHERE x.sku_id=? AND x.week>{w}-52 {sc}
        GROUP BY x.week""", [sid] + sa)
    fut = rows(con, f"""SELECT f.week, wk.week_start, SUM(p10) p10, SUM(p50) p50, SUM(p90) p90 FROM forecast f
        JOIN locations l USING(location_id) JOIN weeks wk ON wk.week=f.week WHERE f.sku_id=? {sc} GROUP BY f.week""", [sid] + sa)
    markets = rows(con, f"""SELECT l.location_id, l.name, l.state, SUM(CASE WHEN x.week>{w}-4 THEN x.sales END) units,
        SUM(CASE WHEN x.week={w} THEN x.closing END) on_hand,
        (SELECT p50 FROM forecast f WHERE f.sku_id=x.sku_id AND f.location_id=l.location_id AND f.horizon=1) forecast_week
        FROM weekly x JOIN locations l USING(location_id) WHERE x.sku_id=? {sc} GROUP BY l.location_id ORDER BY units DESC""",
                   [sid] + sa)
    return mask(u, [{"info": info, "trend": trend, "forecast": fut, "markets": markets}])[0]


# ----------------------------------------------------------------------------- inventory & expiry
@app.get("/api/inventory")
def inventory(state: str | None = None, status: str | None = None, q: str | None = None, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    sc, sa = scope_sql(u, "l", state)
    nw = meta(con)["next_week"]
    out = rows(con, f"""SELECT d.sku_id, d.name medicine, d.category, d.velocity, l.location_id, l.name location, l.state,
        COALESCE(b.qty,0) on_hand, COALESCE(b.qty,0)*d.cost stock_value, b.nearest_expiry,
        f.p50 forecast_week, COALESCE(o.qty,0) on_order
        FROM medicines d CROSS JOIN locations l
        LEFT JOIN (SELECT sku_id, location_id, SUM(qty) qty, MIN(expiry_date) nearest_expiry FROM batches WHERE status='usable'
                   GROUP BY 1,2) b ON b.sku_id=d.sku_id AND b.location_id=l.location_id
        LEFT JOIN forecast f ON f.sku_id=d.sku_id AND f.location_id=l.location_id AND f.horizon=1
        LEFT JOIN (SELECT sku_id, location_id, SUM(qty) qty FROM orders WHERE status IN ('approved','dispatched','in_transit','delayed')
                   GROUP BY 1,2) o ON o.sku_id=d.sku_id AND o.location_id=l.location_id
        WHERE 1=1 {sc} {"AND (d.name LIKE ? OR l.name LIKE ?)" if q else ""}""", sa + ([f"%{q}%"] * 2 if q else []))
    for r in out:
        rate = max(r["forecast_week"] or 0, 0.05)
        r["cover_weeks"] = round(r["on_hand"] / rate, 1)
        r["days_to_expiry"] = (date.fromisoformat(r["nearest_expiry"]) - date.fromisoformat(nw)).days if r["nearest_expiry"] else None
        r["status"] = ("out" if r["on_hand"] <= 0 and rate >= 0.5 else "low" if r["cover_weeks"] < 2 else
                       "excess" if r["cover_weeks"] > 12 and r["velocity"] != "slow" else "ok")
    summary = {s: sum(1 for r in out if r["status"] == s) for s in ("out", "low", "ok", "excess")}
    if status:
        out = [r for r in out if r["status"] == status]
    out.sort(key=lambda r: ({"out": 0, "low": 1, "excess": 2, "ok": 3}[r["status"]], r["cover_weeks"]))
    return {"summary": summary, "items": mask(u, out)}


@app.get("/api/expiry")
def expiry(state: str | None = None, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    m = meta(con)
    sc, sa = scope_sql(u, "l", state)
    nw = date.fromisoformat(m["next_week"])
    min_shelf = setting(con, "min_shelf_days", m["min_shelf_days"])
    w = m["as_of_week"]
    out = rows(con, f"""SELECT b.*, d.name medicine, d.cost, l.name location, l.state,
        MAX(f.p50, COALESCE(a.avg12, 0)) forecast_week
        FROM batches b JOIN medicines d USING(sku_id) JOIN locations l USING(location_id)
        LEFT JOIN forecast f ON f.sku_id=b.sku_id AND f.location_id=b.location_id AND f.horizon=1
        LEFT JOIN (SELECT sku_id, location_id, AVG(sales) avg12 FROM weekly WHERE week>{w}-12 GROUP BY 1,2) a
          ON a.sku_id=b.sku_id AND a.location_id=b.location_id
        WHERE b.status IN ('usable','held') AND julianday(b.expiry_date)-julianday(?) <= 365 {sc}""", [str(nw)] + sa)
    # demand elsewhere, to suggest where near-expiry stock could be moved
    need = rows(con, """SELECT r.sku_id, r.location_id, l.name, r.target_stock - r.on_hand - r.on_order AS gap
        FROM recommendations r JOIN locations l USING(location_id) WHERE r.status='open' ORDER BY gap DESC""")
    best = {}
    for n in need:
        best.setdefault(n["sku_id"], n)
    for r in out:
        days = (date.fromisoformat(r["expiry_date"]) - nw).days
        sell_days = max(days - min_shelf, 0)
        r["days_to_expiry"] = days
        r["sellable_days"] = sell_days
        r["value"] = round(r["qty"] * r["cost"], 2)
        r["projected_sales"] = round((r["forecast_week"] or 0) * sell_days / 7)
        r["at_risk_units"] = max(r["qty"] - r["projected_sales"], 0)
        r["at_risk_value"] = round(r["at_risk_units"] * r["cost"], 2)
        alt = best.get(r["sku_id"])
        if r["at_risk_units"] <= 0:
            r["action"] = "Sell first (FEFO)" if sell_days <= 90 else "No action"
        elif sell_days <= 0:
            r["action"] = "Return to depot / approved disposal"
        elif alt and alt["location_id"] != r["location_id"] and alt["gap"] > 0:
            r["action"] = f"Transfer {min(r['at_risk_units'], int(alt['gap']))} to {alt['name']}"
        else:
            r["action"] = "Offer to stockists / return before expiry"
        r["bucket"] = "≤30" if days <= 30 else "31-60" if days <= 60 else "61-90" if days <= 90 else "91-180" if days <= 180 else "181-365"
    buckets = {}
    for r in out:
        bk = buckets.setdefault(r["bucket"], {"bucket": r["bucket"], "batches": 0, "units": 0, "value": 0.0, "at_risk_value": 0.0})
        bk["batches"] += 1; bk["units"] += r["qty"]; bk["value"] += r["value"]; bk["at_risk_value"] += r["at_risk_value"]
    out.sort(key=lambda r: (-r["at_risk_value"], r["days_to_expiry"]))
    order = ["≤30", "31-60", "61-90", "91-180", "181-365"]
    return {"buckets": mask(u, [buckets[b] for b in order if b in buckets]), "items": mask(u, out[:600]),
            "min_shelf_days": min_shelf}


# ----------------------------------------------------------------------------- forecasting
@app.get("/api/forecast")
def forecast(sku: str, loc: str | None = None, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    w = meta(con)["as_of_week"]
    sc, sa = scope_sql(u)
    lf, la = ("AND x.location_id=?", [loc]) if loc else ("", [])
    hist = rows(con, f"""SELECT x.week, wk.week_start, SUM(x.sales) sales, SUM(x.true_demand) demand, MAX(x.stockout) stockout,
        SUM(x.stockout) stockout_n FROM weekly x JOIN locations l USING(location_id) JOIN weeks wk ON wk.week=x.week
        WHERE x.sku_id=? {lf} AND x.week>{w}-52 {sc} GROUP BY x.week ORDER BY x.week""", [sku] + la + sa)
    bt = {r["week"]: r for r in rows(con, f"""SELECT x.week, SUM(p10) p10, SUM(p50) p50, SUM(p90) p90, SUM(ma8) ma8
        FROM forecast_backtest x JOIN locations l USING(location_id) WHERE x.sku_id=? {lf} {sc} GROUP BY x.week""", [sku] + la + sa)}
    for h in hist:
        h.update({k: bt.get(h["week"], {}).get(k) for k in ("p10", "p50", "p90", "ma8")})
    fut = rows(con, f"""SELECT x.week, wk.week_start, SUM(p10) p10, SUM(p50) p50, SUM(p90) p90 FROM forecast x
        JOIN locations l USING(location_id) JOIN weeks wk ON wk.week=x.week WHERE x.sku_id=? {lf} {sc}
        GROUP BY x.week ORDER BY x.week""", [sku] + la + sa)
    adj = rows(con, "SELECT * FROM forecast_adjustments WHERE sku_id=? AND (location_id=? OR ?) ORDER BY ts DESC",
               (sku, loc, loc is None))
    if adj and loc:
        f = 1 + adj[0]["pct"] / 100
        for r in fut:
            r["adjusted"] = round(r["p50"] * f, 1)
    # accuracy per series on weeks where stock was available (what a pilot can actually measure), summed
    acc = one(con, f"""SELECT SUM(ABS(f.p50 - x.sales)) e_ml, SUM(ABS(f.ma8 - x.sales)) e_ma, SUM(x.sales) tot,
        AVG(CASE WHEN x.sales BETWEEN f.p10 AND f.p90 THEN 1.0 ELSE 0 END) hit, COUNT(*) n
        FROM forecast_backtest f JOIN weekly x ON x.sku_id=f.sku_id AND x.location_id=f.location_id AND x.week=f.week
        JOIN locations l ON l.location_id=f.location_id WHERE f.sku_id=? {lf.replace('x.', 'f.')} AND x.stockout=0 {sc}""",
              [sku] + la + sa)
    tot = acc["tot"] or 1
    acc_ml, acc_ma, inside = 1 - (acc["e_ml"] or 0) / tot, 1 - (acc["e_ma"] or 0) / tot, acc["hit"] or 0
    drivers = []
    med = one(con, "SELECT * FROM medicines WHERE sku_id=?", (sku,))
    if med:
        if med["season"] != "flat":
            drivers.append(f"{med['season'].capitalize()}-season medicine: demand rises in "
                           + ("June-September" if med["season"] == "monsoon" else "December-February"))
        drivers.append({"fast": "Fast-moving", "med": "Medium-moving", "slow": "Slow, intermittent"}[med["velocity"]] + " demand")
    so = sum(h["stockout_n"] for h in hist)
    if so:
        drivers.append(f"{so} stock-out weeks in the last year were treated as unknown demand, not low demand")
    fest = rows(con, f"SELECT week_start, festival FROM weeks WHERE festival!='' AND week>{w} LIMIT 3")
    for f_ in fest:
        drivers.append(f"Festival week ahead: {f_['festival']} ({f_['week_start']})")
    return {"history": hist, "future": fut, "adjustments": adj,
            "accuracy": {"model": acc_ml, "baseline": acc_ma, "interval_hit": inside, "weeks": acc["n"]}, "drivers": drivers}


@app.post("/api/forecast/adjust")
def forecast_adjust(body: dict = Body(...), x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    if u["role"] == "viewer":
        raise HTTPException(403, "Read-only role")
    if not body.get("reason"):
        raise HTTPException(400, "A reason is required for every forecast change")
    con.execute("INSERT INTO forecast_adjustments VALUES (?,?,?,?,?,?)",
                (body["sku"], body["loc"], float(body["pct"]), body["reason"], u["name"], datetime.now().isoformat(timespec="seconds")))
    audit(con, u, "forecast_adjust", f"{body['sku']}@{body['loc']}", f"{body['pct']:+}% - {body['reason']}")
    con.commit()
    return {"ok": True}


@app.get("/api/forecast/reliability")
def reliability(x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    sc, sa = scope_sql(u)
    out = rows(con, f"""SELECT f.sku_id, d.name medicine, f.location_id, l.name location, l.state,
        SUM(ABS(f.p50 - x.sales)) / NULLIF(SUM(x.sales),0) wape_model, SUM(ABS(f.ma8 - x.sales)) / NULLIF(SUM(x.sales),0) wape_base,
        SUM(f.p50 - x.sales) / NULLIF(SUM(x.sales),0) bias, SUM(x.sales) units
        FROM forecast_backtest f JOIN weekly x ON x.sku_id=f.sku_id AND x.location_id=f.location_id AND x.week=f.week
        JOIN medicines d ON d.sku_id=f.sku_id JOIN locations l ON l.location_id=f.location_id
        WHERE x.stockout=0 {sc} GROUP BY f.sku_id, f.location_id HAVING units > 200 ORDER BY wape_model DESC LIMIT 25""", sa)
    return out


# ----------------------------------------------------------------------------- recommendations
@app.get("/api/recommendations")
def recommendations(state: str | None = None, status: str = "open", priority: str | None = None,
                    q: str | None = None, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    sc, sa = scope_sql(u, "l", state)
    st = {"open": ("open", "awaiting_approval"), "done": ("approved", "modified", "rejected", "postponed")}.get(status, (status,))
    out = rows(con, f"""SELECT r.*, d.name medicine, d.category, d.cost, d.case_pack, d.velocity, l.name location, l.state,
        l.district, l.hill, t.name transfer_from_name FROM recommendations r JOIN medicines d USING(sku_id)
        JOIN locations l USING(location_id) LEFT JOIN locations t ON t.location_id=r.transfer_from
        WHERE r.status IN ({','.join('?' * len(st))}) {sc} {"AND r.priority=?" if priority else ""}
        {"AND (d.name LIKE ? OR l.name LIKE ?)" if q else ""}
        ORDER BY CASE r.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, r.cover_days""",
               list(st) + sa + ([priority] if priority else []) + ([f"%{q}%"] * 2 if q else []))
    return mask(u, out)


def _decide(con, u, rid, action, qty=None, note="", use_transfer=True):
    r = one(con, """SELECT r.*, l.state, l.hill, l.name location, d.name medicine, d.cost FROM recommendations r
        JOIN locations l USING(location_id) JOIN medicines d USING(sku_id) WHERE rec_id=?""", (rid,))
    if not r:
        raise HTTPException(404, "Recommendation not found")
    if u["role"] == "viewer":
        raise HTTPException(403, "Read-only role cannot approve")
    if u["states"] and r["state"] not in u["states"]:
        raise HTTPException(403, "Outside your assigned states")
    if r["status"] not in ("open", "awaiting_approval"):
        raise HTTPException(409, f"Already {r['status']}")
    if action in ("modify", "reject", "postpone") and not note:
        raise HTTPException(400, "Please give a reason")
    limit = setting(con, "approval_limit", meta(con)["approval_limit"])
    now = datetime.now().isoformat(timespec="seconds")
    if action in ("approve", "modify"):
        q = int(qty if qty is not None else r["suggested_qty"])
        value = q * r["cost"]
        if value > limit and u["role"] not in ("head",) and r["status"] != "awaiting_approval":
            con.execute("UPDATE recommendations SET status='awaiting_approval', decided_qty=?, decided_by=?, decided_at=?, decision_note=? WHERE rec_id=?",
                        (q, u["name"], now, note or f"Above ₹{limit:,.0f} - sent to Head of Supply Chain", rid))
            audit(con, u, "submit_for_approval", rid, f"{r['medicine']} @ {r['location']}: {q} units, ₹{value:,.0f}")
            return "awaiting_approval"
        if r["status"] == "awaiting_approval" and u["role"] != "head":
            raise HTTPException(403, "Only the Head of Supply Chain can approve orders above the limit")
        t = today(con)
        if use_transfer and r["transfer_from"] and r["transfer_qty"]:
            con.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (f"TR-{uuid.uuid4().hex[:6].upper()}", "transfer", r["sku_id"], r["location_id"], r["transfer_from"],
                         int(r["transfer_qty"]), str(t), str(t + timedelta(days=7 if r["hill"] else 4)),
                         "approved", note, "planner", rid, u["name"], now))
        if q > 0:
            con.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (f"RO-{uuid.uuid4().hex[:6].upper()}", "replenishment", r["sku_id"], r["location_id"], "Rani C&F depot",
                         q, str(t), str(t + timedelta(days=int(r["lead_days"]))), "approved", note, "planner", rid, u["name"], now))
        status = "approved" if action == "approve" and q == r["suggested_qty"] else "modified"
        con.execute("UPDATE recommendations SET status=?, decided_qty=?, decided_by=?, decided_at=?, decision_note=? WHERE rec_id=?",
                    (status, q, u["name"], now, note, rid))
        audit(con, u, status, rid, f"{r['medicine']} @ {r['location']}: order {q}"
              + (f" + transfer {r['transfer_qty']}" if use_transfer and r["transfer_qty"] else "") + (f" - {note}" if note else ""))
        con.execute("UPDATE alerts SET status='resolved' WHERE sku_id=? AND location_id=? AND kind IN ('stockout','stockout_risk')",
                    (r["sku_id"], r["location_id"]))
        return status
    if action in ("reject", "postpone"):
        status = "rejected" if action == "reject" else "postponed"
        con.execute("UPDATE recommendations SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE rec_id=?",
                    (status, u["name"], now, note, rid))
        audit(con, u, status, rid, f"{r['medicine']} @ {r['location']} - {note}")
        return status
    raise HTTPException(400, "Unknown action")


@app.post("/api/recommendations/{rid}/decision")
def decide(rid: str, body: dict = Body(...), x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    status = _decide(con, u, rid, body.get("action"), body.get("qty"), body.get("note", ""), body.get("use_transfer", True))
    con.commit()
    return {"status": status}


@app.post("/api/recommendations/bulk")
def decide_bulk(body: dict = Body(...), x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    res = {}
    for rid in body.get("ids", []):
        try:
            res[rid] = _decide(con, u, rid, body.get("action", "approve"), None, body.get("note", ""))
        except HTTPException as e:
            res[rid] = f"skipped: {e.detail}"
    con.commit()
    return res


# ----------------------------------------------------------------------------- orders & transfers
NEXT = {"approved": "dispatched", "dispatched": "in_transit", "in_transit": "received", "delayed": "received"}


@app.get("/api/orders")
def orders(status: str | None = None, kind: str | None = None, origin: str | None = None,
           x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    sc, sa = scope_sql(u)
    out = rows(con, f"""SELECT o.*, d.name medicine, d.cost, o.qty*d.cost value, l.name location, l.state,
        COALESCE(s.name, o.source) source_name FROM orders o JOIN medicines d USING(sku_id) JOIN locations l USING(location_id)
        LEFT JOIN locations s ON s.location_id=o.source WHERE 1=1 {sc}
        {"AND o.status=?" if status else ""} {"AND o.kind=?" if kind else ""} {"AND o.origin=?" if origin else ""}
        ORDER BY (o.origin='planner') DESC, o.order_date DESC LIMIT 800""",
               sa + [x for x in (status, kind, origin) if x])
    summary = rows(con, f"""SELECT o.status, COUNT(*) n, SUM(o.qty*d.cost) value FROM orders o JOIN medicines d USING(sku_id)
        JOIN locations l USING(location_id) WHERE 1=1 {sc} GROUP BY o.status""", sa)
    return {"items": mask(u, out), "summary": mask(u, summary)}


@app.post("/api/orders/{oid}/advance")
def advance(oid: str, body: dict = Body(default={}), x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    if u["role"] == "viewer":
        raise HTTPException(403, "Read-only role")
    o = one(con, "SELECT o.*, d.shelf_life_months FROM orders o JOIN medicines d USING(sku_id) WHERE order_id=?", (oid,))
    if not o:
        raise HTTPException(404, "Order not found")
    new = body.get("status") or NEXT.get(o["status"])
    if not new:
        raise HTTPException(409, f"Order is already {o['status']}")
    now = datetime.now().isoformat(timespec="seconds")
    if new == "received":
        t = today(con)
        if o["kind"] == "transfer":       # take stock from the source location, earliest expiry first
            left = o["qty"]
            src_exp = None
            for b in rows(con, "SELECT * FROM batches WHERE sku_id=? AND location_id=? AND status='usable' ORDER BY expiry_date",
                          (o["sku_id"], o["source"])):
                take = min(left, b["qty"])
                con.execute("UPDATE batches SET qty=qty-? WHERE batch_id=?", (take, b["batch_id"]))
                src_exp = src_exp or b["expiry_date"]
                left -= take
                if left <= 0:
                    break
            expiry_d = src_exp or str(t + timedelta(days=180))
        else:
            expiry_d = str(t + timedelta(days=int(o["shelf_life_months"] * 30 * 0.6)))
        qty = int(body.get("received_qty", o["qty"]))
        con.execute("INSERT INTO batches VALUES (?,?,?,?,?,?,?,?)",
                    (f"B{uuid.uuid4().hex[:6].upper()}", o["sku_id"], o["location_id"], qty,
                     str(t - timedelta(days=30)), expiry_d, str(t), "usable"))
        if qty != o["qty"]:
            con.execute("UPDATE orders SET note=? WHERE order_id=?", (f"Short receipt: {qty} of {o['qty']}", oid))
    con.execute("UPDATE orders SET status=?, updated_at=? WHERE order_id=?", (new, now, oid))
    audit(con, u, f"order_{new}", oid, f"{o['kind']} {o['qty']} units")
    con.commit()
    return {"status": new}


# ----------------------------------------------------------------------------- alerts
@app.get("/api/alerts")
def alerts(status: str = "open", kind: str | None = None, x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    sc, sa = scope_sql(u)
    return rows(con, f"""SELECT a.*, l.name location, l.state, d.name medicine FROM alerts a
        LEFT JOIN locations l USING(location_id) LEFT JOIN medicines d USING(sku_id)
        WHERE a.status=? {sc} {"AND a.kind=?" if kind else ""}
        ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, a.alert_id""",
                [status] + sa + ([kind] if kind else []))


@app.post("/api/alerts/{aid}")
def alert_update(aid: str, body: dict = Body(...), x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    if u["role"] == "viewer":
        raise HTTPException(403, "Read-only role")
    con.execute("UPDATE alerts SET status=COALESCE(?, status), assigned_to=COALESCE(?, assigned_to) WHERE alert_id=?",
                (body.get("status"), body.get("assigned_to"), aid))
    audit(con, u, "alert_update", aid, json.dumps(body))
    con.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- what-if
@app.post("/api/whatif")
def whatif(body: dict = Body(...), x_user: str | None = Header(None)):
    """Monte-Carlo projection of 8 weeks of stock for one medicine at one location under a scenario."""
    con = db()
    user_of(con, x_user)
    sku, lid = body["sku"], body["loc"]
    demand_pct = float(body.get("demand_pct", 0)) / 100
    delay = float(body.get("delay_days", 0))
    order_qty = float(body.get("order_qty", 0))
    order_in = float(body.get("order_in_days", 0))
    transfer_qty = float(body.get("transfer_qty", 0))
    supply_pct = float(body.get("supply_pct", 100)) / 100
    loc = one(con, "SELECT * FROM locations WHERE location_id=?", (lid,))
    med = one(con, "SELECT * FROM medicines WHERE sku_id=?", (sku,))
    if not loc or not med:
        raise HTTPException(404, "Unknown medicine or location")
    fc = rows(con, "SELECT * FROM forecast WHERE sku_id=? AND location_id=? ORDER BY horizon", (sku, lid))
    t = today(con)
    on_hand = one(con, "SELECT COALESCE(SUM(qty),0) q FROM batches WHERE sku_id=? AND location_id=? AND status='usable'", (sku, lid))["q"]
    arrivals = np.zeros(9)
    for o in rows(con, """SELECT qty, eta FROM orders WHERE sku_id=? AND location_id=? AND status IN
                       ('approved','dispatched','in_transit','delayed')""", (sku, lid)):
        wk = max(0, int(np.floor(((date.fromisoformat(o["eta"]) - t).days + delay) / 7)))
        if wk > 8:
            continue
        arrivals[wk] += o["qty"]
    if order_qty:
        wk = int(np.floor((order_in + loc["lead_days"] + delay) / 7))
        if wk <= 8:
            arrivals[wk] += order_qty * supply_pct
    if transfer_qty:
        arrivals[1 if not loc["hill"] else 2] += transfer_qty
    p10 = np.array([f["p10"] for f in fc]); p50 = np.array([f["p50"] for f in fc]); p90 = np.array([f["p90"] for f in fc])
    mu = p50 * (1 + demand_pct)
    sigma = np.maximum((p90 - p10) / 2.56, 0.3) * (1 + demand_pct)
    rng = np.random.default_rng(0)
    sims = 2000
    dem = np.maximum(rng.normal(mu, sigma, (sims, 8)), 0)
    stock = np.full(sims, float(on_hand))
    path, lost, served = [], np.zeros(sims), np.zeros(sims)
    for k in range(8):                       # arrivals[k] lands at the start of week k (0 = this week)
        stock = stock + arrivals[k]
        s = np.minimum(stock, dem[:, k])
        lost += dem[:, k] - s
        served += s
        stock -= s
        path.append(stock.copy())
    path = np.array(path).T
    weeks = rows(con, f"SELECT week_start FROM weeks WHERE week > {meta(con)['as_of_week']} ORDER BY week LIMIT 8")
    p_out = (path <= 0.5).mean(0)
    end_cover = np.median(path[:, -1]) / max(mu[-1], 0.1)
    holding = float(np.median(path.mean(1)) * med["cost"] * CARRY_RATE * 8 / 52)
    lost_margin = float(lost.mean() * (med["mrp"] - med["cost"]))
    return {
        "weeks": [w_["week_start"] for w_ in weeks], "demand": mu.round(1).tolist(),
        "stock_p10": np.percentile(path, 10, 0).round(1).tolist(), "stock_p50": np.percentile(path, 50, 0).round(1).tolist(),
        "stock_p90": np.percentile(path, 90, 0).round(1).tolist(), "stockout_prob": p_out.round(3).tolist(),
        "arrivals": arrivals[:8].tolist(),
        "summary": {"on_hand": on_hand, "prob_any_stockout": float((path <= 0.5).any(1).mean()),
                    "expected_lost_units": float(lost.mean()), "fill_rate": float(served.sum() / max(dem.sum(), 1)),
                    "end_cover_weeks": float(end_cover), "order_cost": order_qty * med["cost"],
                    "holding_cost": holding, "lost_margin": lost_margin,
                    "expiry_risk": "high" if end_cover > 16 else "medium" if end_cover > 10 else "low"},
        "assumptions": [f"Demand follows the model forecast {'+' if demand_pct >= 0 else ''}{demand_pct:.0%}, with the model's uncertainty range",
                        f"Delivery to {loc['name']} takes {loc['lead_days']} days" + (f" + {delay:.0f} days delay" if delay else ""),
                        f"Supplier delivers {supply_pct:.0%} of the ordered quantity" if order_qty else "No new order placed",
                        "Holding cost 18% a year; lost margin = MRP minus cost for each unit not supplied",
                        "2,000 simulated futures; results are estimates, not guarantees"],
    }


# ----------------------------------------------------------------------------- impact
@app.get("/api/impact")
def impact(x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    return {"metrics": rows(con, "SELECT * FROM impact"),
            "weekly": rows(con, "SELECT i.*, w.week_start FROM impact_weekly i JOIN weeks w USING(week)"),
            "meta": meta(con),
            "decisions": one(con, """SELECT SUM(status='approved') approved, SUM(status='modified') modified,
                SUM(status='rejected') rejected, SUM(status='postponed') postponed, SUM(status='awaiting_approval') awaiting,
                COUNT(*) total FROM recommendations""")}


# ----------------------------------------------------------------------------- data import
TEMPLATES = {
    "sales": ["week_start", "sku_id", "location_id", "qty_sold", "closing_stock"],
    "stock": ["sku_id", "location_id", "batch_id", "qty", "mfg_date", "expiry_date"],
    "medicines": ["sku_id", "name", "form", "category", "mrp", "case_pack", "shelf_life_months"],
}


@app.get("/api/templates/{kind}.csv")
def template(kind: str):
    if kind not in TEMPLATES:
        raise HTTPException(404)
    sample = ROOT / "samples" / f"{kind}_sample.csv"
    if sample.exists():
        return FileResponse(sample, media_type="text/csv", filename=f"{kind}_template.csv")
    return StreamingResponse(io.StringIO(",".join(TEMPLATES[kind]) + "\n"), media_type="text/csv")


@app.post("/api/upload")
async def upload(kind: str = Form(...), file: UploadFile = File(...), x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    if u["role"] == "viewer":
        raise HTTPException(403, "Read-only role")
    if kind not in TEMPLATES:
        raise HTTPException(400, "Unknown file type")
    text = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    cols = [c.strip() for c in (reader.fieldnames or [])]
    issues = []
    missing = [c for c in TEMPLATES[kind] if c not in cols]
    if missing:
        issues.append({"row": 1, "level": "error", "field": ",".join(missing), "message": "Missing required column(s)"})
    skus = {r[0] for r in con.execute("SELECT sku_id FROM medicines")}
    locs = {r[0] for r in con.execute("SELECT location_id FROM locations")}
    seen, n, t = set(), 0, today(con)
    min_shelf = setting(con, "min_shelf_days", meta(con)["min_shelf_days"])

    def num(v, row, field, allow_neg=False):
        try:
            x = float(v)
        except (TypeError, ValueError):
            issues.append({"row": row, "level": "error", "field": field, "message": f"'{v}' is not a number"}); return None
        if x < 0 and not allow_neg:
            issues.append({"row": row, "level": "error", "field": field, "message": f"Negative value {v}"})
        return x

    def day(v, row, field):
        try:
            return date.fromisoformat(v.strip())
        except (AttributeError, ValueError):
            issues.append({"row": row, "level": "error", "field": field, "message": f"'{v}' is not a date (use YYYY-MM-DD)"})

    if not missing:
        for i, r in enumerate(reader, start=2):
            n += 1
            r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
            if kind in ("sales", "stock"):
                if r["sku_id"] not in skus:
                    issues.append({"row": i, "level": "error", "field": "sku_id", "message": f"Unknown medicine code '{r['sku_id']}'"})
                if r["location_id"] not in locs:
                    issues.append({"row": i, "level": "error", "field": "location_id", "message": f"Unknown location '{r['location_id']}'"})
            if kind == "sales":
                key = (r["week_start"], r["sku_id"], r["location_id"])
                d = day(r["week_start"], i, "week_start")
                q = num(r["qty_sold"], i, "qty_sold")
                num(r["closing_stock"], i, "closing_stock")
                if d and d > t:
                    issues.append({"row": i, "level": "error", "field": "week_start", "message": "Date is in the future"})
                if q is not None and q > 5000:
                    issues.append({"row": i, "level": "warning", "field": "qty_sold", "message": f"Unusually large quantity {q:.0f} - please check"})
            elif kind == "stock":
                key = r["batch_id"]
                num(r["qty"], i, "qty")
                mfg, exp_ = day(r["mfg_date"], i, "mfg_date"), day(r["expiry_date"], i, "expiry_date")
                if mfg and exp_ and exp_ <= mfg:
                    issues.append({"row": i, "level": "error", "field": "expiry_date", "message": "Expiry date is before manufacturing date"})
                elif exp_ and (exp_ - t).days < 0:
                    issues.append({"row": i, "level": "error", "field": "expiry_date", "message": "Batch has already expired - block from dispatch"})
                elif exp_ and (exp_ - t).days < min_shelf:
                    issues.append({"row": i, "level": "warning", "field": "expiry_date", "message": f"Less than {min_shelf} days of shelf life left"})
            else:
                key = r["sku_id"]
                num(r["mrp"], i, "mrp"); num(r["case_pack"], i, "case_pack"); num(r["shelf_life_months"], i, "shelf_life_months")
                if r["sku_id"] in skus:
                    issues.append({"row": i, "level": "warning", "field": "sku_id", "message": "Existing medicine - will be updated"})
            if key in seen:
                issues.append({"row": i, "level": "error", "field": "-", "message": "Duplicate row"})
            seen.add(key)
    errors = sum(1 for x in issues if x["level"] == "error")
    warnings = len(issues) - errors
    status = "rejected" if missing else "needs_attention" if errors else "accepted"
    uid = f"UP-{uuid.uuid4().hex[:6].upper()}"
    con.execute("INSERT INTO uploads VALUES (?,?,?,?,?,?,?,?,?,?)",
                (uid, datetime.now().isoformat(timespec="seconds"), u["name"], file.filename, kind, n, errors, warnings,
                 status, json.dumps(issues[:200])))
    audit(con, u, "upload", uid, f"{file.filename}: {n} rows, {errors} errors, {warnings} warnings")
    con.commit()
    return {"upload_id": uid, "rows": n, "errors": errors, "warnings": warnings, "status": status, "issues": issues[:200]}


@app.get("/api/uploads")
def uploads(x_user: str | None = Header(None)):
    con = db()
    user_of(con, x_user)
    sources = [
        {"source": "Depot dispatches (ERP export)", "last": meta(con)["data_through"], "frequency": "Daily", "status": "ok"},
        {"source": "Stockist sales & closing stock", "last": meta(con)["data_through"], "frequency": "Weekly", "status": "ok"},
        {"source": "Batch & expiry register", "last": meta(con)["data_through"], "frequency": "Weekly", "status": "ok"},
        {"source": "Field team demand notes", "last": None, "frequency": "As reported", "status": "not connected"},
    ]
    return {"uploads": rows(con, "SELECT * FROM uploads ORDER BY ts DESC"), "sources": sources}


# ----------------------------------------------------------------------------- admin
@app.get("/api/audit")
def audit_log(x_user: str | None = Header(None)):
    con = db()
    user_of(con, x_user)
    return rows(con, "SELECT * FROM audit ORDER BY ts DESC LIMIT 300")


@app.get("/api/settings")
def get_settings(x_user: str | None = Header(None)):
    con = db()
    user_of(con, x_user)
    m = meta(con)
    return {"approval_limit": setting(con, "approval_limit", m["approval_limit"]),
            "min_shelf_days": setting(con, "min_shelf_days", m["min_shelf_days"]),
            "expiry_alert_days": setting(con, "expiry_alert_days", m["expiry_alert_days"]),
            "safety_factor": m["safety_factor"], "monsoon_buffer_days": m["monsoon_buffer_days"]}


@app.post("/api/settings")
def set_settings(body: dict = Body(...), x_user: str | None = Header(None)):
    con = db()
    u = user_of(con, x_user)
    if u["role"] != "head":
        raise HTTPException(403, "Only the Head of Supply Chain can change settings")
    for k in ("approval_limit", "min_shelf_days", "expiry_alert_days"):
        if k in body:
            con.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (k, json.dumps(float(body[k]))))
            audit(con, u, "setting", k, str(body[k]))
    con.commit()
    return {"ok": True}


# ----------------------------------------------------------------------------- CSV export
@app.get("/api/export/{name}.csv")
def export(name: str, x_user: str | None = None, state: str | None = None):
    data = {"recommendations": lambda: recommendations(state=state, x_user=x_user),
            "inventory": lambda: inventory(state=state, x_user=x_user)["items"],
            "expiry": lambda: expiry(state=state, x_user=x_user)["items"],
            "orders": lambda: orders(x_user=x_user)["items"],
            "alerts": lambda: alerts(x_user=x_user)}.get(name)
    if not data:
        raise HTTPException(404)
    items = data()
    buf = io.StringIO()
    if items:
        w = csv.DictWriter(buf, fieldnames=list(items[0].keys()))
        w.writeheader()
        w.writerows(items)
    buf.seek(0)
    return StreamingResponse(buf, media_type="text/csv",
                             headers={"Content-Disposition": f"attachment; filename={name}_{date.today()}.csv"})


@app.get("/api/health")
def health():
    return {"ok": DB_PATH.exists()}


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
