import {
  ACTIVITY_KEY,
  DEFAULT_SETTINGS,
  PRESETS,
  SETTINGS_KEY,
  formatDuration,
  formatRelative,
  getStaleTabs,
  hostFromUrl,
  plural,
  splitDuration,
} from "./shared.js";

const MIN_THRESHOLD_MS = 60_000;
const MAX_THRESHOLD_MS = 365 * 86_400_000;
const UNIT_MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** Статичные SVG-иконки для динамически создаваемых элементов. */
const ICONS = {
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
  pin:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4.8l2 2.2H7l2-2.2z"/></svg>',
};

const state = {
  settings: null,
  firstRun: true,
  items: [],
  loading: true,
  closing: false,
  error: null,
  toastTimer: null,
};

const $ = (id) => document.getElementById(id);

const ui = {
  onboarding: $("view-onboarding"),
  main: $("view-main"),
  presets: $("presets"),
  customValue: $("custom-value"),
  customUnit: $("custom-unit"),
  preview: $("threshold-preview"),
  keepPinned: $("keep-pinned"),
  settingsError: $("settings-error"),
  saveSettings: $("save-settings"),
  cancelSettings: $("cancel-settings"),
  thresholdCaption: $("threshold-caption"),
  statusCard: $("status-card"),
  refresh: $("refresh"),
  openSettings: $("open-settings"),
  tabsList: $("tabs-list"),
  tabsCount: $("tabs-count"),
  toast: $("toast"),
};

let refreshToken = 0;

init();

async function init() {
  buildPresets();
  bindEvents();

  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const saved = stored[SETTINGS_KEY];
    if (saved && Number.isFinite(saved.thresholdMs)) {
      state.settings = normalizeSettings(saved);
      state.firstRun = false;
      showMain();
    } else {
      state.settings = { ...DEFAULT_SETTINGS };
      state.firstRun = true;
      showOnboarding();
    }
  } catch {
    state.settings = { ...DEFAULT_SETTINGS };
    state.firstRun = true;
    showOnboarding();
    showToast("Не удалось прочитать настройки");
  }
}

function normalizeSettings(saved) {
  const raw = Number.isFinite(saved.thresholdMs) ? saved.thresholdMs : DEFAULT_SETTINGS.thresholdMs;
  const thresholdMs = Math.min(MAX_THRESHOLD_MS, Math.max(MIN_THRESHOLD_MS, Math.round(raw)));
  return { thresholdMs, keepPinned: saved.keepPinned !== false };
}

function buildPresets() {
  ui.presets.replaceChildren();
  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset";
    button.textContent = preset.label;
    button.dataset.ms = String(preset.ms);
    button.addEventListener("click", () => {
      const { value, unit } = splitDuration(preset.ms);
      ui.customValue.value = String(value);
      ui.customUnit.value = unit;
      clearSettingsError();
      syncPresetSelection();
      updatePreview();
    });
    ui.presets.append(button);
  }
}

function bindEvents() {
  ui.saveSettings.addEventListener("click", handleSave);
  ui.cancelSettings.addEventListener("click", () => {
    state.firstRun = false;
    showMain();
  });

  ui.refresh.addEventListener("click", () => refreshTabs());
  ui.openSettings.addEventListener("click", () => {
    state.firstRun = false;
    showOnboarding();
  });

  for (const input of [ui.customValue, ui.customUnit]) {
    input.addEventListener("input", onFormChanged);
    input.addEventListener("change", onFormChanged);
  }

  ui.statusCard.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-action]");
    if (!trigger) return;
    if (trigger.dataset.action === "retry") {
      refreshTabs();
    } else if (trigger.dataset.action === "close-stale") {
      handleCloseStale();
    }
  });
}

function onFormChanged() {
  clearSettingsError();
  syncPresetSelection();
  updatePreview();
}

function readThreshold() {
  const value = Number(ui.customValue.value);
  if (!Number.isFinite(value) || value <= 0) {
    return { ms: null, error: "Введите число больше нуля." };
  }

  const ms = Math.round(value * (UNIT_MS[ui.customUnit.value] ?? UNIT_MS.minutes));
  if (ms < MIN_THRESHOLD_MS) {
    return { ms: null, error: "Минимальный порог — 1 минута." };
  }
  if (ms > MAX_THRESHOLD_MS) {
    return { ms: null, error: "Максимальный порог — 365 дней." };
  }
  return { ms, error: null };
}

function syncPresetSelection() {
  const { ms } = readThreshold();
  for (const button of ui.presets.querySelectorAll(".preset")) {
    const isSelected = Number(button.dataset.ms) === ms;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  }
}

function updatePreview() {
  const { ms, error } = readThreshold();
  ui.preview.classList.toggle("is-error", Boolean(error));
  ui.preview.textContent = error
    ? "Укажите, через сколько вкладка считается неактивной."
    : `Вкладка попадёт в список, если её не открывали дольше ${formatDuration(ms)}.`;
}

function applySettingsToForm(settings) {
  const { value, unit } = splitDuration(settings.thresholdMs);
  ui.customValue.value = String(value);
  ui.customUnit.value = unit;
  ui.keepPinned.checked = settings.keepPinned !== false;
  clearSettingsError();
  syncPresetSelection();
  updatePreview();
}

function showSettingsError(message) {
  ui.settingsError.textContent = message;
  ui.settingsError.hidden = false;
}

function clearSettingsError() {
  ui.settingsError.hidden = true;
  ui.settingsError.textContent = "";
}

function showOnboarding() {
  ui.main.hidden = true;
  ui.onboarding.hidden = false;
  applySettingsToForm(state.settings ?? DEFAULT_SETTINGS);
  ui.saveSettings.textContent = state.firstRun ? "Начать" : "Сохранить";
  ui.cancelSettings.hidden = state.firstRun;
  ui.saveSettings.disabled = false;
}

function showMain() {
  ui.onboarding.hidden = true;
  ui.main.hidden = false;
  renderThresholdCaption();
  refreshTabs();
}

async function handleSave() {
  if (ui.saveSettings.disabled) return;

  const { ms, error } = readThreshold();
  if (error) {
    showSettingsError(error);
    return;
  }

  const settings = { thresholdMs: ms, keepPinned: ui.keepPinned.checked };
  ui.saveSettings.disabled = true;
  ui.saveSettings.textContent = "Сохраняем…";

  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    state.settings = settings;
    state.firstRun = false;
    showMain();
  } catch {
    showSettingsError("Не удалось сохранить настройки. Попробуйте ещё раз.");
  } finally {
    ui.saveSettings.disabled = false;
    ui.saveSettings.textContent = state.firstRun ? "Начать" : "Сохранить";
  }
}

function renderThresholdCaption() {
  if (!state.settings) return;
  ui.thresholdCaption.textContent = `Неактивны дольше ${formatDuration(state.settings.thresholdMs)}`;
}

async function readActivityLog() {
  try {
    const stored = await chrome.storage.session.get(ACTIVITY_KEY);
    return stored?.[ACTIVITY_KEY] ?? {};
  } catch {
    return {};
  }
}

async function refreshTabs() {
  const token = ++refreshToken;
  state.loading = true;
  state.error = null;
  ui.refresh.classList.add("is-spinning");
  renderStatusCard();
  renderList();
  renderCount();

  try {
    const [tabs, activity] = await Promise.all([chrome.tabs.query({}), readActivityLog()]);
    if (token !== refreshToken) return;

    const now = Date.now();
    const resolved = tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => ({
        ...tab,
        lastAccessed:
          typeof tab.lastAccessed === "number"
            ? tab.lastAccessed
            : typeof activity[tab.id] === "number"
              ? activity[tab.id]
              : null,
      }));

    const staleIds = new Set(
      getStaleTabs(resolved, state.settings.thresholdMs, {
        now,
        keepPinned: state.settings.keepPinned,
      }).map((tab) => tab.id),
    );

    state.items = resolved
      .map((tab) => ({ tab, lastAccessed: tab.lastAccessed, stale: staleIds.has(tab.id) }))
      .sort(compareItems);
  } catch {
    if (token !== refreshToken) return;
    state.items = [];
    state.error = "Не удалось получить список вкладок. Закройте и откройте расширение заново.";
  } finally {
    if (token === refreshToken) {
      state.loading = false;
      ui.refresh.classList.remove("is-spinning");
      renderThresholdCaption();
      renderStatusCard();
      renderList();
      renderCount();
    }
  }
}

function compareItems(a, b) {
  if (a.stale !== b.stale) return a.stale ? -1 : 1;
  if (a.lastAccessed == null && b.lastAccessed == null) return a.tab.id - b.tab.id;
  if (a.lastAccessed == null) return 1;
  if (b.lastAccessed == null) return -1;
  return a.lastAccessed - b.lastAccessed;
}

function renderStatusCard() {
  const card = ui.statusCard;
  card.replaceChildren();
  card.className = "status-card";

  if (state.loading) {
    card.classList.add("is-loading");
    const head = el("div", "status-head");
    const iconBox = el("div", "status-icon sk");
    const body = el("div", "status-body");
    const line1 = el("div", "sk sk-line");
    line1.style.width = "48%";
    const line2 = el("div", "sk sk-line sk-line-sm");
    line2.style.width = "78%";
    body.append(line1, line2);
    head.append(iconBox, body);
    card.append(head);
    return;
  }

  if (state.error) {
    card.classList.add("is-danger");
    card.append(statusHead("alert", "Не получилось загрузить вкладки", state.error));
    card.append(actionButton("retry", "Попробовать снова", "btn btn-secondary btn-block"));
    return;
  }

  const thresholdLabel = formatDuration(state.settings.thresholdMs);
  const staleCount = state.items.filter((item) => item.stale).length;

  if (staleCount > 0) {
    card.classList.add("is-danger");
    card.append(
      statusHead(
        "alert",
        "Есть вкладки без внимания",
        `Их не открывали дольше ${thresholdLabel}. Найдено: ${staleCount} ${plural(staleCount, ["вкладка", "вкладки", "вкладок"])}.`,
      ),
    );

    const button = actionButton(
      "close-stale",
      state.closing
        ? "Закрываем…"
        : `Закрыть ${staleCount} ${plural(staleCount, ["вкладку", "вкладки", "вкладок"])}`,
      "btn btn-danger",
    );
    button.disabled = state.closing;
    card.append(button);
    card.append(
      el("p", "status-hint", "Закроются только после нажатия. Автоматически ничего не удаляется."),
    );
    return;
  }

  card.classList.add("is-success");
  card.append(
    statusHead(
      "check",
      "Все вкладки свежие",
      `Ни одна вкладка не простаивает дольше ${thresholdLabel}.`,
    ),
  );

  const unknownCount = state.items.filter((item) => item.lastAccessed == null).length;
  if (unknownCount > 0) {
    card.append(
      el(
        "p",
        "status-hint",
        `${unknownCount} ${plural(unknownCount, ["вкладка", "вкладки", "вкладок"])} без данных о последнем открытии — их не трогаем.`,
      ),
    );
  }
}

function renderCount() {
  ui.tabsCount.textContent = state.loading ? "…" : String(state.items.length);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name) {
  const span = el("span", "icon");
  span.innerHTML = ICONS[name] ?? "";
  return span;
}

function statusHead(iconName, title, text) {
  const head = el("div", "status-head");
  const iconBox = el("div", "status-icon");
  iconBox.append(icon(iconName));
  const body = el("div", "status-body");
  body.append(el("p", "status-title", title), el("p", "status-text", text));
  head.append(iconBox, body);
  return head;
}

function actionButton(action, label, className) {
  const button = el("button", className, label);
  button.type = "button";
  button.dataset.action = action;
  return button;
}

function renderList() {
  const list = ui.tabsList;
  list.replaceChildren();

  if (state.loading) {
    for (let i = 0; i < 4; i += 1) list.append(skeletonRow());
    return;
  }

  if (state.items.length === 0) {
    list.append(
      state.error
        ? emptyState("Список недоступен", "Нажмите «Обновить» в шапке или откройте расширение заново.")
        : emptyState("Пока пусто", "Откройте пару страниц и загляните сюда снова."),
    );
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of state.items) fragment.append(tabRow(item));
  list.append(fragment);
}

function skeletonRow() {
  const row = el("div", "skeleton-row");
  row.append(el("div", "sk sk-icon"));

  const text = el("div", "sk-text");
  const line1 = el("div", "sk sk-line");
  line1.style.width = "62%";
  const line2 = el("div", "sk sk-line sk-line-sm");
  line2.style.width = "40%";
  text.append(line1, line2);

  row.append(text);
  return row;
}

function emptyState(titleText, subtitleText) {
  const box = el("div", "list-empty");
  box.append(el("strong", null, titleText));
  if (subtitleText) box.append(el("span", null, subtitleText));
  return box;
}

function tabRow(item) {
  const { tab, stale } = item;
  const host = hostFromUrl(tab.url);
  const now = Date.now();

  const row = el("div", "tab-row" + (stale ? " is-stale" : ""));
  row.setAttribute("role", "listitem");
  row.dataset.tabId = String(tab.id);

  row.append(tabFavicon(tab, host));

  const text = el("div", "tab-text");
  const titleText = (tab.title || host || "Без названия").trim();
  const title = el("div", "tab-title", titleText);
  title.title = titleText;

  const meta = el("div", "tab-meta");
  const hostNode = el("span", "tab-host", host || "без адреса");
  hostNode.title = tab.url || "";
  meta.append(hostNode, el("span", "meta-sep", "·"));

  const time = el("span", "tab-time" + (stale ? " is-danger" : ""));
  time.textContent =
    item.lastAccessed == null ? "время неизвестно" : formatRelative(now - item.lastAccessed);
  if (item.lastAccessed != null) {
    time.title = `Последняя активность: ${new Date(item.lastAccessed).toLocaleString("ru-RU")}`;
  }
  meta.append(time);

  if (tab.pinned) {
    const pin = el("span", "tab-pin");
    pin.append(icon("pin"), el("span", null, "закреплена"));
    meta.append(el("span", "meta-sep", "·"), pin);
  }

  text.append(title, meta);
  row.append(text);

  const close = el("button", "tab-close");
  close.type = "button";
  close.title = "Закрыть вкладку";
  close.setAttribute("aria-label", `Закрыть вкладку «${titleText}»`);
  close.innerHTML = ICONS.close;
  close.addEventListener("click", () => handleCloseSingle(item, row, close));
  row.append(close);

  return row;
}

function tabFavicon(tab, host) {
  const box = el("div", "tab-favicon");
  const fallback = el("span", "fallback");
  const source = (tab.title || host || "?").trim();
  fallback.textContent = source ? [...source][0].toUpperCase() : "?";
  fallback.style.setProperty("--hue", String(hueFor(host || source)));
  box.append(fallback);

  if (tab.favIconUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = tab.favIconUrl;
    img.addEventListener("load", () => {
      fallback.hidden = true;
    });
    img.addEventListener("error", () => img.remove());
    box.append(img);
  }

  return box;
}

function hueFor(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return hash;
}

async function handleCloseSingle(item, row, button) {
  if (state.closing) return;

  state.closing = true;
  renderStatusCard();
  button.disabled = true;
  row.classList.add("is-closing");
  await wait(150);

  try {
    await closeTabs([item.tab.id]);
  } finally {
    state.closing = false;
    await refreshTabs();
  }
}

async function handleCloseStale() {
  if (state.closing) return;

  const ids = state.items
    .filter((item) => item.stale && Number.isInteger(item.tab.id))
    .map((item) => item.tab.id);
  if (ids.length === 0) return;

  state.closing = true;
  renderStatusCard();

  try {
    await closeTabs(ids);
  } finally {
    state.closing = false;
    await refreshTabs();
  }
}

async function closeTabs(ids) {
  const unique = [...new Set(ids)];
  const results = await Promise.allSettled(unique.map((id) => chrome.tabs.remove(id)));
  const closed = results.filter((result) => result.status === "fulfilled").length;
  const failed = unique.length - closed;

  if (closed > 0) {
    const base = `${closedVerb(closed)} ${closed} ${plural(closed, ["вкладка", "вкладки", "вкладок"])}`;
    showToast(failed > 0 ? `${base} · не удалось: ${failed}` : base);
  } else {
    showToast("Не удалось закрыть — возможно, вкладки уже закрыты");
  }

  return closed;
}

function closedVerb(count) {
  return plural(count, ["Закрыта", "Закрыто", "Закрыто"]);
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  ui.toast.textContent = message;
  ui.toast.classList.add("is-visible");
  state.toastTimer = setTimeout(() => {
    ui.toast.classList.remove("is-visible");
  }, 2600);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


