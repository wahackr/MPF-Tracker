const STORAGE_KEY = "mpf_portfolio_locale";

const translations = {
  en: {
    "brand.title": "MPF Portfolio",
    "brand.subtitle": "Account administration",
    "lang.label": "Language",

    "form.api_key": "API key",
    "form.api_key_placeholder": "Enter X-API-Key",
    "btn.connect": "Connect",

    "status.not_connected": "Not connected",
    "status.connected": "Connected",
    "status.api_ready": "API ready",
    "status.api_unavailable": "API unavailable",
    "status.key_rejected": "Key rejected",

    "sidebar.workspace": "Workspace",
    "sidebar.accounts": "Accounts",
    "sidebar.refresh_aria": "Refresh accounts",
    "sidebar.empty_connect": "Connect to load accounts.",
    "sidebar.empty_accounts": "No accounts yet. Create your first account below.",
    "sidebar.new_account": "New account",

    "form.display_name": "Display name",
    "form.display_name_placeholder": "My MPF account",
    "form.provider": "Provider",
    "form.scheme": "Scheme",
    "form.currency": "Currency",
    "btn.create_account": "Create account",

    "empty.eyebrow": "Portfolio console",
    "empty.title": "Select an account",
    "empty.description":
      "Manage holdings, allocations, contribution plans, and reconciliations from one place.",

    "tab.aria": "Portfolio sections",
    "tab.overview": "Overview",
    "tab.holdings": "Holdings",
    "tab.allocations": "Allocations",
    "tab.plans": "Contributions",
    "tab.valuation": "Valuation",
    "tab.reconcile": "Reconcile",

    "overview.eyebrow": "Account details",
    "overview.title": "Overview",
    "metric.holdings": "Holding records",
    "metric.holdings_note": "Historical baselines",
    "metric.allocations": "Allocation rules",
    "metric.allocations_note": "Current and historical",
    "metric.plans": "Contribution plans",
    "metric.plans_note": "All plan versions",

    "card.edit_account": "Edit account",
    "card.edit_account_desc": "Update the account label, currency, or active status.",
    "btn.save_changes": "Save changes",
    "common.active": "Active",
    "account.inactive": "Inactive",
    "plan.closed": "Closed",

    "valuation.eyebrow": "Current fund prices",
    "valuation.title": "Latest valuation",
    "valuation.desc": "Calculate the selected account using the latest available prices as of today.",
    "btn.check_valuation": "Check valuation",
    "valuation.hint": "Select “Check valuation” to load the latest result.",
    "valuation.calculating": "Calculating the latest valuation…",
    "valuation.no_holdings":
      "No holdings are available to value yet. Add a holding baseline in the Holdings tab, then check again.",
    "metric.account_value": "Account value",
    "metric.calc_status": "Calculation status",
    "metric.unpriced": "Unpriced funds",
    "valuation.unavailable": "Unavailable",
    "valuation.priced_subtotal": "Priced subtotal · {currency}",
    "valuation.as_of": "As of {date}",
    "valuation.calculated": "Calculated {time}",
    "card.snapshot_history": "Snapshot history",
    "card.snapshot_history_desc": "Previously saved valuations for this account.",

    "btn.refresh": "Refresh",
    "btn.refresh_history": "Refresh history",
    "btn.loading": "Loading…",
    "btn.saving": "Saving…",

    "holdings.eyebrow": "Unit balances",
    "holdings.title": "Holding baselines",
    "holdings.desc": "Each submission records fund units as of one effective date.",
    "card.chart_title": "Fund allocation by value",
    "card.chart_desc": "Share of the account’s latest priced holdings.",
    "chart.loading": "Loading current allocation…",
    "chart.loading_values": "Loading current fund values…",
    "chart.holdings_hint": "Open the Holdings tab to load the current allocation.",
    "chart.no_priced": "No priced fund holdings are available for this account yet.",
    "chart.as_of_priced": "As of {date} · priced total {amount}",
    "chart.unpriced_excluded": " · {count} unpriced fund(s) excluded",
    "chart.pie_aria": "Fund allocation by value: {list}",
    "card.add_baseline": "Add baseline",
    "card.add_baseline_desc": "Use verified for trustee values and estimated when units are inferred.",
    "form.effective_date": "Effective date",
    "form.source": "Source",
    "form.status": "Status",
    "form.verified": "Verified",
    "form.estimated": "Estimated",
    "form.funds_units": "Funds and units",
    "btn.add_fund": "+ Add fund",
    "btn.record_baseline": "Record baseline",

    "allocations.eyebrow": "Contribution routing",
    "allocations.title": "Allocation rules",
    "allocations.desc": "A complete rule set must allocate exactly 100%.",
    "card.publish_allocation": "Publish allocation",
    "card.publish_allocation_desc": "The previous active version for this stream ends automatically.",
    "form.contribution_stream": "Contribution stream",
    "form.effective_from": "Effective from",
    "form.effective_to": "Effective to",
    "form.optional": "optional",
    "form.fund_weights": "Fund weights",
    "btn.publish_allocation": "Publish allocation",

    "plans.eyebrow": "Scheduled cash flow",
    "plans.title": "Contribution plans",
    "plans.desc": "Configure the expected monthly amount and contribution day.",
    "plans.history_title": "Contribution history",
    "plans.history_desc": "Events appear after purchase processing runs.",
    "card.set_plan": "Set contribution plan",
    "card.set_plan_desc": "The active plan for the same stream will be closed.",
    "form.monthly_amount": "Monthly amount",
    "form.expected_day": "Expected day",
    "btn.save_plan": "Save contribution plan",

    "reconcile.eyebrow": "Authoritative correction",
    "reconcile.title": "Reconcile with eMPF",
    "reconcile.desc": "Record actual trustee units and preserve the earlier audit history.",
    "reconcile.callout_strong": "Use the trustee statement date.",
    "reconcile.callout_body":
      "Reconciliation entries are always stored as verified and invalidate portfolio snapshots from that date.",
    "reconcile.history_title": "Reconciliation history",
    "reconcile.history_desc": "Verified balances recorded from trustee statements.",
    "form.notes": "Notes",
    "form.notes_placeholder": "eMPF statement reference",
    "form.verified_units": "Verified fund units",
    "btn.record_reconciliation": "Record reconciliation",

    "fund.search_placeholder": "Search fund name or alias",
    "fund.search_aria": "Search fund by name or alias",
    "fund.searching": "Searching funds…",
    "fund.no_results": "No matching funds found.",
    "fund.remove_aria": "Remove fund row",
    "fund.weight_placeholder": "Weight %",
    "fund.units_placeholder": "Units",
    "fund.transaction_line": "{fund}: {amount} at {price} → {units} units ({status})",

    "error.fund_rows_incomplete": "Select a fund from the search results and complete every value.",
    "error.account_required": "Select an account first.",
    "error.api_key_missing": "Enter the API key before making a request.",
    "error.unexpected": "Unexpected error",
    "error.request_failed": "Request failed with {status}",

    "toast.connected": "Connected to the Portfolio API.",
    "toast.accounts_refreshed": "Accounts refreshed.",
    "toast.account_created": "Account created.",
    "toast.account_updated": "Account updated.",
    "toast.baseline_recorded": "Holding baseline recorded.",
    "toast.allocation_published": "Allocation rules published.",
    "toast.plan_saved": "Contribution plan saved.",
    "toast.reconciliation_recorded": "Reconciliation recorded.",

    "empty.holdings": "No holding baselines have been recorded.",
    "empty.reconciliations": "No reconciliations have been recorded.",
    "empty.allocations": "No allocation rules have been published.",
    "empty.plans": "No contribution plans have been configured.",
    "empty.contributions": "No contribution events have been processed for this account yet.",
    "empty.snapshots": "No valuation snapshots have been saved for this account yet.",
    "empty.valuation_funds": "No fund holdings were found for this account.",

    "col.effective_date": "Effective date",
    "col.fund": "Fund",
    "col.units": "Units",
    "col.status": "Status",
    "col.source": "Source",
    "col.notes": "Trustee statement",
    "col.verified_units": "Verified fund units",
    "col.from": "From",
    "col.to": "To",
    "col.stream": "Stream",
    "col.weight": "Weight",
    "col.amount": "Amount",
    "col.expected_day": "Expected day",
    "col.run_date": "Run date",
    "col.expected_date": "Expected date",
    "col.contribution": "Contribution",
    "col.fund_transactions": "Fund transactions",
    "col.as_of": "As of",
    "col.value": "Value",
    "col.calculated": "Calculated",
    "col.revision": "Revision",
    "col.price": "Price",
    "col.price_date": "Price date",
    "col.price_status": "Price status",
    "col.units_status": "Units status",

    "enum.VERIFIED": "Verified",
    "enum.ESTIMATED": "Estimated",
    "enum.CONFIRMED": "Confirmed",
    "enum.FAILED_REVIEW": "Failed review",
    "enum.WAITING": "Waiting",
    "enum.COMPLETE": "Complete",
    "enum.PARTIAL": "Partial",
    "enum.STALE": "Stale",
    "enum.FRESH": "Fresh",
    "enum.MISSING": "Missing"
  },
  "zh-Hant": {
    "brand.title": "MPF 投資組合",
    "brand.subtitle": "帳戶管理",
    "lang.label": "語言",

    "form.api_key": "API 金鑰",
    "form.api_key_placeholder": "輸入 X-API-Key",
    "btn.connect": "連線",

    "status.not_connected": "未連線",
    "status.connected": "已連線",
    "status.api_ready": "API 就緒",
    "status.api_unavailable": "API 無法使用",
    "status.key_rejected": "金鑰遭拒",

    "sidebar.workspace": "工作區",
    "sidebar.accounts": "帳戶",
    "sidebar.refresh_aria": "重新整理帳戶",
    "sidebar.empty_connect": "連線後載入帳戶。",
    "sidebar.empty_accounts": "尚無帳戶。請於下方建立第一個帳戶。",
    "sidebar.new_account": "建立新帳戶",

    "form.display_name": "顯示名稱",
    "form.display_name_placeholder": "我的強積金帳戶",
    "form.provider": "供應商",
    "form.scheme": "計劃",
    "form.currency": "貨幣",
    "btn.create_account": "建立帳戶",

    "empty.eyebrow": "投資組合控制台",
    "empty.title": "選擇帳戶",
    "empty.description": "在同一處管理持倉、分配、供款計劃與對帳。",

    "tab.aria": "投資組合區塊",
    "tab.overview": "總覽",
    "tab.holdings": "持倉",
    "tab.allocations": "分配",
    "tab.plans": "供款",
    "tab.valuation": "估值",
    "tab.reconcile": "對帳",

    "overview.eyebrow": "帳戶資料",
    "overview.title": "總覽",
    "metric.holdings": "持倉記錄",
    "metric.holdings_note": "歷史基準",
    "metric.allocations": "分配規則",
    "metric.allocations_note": "現時及歷史",
    "metric.plans": "供款計劃",
    "metric.plans_note": "所有計劃版本",

    "card.edit_account": "編輯帳戶",
    "card.edit_account_desc": "更新帳戶名稱、貨幣或啟用狀態。",
    "btn.save_changes": "儲存變更",
    "common.active": "啟用",
    "account.inactive": "已停用",
    "plan.closed": "已結束",

    "valuation.eyebrow": "最新基金價格",
    "valuation.title": "最新估值",
    "valuation.desc": "以今日最新可得價格計算所選帳戶。",
    "btn.check_valuation": "查看估值",
    "valuation.hint": "按「查看估值」載入最新結果。",
    "valuation.calculating": "正在計算最新估值…",
    "valuation.no_holdings": "目前沒有可估值的持倉。請先在持倉分頁新增基準，然後再試。",
    "metric.account_value": "帳戶價值",
    "metric.calc_status": "計算狀態",
    "metric.unpriced": "未定價基金",
    "valuation.unavailable": "無法取得",
    "valuation.priced_subtotal": "已定價小計 · {currency}",
    "valuation.as_of": "截至 {date}",
    "valuation.calculated": "計算於 {time}",
    "card.snapshot_history": "快照歷史",
    "card.snapshot_history_desc": "此帳戶先前儲存的估值。",

    "btn.refresh": "重新整理",
    "btn.refresh_history": "重新整理歷史",
    "btn.loading": "載入中…",
    "btn.saving": "儲存中…",

    "holdings.eyebrow": "單位結餘",
    "holdings.title": "持倉基準",
    "holdings.desc": "每次提交記錄某一生效日期的基金單位。",
    "card.chart_title": "按價值劃分的基金分配",
    "card.chart_desc": "帳戶最新已定價持倉的佔比。",
    "chart.loading": "正在載入目前分配…",
    "chart.loading_values": "正在載入目前基金價值…",
    "chart.holdings_hint": "開啟持倉分頁以載入目前分配。",
    "chart.no_priced": "此帳戶目前沒有已定價的基金持倉。",
    "chart.as_of_priced": "截至 {date} · 已定價總值 {amount}",
    "chart.unpriced_excluded": " · 已排除 {count} 隻未定價基金",
    "chart.pie_aria": "按價值劃分的基金分配：{list}",
    "card.add_baseline": "新增基準",
    "card.add_baseline_desc": "受託人數據請選「已核實」，推算單位請選「估計」。",
    "form.effective_date": "生效日期",
    "form.source": "來源",
    "form.status": "狀態",
    "form.verified": "已核實",
    "form.estimated": "估計",
    "form.funds_units": "基金與單位",
    "btn.add_fund": "+ 新增基金",
    "btn.record_baseline": "記錄基準",

    "allocations.eyebrow": "供款分配",
    "allocations.title": "分配規則",
    "allocations.desc": "完整規則組合必須恰好分配 100%。",
    "card.publish_allocation": "發佈分配",
    "card.publish_allocation_desc": "此供款項目的先前生效版本將自動結束。",
    "form.contribution_stream": "供款項目",
    "form.effective_from": "生效起始日",
    "form.effective_to": "生效結束日",
    "form.optional": "選填",
    "form.fund_weights": "基金權重",
    "btn.publish_allocation": "發佈分配",

    "plans.eyebrow": "預定資金流",
    "plans.title": "供款計劃",
    "plans.desc": "設定預期每月金額及供款日。",
    "plans.history_title": "供款歷史",
    "plans.history_desc": "事件於購入處理執行後顯示。",
    "card.set_plan": "設定供款計劃",
    "card.set_plan_desc": "相同項目的現行計劃將被結束。",
    "form.monthly_amount": "每月金額",
    "form.expected_day": "預期日期",
    "btn.save_plan": "儲存供款計劃",

    "reconcile.eyebrow": "權威修正",
    "reconcile.title": "與 eMPF 對帳",
    "reconcile.desc": "記錄受託人實際單位並保留先前的審計歷史。",
    "reconcile.callout_strong": "請使用受託人結單日期。",
    "reconcile.callout_body": "對帳記錄一律以「已核實」儲存，並使該日期起的投資組合快照失效。",
    "reconcile.history_title": "對帳歷史",
    "reconcile.history_desc": "根據受託人結單記錄的已核實結餘。",
    "form.notes": "備註",
    "form.notes_placeholder": "eMPF 結單參考",
    "form.verified_units": "已核實基金單位",
    "btn.record_reconciliation": "記錄對帳",

    "fund.search_placeholder": "搜尋基金名稱或別名",
    "fund.search_aria": "按名稱或別名搜尋基金",
    "fund.searching": "正在搜尋基金…",
    "fund.no_results": "找不到符合的基金。",
    "fund.remove_aria": "移除基金列",
    "fund.weight_placeholder": "權重 %",
    "fund.units_placeholder": "單位",
    "fund.transaction_line": "{fund}：{amount}，價格 {price} → {units} 單位（{status}）",

    "error.fund_rows_incomplete": "請從搜尋結果選擇基金並填寫所有數值。",
    "error.account_required": "請先選擇帳戶。",
    "error.api_key_missing": "提出請求前請先輸入 API 金鑰。",
    "error.unexpected": "發生不明錯誤",
    "error.request_failed": "請求失敗（{status}）",

    "toast.connected": "已連線至投資組合 API。",
    "toast.accounts_refreshed": "帳戶已重新整理。",
    "toast.account_created": "帳戶已建立。",
    "toast.account_updated": "帳戶已更新。",
    "toast.baseline_recorded": "持倉基準已記錄。",
    "toast.allocation_published": "分配規則已發佈。",
    "toast.plan_saved": "供款計劃已儲存。",
    "toast.reconciliation_recorded": "對帳已記錄。",

    "empty.holdings": "尚未記錄持倉基準。",
    "empty.reconciliations": "尚未記錄對帳。",
    "empty.allocations": "尚未發佈分配規則。",
    "empty.plans": "尚未設定供款計劃。",
    "empty.contributions": "此帳戶尚未處理任何供款事件。",
    "empty.snapshots": "此帳戶尚未儲存任何估值快照。",
    "empty.valuation_funds": "找不到此帳戶的基金持倉。",

    "col.effective_date": "生效日期",
    "col.fund": "基金",
    "col.units": "單位",
    "col.status": "狀態",
    "col.source": "來源",
    "col.notes": "受託人結單",
    "col.verified_units": "已核實基金單位",
    "col.from": "起始",
    "col.to": "結束",
    "col.stream": "項目",
    "col.weight": "權重",
    "col.amount": "金額",
    "col.expected_day": "預期日期",
    "col.run_date": "執行日期",
    "col.expected_date": "預期日期",
    "col.contribution": "供款",
    "col.fund_transactions": "基金交易",
    "col.as_of": "截至",
    "col.value": "價值",
    "col.calculated": "計算時間",
    "col.revision": "修訂版",
    "col.price": "價格",
    "col.price_date": "價格日期",
    "col.price_status": "價格狀態",
    "col.units_status": "單位狀態",

    "enum.VERIFIED": "已核實",
    "enum.ESTIMATED": "估計",
    "enum.CONFIRMED": "已確認",
    "enum.FAILED_REVIEW": "審計失敗",
    "enum.WAITING": "等待中",
    "enum.COMPLETE": "完整",
    "enum.PARTIAL": "部分",
    "enum.STALE": "過時",
    "enum.FRESH": "最新",
    "enum.MISSING": "缺少"
  }
};

let currentLocale = detectLocale();
let changeHandler = null;

function detectLocale() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "en" || saved === "zh-Hant") return saved;
  const languages = navigator.languages ?? [navigator.language ?? "en"];
  return languages.some((tag) => /^zh/i.test(tag)) ? "zh-Hant" : "en";
}

export function currentLocaleTag() {
  return currentLocale;
}

export function localeTag() {
  return currentLocale === "zh-Hant" ? "zh-HK" : "en-HK";
}

export function t(key, params) {
  const template = translations[currentLocale]?.[key] ?? translations.en[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match
  );
}

export function statusLabel(value) {
  if (value === null || value === undefined || value === "") return value;
  const key = `enum.${value}`;
  return translations[currentLocale]?.[key] ?? translations.en[key] ?? String(value);
}

function applyStaticText() {
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll("[data-i18n-placeholder]")) {
    element.placeholder = t(element.dataset.i18nPlaceholder);
  }
  for (const element of document.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
  document.documentElement.lang = currentLocale === "zh-Hant" ? "zh-Hant" : "en";
  document.title = t("brand.title");
}

function updateSwitchButtons() {
  for (const button of document.querySelectorAll(".lang-button")) {
    button.setAttribute("aria-pressed", String(button.dataset.locale === currentLocale));
  }
}

export function setLocale(locale) {
  if (locale !== "en" && locale !== "zh-Hant") return;
  currentLocale = locale;
  localStorage.setItem(STORAGE_KEY, locale);
  applyStaticText();
  updateSwitchButtons();
  changeHandler?.();
}

export function initI18n(onChange) {
  changeHandler = onChange;
  for (const button of document.querySelectorAll(".lang-button")) {
    button.addEventListener("click", () => setLocale(button.dataset.locale));
  }
  applyStaticText();
  updateSwitchButtons();
}
