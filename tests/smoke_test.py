"""End-to-end smoke test: every API endpoint, the approval rules, role scoping, order receipt and CSV checks.
Run:  python tests/smoke_test.py      (uses a temporary copy of data/nepd.db; nothing is changed)"""
import shutil, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from fastapi.testclient import TestClient  # noqa: E402
from server import api  # noqa: E402

tmp = Path(tempfile.mkdtemp()) / "nepd.db"
shutil.copy(ROOT / "data" / "nepd.db", tmp)
api.DB_PATH = tmp
c = TestClient(api.app)
PLANNER, HEAD, HILLS, VIEWER = ({"X-User": u} for u in ("U2", "U1", "U3", "U5"))
ok = 0


def check(cond, msg):
    global ok
    assert cond, msg
    ok += 1
    print("  ✓", msg)


def get(path, h=PLANNER):
    r = c.get(path, headers=h)
    assert r.status_code == 200, (path, r.status_code, r.text[:300])
    return r.json()


print("Read endpoints")
for p in ["/api/session", "/api/overview", "/api/locations", "/api/locations/LOC01", "/api/medicines", "/api/medicines/SKU001",
          "/api/inventory", "/api/expiry", "/api/forecast?sku=SKU001&loc=LOC01", "/api/forecast?sku=SKU001", "/api/forecast/reliability",
          "/api/recommendations", "/api/orders", "/api/alerts", "/api/impact", "/api/uploads", "/api/audit", "/api/settings"]:
    get(p)
check(True, "18 read endpoints return 200")
imp = {m["metric"]: m for m in get("/api/impact")["metrics"]}
check(imp["stockout"]["planner"] < imp["stockout"]["manual"], "planner reduces stock-outs in the backtest")
check(get("/api/forecast?sku=SKU001")["accuracy"]["model"] > get("/api/forecast?sku=SKU001")["accuracy"]["baseline"], "model beats 8-week average for SKU001 (network)")

print("Decisions and approval limit")
recs = get("/api/recommendations")
small = next(r for r in recs if not r["needs_approval"])
big = next(r for r in recs if r["needs_approval"])
post = lambda p, b, h=PLANNER: c.post(p, json=b, headers=h)
check(post(f"/api/recommendations/{small['rec_id']}/decision", {"action": "approve"}).json()["status"] == "approved", "planner approves an order under the limit")
check(post(f"/api/recommendations/{big['rec_id']}/decision", {"action": "approve"}).json()["status"] == "awaiting_approval", "order above the limit goes to the Head")
check(post(f"/api/recommendations/{big['rec_id']}/decision", {"action": "approve"}).status_code == 403, "planner cannot approve it a second time")
check(post(f"/api/recommendations/{big['rec_id']}/decision", {"action": "approve"}, HEAD).json()["status"] == "approved", "Head of Supply Chain approves it")
check(post(f"/api/recommendations/{recs[5]['rec_id']}/decision", {"action": "reject"}).status_code == 400, "reject without a reason is refused")
check(post(f"/api/recommendations/{recs[5]['rec_id']}/decision", {"action": "reject", "note": "duplicate"}).json()["status"] == "rejected", "reject with a reason works")
tr = next(r for r in recs if r["transfer_from"] and r["status"] == "open" and not r["needs_approval"])
post(f"/api/recommendations/{tr['rec_id']}/decision", {"action": "approve"})
kinds = {o["kind"] for o in get("/api/orders?origin=planner")["items"]}
check(kinds == {"replenishment", "transfer"}, "approvals create depot dispatches and transfers")

print("Order life-cycle")
o = get("/api/orders?origin=planner")["items"][0]
before = sum(b["on_hand"] for b in get("/api/inventory")["items"] if b["sku_id"] == o["sku_id"] and b["location_id"] == o["location_id"])
for _ in range(3):
    post(f"/api/orders/{o['order_id']}/advance", {})
after = sum(b["on_hand"] for b in get("/api/inventory")["items"] if b["sku_id"] == o["sku_id"] and b["location_id"] == o["location_id"])
check(after > before, f"receiving {o['order_id']} adds stock ({before} → {after})")

print("Roles")
check(post(f"/api/recommendations/{recs[7]['rec_id']}/decision", {"action": "approve"}, VIEWER).status_code == 403, "viewer cannot approve")
check(get("/api/recommendations", VIEWER)[0]["value"] is None, "viewer cannot see values")
hill_states = set(get("/api/session", HILLS)["user"]["states"])
check({r["state"] for r in get("/api/recommendations", HILLS)} <= hill_states, "regional manager sees only own states")
check(c.post("/api/settings", json={"approval_limit": 1}, headers=PLANNER).status_code == 403, "only the Head can change settings")

print("What-if and data import")
w0 = post("/api/whatif", {"sku": "SKU008", "loc": "LOC34", "order_qty": 0}).json()["summary"]
w1 = post("/api/whatif", {"sku": "SKU008", "loc": "LOC34", "order_qty": 300}).json()["summary"]
check(w1["fill_rate"] > w0["fill_rate"], "what-if: placing an order raises the expected fill rate")
r = c.post("/api/upload", data={"kind": "stock"}, files={"file": ("s.csv", (ROOT / "samples" / "stock_sample.csv").read_bytes())}, headers=PLANNER).json()
check(r["errors"] >= 3 and r["status"] == "needs_attention", f"stock template: {r['errors']} errors, {r['warnings']} warnings flagged")
check(c.get("/api/export/recommendations.csv?x_user=U2").text.startswith("rec_id,"), "CSV export works")
check(len(get("/api/audit")) > 5, "decisions are written to the audit trail")
print(f"\nAll {ok} checks passed.")
