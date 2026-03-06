// EJECTOR startNow機能 テストスイート
// Node.js で実行: node test_startnow.js

const _store = {};
const localStorage = {
  getItem: k => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = v; },
  removeItem: k => { delete _store[k]; },
};
global.localStorage = localStorage;

// ─── ユーティリティ（本体と同じロジック） ────────────
function offsetToDateKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function isRepeatMatchDay(task, offset) {
  if (task.repeatMode === 'daily') return true;
  const d = new Date(); d.setDate(d.getDate() + offset);
  const dow = d.getDay();
  if (task.repeatMode === 'weekday') return dow >= 1 && dow <= 5;
  if (task.repeatMode === 'weekend') return dow === 0 || dow === 6;
  if (task.repeatMode === 'custom') return task.customDays.includes(dow);
  return false;
}

// ─── startNow ロジック（ejector.htmlと同一） ─────────
function startNow(tasks, taskId, currentDayOffset = 0) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { tasks, error: 'task not found' };

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dk = offsetToDateKey(currentDayOffset);

  if (task.repeatMode !== 'none') {
    // 繰り返しタスク → 今日のみコピーをタイムラインへ
    const todayCopy = {
      id: Date.now() + 1,
      title: task.title,
      duration: task.duration,
      allocated: true,
      start: nowMin,
      repeatMode: 'none',
      allocatedOffset: dk,
      createdOffset: dk,
      customDays: [],
      doneDates: [],
      notify: task.notify || false,
      scheduled: false,
      subtasks: task.subtasks ? JSON.parse(JSON.stringify(task.subtasks.map(s => ({ title: s.title })))) : [],
    };
    tasks.push(todayCopy);
    return { tasks, addedCopy: todayCopy, nowMin };
  } else {
    // 通常タスク → そのままタイムラインへ
    task.start = nowMin;
    task.allocated = true;
    task.allocatedOffset = dk;
    return { tasks, modified: task, nowMin };
  }
}

// ─── テストスイート ───────────────────────────────────
let passed = 0, failed = 0;
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
function assert(c, msg) { if (!c) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n╔════════════════════════════════════════════╗');
console.log('║   EJECTOR startNow テストスイート         ║');
console.log('╚════════════════════════════════════════════╝\n');

// ── [1] 通常タスク（repeatMode=none）─────────────────
console.log('▶ [1] 通常タスク（repeatMode=none）');

test('通常タスクはallocated=trueになる', () => {
  const tasks = [
    { id: 1, title: '読書', duration: 30, allocated: false, repeatMode: 'none',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(0) }
  ];
  const { tasks: result } = startNow(tasks, 1, 0);
  const t = result.find(x => x.id === 1);
  assert(t.allocated === true, 'allocated=trueになる');
});

test('通常タスクのstartが現在時刻（分）にセットされる', () => {
  const tasks = [
    { id: 1, title: '読書', duration: 30, allocated: false, repeatMode: 'none',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(0) }
  ];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const { modified } = startNow(tasks, 1, 0);
  assertEqual(modified.start, nowMin, '開始時間が現在時刻になる');
});

test('通常タスクのallocatedOffsetが今日のdateKeyにセットされる', () => {
  const tasks = [
    { id: 1, title: '読書', duration: 30, allocated: false, repeatMode: 'none',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(0) }
  ];
  const dk = offsetToDateKey(0);
  const { modified } = startNow(tasks, 1, 0);
  assertEqual(modified.allocatedOffset, dk, 'allocatedOffsetが今日');
});

test('通常タスクは新しいタスクを追加しない（元のタスクを変更）', () => {
  const tasks = [
    { id: 1, title: '読書', duration: 30, allocated: false, repeatMode: 'none',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(0) }
  ];
  const initialLen = tasks.length;
  const { tasks: result } = startNow([...tasks], 1, 0);
  assertEqual(result.length, initialLen, 'タスク数は増えない');
});

test('存在しないtaskIdはエラーを返す', () => {
  const tasks = [];
  const { error } = startNow(tasks, 999, 0);
  assert(error === 'task not found', 'エラーが返る');
});

// ── [2] 繰り返しタスク（repeatMode!=none）────────────
console.log('\n▶ [2] 繰り返しタスク（repeatMode!=none）');

test('繰り返しタスクはオリジナルを変更しない', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const orig = tasks[0];
  startNow(tasks, 1, 0);
  assert(orig.allocated === false, 'オリジナルのallocatedは変わらない');
  assert(orig.start === undefined, 'オリジナルのstartは変わらない');
});

test('繰り返しタスクはコピーが追加される', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const { tasks: result } = startNow(tasks, 1, 0);
  assertEqual(result.length, 2, 'コピーが追加されて2件になる');
});

test('繰り返しタスクのコピーはrepeatMode=none', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.repeatMode, 'none', 'コピーのrepeatMode=none');
});

test('繰り返しタスクのコピーはallocated=true', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assert(addedCopy.allocated === true, 'コピーはallocated=true');
});

test('繰り返しタスクのコピーのstartが現在時刻', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.start, nowMin, 'コピーの開始時間が現在時刻');
});

test('繰り返しタスクのコピーのallocatedOffsetは今日', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const dk = offsetToDateKey(0);
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.allocatedOffset, dk, 'コピーのallocatedOffsetは今日');
});

test('繰り返しタスクのコピーのdoneDatesは空', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [offsetToDateKey(-1)], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.doneDates.length, 0, 'コピーのdoneDatesは空');
});

test('繰り返しタスクのコピーはタイトルが元と同じ', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'weekday',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.title, 'NIKKE', 'タイトルが保持される');
});

test('繰り返しタスクのコピーはdurationが元と同じ', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.duration, 15, 'durationが保持される');
});

// ── [3] サブタスクの扱い ───────────────────────────
console.log('\n▶ [3] サブタスクの扱い');

test('繰り返しタスクのサブタスクはtitleのみコピーされる（完了状態はリセット）', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10),
      subtasks: [
        { title: 'ミッション1', [`done_${dk}`]: true },
        { title: 'ミッション2', [`done_${dk}`]: false },
      ]
    }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assert(addedCopy.subtasks.length === 2, 'サブタスク2件がコピーされる');
  assert(!addedCopy.subtasks[0][`done_${dk}`], '完了状態はリセットされる');
  assertEqual(addedCopy.subtasks[0].title, 'ミッション1', 'タイトルは保持される');
});

test('サブタスクなしのタスクはsubtasksが空配列になる', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assert(Array.isArray(addedCopy.subtasks), 'subtasksが配列');
  assertEqual(addedCopy.subtasks.length, 0, '空配列');
});

// ── [4] エッジケース ───────────────────────────────
console.log('\n▶ [4] エッジケース');

test('既にallocated=trueの通常タスクはstartが更新される', () => {
  const tasks = [
    { id: 1, title: '読書', duration: 30, allocated: true, start: 600,
      repeatMode: 'none', doneDates: [], customDays: [], allocatedOffset: offsetToDateKey(-1) }
  ];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const { modified } = startNow(tasks, 1, 0);
  assertEqual(modified.start, nowMin, '既存タスクのstartが現在時刻に更新される');
});

test('notifyフラグはコピーに引き継がれる', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10), notify: true }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assert(addedCopy.notify === true, 'notifyフラグが引き継がれる');
});

test('コピーのscheduledは常にfalse（固定しない）', () => {
  const tasks = [
    { id: 1, title: 'NIKKE', duration: 15, allocated: false, repeatMode: 'daily',
      doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10), scheduled: true }
  ];
  const { addedCopy } = startNow(tasks, 1, 0);
  assert(addedCopy.scheduled === false, 'コピーのscheduledはfalse');
});

// ── 結果サマリー ─────────────────────────────────────
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
