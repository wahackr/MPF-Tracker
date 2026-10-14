const state = {
  apiKey: sessionStorage.getItem("mpf_portfolio_api_key") ?? "",
  accounts: [],
  selectedAccount: null,
  holdings: [],
  allocations: [],
  plans: [],
  contributionHistory: [],
  reconciliations: [],
  funds: new Map(),
  snapshotHistory: [],
  valuation: null
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

function setConnectionStatus(label, kind) {
  const status = $("#connection-status");
  status.textContent = label;
  status.className = `status-pill status-${kind}`;
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

async function api(path, options = {}) {
  if (!state.apiKey) {
    throw new Error("Enter the API key before making a request.");
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
    throw new Error(`${payload.detail ?? `Request failed with ${response.status}`}${details}`);
  }
  return payload;
}

async function submitForm(form, action) {
  const button = form.querySelector('button[type="submit"]');
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
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
    ? new Intl.NumberFormat("en-HK", { maximumFractionDigits: 10 }).format(number)
    : String(value);
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
      const value = column.format ? column.format(row[column.key], row) : row[column.key];
      td.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
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
    empty.textContent = "No accounts yet. Create your first account below.";
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
    detail.textContent = `${account.provider} · ${account.currency}${account.active ? "" : " · Inactive"}`;
    button.append(label, detail);
    button.addEventListener("click", () => selectAccount(account.account_id));
    list.append(button);
  }
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
  $("#account-active").textContent = account.active ? "Active" : "Inactive";
  $("#holding-count").textContent = String(
    state.holdings.filter((holding) => holding.source !== "reconciliation").length
  );
  $("#allocation-count").textContent = String(state.allocations.length);
  $("#plan-count").textContent = String(state.plans.length);

  const updateForm = $("#update-account-form");
  updateForm.elements.display_label.value = account.display_label;
  updateForm.elements.currency.value = account.currency;
  updateForm.elements.active.checked = account.active;

  renderTable(
    "#holdings-table",
    [
      { label: "Effective date", key: "effective_date", format: dateOnly },
      { label: "Fund", key: "fund_id", format: fundName },
      { label: "Units", key: "units", format: formatNumber, className: "value-positive" },
      { label: "Status", key: "verification_status" },
      { label: "Source", key: "source" }
    ],
    state.holdings.filter((holding) => holding.source !== "reconciliation"),
    "No holding baselines have been recorded."
  );

  renderTable(
    "#reconciliations-table",
    [
      { label: "Effective date", key: "effective_date", format: dateOnly },
      { label: "Trustee statement", key: "notes" },
      { label: "Verified fund units", key: "holdings", format: (holdings) => holdings.map((holding) => `${fundName(holding.fund_id)}: ${formatNumber(holding.units)}`).join(" · ") }
    ],
    state.reconciliations,
    "No reconciliations have been recorded."
  );

  renderTable(
    "#allocations-table",
    [
      { label: "From", key: "effective_from", format: dateOnly },
      { label: "To", key: "effective_to", format: dateOnly },
      { label: "Stream", key: "contribution_stream" },
      { label: "Fund", key: "fund_id", format: fundName },
      {
        label: "Weight",
        key: "weight",
        format: (value) => `${formatNumber(value)}%`,
        className: "value-positive"
      }
    ],
    state.allocations,
    "No allocation rules have been published."
  );

  renderTable(
    "#plans-table",
    [
      { label: "From", key: "effective_from", format: dateOnly },
      { label: "To", key: "effective_to", format: dateOnly },
      { label: "Stream", key: "contribution_stream" },
      { label: "Amount", key: "amount", format: formatNumber, className: "value-positive" },
      { label: "Expected day", key: "expected_day" },
      { label: "Status", key: "active", format: (value) => (value ? "Active" : "Closed") }
    ],
    state.plans,
    "No contribution plans have been configured."
  );

  const money = new Intl.NumberFormat("en-HK", {
    style: "currency",
    currency: account.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  renderTable(
    "#contribution-history-table",
    [
      { label: "Run date", key: "created_at", format: (value) => value ? new Date(value).toLocaleString("en-HK") : "—" },
      { label: "Expected date", key: "expected_date", format: dateOnly },
      { label: "Stream", key: "contribution_stream" },
      { label: "Contribution", key: "amount", format: (value) => money.format(Number(value)) },
      { label: "Status", key: "status" },
      {
        label: "Fund transactions",
        key: "transactions",
        format: (transactions) => transactions.length
          ? transactions.map((transaction) => `${fundName(transaction.fund_id)}: ${money.format(Number(transaction.cash_amount))} at ${formatNumber(transaction.unit_price)} → ${formatNumber(transaction.units_delta)} units (${transaction.status})`).join(" · ")
          : "—"
      }
    ],
    state.contributionHistory,
    "No contribution events have been processed for this account yet."
  );

  renderTable(
    "#valuation-history-table",
    [
      { label: "As of", key: "as_of_date", format: dateOnly },
      {
        label: "Value",
        key: "total_value",
        format: (value, row) => value === null ? "—" : new Intl.NumberFormat("en-HK", {
          style: "currency",
          currency: row.currency ?? account.currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        }).format(Number(value))
      },
      { label: "Status", key: "calculation_status" },
      { label: "Calculated", key: "calculated_at", format: (value) => value ? new Date(value).toLocaleString("en-HK") : "—" },
      { label: "Revision", key: "revision" }
    ],
    state.snapshotHistory,
    "No valuation snapshots have been saved for this account yet."
  );

  renderAccountList();
}

async function loadAccounts({ selectId } = {}) {
  state.accounts = await api("/v1/accounts");
  setConnectionStatus("Connected", "good");
  renderAccountList();

  const targetId = selectId ?? state.selectedAccount?.account_id;
  if (targetId && state.accounts.some((account) => account.account_id === targetId)) {
    await selectAccount(targetId);
  }
}

async function selectAccount(accountId) {
  try {
    const [account, holdings, allocations, plans, reconciliations, contributionHistory] = await Promise.all([
      api(`/v1/accounts/${accountId}`),
      api(`/v1/accounts/${accountId}/holdings`),
      api(`/v1/accounts/${accountId}/allocation-rules`),
      api(`/v1/accounts/${accountId}/contribution-plans`),
      api(`/v1/accounts/${accountId}/reconciliations`),
      api(`/v1/accounts/${accountId}/contribution-history`)
    ]);
    state.selectedAccount = account;
    state.holdings = holdings.items;
    state.allocations = allocations.items;
    state.plans = plans.items;
    state.contributionHistory = contributionHistory.items;
    state.reconciliations = reconciliations.items;
    state.snapshotHistory = [];
    state.funds = new Map();
    const fundIds = [
      ...holdings.items.map((holding) => holding.fund_id),
      ...allocations.items.map((allocation) => allocation.fund_id),
      ...reconciliations.items.flatMap((item) => item.holdings.map((holding) => holding.fund_id)),
      ...contributionHistory.items.flatMap((event) => event.transactions.map((transaction) => transaction.fund_id))
    ];
    await loadFundNames(fundIds);
    state.valuation = null;
    $("#valuation-results").hidden = true;
    $("#valuation-message").hidden = false;
    $("#valuation-message").textContent = "Select “Check valuation” to load the latest result.";
    $("#holdings-chart-content").hidden = true;
    $("#holdings-chart-message").hidden = false;
    $("#holdings-chart-message").textContent = "Open the Holdings tab to load the current allocation.";
    renderAccountWorkspace();
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
  search.placeholder = "Search fund name or alias";
  search.autocomplete = "off";
  search.setAttribute("aria-label", "Search fund by name or alias");
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
    loading.textContent = "Searching funds…";
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
          empty.textContent = "No matching funds found.";
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
  value.placeholder = kind === "weight" ? "Weight %" : "Units";
  value.required = true;
  if (kind === "weight") value.addEventListener("input", updateAllocationTotal);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove-row";
  remove.setAttribute("aria-label", "Remove fund row");
  remove.textContent = "×";
  remove.addEventListener("click", () => {
    row.remove();
    updateAllocationTotal();
  });

  row.append(picker, value, remove);
  container.append(row);
}

function readFundRows(containerId, valueName) {
  const rows = [...document.querySelectorAll(`#${containerId} .repeat-row`)].map((row) => ({
    fund_id: row.querySelector('[name="fund_id"]').value.trim(),
    [valueName]: row.querySelector(`[name="${valueName}"]`).value
  }));
  if (rows.length === 0 || rows.some((row) => !row.fund_id || row[valueName] === "")) {
    throw new Error("Select a fund from the search results and complete every value.");
  }
  return rows;
}

function resetFundRows(containerId) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  addFundRow(containerId);
  updateAllocationTotal();
}

function updateAllocationTotal() {
  const total = [...document.querySelectorAll('#allocation-rows [name="weight"]')]
    .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const badge = $("#allocation-total");
  badge.textContent = `${Number(total.toFixed(4))}%`;
  badge.classList.toggle("valid", Math.abs(total - 100) < 1e-9);
}

function selectedAccountId() {
  if (!state.selectedAccount) throw new Error("Select an account first.");
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

async function loadHoldingsChart() {
  if (!state.selectedAccount) return;
  const accountId = state.selectedAccount.account_id;
  const button = $("#refresh-holdings-chart");
  const message = $("#holdings-chart-message");
  const content = $("#holdings-chart-content");
  button.disabled = true;
  button.textContent = "Loading…";
  content.hidden = true;
  message.hidden = false;
  message.textContent = "Loading current fund values…";
  try {
    const result = await api(`/v1/valuation/latest?account_id=${encodeURIComponent(accountId)}`);
    if (state.selectedAccount?.account_id !== accountId) return;
    const account = result.accounts?.find((item) => item.account_id === accountId);
    const pricedFunds = (account?.funds ?? [])
      .filter((fund) => fund.market_value !== null && Number(fund.market_value) > 0)
      .map((fund) => ({ ...fund, value: Number(fund.market_value) }));
    const pricedTotal = pricedFunds.reduce((sum, fund) => sum + fund.value, 0);
    if (pricedFunds.length === 0 || pricedTotal <= 0) {
      message.textContent = "No priced fund holdings are available for this account yet.";
      return;
    }

    await loadFundNames(pricedFunds.map((fund) => fund.fund_id)).catch(() => {});
    if (state.selectedAccount?.account_id !== accountId) return;
    const colors = ["#165c46", "#b8842d", "#397e9b", "#9b5f85", "#6e8e43", "#d1784b", "#6375a5", "#8b7657"];
    let cursor = 0;
    const slices = pricedFunds.map((fund, index) => {
      const start = cursor;
      const percentage = (fund.value / pricedTotal) * 100;
      cursor += percentage * 3.6;
      return { ...fund, percentage, start, end: cursor, color: colors[index % colors.length], info: state.funds.get(fund.fund_id) };
    });
    const pie = $("#holdings-pie");
    pie.style.background = `conic-gradient(${slices.map((slice) => `${slice.color} ${slice.start}deg ${slice.end}deg`).join(", ")})`;
    pie.setAttribute("aria-label", `Fund allocation by value: ${slices.map((slice) => `${slice.info?.name ?? slice.fund_id} ${slice.percentage.toFixed(1)} percent`).join(", ")}`);

    const legend = $("#holdings-legend");
    legend.replaceChildren();
    const currency = account.currency ?? state.selectedAccount.currency;
    const money = new Intl.NumberFormat("en-HK", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

    const unpriced = account?.unpriced_fund_count ?? 0;
    message.textContent = `As of ${dateOnly(result.requested_as_of)} · priced total ${money.format(pricedTotal)}${unpriced > 0 ? ` · ${unpriced} unpriced fund${unpriced === 1 ? "" : "s"} excluded` : ""}`;
    content.hidden = false;
  } catch (error) {
    if (state.selectedAccount?.account_id === accountId) message.textContent = errorMessage(error);
  } finally {
    button.disabled = false;
    button.textContent = "Refresh";
  }
}

async function loadSnapshotHistory() {
  if (!state.selectedAccount) return;
  const accountId = state.selectedAccount.account_id;
  const button = $("#refresh-valuation-history");
  button.disabled = true;
  button.textContent = "Loading…";
  try {
    const result = await api(`/v1/valuation/history?account_id=${encodeURIComponent(accountId)}`);
    if (state.selectedAccount?.account_id !== accountId) return;
    state.snapshotHistory = result.items ?? [];
    renderAccountWorkspace();
  } catch (error) {
    showToast(errorMessage(error), "error");
  } finally {
    button.disabled = false;
    button.textContent = "Refresh history";
  }
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
      showToast("Connected to the Portfolio API.");
    });
  });

  $("#refresh-accounts").addEventListener("click", async () => {
    try {
      await loadAccounts();
      showToast("Accounts refreshed.");
    } catch (error) {
      showToast(errorMessage(error), "error");
    }
  });

  $("#refresh-holdings-chart").addEventListener("click", loadHoldingsChart);

  $("#refresh-valuation-history").addEventListener("click", loadSnapshotHistory);

  $("#refresh-contribution-history").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Loading…";
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
      button.textContent = "Refresh history";
    }
  });

  $("#load-valuation").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Loading…";
    $("#valuation-results").hidden = true;
    $("#valuation-message").hidden = false;
    $("#valuation-message").textContent = "Calculating the latest valuation…";
    try {
      const accountId = selectedAccountId();
      const result = await api(`/v1/valuation/latest?account_id=${encodeURIComponent(accountId)}`);
      const accountResult = result.accounts?.find((item) => item.account_id === accountId);
      if (!accountResult) {
        $("#valuation-results").hidden = true;
        $("#valuation-message").textContent = "No holdings are available to value yet. Add a holding baseline in the Holdings tab, then check again.";
        return;
      }

      state.valuation = { result, account: accountResult };
      const currency = accountResult.currency ?? state.selectedAccount.currency;
      const amount = accountResult.total_value ?? accountResult.priced_subtotal;
      $("#valuation-total").textContent = amount === null || amount === undefined
        ? "Unavailable"
        : new Intl.NumberFormat("en-HK", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount));
      $("#valuation-currency").textContent = accountResult.total_value === null
        ? `Priced subtotal · ${currency}`
        : currency;
      $("#valuation-status").textContent = accountResult.calculation_status;
      $("#valuation-as-of").textContent = `As of ${dateOnly(result.requested_as_of)}`;
      $("#valuation-unpriced").textContent = String(accountResult.unpriced_fund_count);
      $("#valuation-calculated-at").textContent = `Calculated ${new Date(result.calculated_at).toLocaleString("en-HK")}`;
      renderTable(
        "#valuation-funds-table",
        [
          { label: "Fund", key: "fund_id", format: fundName },
          { label: "Units", key: "units", format: formatNumber },
          { label: "Price", key: "price", format: formatNumber },
          { label: "Price date", key: "price_date", format: dateOnly },
          { label: "Value", key: "market_value", format: (value) => value === null ? "—" : new Intl.NumberFormat("en-HK", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value)) },
          { label: "Price status", key: "price_status" },
          { label: "Units status", key: "units_status" }
        ],
        accountResult.funds ?? [],
        "No fund holdings were found for this account."
      );
      $("#valuation-message").hidden = true;
      $("#valuation-results").hidden = false;
    } catch (error) {
      $("#valuation-message").textContent = errorMessage(error);
      showToast(errorMessage(error), "error");
    } finally {
      button.disabled = false;
      button.textContent = "Check valuation";
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
      showToast("Account created.");
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
      showToast("Account updated.");
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
      showToast("Holding baseline recorded.");
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
      showToast("Allocation rules published.");
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
      showToast("Contribution plan saved.");
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
      showToast("Reconciliation recorded.");
    });
  });

  for (const button of $$(".add-row")) {
    button.addEventListener("click", () => addFundRow(button.dataset.target));
  }
}

async function initialize() {
  registerTabs();
  registerForms();
  resetFundRows("baseline-rows");
  resetFundRows("allocation-rows");
  resetFundRows("reconciliation-rows");
  setDefaultDates();

  try {
    const health = await fetch("/health").then((response) => response.json());
    setConnectionStatus(health.status === "ready" ? "API ready" : "API unavailable", health.status === "ready" ? "neutral" : "bad");
  } catch {
    setConnectionStatus("API unavailable", "bad");
  }

  if (state.apiKey) {
    $("#api-key").value = state.apiKey;
    try {
      await loadAccounts();
    } catch (error) {
      setConnectionStatus("Key rejected", "bad");
      showToast(errorMessage(error), "error");
    }
  }
}

initialize();
