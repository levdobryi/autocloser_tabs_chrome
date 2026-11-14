import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY,
  DEFAULT_SETTINGS,
  HOUR,
  MINUTE,
  PRESETS,
  formatDuration,
  formatRelative,
  getStaleTabs,
  hostFromUrl,
  isStale,
  plural,
  splitDuration,
} from "../shared.js";

const NOW = 1_700_000_000_000;
const UNIT_MS = { minutes: MINUTE, hours: HOUR, days: DAY };

/** Вкладка для тестов: по умолчанию открыта 30 минут назад. */
function makeTab(overrides = {}) {
  return { id: 1, pinned: false, lastAccessed: NOW - 30 * MINUTE, ...overrides };
}

test("plural: границы 11-14, сотни и отрицательные числа", () => {
  const forms = ["день", "дня", "дней"];
  assert.equal(plural(101, forms), "день");
  assert.equal(plural(102, forms), "дня");
  assert.equal(plural(104, forms), "дня");
  assert.equal(plural(105, forms), "дней");
  assert.equal(plural(111, forms), "дней");
  assert.equal(plural(112, forms), "дней");
  assert.equal(plural(114, forms), "дней");
  assert.equal(plural(121, forms), "день");
  assert.equal(plural(1001, forms), "день");
  assert.equal(plural(-1, forms), "день");
  assert.equal(plural(-22, forms), "дня");
  assert.equal(plural(-25, forms), "дней");
});

test("formatDuration: границы минут, часов и суток", () => {
  assert.equal(formatDuration(0), "меньше минуты");
  assert.equal(formatDuration(MINUTE), "1 минута");
  assert.equal(formatDuration(2 * MINUTE), "2 минуты");
  assert.equal(formatDuration(5 * MINUTE), "5 минут");
  assert.equal(formatDuration(59 * MINUTE), "59 минут");
  assert.equal(formatDuration(60 * MINUTE), "1 час");
  assert.equal(formatDuration(90 * MINUTE), "1 час 30 минут");
  assert.equal(formatDuration(21 * HOUR), "21 час");
  assert.equal(formatDuration(23 * HOUR + 59 * MINUTE), "23 часа 59 минут");
  assert.equal(formatDuration(24 * HOUR - 1), "1 день");
  assert.equal(formatDuration(2 * DAY), "2 дня");
  assert.equal(formatDuration(29 * DAY + 23 * HOUR), "29 дней 23 часа");
  assert.equal(formatDuration(30 * DAY), "30 дней");
  assert.equal(formatDuration(-5 * MINUTE), "меньше минуты");
});

test("formatRelative: границы минут, часов, дней и лет", () => {
  assert.equal(formatRelative(MINUTE - 1), "только что");
  assert.equal(formatRelative(MINUTE), "1 минуту назад");
  assert.equal(formatRelative(2 * MINUTE), "2 минуты назад");
  assert.equal(formatRelative(5 * MINUTE), "5 минут назад");
  assert.equal(formatRelative(59.9 * MINUTE), "59 минут назад");
  assert.equal(formatRelative(23.9 * HOUR), "23 часа назад");
  assert.equal(formatRelative(24 * HOUR), "1 день назад");
  assert.equal(formatRelative(5 * DAY), "5 дней назад");
  assert.equal(formatRelative(29.9 * DAY), "29 дней назад");
  assert.equal(formatRelative(30 * DAY), "1 месяц назад");
  assert.equal(formatRelative(11 * 30 * DAY), "11 месяцев назад");
  assert.equal(formatRelative(365 * DAY), "1 год назад");
  assert.equal(formatRelative(730 * DAY), "2 года назад");
});

test("splitDuration: единицы, некорректные значения и округление", () => {
  assert.deepEqual(splitDuration(DAY), { value: 1, unit: "days" });
  assert.deepEqual(splitDuration(3 * DAY), { value: 3, unit: "days" });
  assert.deepEqual(splitDuration(1.5 * DAY), { value: 36, unit: "hours" });
  assert.deepEqual(splitDuration(HOUR), { value: 1, unit: "hours" });
  assert.deepEqual(splitDuration(25 * HOUR), { value: 25, unit: "hours" });
  assert.deepEqual(splitDuration(DAY - MINUTE), { value: 1439, unit: "minutes" });
  assert.deepEqual(splitDuration(1), { value: 1, unit: "minutes" });
  assert.deepEqual(splitDuration(59_999), { value: 1, unit: "minutes" });
  // Некорректные значения дают безопасный запасной вариант «1 час».
  assert.deepEqual(splitDuration(0), { value: 1, unit: "hours" });
  assert.deepEqual(splitDuration(-MINUTE), { value: 1, unit: "hours" });
  assert.deepEqual(splitDuration(NaN), { value: 1, unit: "hours" });
  assert.deepEqual(splitDuration(Infinity), { value: 1, unit: "hours" });
  assert.deepEqual(splitDuration("3600000"), { value: 1, unit: "hours" });
  assert.deepEqual(splitDuration(undefined), { value: 1, unit: "hours" });
});

test("splitDuration и PRESETS: обратное преобразование совпадает с порогом", () => {
  for (const preset of PRESETS) {
    const { value, unit } = splitDuration(preset.ms);
    assert.equal(value * UNIT_MS[unit], preset.ms, `пресет «${preset.label}» теряет значение`);
  }
});

test("isStale: строгие границы порога и некорректные аргументы", () => {
  const threshold = HOUR;
  assert.equal(isStale(makeTab({ lastAccessed: NOW - threshold }), threshold, { now: NOW }), true);
  assert.equal(
    isStale(makeTab({ lastAccessed: NOW - threshold + 1 }), threshold, { now: NOW }),
    false,
  );
  assert.equal(isStale(makeTab({ lastAccessed: NOW }), threshold, { now: NOW }), false);
  assert.equal(isStale(makeTab({ lastAccessed: NOW - 5 * HOUR }), NaN, { now: NOW }), false);
  assert.equal(isStale(makeTab({ lastAccessed: NOW - 5 * HOUR }), Infinity, { now: NOW }), false);
  assert.equal(isStale({}, threshold, { now: NOW }), false);
  assert.equal(isStale(undefined, threshold, { now: NOW }), false);
});

test("getStaleTabs: пустой список и защита закреплённых по умолчанию", () => {
  assert.deepEqual(getStaleTabs([], HOUR, { now: NOW }), []);

  const tabs = [
    makeTab({ id: 1, pinned: true, lastAccessed: NOW - 10 * HOUR }),
    makeTab({ id: 2, lastAccessed: NOW - 2 * HOUR }),
  ];
  const defaultResult = getStaleTabs(tabs, HOUR, { now: NOW });
  assert.deepEqual(
    defaultResult.map((tab) => tab.id),
    [2],
  );
  assert.equal(DEFAULT_SETTINGS.keepPinned, true);
});

test("hostFromUrl: нормализация регистра, портов и нестандартных схем", () => {
  assert.equal(hostFromUrl("https://www.Example.COM:443/path"), "example.com");
  assert.equal(hostFromUrl("https://user:pass@example.com/x"), "example.com");
  assert.equal(hostFromUrl("https://[::1]:8080/x"), "[::1]");
  assert.equal(hostFromUrl("ftp://ftp.example.com/a"), "ftp://ftp.example.com");
  assert.equal(hostFromUrl("chrome-extension://abcdef/popup.html"), "chrome-extension://abcdef");
  assert.equal(hostFromUrl("about:blank"), "about:");
  assert.equal(hostFromUrl("mailto:user@example.com"), "mailto:");
  assert.equal(hostFromUrl(undefined), "");
  assert.equal(hostFromUrl(null), "");
  assert.equal(hostFromUrl("example.com"), "");
});
