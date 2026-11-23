"""Synthetic Northeast pharma network + inventory engine.

One demand history, one set of operational shocks (lead-time noise, landslides, supplier short-supply,
aged stock from the depot). Two ordering policies are replayed over the SAME demand and shocks:

* manual  - today's practice: fortnightly review, reorder point on 8-week average sales, order 4 weeks of
            cover in full cases.
* planner - weekly review, ML forecast (p50/p90), lead time with monsoon hill buffer, safety stock from
            forecast spread, expiry-aware order cap, smaller boxes for slow movers, and transfers of surplus
            stock to locations that are about to run short.

Everything is numpy; no external services.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

SEED = 42
WEEKS = 104
START = np.datetime64("2024-11-25")          # Monday; week 103 starts 2026-11-16
BACKTEST_START = 52                         # year 2 is the evaluation year
MIN_SHELF_WEEKS = 13                        # stock with < ~90 days left cannot be dispatched/sold
HILL_STATES = ["Arunachal Pradesh", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Sikkim"]
HILL_DISTRICTS = ["Karbi Anglong", "Dima Hasao"]
CHRONIC = ["diabetes", "cardio", "endocrine", "neuro", "gastro"]
MANUAL = dict(review_every=2, rop_extra_weeks=0.5, cover_weeks=4)
PLANNER = dict(k_safety=1.3, monsoon_hill_buffer_days=4, slow_box=10, transfer_min_cover_weeks=8)

COORDS = {  # approximate district HQ lat/lon, for the network map only
    "Kamrup Metro": (26.14, 91.74), "Kamrup": (26.30, 91.40), "Nagaon": (26.35, 92.68), "Jorhat": (26.75, 94.21),
    "Dibrugarh": (27.48, 94.91), "Tinsukia": (27.49, 95.36), "Sonitpur": (26.63, 92.80), "Cachar": (24.82, 92.80),
    "Barpeta": (26.32, 91.00), "Golaghat": (26.52, 93.96), "Lakhimpur": (27.24, 94.10), "Dhubri": (26.02, 89.98),
    "Bongaigaon": (26.48, 90.56), "Karbi Anglong": (25.84, 93.43), "Dima Hasao": (25.17, 93.02),
    "Sivasagar": (26.98, 94.64), "East Khasi Hills": (25.57, 91.88), "West Garo Hills": (25.51, 90.22),
    "West Jaintia Hills": (25.45, 92.20), "Ri-Bhoi": (25.89, 91.88), "Papum Pare": (27.10, 93.62),
    "East Siang": (28.07, 95.33), "Lohit": (27.92, 96.17), "Tawang": (27.59, 91.86), "Kohima": (25.67, 94.11),
    "Dimapur": (25.91, 93.73), "Mokokchung": (26.33, 94.52), "Tuensang": (26.27, 94.83),
    "Imphal West": (24.80, 93.90), "Imphal East": (24.86, 94.02), "Churachandpur": (24.33, 93.68),
    "Ukhrul": (25.10, 94.36), "Aizawl": (23.73, 92.72), "Lunglei": (22.88, 92.73), "Champhai": (23.46, 93.33),
    "West Tripura": (23.84, 91.28), "Gomati": (23.53, 91.48), "Dhalai": (23.85, 91.90),
    "North Tripura": (24.33, 92.01), "East Sikkim": (27.33, 88.61),
}
LOC_TYPES = ["stockist", "retail_chain", "hospital", "institution"]
TYPE_LABEL = {"stockist": "Stockist", "retail_chain": "Retail chain", "hospital": "Hospital", "institution": "Institution"}


def week_dates(n: int = WEEKS) -> np.ndarray:
    return START + np.arange(n) * np.timedelta64(7, "D")


@dataclass
class Network:
    sku: dict
    loc: dict
    cal: dict
    S: int
    L: int

    @property
    def N(self) -> int:
        return self.S * self.L

    def si(self):
        return np.repeat(np.arange(self.S), self.L)

    def li(self):
        return np.tile(np.arange(self.L), self.S)


def build_network(rng: np.random.Generator, seeds: dict) -> Network:
    cols = seeds["skus"]["columns"]
    rows = [r.split(",") for r in seeds["skus"]["rows"]]
    sku = {c: np.array([r[i] for r in rows]) for i, c in enumerate(cols)}
    S = len(rows)
    sku["mrp_inr"] = sku["mrp_inr"].astype(float)
    sku["shelf_life_months"] = sku["shelf_life_months"].astype(int)
    sku["sku_id"] = np.array([f"SKU{i + 1:03d}" for i in range(S)])
    sku["unit_cost_inr"] = np.round(sku["mrp_inr"] * rng.uniform(0.55, 0.7, S), 2)
    sku["case_pack"] = np.where(sku["velocity"] == "fast", 100, 50)

    pairs = [(s, d) for s, ds in seeds["geo"].items() for d in ds]
    L = len(pairs)
    loc = {"state": np.array([p[0] for p in pairs]), "district": np.array([p[1] for p in pairs])}
    loc["location_id"] = np.array([f"LOC{i + 1:02d}" for i in range(L)])
    loc["location_type"] = rng.choice(LOC_TYPES, L, p=[0.5, 0.25, 0.15, 0.1])
    loc["hill"] = np.isin(loc["state"], HILL_STATES) | np.isin(loc["district"], HILL_DISTRICTS)
    loc["base_lead_days"] = np.select(
        [loc["district"] == "Kamrup Metro", loc["hill"], loc["state"] == "Tripura"],
        [1, rng.integers(5, 8, L), 4], rng.integers(2, 4, L))
    loc["name"] = np.array([f"{d} {TYPE_LABEL[t]}" for d, t in zip(loc["district"], loc["location_type"])])
    loc["lat"] = np.array([COORDS[d][0] for d in loc["district"]])
    loc["lon"] = np.array([COORDS[d][1] for d in loc["district"]])

    wk = week_dates(WEEKS + 12)                      # 12 extra weeks for the forecast horizon
    months = (wk.astype("datetime64[M]").astype(int) % 12) + 1
    fest = {np.datetime64(k): v for k, v in seeds["festivals"].items()}
    fest_name = [next((v for k, v in fest.items() if 0 <= (k - w).astype(int) < 7), "") for w in wk]
    cal = {"week_start": wk, "month": months, "monsoon": np.isin(months, [6, 7, 8, 9]),
           "winter": np.isin(months, [12, 1, 2]), "festival": np.array(fest_name)}
    return Network(sku, loc, cal, S, L)


def latent_demand(net: Network, rng: np.random.Generator) -> np.ndarray:
    """True (uncensored) weekly demand [N, WEEKS]. Seasonal, promotional, festival and outbreak effects
    plus distributor-level AR(1) noise. Slow movers are intermittent."""
    S, L, W = net.S, net.L, WEEKS
    sku, loc = net.sku, net.loc
    m, t = net.cal["month"][:W], np.arange(W)
    base = np.vectorize({"fast": 120, "med": 35, "slow": 1.2}.get)(sku["velocity"]) * rng.uniform(0.7, 1.3, S)
    scale = np.vectorize({"stockist": 1, "retail_chain": 0.5, "hospital": 0.8, "institution": 0.6}.get)(loc["location_type"])
    prof = {"monsoon": 1 + 0.8 * np.isin(m, [6, 7, 8, 9]) + 0.3 * np.isin(m, [5, 10]),
            "winter": 1 + 0.7 * np.isin(m, [12, 1, 2]) + 0.25 * np.isin(m, [11, 3]),
            "flat": 1 + 0.08 * t / 52}
    seas = np.stack([prof[p] for p in sku["season_profile"]])
    promo = np.zeros((S, W))
    for s in range(S):
        promo[s, rng.choice(W, 5, replace=False)] = 1
    fest = (net.cal["festival"][:W] != "").astype(float)
    lam = (base[:, None, None] * scale[None, :, None]
           * (seas * (1 + 0.5 * promo - 0.15 * np.roll(promo, 1, 1)))[:, None, :]
           * (1 + 0.1 * np.roll(fest, -1) - 0.15 * fest)[None, None, :])
    wks = net.cal["week_start"][:W]
    outbreaks = [(["antimalarial"], ["Cachar", "Dhalai"], "2026-08-03", "2026-08-24", 3.0),
                 (["antidiarrhoeal", "antiinfective"], ["Dhubri"], "2025-07-07", "2025-07-28", 2.5)]
    for cls, dists, a, b, k in outbreaks:
        ww = np.where((wks >= np.datetime64(a)) & (wks <= np.datetime64(b)))[0]
        lam[np.ix_(np.isin(sku["therapeutic_class"], cls), np.isin(loc["district"], dists), ww)] *= k
    chronic = np.isin(sku["therapeutic_class"], CHRONIC) & (sku["velocity"] != "slow")
    cv = np.where(chronic, 0.06, 0.12)[:, None]
    phi = 0.7
    x = np.zeros((S, L, W))
    x[:, :, 0] = rng.normal(0, 1, (S, L)) * cv
    for w in range(1, W):
        x[:, :, w] = phi * x[:, :, w - 1] + rng.normal(0, 1, (S, L)) * cv * np.sqrt(1 - phi ** 2)
    p_occ = np.where(sku["velocity"] == "slow", 0.35, 1.0)[:, None, None]
    mu = lam * np.exp(x - cv[:, :, None] ** 2 / 2)
    d = np.where(rng.random(lam.shape) < p_occ, rng.poisson(mu / p_occ), 0)
    return d.reshape(S * L, W).astype(float)


@dataclass
class Shocks:
    lt_noise: np.ndarray        # [N, W] extra days 0-1
    slide: np.ndarray           # [N, W] bool landslide on route that week
    slide_days: np.ndarray      # [N, W] 3-10 days
    short: np.ndarray           # [N, W] bool manufacturer short-supplies the order
    short_frac: np.ndarray      # [N, W]
    age_frac: np.ndarray        # [N, W] fraction of shelf life left on arrival
    short_dated: np.ndarray     # [N, W] bool depot only has short-dated (6 month) stock


def build_shocks(net: Network, rng: np.random.Generator) -> Shocks:
    N, W = net.N, WEEKS
    state = net.loc["state"][net.li()]
    hill = net.loc["hill"][net.li()]
    monsoon_weeks = np.where(net.cal["monsoon"][:W])[0]
    slide_weeks = {s: set(rng.choice(monsoon_weeks, 6, replace=False)) for s in HILL_STATES}
    slide = np.zeros((N, W), bool)
    for n in range(N):
        if hill[n] and state[n] in slide_weeks:
            slide[n, list(slide_weeks[state[n]])] = True
    late = np.isin(state, ["Mizoram", "Manipur"]) & hill            # late-season landslide on NH-306/NH-37 (week 102)
    slide[late, 102] = True
    dxm = np.isin(net.si(), np.where(np.char.startswith(net.sku["generic_name"], "Dextromethorphan"))[0])
    short_dated = np.zeros((N, W), bool)
    short_dated[np.ix_(dxm, np.arange(60, 66))] = True
    return Shocks(lt_noise=rng.integers(0, 2, (N, W)), slide=slide, slide_days=rng.integers(3, 11, (N, W)),
                  short=rng.random((N, W)) < 0.15, short_frac=rng.uniform(0.3, 0.8, (N, W)),
                  age_frac=rng.uniform(0.35, 0.75, (N, W)), short_dated=short_dated)


@dataclass
class RunResult:
    sales: np.ndarray
    close: np.ndarray
    stockout: np.ndarray
    expired: np.ndarray
    on_order: np.ndarray
    shipments: list = field(default_factory=list)   # (n, order_week, arrival_week, lead_days, qty, slide, expiry_week, life_w, kind, src)
    inv: np.ndarray | None = None                   # final slots
    exp: np.ndarray | None = None
    arr: np.ndarray | None = None
    forecasts: dict = field(default_factory=dict)   # week -> (f10, f50, f90)


def _consume_fefo(inv, exp, avail_mask, qty):
    """Issue qty per row from available slots, earliest expiry first. Returns units actually issued."""
    key = np.where(avail_mask & (inv > 0), exp, np.inf)
    order = np.argsort(key, axis=1)
    sorted_inv = np.take_along_axis(np.where(avail_mask, inv, 0), order, 1)
    cum = np.cumsum(sorted_inv, 1)
    remaining = np.clip(cum - qty[:, None], 0, None)
    new_sorted = np.diff(remaining, axis=1, prepend=0)
    issued = np.minimum(qty, cum[:, -1])
    new = inv.copy()
    rows = np.arange(inv.shape[0])[:, None]
    new[rows, order] = np.where(np.take_along_axis(avail_mask, order, 1), new_sorted, np.take_along_axis(inv, order, 1))
    return new, issued


def run_policy(net: Network, demand: np.ndarray, sh: Shocks, policy: str, forecaster=None,
               planner_from: int = BACKTEST_START, record_forecasts: bool = False) -> RunResult:
    N, W = net.N, WEEKS
    si, li = net.si(), net.li()
    sku, loc = net.sku, net.loc
    shelf_w = sku["shelf_life_months"][si] * 4.33
    case = sku["case_pack"][si].astype(float)
    slow = (sku["velocity"] == "slow")[si]
    base_lt = loc["base_lead_days"][li]
    hill = loc["hill"][li]
    T = W + 20
    arr = np.concatenate([np.arange(T), np.arange(T)])         # PO slots then transfer slots
    inv, exp = np.zeros((N, 2 * T)), np.full((N, 2 * T), 1e9)
    inv[:, 0], exp[:, 0] = demand[:, :4].mean(1) * 4, shelf_w * 0.5
    sales, close, sto, expd, onord_hist = (np.zeros((N, W)) for _ in range(5))
    res = RunResult(sales, close, sto, expd, onord_hist)

    def place(rows, slot, qty, expiry):
        has = inv[rows, slot] > 0
        exp[rows, slot] = np.where(has, np.minimum(exp[rows, slot], expiry), expiry)
        inv[rows, slot] += qty

    for w in range(W):
        avail = arr <= w
        dead = avail[None, :] & (inv > 0) & (exp - MIN_SHELF_WEEKS <= w)
        expd[:, w] = (inv * dead).sum(1)
        inv[dead] = 0
        inv, issued = _consume_fefo(inv, exp, np.broadcast_to(avail, inv.shape), demand[:, w])
        sales[:, w] = issued
        sto[:, w] = demand[:, w] > issued + 1e-9
        close[:, w] = (inv * avail).sum(1)
        onord = (inv * ~avail).sum(1)
        onord_hist[:, w] = onord
        if w >= W - 1:
            continue
        lt = base_lt + sh.lt_noise[:, w] + sh.slide[:, w] * sh.slide_days[:, w]
        life = shelf_w
        remaining = np.where(sh.short_dated[:, w], 26.0, shelf_w * sh.age_frac[:, w])   # weeks left on arrival
        if policy == "manual" or w < planner_from:
            if w % MANUAL["review_every"]:
                continue
            ma8 = sales[:, max(0, w - 7):w + 1].mean(1)
            lw_plan = np.ceil(base_lt / 7)
            qty = np.ceil(np.maximum(ma8 * MANUAL["cover_weeks"], 1) / case) * case
            need = close[:, w] + onord < np.maximum(ma8 * (lw_plan + MANUAL["rop_extra_weeks"]), 1)
            rows = np.where(need)[0]
        else:
            f10, f50, f90 = forecaster(sales[:, :w + 1], sto[:, :w + 1], w)
            if record_forecasts:
                res.forecasts[w] = (f10, f50, f90)
            tg = plan_targets(net, f50, f90, w)
            d50, target = tg["d50"], tg["target"]
            ip = close[:, w] + onord
            deficit = np.maximum(target - ip, 0)
            # --- transfers: surplus at one location -> deficit at another (same SKU), soonest expiry first
            rate = np.maximum(f50[:, 0], 1e-6)
            cover_w = close[:, w] / rate
            surplus = np.where(cover_w > PLANNER["transfer_min_cover_weeks"],
                               np.maximum(close[:, w] - target - rate * 4, 0), 0)
            for s in np.where(np.add.reduceat(surplus > 0, np.arange(0, N, net.L)) & np.add.reduceat(deficit > 0, np.arange(0, N, net.L)))[0]:
                rws = np.arange(s * net.L, (s + 1) * net.L)
                donors = rws[np.argsort(-surplus[rws])]
                takers = rws[np.argsort(-deficit[rws])]
                for d_ in donors:
                    if surplus[d_] < 1:
                        break
                    for t_ in takers:
                        if deficit[t_] < 1 or t_ == d_:
                            continue
                        q = np.floor(min(surplus[d_], deficit[t_]))
                        if q < 1:
                            continue
                        key = np.where(avail & (inv[d_] > 0), exp[d_], np.inf)
                        slot = int(np.argmin(key))
                        q = min(q, np.floor(inv[d_, slot]))
                        if q < 1 or exp[d_, slot] - MIN_SHELF_WEEKS - w < q / rate[t_]:
                            continue           # would expire at destination too
                        tw = w + (2 if hill[t_] else 1)
                        inv[d_, slot] -= q
                        close[d_, w] -= q
                        place(np.array([t_]), T + tw, q, exp[d_, slot])
                        surplus[d_] -= q
                        deficit[t_] -= q
                        res.shipments.append((t_, w, tw, (tw - w) * 7, q, False, exp[d_, slot], 0, "transfer", d_))
            # --- replenishment orders from the depot
            qty = order_quantity(net, deficit, rate, ip, d50, sh.short_dated[:, w])
            rows = np.where(qty > 0)[0]
        if len(rows) == 0:
            continue
        q = qty[rows]
        q = np.where(sh.short[rows, w], np.floor(q * sh.short_frac[rows, w]), q)
        lw = np.ceil(lt[rows] / 7).astype(int)
        a = w + lw
        expiry = a + remaining[rows]
        for n_, a_, q_, e_ in zip(rows, a, q, expiry):
            if q_ > 0:
                place(np.array([n_]), a_, q_, e_)
        for n_, a_, l_, q_, e_ in zip(rows, a, lt[rows], q, expiry):
            if q_ > 0:
                res.shipments.append((n_, w, a_, int(l_), q_, bool(sh.slide[n_, w]), e_, life[n_], "order", -1))
    res.inv, res.exp, res.arr = inv, exp, arr
    return res


def plan_targets(net: Network, f50, f90, w):
    """Planner order-up-to level per series for a review at the end of week w."""
    hill = net.loc["hill"][net.li()]
    base_lt = net.loc["base_lead_days"][net.li()]
    monsoon_next = bool(net.cal["monsoon"][w + 1])
    lead_plan = base_lt + hill * monsoon_next * PLANNER["monsoon_hill_buffer_days"]
    H = np.ceil(lead_plan / 7).astype(int) + 1                     # lead time + 1-week review period
    hmask = np.arange(1, 9)[None, :] <= H[:, None]
    f50x = np.concatenate([f50, np.repeat(f50[:, -1:], 8, 1)], 1)[:, :8]
    f90x = np.concatenate([f90, np.repeat(f90[:, -1:], 8, 1)], 1)[:, :8]
    d50 = (f50x * hmask).sum(1)
    spread = np.sqrt((((f90x - f50x) ** 2) * hmask).sum(1))
    safety = PLANNER["k_safety"] * spread
    return dict(lead_plan=lead_plan, H=H, d50=d50, safety=safety, target=d50 + safety)


def order_quantity(net: Network, deficit, rate, ip, d50, short_dated):
    """Round the shortfall to dispatch packs and cap it so the new stock can be sold before it expires."""
    si = net.si()
    slow = (net.sku["velocity"] == "slow")[si]
    case = net.sku["case_pack"][si].astype(float)
    shelf_w = net.sku["shelf_life_months"][si] * 4.33
    pack = np.where(slow, PLANNER["slow_box"], case)
    worst_left = np.where(short_dated, 26.0, shelf_w * 0.35)          # depot ships stock with >=35% life left
    sellable_w = np.maximum(worst_left - MIN_SHELF_WEEKS, 1)
    cap = np.floor(rate * sellable_w / pack) * pack
    qty = np.ceil(deficit / pack) * pack
    return np.where(qty > cap, np.maximum(cap, pack * (ip < d50)), qty)


def load_seeds() -> dict:
    return json.loads((Path(__file__).parent / "seeds.json").read_text())


def generate():
    rng = np.random.default_rng(SEED)
    net = build_network(rng, load_seeds())
    demand = latent_demand(net, rng)
    shocks = build_shocks(net, rng)
    return net, demand, shocks
