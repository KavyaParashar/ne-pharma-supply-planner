"""One command that produces everything the app needs:  python -m server.build

1. Generate the synthetic network, demand and operational shocks.
2. Replay today's manual ordering for 104 weeks -> this is the "company history" shown in the app.
3. Train the forecaster on year 1 only, replay the planner on year 2 over the same demand -> impact numbers.
4. Retrain on all 104 weeks, forecast the next 8 weeks and produce this week's recommendations,
   transfer suggestions, expiry actions and alerts.
5. Write it all to one SQLite file (data/nepd.db).
"""
from __future__ import annotations

import json
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np

from . import model, sim
from .sim import BACKTEST_START, MIN_SHELF_WEEKS, PLANNER, WEEKS

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "nepd.db"
SCHEMA = (Path(__file__).parent / "schema.sql").read_text()
APPROVAL_LIMIT = 10000


def wdate(w) -> str:
    return str(sim.START + np.timedelta64(int(round(float(w) * 7)), "D"))


def build(db_path: Path = DB_PATH, log=print):
    t0 = time.time()
    net, demand, sh = sim.generate()
    N, S, L = net.N, net.S, net.L
    si, li = net.si(), net.li()
    sku, loc = net.sku, net.loc
    cost = sku["unit_cost_inr"][si]
    log(f"[1/5] network: {S} medicines x {L} locations x {WEEKS} weeks")

    manual = sim.run_policy(net, demand, sh, "manual")
    log("[2/5] manual policy replayed")

    fc_bt = model.Forecaster(net).fit(manual.sales, manual.stockout, BACKTEST_START - 1, horizons=range(1, 5))
    planner = sim.run_policy(net, demand, sh, "planner", forecaster=fc_bt.as_policy_callback())
    hist = {"p10": [], "p50": [], "p90": [], "ma8": []}
    for t in range(BACKTEST_START - 1, WEEKS - 1):          # one-week-ahead forecasts made on the real history
        p10, p50, p90 = fc_bt.predict(manual.sales, manual.stockout, t, [1])
        hist["p10"].append(p10[:, 0]); hist["p50"].append(p50[:, 0]); hist["p90"].append(p90[:, 0])
        hist["ma8"].append(model.moving_average(manual.sales, t))
    hist = {k: np.array(v).T for k, v in hist.items()}      # [N, 52] for target weeks 52..103
    log(f"[3/5] backtest done ({time.time() - t0:.0f}s)")

    fc = model.Forecaster(net).fit(manual.sales, manual.stockout, WEEKS - 1, horizons=range(1, 9))
    f10, f50, f90 = fc.predict(manual.sales, manual.stockout, WEEKS - 1, range(1, 9))
    log(f"[4/5] production model trained on {fc.n_train:,} rows")

    if db_path.exists():
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.executescript(SCHEMA)
    ins = lambda table, rows: con.executemany(
        f"INSERT INTO {table} VALUES ({','.join('?' * len(rows[0]))})", rows) if rows else None

    # ---------------- masters
    ins("medicines", [(sku["sku_id"][s], sku["generic_name"][s], sku["dosage_form"][s], sku["therapeutic_class"][s],
                       sku["season_profile"][s], sku["velocity"][s], float(sku["mrp_inr"][s]),
                       float(sku["unit_cost_inr"][s]), int(sku["case_pack"][s]), int(sku["shelf_life_months"][s]),
                       "active") for s in range(S)])
    ins("locations", [(loc["location_id"][l], loc["name"][l], loc["location_type"][l], loc["state"][l],
                       loc["district"][l], int(loc["hill"][l]), int(loc["base_lead_days"][l]),
                       float(loc["lat"][l]), float(loc["lon"][l]), "active") for l in range(L)])
    ins("weeks", [(w, wdate(w), int(net.cal["month"][w]), int(net.cal["monsoon"][w]), net.cal["festival"][w])
                  for w in range(WEEKS + 8)])

    # ---------------- weekly history (what the company actually observed)
    rows = []
    for n in range(N):
        s_id, l_id = sku["sku_id"][si[n]], loc["location_id"][li[n]]
        for w in range(WEEKS):
            rows.append((s_id, l_id, w, int(manual.sales[n, w]), int(manual.close[n, w]),
                         int(manual.stockout[n, w]), int(manual.expired[n, w]), int(demand[n, w])))
    ins("weekly", rows)

    # ---------------- forecasts: next 8 weeks + backtest one-week-ahead
    ins("forecast", [(sku["sku_id"][si[n]], loc["location_id"][li[n]], WEEKS + h, h + 1,
                      round(float(f10[n, h]), 2), round(float(f50[n, h]), 2), round(float(f90[n, h]), 2))
                     for n in range(N) for h in range(8)])
    ins("forecast_backtest", [(sku["sku_id"][si[n]], loc["location_id"][li[n]], BACKTEST_START + j,
                               round(float(hist["p10"][n, j]), 2), round(float(hist["p50"][n, j]), 2),
                               round(float(hist["p90"][n, j]), 2), round(float(hist["ma8"][n, j]), 2))
                              for n in range(N) for j in range(hist["p50"].shape[1])])

    # ---------------- batches on hand + orders history / in transit
    batch_rows, order_rows = [], []
    inv, exp, arr = manual.inv, manual.exp, manual.arr
    bid = 0
    for n in range(N):
        for slot in np.where((inv[n] > 0) & (arr <= WEEKS - 1))[0]:
            bid += 1
            e = exp[n, slot]
            life_w = sku["shelf_life_months"][si[n]] * 4.33
            batch_rows.append((f"B{bid:06d}", sku["sku_id"][si[n]], loc["location_id"][li[n]], int(inv[n, slot]),
                               wdate(e - life_w), wdate(e), wdate(min(arr[slot], WEEKS - 1)), "usable"))
    ins("batches", batch_rows)
    for i, (n, ow, aw, lead, q, slide, e, life, kind, src) in enumerate(manual.shipments):
        if ow < WEEKS - 16 and aw < WEEKS - 1:
            continue                                         # keep the last 16 weeks of history
        status = "received" if aw <= WEEKS - 1 else ("delayed" if slide else "in_transit")
        order_rows.append((f"RO-{26000 + i}", "replenishment", sku["sku_id"][si[n]], loc["location_id"][li[n]],
                           "Rani C&F depot", int(q), wdate(ow), wdate(ow + lead / 7), status,
                           "route disruption (landslide)" if slide else "", "history", None, "system", wdate(ow)))
    ins("orders", order_rows)

    # ---------------- this week's plan (end of week 103)
    w = WEEKS - 1
    close = manual.close[:, w]
    onord = (inv * (arr > w)).sum(1)
    tg = sim.plan_targets(net, f50, f90, w)
    rate = np.maximum(f50[:, 0], 1e-6)
    ip = close + onord
    deficit = np.maximum(tg["target"] - ip, 0)
    qty = sim.order_quantity(net, deficit, rate, ip, tg["d50"], np.zeros(N, bool))
    cover_days = close / rate * 7
    sold4 = manual.sales[:, w - 3:w + 1].mean(1)

    # transfer suggestions: surplus (> 8 weeks cover beyond target) to a location that needs the same medicine
    surplus = np.where(close / rate > PLANNER["transfer_min_cover_weeks"], np.maximum(close - tg["target"] - rate * 4, 0), 0)
    transfer = {}
    for s in range(S):
        rws = np.arange(s * L, (s + 1) * L)
        for t_ in rws[np.argsort(-deficit[rws])]:
            if deficit[t_] < 1:
                break
            donors = [d for d in rws[np.argsort(-surplus[rws])] if surplus[d] >= 1 and d != t_]
            same_state = [d for d in donors if loc["state"][li[d]] == loc["state"][li[t_]]]
            pick = (same_state or donors or [None])[0]
            if pick is None:
                continue
            q = float(np.floor(min(surplus[pick], deficit[t_])))
            if q >= 1:
                transfer[t_] = (pick, q)
                surplus[pick] -= q
    rec_rows, rid = [], 0
    for n in np.argsort(cover_days):
        if qty[n] <= 0 and n not in transfer:
            continue
        lead = float(tg["lead_plan"][n])
        pr = "urgent" if cover_days[n] < lead else "high" if cover_days[n] < lead + 7 else "normal"
        if cover_days[n] > 28 and n not in transfer:
            pr = "low"
        if rate[n] < 1 and pr in ("urgent", "high"):
            pr = "normal"                       # slow, intermittent medicines: order, but not an emergency
        s, l = si[n], li[n]
        tq = transfer.get(n)
        order_q = max(float(qty[n]) - (tq[1] if tq else 0), 0)
        if tq and order_q > 0:
            pack = PLANNER["slow_box"] if sku["velocity"][s] == "slow" else sku["case_pack"][s]
            order_q = float(np.ceil(order_q / pack) * pack)
        hill_note = " (hill route, +4 days monsoon buffer)" if loc["hill"][l] and net.cal["monsoon"][w + 1] else \
            " (hill route)" if loc["hill"][l] else ""
        fmt = lambda v: f"{v:.1f}" if v < 10 else f"{v:.0f}"
        reason = (f"Expected demand about {fmt(rate[n])}/week (likely range {fmt(f10[n, 0])}-{fmt(f90[n, 0])}). "
                  + (f"Out of stock now" if close[n] <= 0 else f"Stock on hand {close[n]:.0f} lasts about {cover_days[n]:.0f} days")
                  + (f", {onord[n]:.0f} already on the way" if onord[n] > 0 else "") + ". "
                  f"Delivery takes about {lead:.0f} days{hill_note}. "
                  f"Target stock {tg['target'][n]:.0f} = {tg['H'][n]} weeks of forecast demand "
                  f"({fmt(tg['d50'][n])}) + safety stock ({fmt(tg['safety'][n])}).")
        if tq:
            reason += (f" {loc['name'][li[tq[0]]]} has {tq[1]:.0f} spare units of the same medicine - transfer "
                       "suggested before ordering new stock.")
        rid += 1
        value = order_q * float(cost[n])
        rec_rows.append((f"R{rid:05d}", sku["sku_id"][s], loc["location_id"][l], pr, int(close[n]), int(onord[n]),
                         round(float(cover_days[n]), 1), round(lead, 1), round(float(rate[n]), 1),
                         round(float(f10[n, 0]), 1), round(float(f90[n, 0]), 1), round(float(sold4[n]), 1),
                         round(float(tg["target"][n]), 0), int(order_q),
                         loc["location_id"][li[tq[0]]] if tq else None, int(tq[1]) if tq else 0,
                         round(value, 2), int(value > APPROVAL_LIMIT), reason, "open", None, None, None, None))
    ins("recommendations", rec_rows)

    # ---------------- alerts
    alerts, aid = [], 0
    def alert(kind, sev, s_id, l_id, msg):
        nonlocal aid
        aid += 1
        alerts.append((f"A{aid:05d}", kind, sev, s_id, l_id, msg, wdate(w + 1), "open", None))
    name = lambda n: f"{sku['generic_name'][si[n]]} at {loc['name'][li[n]]}"
    for n in np.where((close <= 0) & (rate >= 1))[0][:60]:
        alert("stockout", "critical", sku["sku_id"][si[n]], loc["location_id"][li[n]],
              f"{name(n)} is out of stock; forecast demand {rate[n]:.0f}/week.")
    for n in np.where((close > 0) & (cover_days < tg["lead_plan"]) & (rate >= 1))[0][:80]:
        alert("stockout_risk", "high", sku["sku_id"][si[n]], loc["location_id"][li[n]],
              f"{name(n)} may run out in {cover_days[n]:.0f} days - before a new delivery can arrive ({tg['lead_plan'][n]:.0f} days).")
    asof = sim.START + np.timedelta64(w * 7 + 6, "D")
    for b in batch_rows:
        exp_d = np.datetime64(b[5])
        days_left = int((exp_d - asof).astype(int)) - MIN_SHELF_WEEKS * 7
        n = int(np.where(sku["sku_id"] == b[1])[0][0]) * L + int(np.where(loc["location_id"] == b[2])[0][0])
        if 0 < days_left <= 90 and b[3] > rate[n] * days_left / 7 * 1.1:
            alert("expiry", "medium", b[1], b[2], f"Batch {b[0]}: {b[3]} units of {sku['generic_name'][si[n]]} at "
                  f"{loc['name'][li[n]]} must be sold within {days_left} days; local demand will clear only "
                  f"~{rate[n] * days_left / 7:.0f}.")
    for n in np.where((cover_days > 12 * 7) & (sku["velocity"][si] != "slow"))[0][:40]:
        alert("overstock", "low", sku["sku_id"][si[n]], loc["location_id"][li[n]],
              f"{name(n)} holds {cover_days[n] / 7:.0f} weeks of stock (₹{close[n] * cost[n]:,.0f} tied up).")
    delayed = {}
    for o in order_rows:
        if o[8] == "delayed":
            delayed.setdefault(o[3], []).append(o)
    for l_id, os_ in delayed.items():
        lname = loc["name"][np.where(loc["location_id"] == l_id)[0][0]]
        alert("delay", "high", None, l_id, f"{len(os_)} orders to {lname} are held up by a landslide on the route; "
              f"revised arrival {max(o[7] for o in os_)}. Check medicines at risk of running out.")
    spike = (manual.sales[:, w - 1:w + 1].mean(1) > 1.6 * manual.sales[:, w - 9:w - 1].mean(1)) & (sold4 > 10)
    for n in np.where(spike)[0][:30]:
        alert("demand_spike", "medium", sku["sku_id"][si[n]], loc["location_id"][li[n]],
              f"Unusual rise in demand for {name(n)}: last 2 weeks are 60%+ above the previous 8.")
    ins("alerts", alerts)

    # ---------------- impact (year-2 backtest, same demand, same disruptions)
    b = slice(BACKTEST_START, WEEKS)
    dem = demand[:, b]
    def stats(r):
        fut = np.array([demand[:, x + 1:x + 9].sum(1) for x in range(BACKTEST_START, WEEKS - 8)]).T
        return dict(
            stockout=float(r.stockout[:, b][dem > 0].mean()),
            fill=float(r.sales[:, b].sum() / dem.sum()),
            excess=float((np.maximum(r.close[:, BACKTEST_START:WEEKS - 8] - fut, 0) * cost[:, None]).sum(0).mean()),
            expiry=float((r.expired[:, b] * cost[:, None]).sum()),
            inventory=float((r.close[:, b] * cost[:, None]).sum(0).mean()),
            dispatches=float(len({(li[x[0]], x[1]) for x in r.shipments if x[1] >= BACKTEST_START and x[8] == "order"}) / (L * (WEEKS - BACKTEST_START))),
            transfers=float(sum(1 for x in r.shipments if x[8] == "transfer")))
    m, p = stats(manual), stats(planner)
    actual = demand[:, BACKTEST_START:WEEKS]
    acc_ml = model.accuracy(hist["p50"], actual)
    acc_ma = model.accuracy(hist["ma8"], actual)
    cover = float(((actual >= hist["p10"]) & (actual <= hist["p90"])).mean())
    err_red = 1 - (1 - acc_ml) / (1 - acc_ma)
    impact = [
        ("forecast_error", "Forecast error (WAPE, weekly medicine x location)", (1 - acc_ma), (1 - acc_ml), "pct",
         "≥20% better than baseline", int(err_red >= 0.2),
         f"Error falls {err_red:.0%} (accuracy {acc_ma:.1%} → {acc_ml:.1%}). Baseline = 8-week moving average used today."),
        ("stockout", "Stock-out incidence (share of medicine x location weeks)", m["stockout"], p["stockout"], "pct",
         "−20%", int(p["stockout"] <= 0.8 * m["stockout"]), "A week counts as a stock-out when demand exceeded available stock."),
        ("excess", "Excess inventory (stock above next 8 weeks of demand, at cost)", m["excess"], p["excess"], "inr",
         "−15%", int(p["excess"] <= 0.85 * m["excess"]), "Average over the evaluation year."),
        ("expiry", "Expiry-related loss (at cost, per year)", m["expiry"], p["expiry"], "inr", "−15%",
         int(p["expiry"] <= 0.85 * m["expiry"]), "Stock written off when less than 90 days of shelf life remained."),
        ("fill", "Order fill rate (units supplied ÷ units demanded)", m["fill"], p["fill"], "pct", "+10 pp",
         int(p["fill"] - m["fill"] >= 0.10),
         f"Baseline is already {m['fill']:.1%}, so only {1 - m['fill']:.1%} headroom exists in this simulation."),
        ("inventory", "Average inventory value (working capital)", m["inventory"], p["inventory"], "inr", "—", None,
         "Not a challenge target; shown so savings are not bought with extra stock."),
        ("dispatches", "Dispatches per location per week", m["dispatches"], p["dispatches"], "num", "—", None,
         "Weekly review means more frequent, smaller dispatches - a logistics cost to agree in the pilot."),
    ]
    con.executemany("INSERT INTO impact VALUES (?,?,?,?,?,?,?,?)", impact)
    weekly_imp = []
    for x in range(BACKTEST_START, WEEKS):
        dm = demand[:, x] > 0
        weekly_imp.append((x, float(manual.stockout[dm, x].mean()), float(planner.stockout[dm, x].mean()),
                           float((manual.close[:, x] * cost).sum()), float((planner.close[:, x] * cost).sum())))
    ins("impact_weekly", weekly_imp)

    meta = {
        "as_of_week": w, "as_of_date": str(asof), "data_through": wdate(w), "next_week": wdate(w + 1),
        "built_at": datetime.now().isoformat(timespec="seconds"), "approval_limit": APPROVAL_LIMIT,
        "forecast_interval_coverage": cover, "train_rows": fc.n_train, "backtest_weeks": WEEKS - BACKTEST_START,
        "transfers_backtest": p["transfers"], "min_shelf_days": MIN_SHELF_WEEKS * 7,
        "expiry_alert_days": 90, "safety_factor": PLANNER["k_safety"], "monsoon_buffer_days": PLANNER["monsoon_hill_buffer_days"],
    }
    con.executemany("INSERT INTO meta VALUES (?,?)", [(k, json.dumps(v)) for k, v in meta.items()])
    users = [("U1", "Anjali Barua", "head", "Head of Supply Chain", "ALL"),
             ("U2", "Rahul Deka", "planner", "Supply Planner", "ALL"),
             ("U3", "Imna Jamir", "regional", "Regional Manager – Hill States", "Nagaland,Manipur,Mizoram,Meghalaya,Arunachal Pradesh,Sikkim"),
             ("U4", "Priya Sharma", "regional", "Regional Manager – Assam & Tripura", "Assam,Tripura"),
             ("U5", "Field Viewer", "viewer", "Sales / Field (read-only)", "ALL")]
    ins("users", users)
    ins("audit", [(datetime.now().isoformat(timespec="seconds"), "system", "build", "data",
                   f"Weekly run: {len(rec_rows)} recommendations, {len(alerts)} alerts, model trained on {fc.n_train:,} rows")])
    con.commit()
    con.close()
    log(f"[5/5] wrote {db_path} in {time.time() - t0:.0f}s  "
        f"(recommendations={len(rec_rows)}, alerts={len(alerts)}, batches={len(batch_rows)}, orders={len(order_rows)})")
    for k, *rest in impact:
        log(f"   {k:11s} manual={rest[1]:,.4f} planner={rest[2]:,.4f} target={rest[4]} met={rest[5]}")


if __name__ == "__main__":
    build()
