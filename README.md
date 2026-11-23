# NE Pharma Supply Planner — NESFIC-I-09

A simple, self-hosted planning tool for **NESFIC 2026, challenge NESFIC-I-09: Improving Medicine Demand Forecasting and Inventory Availability Across Northeast India** (challenge owner: GR Dhanuka Group).

Every week it forecasts demand for each medicine at each location and suggests what to dispatch or transfer. Each suggestion comes with a plain-language reason, and a person approves it before anything happens. It also tracks batches that are close to expiry, deliveries held up on hill routes, and results against the five challenge KPIs.

**This version does not need Databricks or any cloud service.** It is one Python process and one SQLite file, with a web app that needs no build step.

## Run it

```bash
./run.sh                       # first run: makes .venv, builds data (~1 min), serves http://localhost:8000
REBUILD=1 ./run.sh             # regenerate the data and retrain the model
docker build -t nepd . && docker run -p 8000:8000 nepd    # or as a container
python tests/smoke_test.py     # 19 end-to-end checks (pip install -r requirements-dev.txt first)
```

Needs Python 3.10+. Dependencies: FastAPI, Uvicorn, NumPy, scikit-learn, python-multipart. API docs are at `/api/docs`.

## What is inside

| Screen | What it does | Features doc module |
|---|---|---|
| Overview | KPIs, 26-week trend plus 8-week forecast, network map, urgent actions, alerts, challenge scorecard | 01 |
| Replenishment plan | Weekly suggestions with priority, reason, transfer option. Approve, change, postpone or reject, singly or in bulk. Approval limit sends large orders to the Head | 09, 11, 17 |
| Demand forecast | History, past forecasts vs today's 8-week average, 80% likely range, next 8 weeks, accuracy, drivers, planner adjustment with reason, least-reliable series | 05, 08, 15 |
| What-if planner | Demand change, delivery delay or landslide, order size and timing, supplier short-supply, transfer. 2,000 simulated futures; save and compare plans | 16 |
| Inventory | Every medicine × location: on hand, on the way, weeks of stock, nearest expiry, status | 06 |
| Batches & expiry | Value likely to expire unsold, by time to expiry, with an action per batch (FEFO, transfer to a named location, return) | 07 |
| Orders & transfers | Depot dispatches and transfers from approval to receipt; short receipts; stock updated on receipt | 10, 11, 13 |
| Alerts | Out of stock, stock-out risk, expiry, overstock, route delays, demand spikes. Assign or resolve | 17 |
| Locations / Medicines | Network map and table, location and medicine detail panels | 02, 03, 04 |
| Impact & pilot | Manual vs planner on the 5 KPIs, weekly charts, method, honest limitations, 12–16 week pilot plan | 18 |
| Data import | CSV upload with checks (columns, codes, numbers, dates, duplicates, expiry), templates, source freshness, history | 20 |
| Users & settings | 5 demo roles, state-level access, cost masking, approval limit and shelf-life settings, audit trail | 21, 23 |

It also works on phones and installs like an app. If the connection drops, the last viewed data stays readable and changes are disabled until it returns (module 22).

## Results (simulation, same demand and disruptions for both policies)

| KPI (target) | Today (manual) | With planner | |
|---|---|---|---|
| Forecast error, WAPE (≥20% better) | 19.7% | 15.7% (−20.1%) | met, borderline |
| Stock-out incidence (−20%) | 9.2% | 1.6% (−83%) | met |
| Excess inventory (−15%) | ₹4.37 L | ₹1.71 L (−61%) | met |
| Expiry loss (−15%) | ₹2.31 L | ₹1.69 L (−27%) | met |
| Fill rate (+10 pp) | 94.8% | 99.6% (+4.8 pp) | **not met**: only 5.2 pp of headroom in the simulation |
| Average inventory | ₹78.1 L | ₹71.7 L (−8%) | not a target |
| Dispatches per location per week | 0.50 | 0.98 | trade-off to manage in the pilot |

All data is synthetic: 60 medicines × 40 locations × 104 weeks. Year 1 trains the model, and year 2 is replayed under both policies. These are not GRD results; the pilot will re-measure the baseline on real data. See `PLAN.md` for the method, assumptions and pilot plan, and `ARCHITECTURE.md` (+ `architecture.svg`) for the tech stack, architecture and tools.

## Layout

```
server/sim.py      synthetic network, demand, disruptions; manual and planner policies
server/model.py    global quantile gradient-boosting forecaster (p10/p50/p90), stock-out aware
server/build.py    simulate → backtest → train → this week's plan, alerts, impact → data/nepd.db
server/api.py      FastAPI: read endpoints, decisions, orders, what-if, upload, settings, audit, CSV export
server/schema.sql  SQLite schema
web/               index.html, styles.css, charts.js (SVG charts), app.js, sw.js (offline), manifest.json
samples/           CSV templates (with deliberate mistakes, to show the checks)
tests/             smoke_test.py
```
