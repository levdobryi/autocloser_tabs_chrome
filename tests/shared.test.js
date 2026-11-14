import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY,
  HOUR,
  MINUTE,
  formatDuration,
  formatRelative,
  getStaleTabs,
  hostFromUrl,
  isStale,
  plural,
  splitDuration,
} from "../shared.js";

const NOW = 1_700_000_000_000;

/** Вкладка для тестов: по умолчанию открыта 30 минут назад. */
function makeTab(overrides = {}) {
  return { id: 1, pinned: false, lastAccessed: NOW - 30 * MINUTE, ...overrides };
}

test("plural выбирает русскую форму для 1 / 2-4 / 5+", () => {
  const forms = ["вкладка", "вкладки", "вкладок"];
  assert.equal(plural(1, forms), "вкладка");
  assert.equal(plural(2, forms), "вкладки");
  assert.equal(plural(4, forms), "вкладки");
  assert.equal(plural(5, forms), "вкладок");
  assert.equal(plural(11, forms), "вкладок");
  assert.equal(plural(21, forms), "вкладка");
  assert.equal(plural(22, forms), "вкладки");
  assert.equal(plural(0, forms), "вкладок");
});

test("formatDuration склоняет минуты, часы и дни", () => {
  assert.equal(formatDuration(15 * MINUTE), "15 минут");
  assert.equal(formatDuration(45 * MINUTE), "45 минут");
  assert.equal(formatDuration(HOUR), "1 час");
  assert.equal(formatDuration(2 * HOUR + 30 * MINUTE), "2 часа 30 минут");
  assert.equal(formatDuration(DAY), "1 день");
  assert.equal(formatDuration(3 * DAY), "3 дня");
  assert.equal(formatDuration(5 * DAY + 3 * HOUR), "5 дней 3 часа");
  assert.equal(formatDuration(500), "меньше минуты");
});

test("formatRelative показывает прошедшее время по-русски", () => {
  assert.equal(formatRelative(0), "только что");
  assert.equal(formatRelative(20_000), "только что");
  assert.equal(formatRelative(MINUTE), "1 минуту назад");
  assert.equal(formatRelative(5 * MINUTE), "5 минут назад");
  assert.equal(formatRelative(HOUR), "1 час назад");
  assert.equal(formatRelative(3 * HOUR), "3 часа назад");
  assert.equal(formatRelative(2 * DAY), "2 дня назад");
  assert.equal(formatRelative(30 * DAY), "1 месяц назад");
  assert.equal(formatRelative(400 * DAY), "1 год назад");
  assert.equal(formatRelative(-5000), "только что");
});

test("splitDuration подбирает удобную единицу измерения", () => {
  assert.deepEqual(splitDuration(HOUR), { value: 1, unit: "hours" });
  assert.deepEqual(splitDuration(2 * DAY), { value: 2, unit: "days" });
  assert.deepEqual(splitDuration(90 * MINUTE), { value: 90, unit: "minutes" });
  assert.deepEqual(splitDuration(45_000), { value: 1, unit: "minutes" });
});

test("isStale учитывает порог, закреплённые вкладки и неизвестное время", () => {
  const threshold = HOUR;

  assert.equal(isStale(makeTab({ lastAccessed: NOW - 2 * HOUR }), threshold, { now: NOW }), true);
  assert.equal(isStale(makeTab({ lastAccessed: NOW - HOUR }), threshold, { now: NOW }), true);
  assert.equal(isStale(makeTab({ lastAccessed: NOW - 59 * MINUTE }), threshold, { now: NOW }), false);
  assert.equal(isStale(makeTab({ lastAccessed: null }), threshold, { now: NOW }), false);
  assert.equal(isStale(makeTab({ lastAccessed: undefined }), threshold, { now: NOW }), false);
  assert.equal(isStale(null, threshold, { now: NOW }), false);
});

test("isStale защищает закреплённые вкладки, если включена настройка", () => {
  const oldPinned = makeTab({ pinned: true, lastAccessed: NOW - 10 * HOUR });

  assert.equal(isStale(oldPinned, HOUR, { now: NOW, keepPinned: true }), false);
  assert.equal(isStale(oldPinned, HOUR, { now: NOW, keepPinned: false }), true);
});

test("getStaleTabs отбирает только забытые вкладки", () => {
  const tabs = [
    makeTab({ id: 1, lastAccessed: NOW - 5 * HOUR }),
    makeTab({ id: 2, lastAccessed: NOW - 10 * MINUTE }),
    makeTab({ id: 3, lastAccessed: null }),
    makeTab({ id: 4, pinned: true, lastAccessed: NOW - 9 * HOUR }),
    makeTab({ id: 5, lastAccessed: NOW - 2 * HOUR }),
  ];

  const result = getStaleTabs(tabs, HOUR, { now: NOW, keepPinned: true });
  assert.deepEqual(
    result.map((tab) => tab.id),
    [1, 5],
  );

  const withPinned = getStaleTabs(tabs, HOUR, { now: NOW, keepPinned: false });
  assert.deepEqual(
    withPinned.map((tab) => tab.id),
    [1, 4, 5],
  );

  assert.deepEqual(getStaleTabs(null, HOUR, { now: NOW }), []);
});

test("formatDuration и formatRelative не ломаются на некорректных значениях", () => {
  assert.equal(formatDuration(NaN), "меньше минуты");
  assert.equal(formatDuration(undefined), "меньше минуты");
  assert.equal(formatRelative(NaN), "только что");
  assert.equal(formatRelative(undefined), "только что");
});

test("hostFromUrl достаёт короткое имя сайта", () => {
  assert.equal(hostFromUrl("https://www.example.com/path?q=1"), "example.com");
  assert.equal(hostFromUrl("http://sub.example.org:8080/a"), "sub.example.org");
  assert.equal(hostFromUrl("chrome://extensions/"), "chrome://extensions");
  assert.equal(hostFromUrl("file:///C:/Users/test/index.html"), "file://");
  assert.equal(hostFromUrl(""), "");
  assert.equal(hostFromUrl("не ссылка"), "");
});
