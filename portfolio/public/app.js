import { initI18n, localeTag, statusLabel, t } from "./i18n.js";

const state = {
  apiKey: sessionStorage.getItem("mpf_portfolio_api_key") ?? "",
  accounts: [],
  selectedAccount: null,
  holdings: [],
  switches: [],
  switchRequestId: null,
  allocations: [],
  plans: [],
  contributionHistory: [],
  confirmingEventId: null,
  confirmingDate: null,
  reconciliations: [],
  funds: new Map(),
  snapshotHistory: [],
  valuation: null,
  holdingsChart: null,
  currentHoldings: null,
  currentHoldingsMessageKey: "chart.holdings_hint",
  connectionStatus: { key: "status.not_connected", kind: "neutral" },
  valuationMessageKey: "valuation.hint",
  chartMessageKey: "chart.loading"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

let toastTimer;

function showToast(message, type = "success") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", type === "error");
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function setConnectionStatus(key, kind) {
  state.connectionStatus = { key, kind };
  const status = $("#connection-status");
  status.textContent = t(key);
  status.className = `status-pill status-${kind}`;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return t("error.unexpected");
}

async function api(path, options = {}) {
  if (!state.apiKey) {
    throw new Error(t("error.api_key_missing"));
  }

  const headers = new Headers(options.headers ?? {});
  headers.set("X-API-Key", state.apiKey);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details = Array.isArray(payload.issues)
      ? ` ${payload.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`
      : "";
    throw new Error(`${payload.detail ?? t("error.request_failed", { status: response.status })}${details}`);
  }
  return payload;
}

async function submitForm(form, action) {
  const button = form.querySelector('button[type="submit"]');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = t("btn.saving");
  try {
    await action();
  } catch (error) {
    showToast(errorMessage(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : "—";
}

function formatNumber(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 10 }).format(number)
    : String(value);
}

function moneyFormatter(currency) {
  return new Intl.NumberFormat(localeTag(), {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function dateTime(value) {
  return value ? new Date(value).toLocaleString(localeTag()) : "—";
}

function fundName(fundId) {
  return state.funds.get(fundId)?.name ?? fundId;
}

async function loadFundNames(fundIds) {
  const ids = [...new Set(fundIds.filter(Boolean))];
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const result = await api(`/v1/funds?ids=${encodeURIComponent(chunk.join(","))}`);
    for (const fund of result.items ?? []) state.funds.set(fund.fund_id, fund);
  }
}

function renderTable(containerSelector, columns, rows, emptyMessage) {
  const container = $(containerSelector);
  container.replaceChildren();

  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "table-empty";
    empty.textContent = emptyMessage;
    container.append(empty);
    return;
  }

  const table = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = column.label;
    headRow.append(th);
  }
  head.append(headRow);

  const body = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      if (column.render) {
        column.render(td, row);
      } else {
        const value = column.format ? column.format(row[column.key], row) : row[column.key];
        td.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
      }
      if (column.className) td.className = column.className;
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(head, body);
  container.append(table);
}

function renderAccountList() {
  const list = $("#account-list");
  list.replaceChildren();

  if (state.accounts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = t("sidebar.empty_accounts");
    list.append(empty);
    return;
  }

  for (const account of state.accounts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "account-item";
    button.classList.toggle(
      "active",
      state.selectedAccount?.account_id === account.account_id
    );

    const label = document.createElement("strong");
    label.textContent = account.display_label;
    const detail = document.createElement("span");
    detail.textContent = `${account.provider} · ${account.currency}${account.active ? "" : ` · ${t("account.inactive")}`}`;
    button.append(label, detail);
    button.addEventListener("click", () => selectAccount(account.account_id));
    list.append(button);
  }
}

function renderAllocations(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(now);
  const part = (type) => parts.find((item) => item.type === type).value;
  const today = `${part("year")}-${part("month")}-${part("day")}`;
  const rules = state.allocations.map((rule) => ({
    ...rule,
    allocation_status: rule.effective_to && dateOnly(rule.effective_to) < today ? "expired"
      : dateOnly(rule.effective_from) > today ? "scheduled" : "active"
  }));
  const columns =
    [
      { label: t("col.status"), key: "allocation_status", format: (value) => t(`allocation.${value}`) },
      { label: t("col.from"), key: "effective_from", format: dateOnly },
      { label: t("col.to"), key: "effective_to", format: dateOnly },
      { label: t("col.stream"), key: "contribution_stream" },
      { label: t("col.fund"), key: "fund_id", format: fundName },
      {
        label: t("col.weight"),
        key: "weight",
        format: (value) => `${formatNumber(value)}%`,
        className: "value-positive"
      }
    ];
  const expired = rules.filter((rule) => rule.allocation_status === "expired");
  renderTable("#allocations-table", columns,
    rules.filter((rule) => rule.allocation_status !== "expired"), t("empty.current_allocations"));
  renderTable("#allocation-history-table", columns, expired, t("empty.allocations"));
  $("#allocation-history").hidden = expired.length === 0;
  $("#allocation-count").textContent = String(rules.filter((rule) => rule.allocation_status === "active").length);
}

function renderAccountWorkspace() {
  const account = state.selectedAccount;
  if (!account) return;

  $("#empty-state").hidden = true;
  $("#account-workspace").hidden = false;
  $("#account-provider").textContent = account.provider;
  $("#account-title").textContent = account.display_label;
  $("#account-scheme").textContent = account.scheme;
  $("#account-currency").textContent = account.currency;
  $("#account-active").textContent = account.active ? t("common.active") : t("account.inactive");
  $("#holding-count").textContent = state.currentHoldings
    ? String(state.currentHoldings.funds.length) : "—";
  $("#plan-count").textContent = String(state.plans.length);

  const updateForm = $("#update-account-form");
  updateForm.elements.display_label.value = account.display_label;
  updateForm.elements.currency.value = account.currency;
  updateForm.elements.active.checked = account.active;

  renderTable(
    "#baseline-history-table",
    [
      { label: t("col.effective_date"), key: "effective_date", format: dateOnly },
      { label: t("col.fund"), key: "fund_id", format: fundName },
      { label: t("col.units"), key: "units", format: formatNumber, className: "value-positive" },
      { label: t("col.status"), key: "verification_status", format: statusLabel },
      { label: t("col.source"), key: "source" }
    ],
    state.holdings,
    t("empty.holdings")
  );
  renderCurrentHoldings();

  renderTable("#switches-table", [
    { label: t("switch.date"), key: "trade_date", format: dateOnly },
    { label: t("switch.sold"), key: "sales", format: (legs) => legs.map((leg) => `${fundName(leg.fund_id)}: ${formatNumber(leg.units)}`).join(" · ") },
    { label: t("switch.bought"), key: "purchases", format: (legs) => legs.map((leg) => `${fundName(leg.fund_id)}: ${formatNumber(leg.units)}`).join(" · ") },
    { label: t("col.notes"), key: "notes" }
  ], state.switches, t("switch.empty"));

  renderTable(
    "#reconciliations-table",
    [
      { label: t("col.effective_date"), key: "effective_date", format: dateOnly },
      { label: t("col.notes"), key: "notes" },
      { label: t("col.verified_units"), key: "holdings", format: (holdings) => holdings.map((holding) => `${fundName(holding.fund_id)}: ${formatNumber(holding.units)}`).join(" · ") }
    ],
    state.reconciliations,
    t("empty.reconciliations")
  );

  renderAllocations();

  renderTable(
    "#plans-table",
    [
      { label: t("col.from"), key: "effective_from", format: dateOnly },
      { label: t("col.to"), key: "effective_to", format: dateOnly },
      { label: t("col.stream"), key: "contribution_stream" },
      { label: t("col.amount"), key: "amount", format: formatNumber, className: "value-positive" },
      { label: t("col.expected_day"), key: "expected_day" },
      { label: t("col.status"), key: "active", format: (value) => (value ? t("common.active") : t("plan.closed")) }
    ],
    state.plans,
    t("empty.plans")
  );

  const money = moneyFormatter(account.currency);
  renderTable(
    "#contribution-history-table",
    [
      { label: t("col.run_date"), key: "created_at", format: dateTime },
      { label: t("col.expected_date"), key: "expected_date", format: dateOnly },
      { label: t("col.stream"), key: "contribution_stream" },
      { label: t("col.contribution"), key: "amount", format: (value) => money.format(Number(value)) },
      { label: t("col.status"), key: "status", format: statusLabel },
      { label: t("col.actual_details"), render: (cell, event) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "text-button";
        button.textContent = event.status === "CONFIRMED" ? t("btn.edit_actual") : t("btn.enter_actual");
        button.addEventListener("click", () => openConfirmationEditor(event));
        cell.append(button);
      } },
      {
        label: t("col.fund_transactions"),
        key: "transactions",
        format: (transactions) => transactions.length
          ? transactions.map((transaction) => t("fund.transaction_line", {
            fund: fundName(transaction.fund_id),
            amount: money.format(Number(transaction.cash_amount)),
            price: formatNumber(transaction.unit_price),
            units: formatNumber(transaction.units_delta),
            status: statusLabel(transaction.status)
          })).join(" · ")
          : "—"
      }
    ],
    state.contributionHistory,
    t("empty.contributions")
  );

  renderTable(
    "#valuation-history-table",
    [
      { label: t("col.as_of"), key: "as_of_date", format: dateOnly },
      {
        label: t("col.value"),
        key: "total_value",
        format: (value, row) => value === null ? "—" : moneyFormatter(row.currency ?? account.currency).format(Number(value))
      },
      { label: t("col.status"), key: "calculation_status", format: statusLabel },
      { label: t("col.calculated"), key: "calculated_at", format: dateTime },
      { label: t("col.revision"), key: "revision" }
    ],
    state.snapshotHistory,
    t("empty.snapshots")
  );

  if (state.holdingsChart) renderHoldingsChart();

  renderAccountList();
}

async function loadAccounts({ selectId } = {}) {
  state.accounts = await api("/v1/accounts");
  setConnectionStatus("status.connected", "good");
  renderAccountList();

  const targetId = selectId ?? state.selectedAccount?.account_id;
  if (targetId && state.accounts.some((account) => account.account_id === targetId)) {
    await selectAccount(targetId);
  }
}

async function selectAccount(accountId) {
  try {
    const [account, holdings, allocations, plans, reconciliations, contributionHistory, switches] = await Promise.all([
      api(`/v1/accounts/${accountId}`),
      api(`/v1/accounts/${accountId}/holdings`),
      api(`/v1/accounts/${accountId}/allocation-rules`),
      api(`/v1/accounts/${accountId}/contribution-plans`),
      api(`/v1/accounts/${accountId}/reconciliations`),
      api(`/v1/accounts/${accountId}/contribution-history`),
      api(`/v1/accounts/${accountId}/switches`)
    ]);
    if (state.selectedAccount?.account_id !== accountId) {
      state.switchRequestId = null;
      $("#switch-form").reset();
      resetFundRows("switch-from-rows");
      resetFundRows("switch-to-rows");
      setDefaultDates();
    }
    state.selectedAccount = account;
    state.switches = switches.items;
    state.holdings = holdings.items;
    state.allocations = allocations.items;
    state.plans = plans.items;
    state.contributionHistory = contributionHistory.items;
    state.confirmingEventId = null;
    state.confirmingDate = null;
    $("#confirmation-editor").hidden = true;
    state.reconciliations = reconciliations.items;
    state.snapshotHistory = [];
    state.funds = new Map();
    const fundIds = [
      ...switches.items.flatMap((item) => [...item.sales, ...item.purchases].map((leg) => leg.fund_id)),
      ...holdings.items.map((holding) => holding.fund_id),
      ...allocations.items.map((allocation) => allocation.fund_id),
      ...reconciliations.items.flatMap((item) => item.holdings.map((holding) => holding.fund_id)),
      ...contributionHistory.items.flatMap((event) => event.transactions.map((transaction) => transaction.fund_id))
    ];
    await loadFundNames(fundIds);
    state.valuation = null;
    state.holdingsChart = null;
    state.currentHoldings = null;
    state.currentHoldingsMessageKey = "chart.holdings_hint";
    $("#valuation-results").hidden = true;
    $("#valuation-message").hidden = false;
    setValuationMessage("valuation.hint");
    $("#holdings-chart-content").hidden = true;
    $("#holdings-chart-message").hidden = false;
    setChartMessage("chart.holdings_hint");
    renderAccountWorkspace();
    await loadHoldingsChart();
  } catch (error) {
    showToast(errorMessage(error), "error");
  }
}

function addFundRow(containerId) {
  const container = document.getElementById(containerId);
  const kind = container.dataset.kind;
  const row = document.createElement("div");
  row.className = "repeat-row";

  const picker = document.createElement("div");
  picker.className = "fund-picker";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = t("fund.search_placeholder");
  search.autocomplete = "off";
  search.setAttribute("aria-label", t("fund.search_aria"));
  search.setAttribute("aria-autocomplete", "list");
  const fund = document.createElement("input");
  fund.type = "hidden";
  fund.name = "fund_id";
  const suggestions = document.createElement("div");
  suggestions.className = "fund-suggestions";
  suggestions.hidden = true;
  suggestions.setAttribute("role", "listbox");
  picker.append(search, fund, suggestions);

  search.addEventListener("input", () => {
    fund.value = "";
    clearTimeout(row.searchTimer);
    const term = search.value.trim();
    if (term.length < 2) {
      suggestions.hidden = true;
      suggestions.replaceChildren();
      return;
    }
    suggestions.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "fund-suggestion-empty";
    loading.textContent = t("fund.searching");
    suggestions.append(loading);
    suggestions.hidden = false;
    row.searchTimer = setTimeout(async () => {
      try {
        const result = await api(`/v1/funds?search=${encodeURIComponent(term)}`);
        if (search.value.trim() !== term) return;
        suggestions.replaceChildren();
        if (result.items.length === 0) {
          const empty = document.createElement("div");
          empty.className = "fund-suggestion-empty";
          empty.textContent = t("fund.no_results");
          suggestions.append(empty);
          return;
        }
        for (const item of result.items) {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "fund-suggestion";
          option.setAttribute("role", "option");
          const name = document.createElement("strong");
          name.textContent = item.name;
          const detail = document.createElement("small");
          const aliases = Array.isArray(item.aliases) ? item.aliases.filter(Boolean) : [];
          detail.textContent = `${item.provider} · ${item.provider_fund_code}${aliases.length ? ` · ${aliases.join(" · ")}` : ""}`;
          option.append(name, detail);
          option.addEventListener("click", () => {
            fund.value = item.fund_id;
            search.value = `${item.name} · ${item.provider_fund_code}`;
            suggestions.hidden = true;
            suggestions.replaceChildren();
          });
          suggestions.append(option);
        }
      } catch (error) {
        if (search.value.trim() !== term) return;
        suggestions.replaceChildren();
        const failure = document.createElement("div");
        failure.className = "fund-suggestion-empty";
        failure.textContent = errorMessage(error);
        suggestions.append(failure);
      }
    }, 250);
  });

  const value = document.createElement("input");
  value.name = kind;
  value.type = "number";
  value.step = kind === "weight" ? "0.01" : "any";
  value.min = "0";
  value.placeholder = kind === "weight" ? t("fund.weight_placeholder") : t("fund.units_placeholder");
  value.required = true;
  if (kind === "weight") value.addEventListener("input", updateAllocationTotal);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-row";
  remove.setAttribute("aria-label", t("fund.remove_aria"));
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    row.remove();
    if (containerId.startsWith("switch-")) state.switchRequestId = null;
    updateAllocationTotal();
  });

  row.append(picker, value, remove);
  container.append(row);
  if (containerId.startsWith("switch-")) state.switchRequestId = null;
}

function readFundRows(containerId, valueName) {
  const rows = [...document.querySelectorAll(`#${containerId} .repeat-row`)].map((row) => ({
    fund_id: row.querySelector('[name="fund_id"]').value.trim(),
    [valueName]: row.querySelector(`[name="${valueName}"]`).value
  }));
  if (rows.length === 0 || rows.some((row) => !row.fund_id || row[valueName] === "")) {
    throw new Error(t("error.fund_rows_incomplete"));
  }
  return rows;
}

function resetFundRows(containerId) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  addFundRow(containerId);
  updateAllocationTotal();
}

function addConfirmationRow(transaction = {}) {
  addFundRow("confirmation-rows");
  const row = $("#confirmation-rows").lastElementChild;
  row.classList.add("confirmation-row");
  const fundId = transaction.fund_id ?? "";
  row.querySelector('[name="fund_id"]').value = fundId;
  row.querySelector('input[type="search"]').value = fundId ? fundName(fundId) : "";

  const field = (name, label, type, value) => {
    const input = document.createElement("input");
    input.name = name;
    input.type = type;
    input.value = value ?? "";
    input.required = true;
    input.setAttribute("aria-label", label);
    if (type === "number") {
      input.min = "0";
      input.step = "any";
    }
    return input;
  };
  const units = row.querySelector('[name="units_delta"]');
  units.value = transaction.units_delta ?? "";
  units.setAttribute("aria-label", t("confirm.units_aria"));
  row.insertBefore(field("trade_date", t("col.trade_date"), "date", transaction.trade_date ?? state.confirmingDate), units);
  row.insertBefore(field("cash_amount", t("col.cash_amount"), "number", transaction.cash_amount), units);
  row.insertBefore(field("unit_price", t("col.unit_price"), "number", transaction.unit_price), units);
}

function openConfirmationEditor(event) {
  state.confirmingEventId = event.event_id;
  state.confirmingDate = dateOnly(event.transactions[0]?.trade_date ?? event.expected_date);
  $("#confirmation-event-label").textContent = t("confirm.event_label", {
    stream: event.contribution_stream,
    date: dateOnly(event.expected_date),
    status: statusLabel(event.status)
  });
  $("#confirmation-rows").replaceChildren();
  for (const transaction of event.transactions) addConfirmationRow(transaction);
  if (event.transactions.length === 0) addConfirmationRow();
  $("#confirmation-editor").hidden = false;
  $("#confirmation-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function readConfirmationRows() {
  const rows = [...document.querySelectorAll("#confirmation-rows .confirmation-row")].map((row) => {
    const value = (name) => row.querySelector(`[name="${name}"]`).value.trim();
    return {
      fund_id: value("fund_id"),
      trade_date: value("trade_date"),
      cash_amount: value("cash_amount"),
      unit_price: value("unit_price"),
      units_delta: value("units_delta")
    };
  });
  if (rows.length === 0 || rows.some((row) => Object.values(row).some((value) => !value))) {
    throw new Error(t("error.confirmation_rows_incomplete"));
  }
  if (new Set(rows.map((row) => row.fund_id)).size !== rows.length) {
    throw new Error(t("error.confirmation_fund_duplicate"));
  }
  return rows;
}

function updateAllocationTotal() {
  const total = [...document.querySelectorAll('#allocation-rows [name="weight"]')]
    .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const badge = $("#allocation-total");
  badge.textContent = `${Number(total.toFixed(4))}%`;
  badge.classList.toggle("valid", Math.abs(total - 100) < 1e-9);
}

function selectedAccountId() {
  if (!state.selectedAccount) throw new Error(t("error.account_required"));
  return state.selectedAccount.account_id;
}

function optionalDate(form, name) {
  const value = form.elements[name].value;
  return value ? { [name]: value } : {};
}

function setDefaultDates() {
  const today = new Date().toISOString().slice(0, 10);
  for (const input of $$('input[type="date"]')) {
    if (!input.name.endsWith("_to") && !input.value) input.value = today;
  }
}

function renderCurrentHoldings() {
  const holdings = state.currentHoldings;
  const message = $("#current-holdings-message");
  if (!holdings) {
    $("#holdings-table").replaceChildren();
    message.textContent = t(state.currentHoldingsMessageKey ?? "chart.holdings_hint");
    return;
  }
  message.textContent = t("holdings.as_of", { date: dateOnly(holdings.requestedAsOf) });
  $("#holding-count").textContent = String(holdings.funds.length);
  const money = moneyFormatter(holdings.currency);
  renderTable("#holdings-table", [
    { label: t("col.fund"), key: "fund_id", format: fundName },
    { label: t("col.units"), key: "units", format: formatNumber },
    { label: t("col.value"), key: "market_value", format: (value) => value === null ? "—" : money.format(Number(value)) },
    { label: t("col.price_date"), key: "price_date", format: dateOnly },
    { label: t("col.units_status"), key: "units_status", format: statusLabel },
    { label: t("col.price_status"), key: "price_status", format: statusLabel }
  ], holdings.funds, t("holdings.empty_current"));
}

function renderHoldingsChart() {
  const chart = state.holdingsChart;
  if (!chart) return;
  const { accountId, requestedAsOf, unpriced, currency, slices, pricedTotal } = chart;
  const pie = $("#holdings-pie");
  pie.style.background = `conic-gradient(${slices.map((slice) => `${slice.color} ${slice.start}deg ${slice.end}deg`).join(", ")})`;
  pie.setAttribute(
    "aria-label",
    t("chart.pie_aria", {
      list: slices.map((slice) => `${slice.info?.name ?? slice.fund_id} ${slice.percentage.toFixed(1)}%`).join(", ")
    })
  );

  const legend = $("#holdings-legend");
  legend.replaceChildren();
  const money = moneyFormatter(currency);
  for (const slice of slices) {
    const item = document.createElement("li");
    const swatch = document.createElement("span");
    swatch.className = "holdings-legend-swatch";
    swatch.style.backgroundColor = slice.color;
    const details = document.createElement("span");
    details.className = "holdings-legend-details";
    const name = document.createElement("strong");
    name.textContent = slice.info?.name ?? slice.fund_id;
    const amount = document.createElement("small");
    amount.textContent = `${slice.percentage.toFixed(1)}% · ${money.format(slice.value)}`;
    details.append(name, amount);
    item.append(swatch, details);
    legend.append(item);
  }

  const message = $("#holdings-chart-message");
  state.chartMessageKey = null;
  message.textContent =
    t("chart.as_of_priced", { date: dateOnly(requestedAsOf), amount: money.format(pricedTotal) }) +
    (unpriced > 0 ? t("chart.unpriced_excluded", { count: unpriced }) : "");
  $("#holdings-chart-content").hidden = false;
}

async function loadHoldingsChart() {
  if (!state.selectedAccount) return;
  const accountId = state.selectedAccount.account_id;
  const button = $("#refresh-holdings-chart");
  const message = $("#holdings-chart-message");
  const content = $("#holdings-chart-content");
  button.disabled = true;
  button.textContent = t("btn.loading");
  content.hidden = true;
  message.hidden = false;
  setChartMessage("chart.loading_values");
  state.holdingsChart = null;
  state.currentHoldings = null;
  state.currentHoldingsMessageKey = "chart.loading_values";
  $("#holding-count").textContent = "—";
  renderCurrentHoldings();
  try {
    const result = await api(`/v1/valuation/latest?account_id=${encodeURIComponent(accountId)}`);
    if (state.selectedAccount?.account_id !== accountId) return;
    const account = result.accounts?.find((item) => item.account_id === accountId);
    // Current balances come from valuation, which applies baselines, trades and switches.
    // Keep unpriced positions visible; a fully sold fund belongs only in history.
    const currentFunds = (account?.funds ?? []).filter((fund) => Number(fund.units) !== 0);
    await loadFundNames(currentFunds.map((fund) => fund.fund_id)).catch(() => { });
    if (state.selectedAccount?.account_id !== accountId) return;
    state.currentHoldings = {
      requestedAsOf: result.requested_as_of,
      currency: account?.currency ?? state.selectedAccount.currency,
      funds: currentFunds
    };
    renderCurrentHoldings();
    const pricedFunds = currentFunds
      .filter((fund) => fund.market_value !== null && Number(fund.market_value) > 0)
      .map((fund) => ({ ...fund, value: Number(fund.market_value) }));
    const pricedTotal = pricedFunds.reduce((sum, fund) => sum + fund.value, 0);
    if (pricedFunds.length === 0 || pricedTotal <= 0) {
      state.holdingsChart = null;
      setChartMessage("chart.no_priced");
      return;
    }

    const colors = ["#0071e1", "#af5815", "#248a3d", "#8b5fcf", "#c93f6b", "#0a86a8", "#5e8c3a", "#6e6e73"];
    let cursor = 0;
    const slices = pricedFunds.map((fund, index) => {
      const start = cursor;
      const percentage = (fund.value / pricedTotal) * 100;
      cursor += percentage * 3.6;
      return { ...fund, percentage, start, end: cursor, color: colors[index % colors.length], info: state.funds.get(fund.fund_id) };
    });
    state.holdingsChart = {
      accountId,
      requestedAsOf: result.requested_as_of,
      unpriced: account?.unpriced_fund_count ?? 0,
      currency: account.currency ?? state.selectedAccount.currency,
      slices,
      pricedTotal
    };
    renderHoldingsChart();
  } catch (error) {
    if (state.selectedAccount?.account_id === accountId) {
      state.chartMessageKey = null;
      message.textContent = errorMessage(error);
      state.currentHoldingsMessageKey = "holdings.load_failed";
      renderCurrentHoldings();
    }
  } finally {
    button.disabled = false;
    button.textContent = t("btn.refresh");
  }
}

async function loadSnapshotHistory() {
  if (!state.selectedAccount) return;
  const accountId = state.selectedAccount.account_id;
  const button = $("#refresh-valuation-history");
  button.disabled = true;
  button.textContent = t("btn.loading");
  try {
    const result = await api(`/v1/valuation/history?account_id=${encodeURIComponent(accountId)}`);
    if (state.selectedAccount?.account_id !== accountId) return;
    state.snapshotHistory = result.items ?? [];
    renderAccountWorkspace();
  } catch (error) {
    showToast(errorMessage(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = t("btn.refresh_history");
  }
}

function setValuationMessage(key) {
  state.valuationMessageKey = key;
  $("#valuation-message").textContent = t(key);
}

function setChartMessage(key) {
  state.chartMessageKey = key;
  $("#holdings-chart-message").textContent = t(key);
}

function renderValuationResults() {
  const valuation = state.valuation;
  if (!valuation) return;
  const { result, account: accountResult } = valuation;
  const currency = accountResult.currency ?? state.selectedAccount?.currency ?? "HKD";
  const money = moneyFormatter(currency);
  const amount = accountResult.total_value ?? accountResult.priced_subtotal;
  $("#valuation-total").textContent = amount === null || amount === undefined
    ? t("valuation.unavailable")
    : money.format(Number(amount));
  $("#valuation-currency").textContent = accountResult.total_value === null
    ? t("valuation.priced_subtotal", { currency })
    : currency;
  $("#valuation-status").textContent = statusLabel(accountResult.calculation_status);
  $("#valuation-as-of").textContent = t("valuation.as_of", { date: dateOnly(result.requested_as_of) });
  $("#valuation-unpriced").textContent = String(accountResult.unpriced_fund_count);
  $("#valuation-calculated-at").textContent = t("valuation.calculated", { time: dateTime(result.calculated_at) });
  renderTable(
    "#valuation-funds-table",
    [
      { label: t("col.fund"), key: "fund_id", format: fundName },
      { label: t("col.units"), key: "units", format: formatNumber },
      { label: t("col.price"), key: "price", format: formatNumber },
      { label: t("col.price_date"), key: "price_date", format: dateOnly },
      { label: t("col.value"), key: "market_value", format: (value) => value === null ? "—" : money.format(Number(value)) },
      { label: t("col.price_status"), key: "price_status", format: statusLabel },
      { label: t("col.units_status"), key: "units_status", format: statusLabel }
    ],
    accountResult.funds ?? [],
    t("empty.valuation_funds")
  );
  $("#valuation-message").hidden = true;
  $("#valuation-results").hidden = false;
}

function registerTabs() {
  for (const tab of $$(".tab")) {
    tab.addEventListener("click", () => {
      for (const item of $$(".tab")) item.classList.toggle("active", item === tab);
      for (const panel of $$(".tab-panel")) {
        panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      }
      if (tab.dataset.tab === "holdings") loadHoldingsChart();
      if (tab.dataset.tab === "valuation") loadSnapshotHistory();
    });
  }
}

function registerForms() {
  $("#connection-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, async () => {
      state.apiKey = $("#api-key").value.trim();
      sessionStorage.setItem("mpf_portfolio_api_key", state.apiKey);
      await loadAccounts();
      showToast(t("toast.connected"));
    });
  });

  $("#refresh-accounts").addEventListener("click", async () => {
    try {
      await loadAccounts();
      showToast(t("toast.accounts_refreshed"));
    } catch (error) {
      showToast(errorMessage(error), "error");
    }
  });

  $("#refresh-holdings-chart").addEventListener("click", loadHoldingsChart);

  $("#refresh-valuation-history").addEventListener("click", loadSnapshotHistory);

  $("#refresh-contribution-history").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = t("btn.loading");
    try {
      const accountId = selectedAccountId();
      const result = await api(`/v1/accounts/${accountId}/contribution-history`);
      if (state.selectedAccount?.account_id !== accountId) return;
      state.contributionHistory = result.items;
      await loadFundNames(result.items.flatMap((item) => item.transactions.map((transaction) => transaction.fund_id)));
      renderAccountWorkspace();
    } catch (error) {
      showToast(errorMessage(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = t("btn.refresh_history");
    }
  });

  $("#add-confirmation-row").addEventListener("click", () => addConfirmationRow());
  $("#cancel-confirmation").addEventListener("click", () => {
    state.confirmingEventId = null;
    state.confirmingDate = null;
    $("#confirmation-editor").hidden = true;
  });
  $("#confirmation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, async () => {
      const accountId = selectedAccountId();
      if (!state.confirmingEventId) throw new Error(t("error.confirmation_event_required"));
      const transactions = readConfirmationRows();
      await api(`/v1/accounts/${accountId}/contribution-history/${encodeURIComponent(state.confirmingEventId)}/confirm`, {
        method: "POST",
        body: JSON.stringify({
          trade_date: transactions[0].trade_date,
          transactions
        })
      });
      await selectAccount(accountId);
      showToast(t("toast.purchase_confirmed"));
    });
  });

  $("#load-valuation").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = t("btn.loading");
    $("#valuation-results").hidden = true;
    $("#valuation-message").hidden = false;
    setValuationMessage("valuation.calculating");
    try {
      const accountId = selectedAccountId();
      const result = await api(`/v1/valuation/latest?account_id=${encodeURIComponent(accountId)}`);
      const accountResult = result.accounts?.find((item) => item.account_id === accountId);
      if (!accountResult) {
        state.valuation = null;
        $("#valuation-results").hidden = true;
        setValuationMessage("valuation.no_holdings");
        return;
      }

      state.valuation = { result, account: accountResult };
      renderValuationResults();
    } catch (error) {
      state.valuationMessageKey = null;
      $("#valuation-message").textContent = errorMessage(error);
      showToast(errorMessage(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = t("btn.check_valuation");
    }
  });

  $("#create-account-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, async () => {
      const form = event.currentTarget;
      const created = await api("/v1/accounts", {
        method: "POST",
        body: JSON.stringify({
          provider: form.elements.provider.value.trim(),
          scheme: form.elements.scheme.value.trim(),
          display_label: form.elements.display_label.value.trim(),
          currency: form.elements.currency.value.trim()
        })
      });
      form.reset();
      form.elements.currency.value = "HKD";
      form.closest("details").open = false;
      await loadAccounts({ selectId: created.account_id });
      showToast(t("toast.account_created"));
    });
  });

  $("#update-account-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, async () => {
      const form = event.currentTarget;
      const accountId = selectedAccountId();
      await api(`/v1/accounts/${accountId}`, {
        method: "PUT",
        body: JSON.stringify({
          display_label: form.elements.display_label.value.trim(),
          currency: form.elements.currency.value.trim(),
          active: form.elements.active.checked
        })
      });
      await loadAccounts({ selectId: accountId });
      showToast(t("toast.account_updated"));
    });
  });

  // Keep the request identity after errors so a lost response can be retried safely.
  $("#switch-form").addEventListener("input", () => { state.switchRequestId = null; });
  $("#switch-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submitForm(form, async () => {
      const accountId = selectedAccountId();
      const sales = readFundRows("switch-from-rows", "units");
      const purchases = readFundRows("switch-to-rows", "units");
      const fundIds = [...sales, ...purchases].map((leg) => leg.fund_id);
      if (new Set(fundIds).size !== fundIds.length) throw new Error(t("switch.unique_funds"));
      // getRandomValues also works on the LAN's HTTP dashboard.
      state.switchRequestId ??= "10000000-1000-4000-8000-100000000000".replace(/[018]/g,
        (digit) => (Number(digit) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(digit) / 4).toString(16));
      await api(`/v1/accounts/${accountId}/switches`, {
        method: "POST",
        body: JSON.stringify({ switch_id: state.switchRequestId, trade_date: form.elements.trade_date.value,
          sales, purchases, notes: form.elements.notes.value.trim() })
      });
      state.switchRequestId = null;
      form.reset();
      resetFundRows("switch-from-rows");
      resetFundRows("switch-to-rows");
      setDefaultDates();
      await selectAccount(accountId);
      showToast(t("switch.saved"));
    });
  });

  $("#baseline-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, async () => {
      const form = event.currentTarget;
      const accountId = selectedAccountId();
      await api(`/v1/accounts/${accountId}/baselines`, {
        method: "POST",
        body: JSON.stringify({
          effective_date: form.elements.effective_date.value,
          source: form.elements.source.value.trim(),
          verification_status: form.elements.verification_status.value,
          holdings: readFundRows("baseline-rows", "units")
        })
      });
      form.reset();
      resetFundRows("baseline-rows");
      setDefaultDates();
      await selectAccount(accountId);
      showToast(t("toast.baseline_recorded"));
    });
  });

  $("#allocation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, async () => {
      const form = event.currentTarget;
      const accountId = selectedAccountId();
      await api(`/v1/accounts/${accountId}/allocation-rules`, {
        method: "PUT",
        body: JSON.stringify({
          effective_from: form.elements.effective_from.value,
          ...optionalDate(form, "effective_to"),
          contribution_stream: form.elements.contribution_stream.value.trim(),
          allocations: readFundRows("allocation-rows", "weight")
        })
      });
      form.reset();
      resetFundRows("allocation-rows");
      setDefaultDates();
      await selectAccount(accountId);
      showToast(t("toast.allocation_published"));
    });
  });

  $("#plan-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, async () => {
      const form = event.currentTarget;
      const accountId = selectedAccountId();
      await api(`/v1/accounts/${accountId}/contribution-plans`, {
        method: "PUT",
        body: JSON.stringify({
          contribution_stream: form.elements.contribution_stream.value.trim(),
          amount: form.elements.amount.value,
          expected_day: Number(form.elements.expected_day.value),
          effective_from: form.elements.effective_from.value,
          ...optionalDate(form, "effective_to")
        })
      });
      form.reset();
      setDefaultDates();
      await selectAccount(accountId);
      showToast(t("toast.plan_saved"));
    });
  });

  $("#reconciliation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submitForm(event.currentTarget, async () => {
      const form = event.currentTarget;
      const accountId = selectedAccountId();
      const notes = form.elements.notes.value.trim();
      await api(`/v1/accounts/${accountId}/reconciliations`, {
        method: "POST",
        body: JSON.stringify({
          effective_date: form.elements.effective_date.value,
          ...(notes ? { notes } : {}),
          holdings: readFundRows("reconciliation-rows", "units")
        })
      });
      form.reset();
      resetFundRows("reconciliation-rows");
      setDefaultDates();
      await selectAccount(accountId);
      showToast(t("toast.reconciliation_recorded"));
    });
  });

  for (const button of $$(".add-row")) {
    button.addEventListener("click", () => addFundRow(button.dataset.target));
  }
}

async function initialize() {
  initI18n(() => {
    setConnectionStatus(state.connectionStatus.key, state.connectionStatus.kind);
    renderAccountList();
    if (state.selectedAccount) renderAccountWorkspace();
    if (state.valuation) renderValuationResults();
    else if (state.valuationMessageKey) setValuationMessage(state.valuationMessageKey);
    if (state.holdingsChart) renderHoldingsChart();
    else if (state.chartMessageKey) setChartMessage(state.chartMessageKey);
  });
  registerTabs();
  registerForms();
  resetFundRows("baseline-rows");
  resetFundRows("switch-from-rows");
  resetFundRows("switch-to-rows");
  resetFundRows("allocation-rows");
  resetFundRows("reconciliation-rows");
  setDefaultDates();

  try {
    const health = await fetch("/health").then((response) => response.json());
    setConnectionStatus(
      health.status === "ready" ? "status.api_ready" : "status.api_unavailable",
      health.status === "ready" ? "neutral" : "bad",
    );
  } catch {
    setConnectionStatus("status.api_unavailable", "bad");
  }

  if (state.apiKey) {
    $("#api-key").value = state.apiKey;
    try {
      await loadAccounts();
    } catch (error) {
      setConnectionStatus("status.key_rejected", "bad");
      showToast(errorMessage(error), "error");
    }
  }
}

initialize();
