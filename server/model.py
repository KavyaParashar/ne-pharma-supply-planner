"""Demand forecasting: one global gradient-boosted model across all medicine x location series.

* Quantile models (p10 / p50 / p90) so planners see a range, not one number.
* Stock-out aware: weeks where the shelf was empty are excluded from training targets, and an
  "in-stock weeks only" average is a feature, so low sales caused by shortages are not read as low demand.
* Scale-free: every series is divided by its own recent level, so fast and slow medicines share one model.
* Horizons 1-8 weeks are predicted directly (horizon is a feature).
Baseline for comparison: the 8-week moving average of sales that planners use today.
"""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor

from .sim import Network

QUANTILES = (0.1, 0.5, 0.9)
FEATURES = ["lag1", "lag2", "lag3", "lag4", "ma4", "ma8", "ma8_instock", "ma26", "stockout_weeks8",
            "log_level", "horizon", "month", "monsoon", "winter", "festival",
            "festival_next", "therapeutic_class", "season_profile", "velocity", "dosage_form",
            "location_type", "hill", "state"]
CATEGORICAL = ["month", "therapeutic_class", "season_profile", "velocity", "dosage_form", "location_type", "state"]


def _codes(values):
    _, inv = np.unique(values, return_inverse=True)
    return inv.astype(float)


class Featurizer:
    def __init__(self, net: Network):
        self.net = net
        si, li = net.si(), net.li()
        self.static = np.column_stack([
            _codes(net.sku["therapeutic_class"])[si], _codes(net.sku["season_profile"])[si],
            _codes(net.sku["velocity"])[si], _codes(net.sku["dosage_form"])[si],
            _codes(net.loc["location_type"])[li], net.loc["hill"][li].astype(float), _codes(net.loc["state"])[li]])
        cal = net.cal
        self.cal = np.column_stack([cal["month"], cal["monsoon"], cal["winter"], cal["festival"] != ""]).astype(float)

    def level(self, sales, stock, t):
        win = slice(max(0, t - 7), t + 1)          # in-stock weeks of the last 8
        s, inst = sales[:, win], ~stock[:, win].astype(bool)
        lvl = (s * inst).sum(1) / np.maximum(inst.sum(1), 1)
        return np.maximum(lvl, 0.3)

    def rows(self, sales, stock, t, horizons):
        """Feature matrix for origin week t (data up to and including t) for each horizon."""
        N = sales.shape[0]
        lvl = self.level(sales, stock, t)
        g = lambda k: np.where(stock[:, t - k].astype(bool), np.nan, sales[:, t - k]) if t - k >= 0 else np.full(N, np.nan)  # censored -> unknown
        def ma(k):
            return sales[:, max(0, t - k + 1):t + 1].mean(1)
        w8 = slice(max(0, t - 7), t + 1)
        inst = ~stock[:, w8].astype(bool)
        ma8_in = np.where(inst.sum(1) > 0, (sales[:, w8] * inst).sum(1) / np.maximum(inst.sum(1), 1), np.nan)
        base = np.column_stack([g(0), g(1), g(2), g(3), ma(4), ma(8), ma8_in, ma(26)]) / lvl[:, None]
        so8 = stock[:, w8].sum(1)
        out = []
        for h in horizons:
            c, cn = self.cal[t + h], self.cal[min(t + h + 1, len(self.cal) - 1)]
            X = np.column_stack([base, so8, np.log(lvl), np.full(N, h),
                                 np.tile(c, (N, 1)), np.full(N, cn[3]), self.static])
            out.append(X)
        return np.vstack(out), lvl


class Forecaster:
    def __init__(self, net: Network, max_iter: int = 250):
        self.fz = Featurizer(net)
        cat_idx = [FEATURES.index(c) for c in CATEGORICAL]
        self.models = {q: HistGradientBoostingRegressor(loss="quantile", quantile=q, max_iter=max_iter,
                                                        learning_rate=0.08, max_leaf_nodes=31, min_samples_leaf=60,
                                                        categorical_features=cat_idx, early_stopping=False, random_state=7)
                       for q in QUANTILES}

    def fit(self, sales, stock, last_week, first_origin=8, horizons=range(1, 9), sample=0.5, seed=1):
        rng = np.random.default_rng(seed)
        Xs, ys = [], []
        for t in range(first_origin, last_week):
            hs = [h for h in horizons if t + h <= last_week]
            if not hs:
                continue
            X, lvl = self.fz.rows(sales, stock, t, hs)
            y = np.concatenate([sales[:, t + h] / lvl for h in hs])
            ok = np.concatenate([~stock[:, t + h].astype(bool) for h in hs])      # censored weeks dropped
            keep = ok & (rng.random(len(y)) < sample)
            Xs.append(X[keep]); ys.append(y[keep])
        X, y = np.vstack(Xs), np.concatenate(ys)
        for m in self.models.values():
            m.fit(X, y)
        self.n_train = len(y)
        return self

    def predict(self, sales, stock, t, horizons=range(1, 5)):
        hs = list(horizons)
        X, lvl = self.fz.rows(sales, stock, t, hs)
        N = sales.shape[0]
        out = []
        for q in QUANTILES:
            p = np.maximum(self.models[q].predict(X), 0).reshape(len(hs), N).T * lvl[:, None]
            out.append(p)
        f10, f50, f90 = out
        f10 = np.minimum(f10, f50)
        f90 = np.maximum(f90, f50)
        return f10, f50, f90

    def as_policy_callback(self):
        return lambda sales, stock, t: self.predict(sales, stock, t, range(1, 5))


def moving_average(sales, t, k=8):
    return sales[:, max(0, t - k + 1):t + 1].mean(1)


def accuracy(pred, actual):
    """Forecast accuracy = 1 - WAPE (weighted absolute percentage error)."""
    return 1 - np.abs(pred - actual).sum() / max(actual.sum(), 1e-9)
