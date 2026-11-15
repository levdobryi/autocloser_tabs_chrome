/**
 * Фоновый service worker.
 * Его задачи:
 *  1) запоминать время последней активности вкладок (запасной вариант, если браузер
 *     не отдаёт tab.lastAccessed);
 *  2) показывать на иконке расширения количество вкладок, которые давно не открывали;
 *  3) если пользователь включил в настройках автозакрытие — раз в минуту закрывать
 *     «забытые» вкладки. Пока тумблер выключен, worker вкладки не трогает.
 */

import {
  ACTIVITY_KEY,
  DEFAULT_SETTINGS,
  LAST_AUTO_CLOSE_KEY,
  SETTINGS_KEY,
  getStaleTabs,
  normalizeSettings,
  selectAutoCloseTabs,
} from "./shared.js";

const BADGE_REFRESH_ALARM = "badge-refresh";
const BADGE_COLOR = "#dc2626";
const UPDATE_DELAY_MS = 350;

let badgeTimer = null;
/** Очередь, чтобы параллельные события не перезаписывали журнал активности. */
let activityQueue = Promise.resolve();
/** Защита от повторного запуска автозакрытия, пока предыдущее не закончилось. */
let autoCloseRunning = false;

async function readSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings(stored[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function readActivity() {
  try {
    const stored = await chrome.storage.session.get(ACTIVITY_KEY);
    return stored[ACTIVITY_KEY] || {};
  } catch {
    return {};
  }
}

/**
 * Добавляет к вкладкам время последней активности: сначала берём данные браузера,
 * затем — журнал из chrome.storage.session.
 * @param {chrome.tabs.Tab[]} tabs
 * @param {Record<string, number>} activity
 */
function resolveTabs(tabs, activity) {
  return tabs
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
}

/** Запоминает, что вкладка только что была активна. */
function rememberTab(tabId) {
  activityQueue = activityQueue
    .then(async () => {
      const activity = await readActivity();
      activity[tabId] = Date.now();
      await chrome.storage.session.set({ [ACTIVITY_KEY]: activity });
    })
    .catch(() => {});
  return activityQueue;
}

/** Убирает закрытую вкладку из журнала активности. */
function forgetTab(tabId) {
  activityQueue = activityQueue
    .then(async () => {
      const activity = await readActivity();
      if (tabId in activity) {
        delete activity[tabId];
        await chrome.storage.session.set({ [ACTIVITY_KEY]: activity });
      }
    })
    .catch(() => {});
  return activityQueue;
}

function scheduleBadgeUpdate() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    updateBadge().catch(() => {});
  }, UPDATE_DELAY_MS);
}

/**
 * Закрывает «забытые» вкладки, если автозакрытие включено в настройках.
 * Возвращает количество успешно закрытых вкладок.
 */
async function autoCloseStaleTabs() {
  if (autoCloseRunning) return 0;

  const settings = await readSettings();
  if (!settings.autoClose) return 0;

  autoCloseRunning = true;
  try {
    const [activity, tabs] = await Promise.all([readActivity(), chrome.tabs.query({})]);
    const resolved = resolveTabs(tabs, activity);
    const targets = selectAutoCloseTabs(resolved, settings.thresholdMs, {
      now: Date.now(),
      keepPinned: settings.keepPinned,
    });

    if (targets.length === 0) return 0;

    const results = await Promise.allSettled(
      targets.map((tab) => chrome.tabs.remove(tab.id)),
    );
    const closed = results.filter((result) => result.status === "fulfilled").length;

    if (closed > 0) {
      try {
        await chrome.storage.local.set({
          [LAST_AUTO_CLOSE_KEY]: { at: Date.now(), count: closed },
        });
      } catch {
        // Журнал автозакрытия нужен только для подсказки в попапе — не критичен.
      }
    }

    return closed;
  } finally {
    autoCloseRunning = false;
  }
}

/** Пересчитывает «забытые» вкладки и обновляет счётчик на иконке. */
async function updateBadge() {
  const [settings, activity, tabs] = await Promise.all([
    readSettings(),
    readActivity(),
    chrome.tabs.query({}),
  ]);

  const now = Date.now();
  const resolved = resolveTabs(tabs, activity);

  // Для счётчика достаточно обычной проверки: он лишь показывает, что есть
  // вкладки без внимания, и ничего не закрывает.
  const stale = getStaleTabs(resolved, settings.thresholdMs, {
    now,
    keepPinned: settings.keepPinned,
  });

  const count = stale.length;
  const text = count === 0 ? "" : count > 99 ? "99+" : String(count);

  await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  if (typeof chrome.action.setBadgeTextColor === "function") {
    try {
      await chrome.action.setBadgeTextColor({ color: "#ffffff" });
    } catch {
      // Старые браузеры могут не поддерживать цвет текста бейджа — не критично.
    }
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({
    title:
      count === 0
        ? "Автозакрытие вкладок"
        : `Без внимания: ${count}. Откройте расширение, чтобы закрыть`,
  });
}

async function ensureAlarm() {
  try {
    const existing = await chrome.alarms.get(BADGE_REFRESH_ALARM);
    if (!existing) {
      await chrome.alarms.create(BADGE_REFRESH_ALARM, { periodInMinutes: 1 });
    }
  } catch {
    // Будильник — вспомогательная функция, без него расширение продолжит работать.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  scheduleBadgeUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  scheduleBadgeUpdate();
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  rememberTab(tabId);
  scheduleBadgeUpdate();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    rememberTab(tabId);
    scheduleBadgeUpdate();
  }
});

chrome.tabs.onCreated.addListener(() => scheduleBadgeUpdate());

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId);
  scheduleBadgeUpdate();
});

// Chrome иногда заменяет вкладку новым id (например, при переносе между окнами).
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  forgetTab(removedTabId);
  rememberTab(addedTabId);
  scheduleBadgeUpdate();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_KEY]) {
    // Если тумблер только что включили, будильник должен точно существовать.
    ensureAlarm();
    scheduleBadgeUpdate();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== BADGE_REFRESH_ALARM) return;
  autoCloseStaleTabs()
    .catch(() => {})
    .finally(() => scheduleBadgeUpdate());
});
