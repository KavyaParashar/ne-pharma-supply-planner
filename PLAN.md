# Build plan — NE Pharma Supply Planner (NESFIC-I-09)

## 1. Why a fresh build

The earlier submission (`../`, Databricks build) proved the idea using Lakeflow, Unity Catalog, Lakebase, Model Serving, Genie and Apps. The public demo (`NE_Pharma_Software_Dashboard.zip`) looked good, but it was static: its suggestions were simple rules, not model output. This build keeps what worked and removes the platform dependency:

| | Earlier build | This build |
|---|---|---|
| Runs on | Databricks workspace (serverless, Lakebase, Model Serving, Genie, Apps) | One Python process + one SQLite file; laptop, any small VM, or GRD's own server |
| Front end | Streamlit (4 tabs) / separate static demo | One web app with 13 screens and no build step; works on mobile and offline |
| Suggestions in the demo | Static rules (dashboard) | Real model forecast + planning policy; approvals persist; orders update stock |
| AI text | LLM `ai_query` explanations | Deterministic plain-language reasons built from the numbers (no external AI service, no data leaves the server) |
| Cost to run | Workspace + serving + Lakebase | About ₹2,000–4,000/month for a 2 vCPU / 4 GB VM in an Indian region (estimate), or ₹0 on existing hardware |

## 2. What the challenge asks for → where it is covered

| NESFIC-I-09 requirement | How this build answers it |
|---|---|
| End-to-end visibility of demand and inventory across the NE network | Overview, Inventory, Locations map, Medicines; state filter; batch-level stock |
| Earlier, more reliable replenishment decisions | Weekly plan, priority by days of stock vs delivery time, monsoon hill buffer, transfers first |
| Forecast accuracy +20% | Global quantile model, stock-out-aware: forecast error 19.7% → 15.7% (−20.1%) in simulation |
| Stock-outs −20% | 9.2% → 1.6% |
| Excess / slow-moving inventory −15% | ₹4.37 L → ₹1.71 L |
| Expiry loss −15% | ₹2.31 L → ₹1.69 L; expiry-aware order caps, FEFO, transfer or return actions |
| Fill rate / service level +10 pp | 94.8% → 99.6% (+4.8 pp). **Not met**: the simulated baseline leaves only 5.2 pp of headroom. To be re-baselined in the pilot |
| Works with existing processes and data | CSV/Excel import with checks; no ERP replacement; people approve every action |
| Multi-state, variable connectivity | 8 states, hill routes, offline read mode, installable on phones |
| Data privacy and confidentiality | Self-hosted in India, role-based access, cost masking, audit trail, no patient data |
| Minimal special hardware | None needed |
| Pharma distribution / quality rules | Batch and expiry register, FEFO, no dispatch under 91 days shelf life, traceable batches |
| 12–16 week pilot at Guwahati/Rani | Pilot plan on the Impact screen and in §6 below |

## 3. Scope against the features document (23 modules)

**Built:** 01 Overview · 02 Locations · 03 Medicine catalogue (view) · 04 Distributors (via locations) · 05 Sales and demand · 06 Inventory · 07 Batches and expiry · 08 AI forecasting · 09 Smart reordering · 10 Orders (dispatch) · 11 Transfers · 13 Shipments (delays, receipt) · 16 What-if · 17 Alerts and approvals · 18 Reports and savings · 20 Data import · 21 Roles and security · 22 Mobile/offline (read) · 23 Settings (core)

**Partly built / later:** 12 Customer order fulfilment (backorders) · 14 Returns and recalls · 15 Field sales updates (forecast adjustment with reason only) · 19 AI assistant. The assistant was left out on purpose: it needs an LLM, and the brief was simple, self-hosted and no external services. It can be added later with a self-hosted model.

## 4. How it works

```
CSV / ERP exports ─┐
(synthetic today)  ├─> server/build.py ── weekly run (~1 min) ──> data/nepd.db (SQLite)
                   │     1 simulate network + demand + disruptions          │
                   │     2 replay manual policy (company history)           │
                   │     3 train on year 1, replay planner on year 2 → KPIs │
                   │     4 retrain on all data → 8-week forecast            │
                   │     5 this week's suggestions, transfers, alerts       │
                   └────────────────────────────────────────────────────────┘
                                                   │
                         server/api.py (FastAPI) ──┤── decisions, orders, what-if, uploads, audit
                                                   │
                         web/ (HTML + CSS + JS, SVG charts, service worker)
```

**Forecast model:** one gradient-boosted model across all 2,400 medicine × location series, with quantile loss for p10/p50/p90 and horizons 1–8 weeks.
- Features: recent sales scaled by the series level, an in-stock-only average, stock-out count, month, monsoon/winter/festival flags, and medicine and location attributes.
- Stock-out weeks are treated as *unknown* demand. They are dropped from training targets and blanked in the lag features, so a shortage is not read as low demand.
- The 80% range contains 86% of actual outcomes in the backtest, so it is slightly wide (conservative).

**Planning policy (weekly):**
- Target stock = forecast demand over lead time + 1 week, plus 1.3 × forecast spread.
- Hill routes get +4 days in the monsoon.
- Stock is transferred first from any location holding more than 8 weeks of cover.
- The remainder is ordered in case packs, or boxes of 10 for slow movers.
- Each order is capped so it can be sold before expiry. The depot ships stock with as little as 35% of its life left, and nothing under 91 days is dispatched.
- Orders above ₹10,000 go to the Head of Supply Chain.

**Simulation assumptions** (`server/sim.py`):
- Seasonal, festival and promotion effects; outbreaks of malaria in Cachar and Dhalai, and diarrhoeal illness in Dhubri; AR(1) distributor noise.
- Intermittent demand for slow movers.
- 1–7 day lead times; 6 monsoon landslide weeks per hill state, plus a late landslide in Mizoram and Manipur this week.
- 15% of orders short-supplied by the manufacturer; a short-dated Dextromethorphan episode.
- Both policies see identical demand and shocks.

**What the results do and do not show:**
- The gains combine better forecasting *and* policy changes: weekly review, smaller boxes and transfers.
- Weekly review doubles dispatch frequency.
- The fill-rate target cannot be reached from a 94.8% baseline.
- Everything must be re-measured on GRD data.

## 5. Roles (demo sign-in from the profile menu)

| User | Role | Sees | Can do |
|---|---|---|---|
| Anjali Barua | Head of Supply Chain | All states | Approve any order, change settings |
| Rahul Deka | Supply Planner | All states | Approve up to the limit |
| Imna Jamir | Regional Manager, hill states | 6 hill states | Approve in own states up to the limit |
| Priya Sharma | Regional Manager, Assam and Tripura | 2 states | Approve in own states up to the limit |
| Field Viewer | Sales / field (read-only) | All states, costs hidden | View only |

Production would use proper sign-in (for example GRD's existing SSO, or OTP login) in place of the demo user switcher.

## 6. Pilot plan (12–16 weeks)

1. **Weeks 1–3, baseline.** Connect ERP dispatch and stockist sales/stock exports for selected SKUs and Assam stockists. Clean the data and measure today's five KPIs.
2. **Weeks 4–6, shadow.** Run the planner alongside the current process and compare its suggestions with actual decisions. Tune the safety factor, lead times and pack rules with the sales and distribution teams.
3. **Weeks 7–14, live.** Planners approve suggestions weekly and agree consolidated dispatch days per route. Track the share of suggestions approved unchanged as an adoption measure.
4. **Weeks 15–16, measure.** Independent before/after on the five KPIs, plus a total-cost-of-ownership note and a scale-up plan to other NE states.

## 7. Next steps if selected

- Connectors for GRD's ERP exports (scheduled CSV/SFTP, or API) in place of synthetic data.
- Returns and recalls (module 14), backorders (12), and field visit notes feeding forecast adjustments (15).
- Email or WhatsApp alerts for urgent stock-outs and approvals.
- Offline write queue for warehouse receipts in low-connectivity locations.
- Assamese / Bengali / Hindi interface labels.
- Optional self-hosted assistant for questions in plain language (19).
