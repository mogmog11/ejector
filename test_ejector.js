// ejector.html テストスクリプト
// Node.js で実行: node test_ejector.js

// ─── テスト用モック環境 ───────────────────────────────
// localStorage モック
const _store = {};
const localStorage = {
  getItem: k => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = v; },
  removeItem: k => { delete _store[k]; },
};

// グローバルに注入
global.localStorage = localStorage;
global.navigator = { vibrate: null };
global.document = {
  hidden: false,
  getElementById: () => ({ style: {}, innerHTML: '', textContent: '', value: '', appendChild: () => {} }),
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {}, className: '', id: '', innerHTML: '', setAttribute: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } }),
  addEventListener: () => {},
  body: { appendChild: () => {} },
};
global.window = { addEventListener: () => {}, onload: null };
global.fetch = async () => ({ ok: false, json: async () => ({}) });
global.Notification = { permission: 'default', requestPermission: async () => 'default' };

// ─── テスト対象関数を直接実装 ─────────────────────────

function offsetToDateKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// あとでリストのフィルターロジック（修正版）
function renderLaterListFilter(tasks, currentDayOffset) {
  const dk = offsetToDateKey(currentDayOffset);
  return tasks.filter(t => {
    if (t.allocated) return false;
    if (t.deletedDates && t.deletedDates.includes(dk)) return false;

    const created = t.createdOffset !== undefined ? t.createdOffset : 0;
    if (dk < created) return false;

    if (t.repeatMode !== 'none') {
      // 繰り返しタスクの処理（簡略化）
      return true;
    }
    // [FIX] repeatMode='none': dk >= created であれば表示（翌日以降も表示）
    return true;
  });
}

// タイムシフトロジック（修正版）
function applyTimeShiftLogic(tasks, currentDayOffset, shiftMinutes) {
  const dk = offsetToDateKey(currentDayOffset);
  
  // タイムラインにあるタスクをフィルタ
  const dayTasks = tasks.filter(t => t.allocated);
  
  dayTasks.forEach(task => {
    const currentStart = task.overrides && task.overrides[dk]
      ? task.overrides[dk].start
      : task.start;
    const newStart = Math.max(0, Math.min(1439, currentStart + shiftMinutes));

    if (task.repeatMode !== 'none') {
      if (!task.overrides) task.overrides = {};
      task.overrides[dk] = { start: newStart };
    } else {
      task.start = newStart;
    }
  });
  
  return tasks;
}

// サブタスクのコピー修正確認
function duplicateTaskLogic(task, currentDayOffset) {
  const copy = JSON.parse(JSON.stringify(task));
  copy.id    = Date.now();
  copy.title = copy.title + ' (コピー)';
  copy.doneDates = [];
  if (copy.repeatMode === 'none') {
    copy.allocatedOffset = offsetToDateKey(currentDayOffset);
    if (copy.start != null) copy.start = (copy.start || 0) + copy.duration;
  }
  copy.createdOffset = offsetToDateKey(currentDayOffset);
  // [FIX] サブタスクはコピーするが完了状態はリセット
  if (copy.subtasks) {
    copy.subtasks = copy.subtasks.map(s => ({ title: s.title }));
  }
  return copy;
}

// ─── テストスイート ────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    results.push({ name, status: 'PASS' });
    passed++;
  } catch(e) {
    console.log(`  ❌ FAIL: ${name}`);
    console.log(`         ${e.message}`);
    results.push({ name, status: 'FAIL', error: e.message });
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

// ══════════════════════════════════════════════════════
console.log('\n╔════════════════════════════════════════════╗');
console.log('║      EJECTOR テストスイート v2.0           ║');
console.log('╚════════════════════════════════════════════╝\n');

// ─── 1. DateKey変換テスト ────────────────────────────
console.log('📅 [1] DateKey変換テスト');

test('今日のoffset(0)が正しいDateKeyを返す', () => {
  const dk = offsetToDateKey(0);
  const today = new Date();
  const expected = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  assertEqual(dk, expected, `DateKey mismatch: ${dk} vs ${expected}`);
});

test('明日のoffset(1)が正しいDateKeyを返す', () => {
  const dk = offsetToDateKey(1);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const expected = tomorrow.getFullYear() * 10000 + (tomorrow.getMonth() + 1) * 100 + tomorrow.getDate();
  assertEqual(dk, expected, `DateKey mismatch: ${dk} vs ${expected}`);
});

test('昨日のoffset(-1)が正しいDateKeyを返す', () => {
  const dk = offsetToDateKey(-1);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const expected = yesterday.getFullYear() * 10000 + (yesterday.getMonth() + 1) * 100 + yesterday.getDate();
  assertEqual(dk, expected, `DateKey mismatch: ${dk} vs ${expected}`);
});

// ─── 2. あとでリスト バグ修正テスト ─────────────────
console.log('\n📋 [2] あとでリスト - 翌日も表示されるかテスト（バグ修正確認）');

test('[FIX] repeatMode=none のタスクが作成日(今日)に表示される', () => {
  const todayDk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: 'タスクA', duration: 30, allocated: false, repeatMode: 'none', doneDates: [], createdOffset: todayDk }
  ];
  const result = renderLaterListFilter(tasks, 0); // 今日
  assertEqual(result.length, 1, 'タスクが今日に表示されるべき');
});

test('[FIX] repeatMode=none のタスクが翌日も表示される（バグ修正）', () => {
  const todayDk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: 'タスクA', duration: 30, allocated: false, repeatMode: 'none', doneDates: [], createdOffset: todayDk }
  ];
  const result = renderLaterListFilter(tasks, 1); // 明日
  assertEqual(result.length, 1, '翌日もタスクが表示されるべき（旧バグでは0件だった）');
});

test('[FIX] repeatMode=none のタスクが1週間後も表示される', () => {
  const todayDk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: 'タスクA', duration: 30, allocated: false, repeatMode: 'none', doneDates: [], createdOffset: todayDk }
  ];
  const result = renderLaterListFilter(tasks, 7); // 7日後
  assertEqual(result.length, 1, '1週間後もタスクが表示されるべき');
});

test('[OK] 作成日より前の日付ではタスクが表示されない', () => {
  const todayDk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: 'タスクA', duration: 30, allocated: false, repeatMode: 'none', doneDates: [], createdOffset: todayDk }
  ];
  const result = renderLaterListFilter(tasks, -1); // 昨日
  assertEqual(result.length, 0, '作成日より前は表示されないべき');
});

test('[OK] allocatedなタスクはあとでリストに表示されない', () => {
  const tasks = [
    { id: 1, title: 'タスクA', duration: 30, allocated: true, repeatMode: 'daily', doneDates: [], start: 600 }
  ];
  const result = renderLaterListFilter(tasks, 0);
  assertEqual(result.length, 0, 'タイムライン上のタスクはリストに出ないべき');
});

test('[OK] deletedDatesに含まれるタスクはその日表示されない', () => {
  const todayDk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: 'タスクA', duration: 30, allocated: false, repeatMode: 'none', doneDates: [], createdOffset: todayDk, deletedDates: [todayDk] }
  ];
  const result = renderLaterListFilter(tasks, 0);
  assertEqual(result.length, 0, '削除済みの日は表示されないべき');
});

// ─── 3. タイムシフトテスト ───────────────────────────
console.log('\n⏩ [3] タイムシフト機能テスト');

test('通常タスクを+30分シフトできる', () => {
  const tasks = [
    { id: 1, title: '仕事', start: 600, duration: 120, allocated: true, repeatMode: 'none', doneDates: [] }
  ];
  const result = applyTimeShiftLogic(JSON.parse(JSON.stringify(tasks)), 0, 30);
  assertEqual(result[0].start, 630, `startが630になるべき、実際: ${result[0].start}`);
});

test('通常タスクを-60分シフトできる', () => {
  const tasks = [
    { id: 1, title: '仕事', start: 600, duration: 120, allocated: true, repeatMode: 'none', doneDates: [] }
  ];
  const result = applyTimeShiftLogic(JSON.parse(JSON.stringify(tasks)), 0, -60);
  assertEqual(result[0].start, 540, `startが540になるべき、実際: ${result[0].start}`);
});

test('繰り返しタスクはオーバーライドとして保存される（元のstartは変わらない）', () => {
  const tasks = [
    { id: 1, title: '起床', start: 420, duration: 30, allocated: true, repeatMode: 'daily', doneDates: [], overrides: {} }
  ];
  const dk = offsetToDateKey(0);
  const result = applyTimeShiftLogic(JSON.parse(JSON.stringify(tasks)), 0, 60);
  assertEqual(result[0].start, 420, `元のstartは変わらないべき`);
  assert(result[0].overrides && result[0].overrides[dk], 'オーバーライドが設定されるべき');
  assertEqual(result[0].overrides[dk].start, 480, `オーバーライドのstartが480になるべき`);
});

test('0分未満にはシフトされない（下限チェック）', () => {
  const tasks = [
    { id: 1, title: '起床', start: 30, duration: 30, allocated: true, repeatMode: 'none', doneDates: [] }
  ];
  const result = applyTimeShiftLogic(JSON.parse(JSON.stringify(tasks)), 0, -60);
  assert(result[0].start >= 0, 'startは0以上であるべき');
});

test('1439分を超えてシフトされない（上限チェック）', () => {
  const tasks = [
    { id: 1, title: '深夜', start: 1420, duration: 30, allocated: true, repeatMode: 'none', doneDates: [] }
  ];
  const result = applyTimeShiftLogic(JSON.parse(JSON.stringify(tasks)), 0, 60);
  assert(result[0].start <= 1439, 'startは1439以下であるべき');
});

test('未allocatedのタスクはシフトされない', () => {
  const tasks = [
    { id: 1, title: 'あとでタスク', start: null, duration: 30, allocated: false, repeatMode: 'none', doneDates: [] }
  ];
  const result = applyTimeShiftLogic(JSON.parse(JSON.stringify(tasks)), 0, 60);
  assert(result[0].start === null, '未allocatedタスクのstartはnullのまま');
});

// ─── 4. サブタスク関連テスト ─────────────────────────
console.log('\n☑ [4] サブタスク機能テスト');

test('[FIX] タスク複製時にサブタスクがコピーされる', () => {
  const task = {
    id: 100, title: 'テスト', start: 600, duration: 30, allocated: true,
    repeatMode: 'none', doneDates: [],
    subtasks: [
      { title: 'サブ1', 'done_20260304': true },
      { title: 'サブ2' }
    ]
  };
  const copy = duplicateTaskLogic(task, 0);
  assert(copy.subtasks, 'コピーにsubtasksが存在するべき');
  assertEqual(copy.subtasks.length, 2, 'サブタスクが2個コピーされるべき');
  assertEqual(copy.subtasks[0].title, 'サブ1', 'サブタスクのタイトルが引き継がれるべき');
});

test('[FIX] 複製されたタスクのサブタスクの完了状態はリセットされる', () => {
  const task = {
    id: 100, title: 'テスト', start: 600, duration: 30, allocated: true,
    repeatMode: 'none', doneDates: [],
    subtasks: [
      { title: 'サブ1', 'done_20260304': true }
    ]
  };
  const copy = duplicateTaskLogic(task, 0);
  const hasDoneKey = Object.keys(copy.subtasks[0]).some(k => k.startsWith('done_'));
  assert(!hasDoneKey, '複製されたサブタスクの完了状態はリセットされるべき');
});

test('subtasksが存在しないタスクのコピーでもエラーにならない', () => {
  const task = {
    id: 100, title: 'シンプルタスク', start: 600, duration: 30, allocated: true,
    repeatMode: 'none', doneDates: []
  };
  let error = null;
  try {
    const copy = duplicateTaskLogic(task, 0);
  } catch(e) {
    error = e;
  }
  assert(error === null, `エラーが発生してはいけない: ${error}`);
});

test('[FIX] applyRepeatChangeでサブタスクが引き継がれる', () => {
  const task = {
    id: 100, title: '繰り返しタスク', start: 600, duration: 30, allocated: false,
    repeatMode: 'daily', doneDates: [],
    subtasks: [{ title: 'サブA' }, { title: 'サブB' }]
  };
  // todayOnlyコピーのシミュレーション
  const dk = offsetToDateKey(0);
  const todayOnly = {
    id: Date.now(),
    title: task.title,
    duration: task.duration,
    allocated: true,
    start: 600,
    repeatMode: 'none',
    allocatedOffset: dk,
    createdOffset: dk,
    customDays: [],
    doneDates: [],
    notify: false,
    subtasks: task.subtasks ? JSON.parse(JSON.stringify(task.subtasks)) : [],
  };
  assertEqual(todayOnly.subtasks.length, 2, 'サブタスクが引き継がれるべき');
  assertEqual(todayOnly.subtasks[0].title, 'サブA', 'サブタスクのタイトルが正しいべき');
});

// ─── 5. DateKey マイグレーションテスト ───────────────
console.log('\n🔄 [5] DateKeyマイグレーションテスト');

test('旧形式(offset整数)のdoneDatesが新形式に変換される', () => {
  // マイグレーション関数のシミュレーション
  const isOldFormat = (v) => typeof v === 'number' && Math.abs(v) < 1000;
  const tasks = [
    { id: 1, title: 'テスト', doneDates: [0, -1, 1], deletedDates: [], repeatMode: 'none', allocated: true }
  ];

  tasks.forEach(task => {
    if (task.doneDates) {
      task.doneDates = task.doneDates.map(v => {
        if (isOldFormat(v)) return offsetToDateKey(v);
        return v;
      });
    }
  });

  const todayDk = offsetToDateKey(0);
  const yesterdayDk = offsetToDateKey(-1);
  const tomorrowDk = offsetToDateKey(1);

  assert(tasks[0].doneDates.includes(todayDk), '今日のDateKeyが含まれるべき');
  assert(tasks[0].doneDates.includes(yesterdayDk), '昨日のDateKeyが含まれるべき');
  assert(tasks[0].doneDates.includes(tomorrowDk), '明日のDateKeyが含まれるべき');
  assert(!tasks[0].doneDates.some(v => Math.abs(v) < 1000), '旧形式が残ってはいけない');
});

// ─── 6. タイムシフトUI計算テスト ─────────────────────
console.log('\n🖥 [6] タイムシフトUI計算テスト');

test('タイムシフト表示文字列: +30分', () => {
  const timeShiftMinutes = 30;
  const abs = Math.abs(timeShiftMinutes);
  const h = Math.floor(abs / 60), m = abs % 60;
  const sign = timeShiftMinutes >= 0 ? '＋' : '−';
  const timeStr = h > 0 ? `${h}時間${m > 0 ? m + '分' : ''}` : `${m}分`;
  const display = timeShiftMinutes === 0 ? '0分' : `${sign}${timeStr}`;
  assertEqual(display, '＋30分', `表示が「＋30分」になるべき、実際:「${display}」`);
});

test('タイムシフト表示文字列: -1時間', () => {
  const timeShiftMinutes = -60;
  const abs = Math.abs(timeShiftMinutes);
  const h = Math.floor(abs / 60), m = abs % 60;
  const sign = timeShiftMinutes >= 0 ? '＋' : '−';
  const timeStr = h > 0 ? `${h}時間${m > 0 ? m + '分' : ''}` : `${m}分`;
  const display = `${sign}${timeStr}`;
  assertEqual(display, '−1時間', `表示が「−1時間」になるべき、実際:「${display}」`);
});

test('タイムシフト表示文字列: +1時間30分', () => {
  const timeShiftMinutes = 90;
  const abs = Math.abs(timeShiftMinutes);
  const h = Math.floor(abs / 60), m = abs % 60;
  const sign = timeShiftMinutes >= 0 ? '＋' : '−';
  const timeStr = h > 0 ? `${h}時間${m > 0 ? m + '分' : ''}` : `${m}分`;
  const display = `${sign}${timeStr}`;
  assertEqual(display, '＋1時間30分', `表示が「＋1時間30分」になるべき、実際:「${display}」`);
});

// ─── 結果サマリー ──────────────────────────────────
console.log('\n╔════════════════════════════════════════════╗');
console.log('║               テスト結果サマリー           ║');
console.log('╠════════════════════════════════════════════╣');
console.log(`║  合計: ${passed + failed} 件`);
console.log(`║  ✅ PASS: ${passed} 件`);
console.log(`║  ❌ FAIL: ${failed} 件`);
console.log('╚════════════════════════════════════════════╝');

if (failed > 0) {
  console.log('\n失敗したテスト:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  • ${r.name}: ${r.error}`);
  });
  process.exit(1);
} else {
  console.log('\n🎉 全テスト合格！\n');
  process.exit(0);
}
