import { expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the shipped dashboard's fetch/render flow without a browser dependency.
class Element {
  children = [];
  style = {};
  attributes = {};
  hidden = false;
  _text = "";
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(" "); }
}
const equity = {
  fund_id: "HSBC:GLOBAL_EQUITY_FUND", units: "16271.9528000000",
  market_value: "552222.88936888", price_date: "2026-10-22",
  units_status: "VERIFIED", price_status: "FRESH"
};
const sold = { ...equity, fund_id: "HSBC:MPF_CONSERVATIVE_FUND", units: "0.0000000000", market_value: "0.00000000" };
function dashboard(funds) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  let fail = false;
  const context = vm.createContext({
    sessionStorage: { getItem: () => "test-key" }, Headers, Intl, console,
    document: { querySelector: element, createElement: () => new Element() },
    t: (key, args = {}) => `${key} ${Object.values(args).join(" ")}`,
    localeTag: () => "en-HK", statusLabel: (value) => value,
    fetch: async (path) => {
      if (fail) throw new Error("Unavailable");
      return { ok: true, json: async () => path.startsWith("/v1/funds")
        ? { items: [{ fund_id: equity.fund_id, name: "Global Equity Fund" }] }
        : { requested_as_of: "2026-10-24", accounts: [{ account_id: "hsbc", currency: "HKD",
          unpriced_fund_count: funds.filter((fund) => fund.market_value === null).length, funds }] } };
    }
  });
  const source = readFileSync(new URL("../../../public/app.js", import.meta.url), "utf8")
    .replace(/^import .*from "\.\/i18n\.js";\n/m, "")
    .replace(/^initialize\(\);$/m, "");
  vm.runInContext(source + "\nglobalThis.view = { state, loadHoldingsChart, renderAllocations };", context);
  const view = context.view;
  view.state.selectedAccount = { account_id: "hsbc", currency: "HKD" };
  view.state.holdings = [{ ...sold, units: "30544.28" }, { ...equity, units: "3352.7576" }];
  return { ...view, element, offline: () => { fail = true; } };
}

test("current holdings and allocation use reconciled units instead of obsolete baselines", async () => {
  const view = dashboard([equity, sold]);
  await view.loadHoldingsChart();
  const table = view.element("#holdings-table").textContent;
  expect(table).toContain("16,271.9528");
  expect(table).toContain("552,222.89");
  expect(table).not.toContain("30,544.28");
  expect(table).not.toContain("3,352.7576");
  expect(table).not.toContain(sold.fund_id);
  expect(view.element("#holding-count").textContent).toBe("1");
  expect(view.state.holdingsChart.slices).toHaveLength(1);
  expect(view.state.holdingsChart.slices[0].percentage).toBe(100);
});

test("unpriced current holdings remain visible even though the chart cannot price them", async () => {
  const view = dashboard([{ ...equity, market_value: null, price_date: null, price_status: "MISSING" }, sold]);
  await view.loadHoldingsChart();
  expect(view.element("#holdings-table").textContent).toContain("16,271.9528");
  expect(view.element("#holdings-table").textContent).toContain("MISSING");
  expect(view.element("#holdings-table").textContent).not.toContain(sold.fund_id);
  expect(view.element("#holdings-chart-content").hidden).toBe(true);
});

test("failed refresh clears previous balances and reports current holdings as unavailable", async () => {
  const view = dashboard([equity, sold]);
  await view.loadHoldingsChart();
  view.offline();
  await view.loadHoldingsChart();
  expect(view.element("#holdings-table").textContent).toBe("");
  expect(view.element("#current-holdings-message").textContent).toContain("holdings.load_failed");
  expect(view.state.holdingsChart).toBeNull();
  expect(view.element("#holding-count").textContent).toBe("—");
});


test("replaced allocations appear as expired history and only active rules are counted", () => {
  const view = dashboard([]);
  view.state.allocations = [
    { fund_id: "old-fund", weight: "100", effective_from: "2026-09-01", effective_to: "2026-10-23" },
    { fund_id: "new-fund-a", weight: "40", effective_from: "2026-10-24", effective_to: null },
    { fund_id: "new-fund-b", weight: "60", effective_from: "2026-10-24", effective_to: null }
  ];
  view.renderAllocations(new Date("2026-10-23T16:00:00Z"));
  const current = view.element("#allocations-table").textContent;
  expect(current).toContain("allocation.active");
  expect(current).toContain("new-fund-a");
  expect(current).toContain("new-fund-b");
  expect(current).not.toContain("old-fund");
  const history = view.element("#allocation-history-table").textContent;
  expect(history).toContain("old-fund");
  expect(history).toContain("allocation.expired");
  expect(view.element("#allocation-history").hidden).toBe(false);
  expect(view.element("#allocation-count").textContent).toBe("2");
});

test("end dates are inclusive and future allocations stay scheduled until Hong Kong midnight", () => {
  const view = dashboard([]);
  view.state.allocations = [
    { fund_id: "old-fund", weight: "100", effective_from: "2026-09-01", effective_to: "2026-10-23" },
    { fund_id: "new-fund", weight: "100", effective_from: "2026-10-24", effective_to: null }
  ];
  view.renderAllocations(new Date("2026-10-23T15:59:59Z"));
  const current = view.element("#allocations-table").textContent;
  expect(current).toContain("allocation.active");
  expect(current).toContain("allocation.scheduled");
  expect(view.element("#allocation-count").textContent).toBe("1");
  expect(view.element("#allocation-history").hidden).toBe(true);
});
