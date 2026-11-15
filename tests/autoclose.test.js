import test from "node:test";
import assert from "node:assert/strict";

import {
  DAY,
  DEFAULT_SETTINGS,
  HOUR,
  LAST_AUTO_CLOSE_KEY,
  MAX_THRESHOLD_MS,
  MIN_THRESHOLD_MS,
  MINUTE,
  normalizeSettings,
  selectAutoCloseTabs,
} from "../shared.js";

const NOW = 1_700_000_000_000;

/**
 * Вкладка для тестов автозакрытия: по умолчанию забытая,
 * в окне 1, без признаков активности.
 */
function makeTab(overrides = {}) {
  return {
    id: 1,
    windowId: 1,
    active: false,
    audible: false,
    pinned: false,
    lastAccessed: NOW - 2 * HOUR,
    ...overrides,
  };
}

/** Только идентификаторы выбранных вкладок — так короче сверять результат. */
function ids(tabs) {
  return tabs.map((tab) => tab.id);
}

test("экспортируемые константы автозакрытия согласованы", () => {
  assert.equal(LAST_AUTO_CLOSE_KEY, "lastAutoClose");
  assert.equal(MIN_THRESHOLD_MS, MINUTE);
  assert.equal(MAX_THRESHOLD_MS, 365 * DAY);
  assert.deepEqual(DEFAULT_SETTINGS, {
    thresholdMs: HOUR,
    keepPinned: true,
    autoClose: false,
  });
});

test("normalizeSettings: пустые и некорректные входы дают значения по умолчанию", () => {
  const defaults = { thresholdMs: HOUR, keepPinned: true, autoClose: false };
  for (const input of [undefined, null, "settings", 42, true, () => {}]) {
    assert.deepEqual(normalizeSettings(input), defaults, `вход: ${String(input)}`);
  }
  // Массив — тоже объект, но без нужных полей; ожидаем безопасные значения.
  assert.deepEqual(normalizeSettings([]), defaults);
});

test("normalizeSettings: thresholdMs округляется и зажимается в допустимые границы", () => {
  assert.equal(normalizeSettings({ thresholdMs: 0 }).thresholdMs, MIN_THRESHOLD_MS);
  assert.equal(normalizeSettings({ thresholdMs: -5 * HOUR }).thresholdMs, MIN_THRESHOLD_MS);
  assert.equal(normalizeSettings({ thresholdMs: MIN_THRESHOLD_MS }).thresholdMs, MIN_THRESHOLD_MS);
  assert.equal(normalizeSettings({ thresholdMs: MIN_THRESHOLD_MS + 1 }).thresholdMs, MIN_THRESHOLD_MS + 1);
  assert.equal(normalizeSettings({ thresholdMs: MAX_THRESHOLD_MS }).thresholdMs, MAX_THRESHOLD_MS);
  assert.equal(normalizeSettings({ thresholdMs: MAX_THRESHOLD_MS + 1 }).thresholdMs, MAX_THRESHOLD_MS);
  assert.equal(normalizeSettings({ thresholdMs: 10 * MAX_THRESHOLD_MS }).thresholdMs, MAX_THRESHOLD_MS);
  // Дробные значения округляются до целых.
  assert.equal(normalizeSettings({ thresholdMs: 90_000.6 }).thresholdMs, 90_001);
  assert.equal(normalizeSettings({ thresholdMs: 2 * HOUR + 0.4 }).thresholdMs, 2 * HOUR);
});

test("normalizeSettings: нечисловой thresholdMs заменяется значением по умолчанию", () => {
  for (const thresholdMs of [undefined, null, NaN, Infinity, -Infinity, "3600000", {}, []]) {
    assert.equal(
      normalizeSettings({ thresholdMs }).thresholdMs,
      HOUR,
      `thresholdMs: ${String(thresholdMs)}`,
    );
  }
});

test("normalizeSettings: keepPinned защищает по умолчанию и отключается только явным false", () => {
  assert.equal(normalizeSettings(undefined).keepPinned, true);
  assert.equal(normalizeSettings({}).keepPinned, true);
  assert.equal(normalizeSettings({ keepPinned: true }).keepPinned, true);
  assert.equal(normalizeSettings({ keepPinned: false }).keepPinned, false);
  // Всё, что не строго false, считается включённой защитой.
  for (const keepPinned of [0, "", null, "false", NaN]) {
    assert.equal(
      normalizeSettings({ keepPinned }).keepPinned,
      true,
      `keepPinned: ${String(keepPinned)}`,
    );
  }
});

test("normalizeSettings: autoClose включается только строгим true", () => {
  assert.equal(normalizeSettings({ autoClose: true }).autoClose, true);
  for (const autoClose of [undefined, false, "true", 1, "1", {}, [], null, NaN]) {
    assert.equal(
      normalizeSettings({ autoClose }).autoClose,
      false,
      `autoClose: ${String(autoClose)}`,
    );
  }
});

test("normalizeSettings: старые настройки без autoClose получают выключенную автоматику", () => {
  assert.deepEqual(normalizeSettings({ thresholdMs: 2 * HOUR, keepPinned: false }), {
    thresholdMs: 2 * HOUR,
    keepPinned: false,
    autoClose: false,
  });
  // Остальные поля не теряются и не портятся.
  assert.deepEqual(normalizeSettings({ thresholdMs: HOUR, keepPinned: true, autoClose: true }), {
    thresholdMs: HOUR,
    keepPinned: true,
    autoClose: true,
  });
});

test("selectAutoCloseTabs: некорректные аргументы дают пустой результат", () => {
  for (const input of [undefined, null, "tabs", 42, {}, { length: 0 }]) {
    assert.deepEqual(selectAutoCloseTabs(input, HOUR, { now: NOW }), []);
  }
  assert.deepEqual(selectAutoCloseTabs([], HOUR, { now: NOW }), []);

  const tabs = [
    makeTab({ id: 1, lastAccessed: NOW - 10 * HOUR }),
    makeTab({ id: 2, lastAccessed: NOW - 10 * HOUR }),
  ];
  // Некорректный порог не должен приводить к закрытию.
  assert.deepEqual(selectAutoCloseTabs(tabs, NaN, { now: NOW }), []);
  assert.deepEqual(selectAutoCloseTabs(tabs, Infinity, { now: NOW }), []);
});

test("selectAutoCloseTabs: вкладки без целочисленного id не выбираются", () => {
  const tabs = [
    makeTab({ id: undefined }),
    makeTab({ id: null }),
    makeTab({ id: "5" }),
    makeTab({ id: 1.5 }),
    makeTab({ id: NaN }),
    makeTab({ id: 10 }),
  ];
  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [10]);
});

test("selectAutoCloseTabs: строгая граница порога и неизвестное время активности", () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1, lastAccessed: NOW - HOUR }), // ровно порог => забыта
    makeTab({ id: 2, windowId: 1, lastAccessed: NOW - HOUR + 1 }), // чуть свежее => не забыта
    makeTab({ id: 3, windowId: 2, lastAccessed: null }),
    makeTab({ id: 4, windowId: 2, lastAccessed: undefined }),
  ];
  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [1]);
});

test("selectAutoCloseTabs: активные и звучащие вкладки не закрываются", () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1, active: true }),
    makeTab({ id: 2, windowId: 1, audible: true }),
    makeTab({ id: 3, windowId: 1 }),
  ];
  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [3]);
});

test("selectAutoCloseTabs: активная вкладка одного окна не мешает другим окнам", () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1, active: true, lastAccessed: NOW - 10 * HOUR }),
    makeTab({ id: 2, windowId: 2, lastAccessed: NOW - 2 * HOUR }),
    makeTab({ id: 3, windowId: 2, lastAccessed: NOW - MINUTE }),
  ];
  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [2]);
});

test("selectAutoCloseTabs: звучащая вкладка одного окна не мешает другим окнам", () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1, audible: true, lastAccessed: NOW - 10 * HOUR }),
    makeTab({ id: 2, windowId: 1, lastAccessed: NOW - 3 * HOUR }),
    makeTab({ id: 3, windowId: 2, lastAccessed: NOW - 3 * HOUR }),
    makeTab({ id: 4, windowId: 2, lastAccessed: NOW - 3 * HOUR }),
  ];
  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [2, 3, 4]);
});

test("selectAutoCloseTabs: последняя вкладка окна защищена от закрытия", () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1, lastAccessed: NOW - 10 * HOUR }), // единственная в окне
    makeTab({ id: 2, windowId: 2, lastAccessed: NOW - 2 * HOUR }),
    makeTab({ id: 3, windowId: 2, lastAccessed: NOW - MINUTE }),
    makeTab({ id: 4, windowId: 3, lastAccessed: NOW - 10 * HOUR }), // единственная в окне
  ];
  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [2]);
});

test("selectAutoCloseTabs: закреплённые защищены при keepPinned по умолчанию", () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1, pinned: true, lastAccessed: NOW - 10 * HOUR }),
    makeTab({ id: 2, windowId: 1, lastAccessed: NOW - 2 * HOUR }),
  ];

  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [2]);
  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW, keepPinned: true })), [2]);
  // Явное отключение защиты возвращает закреплённую вкладку в выборку.
  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW, keepPinned: false })), [1, 2]);
});

test("selectAutoCloseTabs: вкладки без windowId не отсекаются правилом единственной вкладки", () => {
  const tabs = [
    makeTab({ id: 1, windowId: undefined, lastAccessed: NOW - 2 * HOUR }),
    makeTab({ id: 2, windowId: undefined, active: true }),
    makeTab({ id: 3, windowId: undefined, audible: true }),
    makeTab({ id: 4, windowId: undefined, pinned: true }),
    makeTab({ id: 5, windowId: undefined, lastAccessed: NOW - MINUTE }),
  ];

  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [1]);
  assert.deepEqual(
    ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW, keepPinned: false })),
    [1, 4],
  );
});

test("selectAutoCloseTabs: смешанный многoоконный сценарий", () => {
  const tabs = [
    // Окно 1: одна забытая вкладка => защищена правилом последней вкладки.
    makeTab({ id: 1, windowId: 1, lastAccessed: NOW - 10 * HOUR }),
    // Окно 2: активная + две забытые => закрываем только неактивные.
    makeTab({ id: 2, windowId: 2, active: true, lastAccessed: NOW - 10 * HOUR }),
    makeTab({ id: 3, windowId: 2, lastAccessed: NOW - 2 * HOUR }),
    makeTab({ id: 4, windowId: 2, lastAccessed: NOW - 4 * HOUR }),
    // Окно 3: звучащая + свежая => ничего не закрываем.
    makeTab({ id: 5, windowId: 3, audible: true, lastAccessed: NOW - 10 * HOUR }),
    makeTab({ id: 6, windowId: 3, lastAccessed: NOW - MINUTE }),
    // Окно 4: закреплённая + забытая => закрываем только незакреплённую.
    makeTab({ id: 7, windowId: 4, pinned: true, lastAccessed: NOW - 10 * HOUR }),
    makeTab({ id: 8, windowId: 4, lastAccessed: NOW - 5 * HOUR }),
  ];

  assert.deepEqual(ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW })), [3, 4, 8]);
  assert.deepEqual(
    ids(selectAutoCloseTabs(tabs, HOUR, { now: NOW, keepPinned: false })),
    [3, 4, 7, 8],
  );
});

test("selectAutoCloseTabs: не мутирует входной массив и сохраняет исходный порядок", () => {
  const tabs = [
    makeTab({ id: 1, windowId: 1, lastAccessed: NOW - 5 * HOUR }),
    makeTab({ id: 2, windowId: 1, lastAccessed: NOW - MINUTE }),
    makeTab({ id: 3, windowId: 2, lastAccessed: NOW - 5 * HOUR }),
    makeTab({ id: 4, windowId: 2, lastAccessed: NOW - 3 * HOUR }),
  ];
  const snapshot = tabs.map((tab) => ({ ...tab }));

  const result = selectAutoCloseTabs(tabs, HOUR, { now: NOW });

  assert.deepEqual(ids(result), [1, 3, 4]);
  assert.deepEqual(tabs, snapshot);
  // Возвращаются те же объекты, а не копии.
  assert.equal(result[0], tabs[0]);
  assert.equal(result[1], tabs[2]);
  assert.equal(result[2], tabs[3]);
});
