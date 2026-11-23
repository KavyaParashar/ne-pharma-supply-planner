CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE medicines (sku_id TEXT PRIMARY KEY, name TEXT, form TEXT, category TEXT, season TEXT, velocity TEXT,
  mrp REAL, cost REAL, case_pack INTEGER, shelf_life_months INTEGER, status TEXT);
CREATE TABLE locations (location_id TEXT PRIMARY KEY, name TEXT, type TEXT, state TEXT, district TEXT, hill INTEGER,
  lead_days INTEGER, lat REAL, lon REAL, status TEXT);
CREATE TABLE weeks (week INTEGER PRIMARY KEY, week_start TEXT, month INTEGER, monsoon INTEGER, festival TEXT);
CREATE TABLE weekly (sku_id TEXT, location_id TEXT, week INTEGER, sales INTEGER, closing INTEGER, stockout INTEGER,
  expired INTEGER, true_demand INTEGER, PRIMARY KEY (sku_id, location_id, week));
CREATE INDEX weekly_week ON weekly(week);
CREATE INDEX weekly_loc ON weekly(location_id, week);
CREATE TABLE forecast (sku_id TEXT, location_id TEXT, week INTEGER, horizon INTEGER, p10 REAL, p50 REAL, p90 REAL);
CREATE INDEX forecast_key ON forecast(sku_id, location_id);
CREATE TABLE forecast_backtest (sku_id TEXT, location_id TEXT, week INTEGER, p10 REAL, p50 REAL, p90 REAL, ma8 REAL);
CREATE INDEX fbt_key ON forecast_backtest(sku_id, location_id);
CREATE TABLE forecast_adjustments (sku_id TEXT, location_id TEXT, pct REAL, reason TEXT, user TEXT, ts TEXT);
CREATE TABLE batches (batch_id TEXT PRIMARY KEY, sku_id TEXT, location_id TEXT, qty INTEGER, mfg_date TEXT,
  expiry_date TEXT, received_date TEXT, status TEXT);
CREATE INDEX batches_key ON batches(sku_id, location_id);
CREATE TABLE orders (order_id TEXT PRIMARY KEY, kind TEXT, sku_id TEXT, location_id TEXT, source TEXT, qty INTEGER,
  order_date TEXT, eta TEXT, status TEXT, note TEXT, origin TEXT, rec_id TEXT, created_by TEXT, updated_at TEXT);
CREATE INDEX orders_loc ON orders(location_id);
CREATE TABLE recommendations (rec_id TEXT PRIMARY KEY, sku_id TEXT, location_id TEXT, priority TEXT, on_hand INTEGER,
  on_order INTEGER, cover_days REAL, lead_days REAL, forecast_week REAL, forecast_low REAL, forecast_high REAL,
  sold_4wk REAL, target_stock REAL, suggested_qty INTEGER, transfer_from TEXT, transfer_qty INTEGER, value REAL,
  needs_approval INTEGER, reason TEXT, status TEXT, decided_qty INTEGER, decided_by TEXT, decided_at TEXT,
  decision_note TEXT);
CREATE TABLE alerts (alert_id TEXT PRIMARY KEY, kind TEXT, severity TEXT, sku_id TEXT, location_id TEXT, message TEXT,
  created TEXT, status TEXT, assigned_to TEXT);
CREATE TABLE impact (metric TEXT PRIMARY KEY, label TEXT, manual REAL, planner REAL, unit TEXT, target TEXT,
  met INTEGER, note TEXT);
CREATE TABLE impact_weekly (week INTEGER, stockout_manual REAL, stockout_planner REAL, inventory_manual REAL,
  inventory_planner REAL);
CREATE TABLE users (user_id TEXT PRIMARY KEY, name TEXT, role TEXT, title TEXT, scope TEXT);
CREATE TABLE audit (ts TEXT, user TEXT, action TEXT, entity TEXT, detail TEXT);
CREATE TABLE uploads (upload_id TEXT PRIMARY KEY, ts TEXT, user TEXT, filename TEXT, kind TEXT, rows INTEGER,
  errors INTEGER, warnings INTEGER, status TEXT, report TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
