/**
 * Чистая логика расширения, которую используют попап и фоновый service worker.
 * Здесь нет обращений к DOM и API Chrome — поэтому этот файл легко тестировать.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Ключи в chrome.storage.local / chrome.storage.session. */
export const SETTINGS_KEY = "settings";
export const ACTIVITY_KEY = "activity";

/** Настройки по умолчанию: вкладка считается забытой после часа без внимания. */
export const DEFAULT_SETTINGS = Object.freeze({
  thresholdMs: HOUR,
  keepPinned: true,
});

/** Готовые варианты порога для экрана первого запуска. */
export const PRESETS = Object.freeze([
  { label: "15 минут", ms: 15 * MINUTE },
  { label: "30 минут", ms: 30 * MINUTE },
  { label: "1 час", ms: HOUR },
  { label: "2 часа", ms: 2 * HOUR },
  { label: "4 часа", ms: 4 * HOUR },
  { label: "12 часов", ms: 12 * HOUR },
  { label: "24 часа", ms: DAY },
  { label: "3 дня", ms: 3 * DAY },
]);

/**
 * Русские формы множественного числа.
 * @param {number} n число
 * @param {[string, string, string]} forms формы для 1 / 2-4 / 5+
 */
export function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

/**
 * Длительность в человекочитаемом виде: «45 минут», «2 часа 30 минут», «3 дня».
 * @param {number} ms миллисекунды
 */
export function formatDuration(ms) {
  const totalMinutes = Number.isFinite(ms) ? Math.max(0, Math.round(ms / MINUTE)) : 0;
  if (totalMinutes < 1) return "меньше минуты";

  if (totalMinutes < 60) {
    return `${totalMinutes} ${plural(totalMinutes, ["минута", "минуты", "минут"])}`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours < 24) {
    const hourPart = `${hours} ${plural(hours, ["час", "часа", "часов"])}`;
    return minutes
      ? `${hourPart} ${minutes} ${plural(minutes, ["минута", "минуты", "минут"])}`
      : hourPart;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  const dayPart = `${days} ${plural(days, ["день", "дня", "дней"])}`;
  return restHours
    ? `${dayPart} ${restHours} ${plural(restHours, ["час", "часа", "часов"])}`
    : dayPart;
}

/**
 * Сколько времени прошло: «только что», «5 минут назад», «2 дня назад».
 * @param {number} ms прошедшие миллисекунды
 */
export function formatRelative(ms) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const minutes = Math.floor(safeMs / MINUTE);
  if (minutes < 1) return "только что";
  if (minutes < 60) {
    return `${minutes} ${plural(minutes, ["минуту", "минуты", "минут"])} назад`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${plural(hours, ["час", "часа", "часов"])} назад`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} ${plural(days, ["день", "дня", "дней"])} назад`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} ${plural(months, ["месяц", "месяца", "месяцев"])} назад`;
  }

  const years = Math.max(1, Math.floor(days / 365));
  return `${years} ${plural(years, ["год", "года", "лет"])} назад`;
}

/**
 * Разбивает длительность на число и удобную единицу для полей ввода.
 * @param {number} ms миллисекунды
 * @returns {{ value: number, unit: "minutes" | "hours" | "days" }}
 */
export function splitDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return { value: 1, unit: "hours" };
  }
  if (ms % DAY === 0 && ms >= DAY) return { value: ms / DAY, unit: "days" };
  if (ms % HOUR === 0 && ms >= HOUR) return { value: ms / HOUR, unit: "hours" };
  return { value: Math.max(1, Math.round(ms / MINUTE)), unit: "minutes" };
}

/**
 * Проверяет, «забыта» ли вкладка: её не открывали дольше порога.
 * Если время последней активности неизвестно — вкладку не трогаем.
 * @param {{ lastAccessed?: number | null, pinned?: boolean } | null | undefined} tab
 * @param {number} thresholdMs порог в миллисекундах
 * @param {{ now?: number, keepPinned?: boolean }} [options]
 */
export function isStale(tab, thresholdMs, options = {}) {
  const { now = Date.now(), keepPinned = true } = options;
  if (!tab) return false;
  if (typeof thresholdMs !== "number" || !Number.isFinite(thresholdMs)) return false;
  if (keepPinned && tab.pinned) return false;
  if (typeof tab.lastAccessed !== "number" || !Number.isFinite(tab.lastAccessed)) return false;
  return now - tab.lastAccessed >= thresholdMs;
}

/**
 * Отбирает вкладки, которые не открывали дольше порога.
 * @param {Array<{ lastAccessed?: number | null, pinned?: boolean }>} tabs
 * @param {number} thresholdMs
 * @param {{ now?: number, keepPinned?: boolean }} [options]
 */
export function getStaleTabs(tabs, thresholdMs, options = {}) {
  if (!Array.isArray(tabs)) return [];
  const now = options.now ?? Date.now();
  return tabs.filter((tab) => isStale(tab, thresholdMs, { ...options, now }));
}

/**
 * Короткое имя сайта для списка вкладок: «example.com», «chrome://extensions».
 * @param {string | undefined} url
 */
export function hostFromUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.hostname.replace(/^www\./i, "");
    }
    if (parsed.protocol === "file:") return "file://";
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
  } catch {
    return "";
  }
}
