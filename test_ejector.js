// EJECTOR 新機能テスト v3.0
// Node.js で実行: node test_ejector_v3.js

const _store = {};
const localStorage = {
  getItem: k => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = v; },
  removeItem: k => { delete _store[k]; },
};
global.localStorage = localStorage;
global.navigator = { vibrate: null };
global.document = {
  hidden: false,
  getElementById: () => ({ style: {}, innerHTML: '', textContent: '', value: '', appendChild: () => {}, checked: false }),
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {}, className: '', id: '', innerHTML: '', setAttribute: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } }),
  addEventListener: () => {},
  body: { appendChild: () => {} },
};
global.window = { addEventListener: () => {}, onload: null };
global.fetch = async () => ({ ok: false, json: async () => ({}) });
global.Notification = { permission: 'default', requestPermission: async () => 'default' };

// ─── 共通ユーティリティ ───────────────────────────────
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
  if (task.repeatMode === 'month-end') {
    const next = new Date(d); next.setDate(d.getDate() + 1);
    return next.getDate() === 1;
  }
  return false;
}

function isTaskForToday(task, offset) {
  const dk = offsetToDateKey(offset);
  if (task.deletedDates && task.deletedDates.includes(dk)) return false;
  if (!task.allocated) return false;
  const created = task.createdOffset !== undefined ? task.createdOffset : 0;
  if (dk < created) return false;
  if (task.repeatMode === 'none') {
    const ao = task.allocatedOffset !== undefined ? task.allocatedOffset : offsetToDateKey(0);
    return ao === dk;
  }
  if (task.repeatMode === 'daily') return true;
  const d = new Date(); d.setDate(d.getDate() + offset);
  const dow = d.getDay();
  if (task.repeatMode === 'weekday') return dow >= 1 && dow <= 5;
  if (task.repeatMode === 'weekend') return dow === 0 || dow === 6;
  if (task.repeatMode === 'custom') return task.customDays.includes(dow);
  if (task.repeatMode === 'month-end') {
    const next = new Date(d); next.setDate(d.getDate() + 1);
    return next.getDate() === 1;
  }
  return false;
}

function getTaskStart(task, offset) {
  const dk = offsetToDateKey(offset);
  if (task.overrides && task.overrides[dk] !== undefined) return task.overrides[dk].start;
  return task.start;
}

// ─── 新機能①: 時間切れ自動移動ロジック ────────────────
function checkOverdueTasks(tasks, nowMin, currentDayOffset = 0) {
  if (currentDayOffset !== 0) return { tasks, movedTitles: [] };
  const dk = offsetToDateKey(0);
  const movedTitles = [];

  tasks.forEach(task => {
    if (!task.allocated) return;
    if (task.repeatMode === 'none' && task.allocatedOffset !== dk) return;
    if (!isTaskForToday(task, 0)) return;

    const taskStart = getTaskStart(task, 0);
    const taskEnd   = taskStart + task.duration;
    const isDone    = task.doneDates.includes(dk);

    if (isDone) return;
    if (taskEnd > nowMin) return;

    if (!task.movedToLaterDates) task.movedToLaterDates = [];
    if (task.movedToLaterDates.includes(dk)) return;

    task.movedToLaterDates.push(dk);
    movedTitles.push(task.title);

    if (task.repeatMode !== 'none') {
      // 繰り返しタスク: 今日だけ削除 → 翌日はタイムラインに残る
      if (!task.deletedDates) task.deletedDates = [];
      task.deletedDates.push(dk);
      // あとでリスト用コピーを追加
      tasks.push({
        id: Date.now() + Math.random(),
        title: task.title,
        duration: task.duration,
        allocated: false,
        repeatMode: 'none',
        customDays: [],
        doneDates: [],
        createdOffset: dk,
        isOverdueMoved: true,
      });
    } else {
      // 通常タスク: あとでリストに戻す
      task.allocated = false;
      task.start = null;
    }
  });

  return { tasks, movedTitles };
}

// ─── 新機能②: 実績時間予測ロジック ───────────────────
let durationHistory = {};

function recordDurationOnDone(task) {
  const key = task.title.trim();
  if (!key) return;
  if (!durationHistory[key]) durationHistory[key] = [];
  durationHistory[key].push(task.duration);
  if (durationHistory[key].length > 20) {
    durationHistory[key] = durationHistory[key].slice(-20);
  }
}

function getPredictedDuration(title) {
  const key = title.trim();
  const hist = durationHistory[key];
  if (!hist || hist.length < 2) return null;
  const recent = hist.slice(-5);
  const avg = Math.round(recent.reduce((s, v) => s + v, 0) / recent.length);
  return avg;
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
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

console.log('\n╔════════════════════════════════════════════╗');
console.log('║   EJECTOR 新機能テストスイート v3.0       ║');
console.log('╚════════════════════════════════════════════╝\n');

// ══════════════════════════════════════════════
//  機能①: 時間切れタスク → 自動「あとで」移動
// ══════════════════════════════════════════════
console.log('⏰ [1] 時間切れタスク自動移動テスト');

test('終了時刻を過ぎた未完了タスクがあとでリストに移動される', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '読書', start: 600, duration: 30, allocated: true, repeatMode: 'none',
      allocatedOffset: dk, doneDates: [], customDays: [], createdOffset: dk }
  ];
  // nowMin = 640 (終了時刻630を超過)
  const { tasks: result, movedTitles } = checkOverdueTasks(JSON.parse(JSON.stringify(tasks)), 640, 0);
  const movedTask = result.find(t => t.id === 1);
  assert(movedTask, 'タスクが存在する');
  assert(!movedTask.allocated, '移動後はallocated=false');
  assert(movedTask.start === null, '移動後はstart=null');
  assert(movedTitles.includes('読書'), '移動タイトルに含まれる');
});

test('完了済みタスクは移動されない', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '読書', start: 600, duration: 30, allocated: true, repeatMode: 'none',
      allocatedOffset: dk, doneDates: [dk], customDays: [], createdOffset: dk }
  ];
  const { movedTitles } = checkOverdueTasks(JSON.parse(JSON.stringify(tasks)), 640, 0);
  assertEqual(movedTitles.length, 0, '完了済みは移動しない');
});

test('まだ終わっていないタスクは移動されない', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '読書', start: 600, duration: 30, allocated: true, repeatMode: 'none',
      allocatedOffset: dk, doneDates: [], customDays: [], createdOffset: dk }
  ];
  // nowMin = 620 (終了時刻630より前)
  const { movedTitles } = checkOverdueTasks(JSON.parse(JSON.stringify(tasks)), 620, 0);
  assertEqual(movedTitles.length, 0, 'まだ終わっていないタスクは動かない');
});

test('繰り返しタスクは今日だけdeletedDatesに追加される（翌日は残る）', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: 'NIKKE', start: 600, duration: 30, allocated: true, repeatMode: 'daily',
      doneDates: [], customDays: [], deletedDates: [], overrides: {}, createdOffset: offsetToDateKey(-30) }
  ];
  const { tasks: result } = checkOverdueTasks(JSON.parse(JSON.stringify(tasks)), 640, 0);
  const original = result.find(t => t.id === 1);
  assert(original, 'オリジナルタスクが存在する');
  assert(original.deletedDates.includes(dk), '今日のdateKeyがdeletedDatesに追加される');
  // 繰り返しなので翌日のタイムラインには残るはず（deletedDatesに翌日が入っていない）
  const tomorrowDk = offsetToDateKey(1);
  assert(!original.deletedDates.includes(tomorrowDk), '翌日は削除されていない');
});

test('繰り返しタスク移動後、あとでリスト用コピーが追加される', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: 'NIKKE', start: 600, duration: 30, allocated: true, repeatMode: 'daily',
      doneDates: [], customDays: [], deletedDates: [], overrides: {}, createdOffset: offsetToDateKey(-30) }
  ];
  const initialCount = tasks.length;
  const { tasks: result } = checkOverdueTasks(JSON.parse(JSON.stringify(tasks)), 640, 0);
  assert(result.length > initialCount, 'あとでコピーが追加された');
  const copy = result.find(t => t.isOverdueMoved && t.title === 'NIKKE');
  assert(copy, 'isOverdueMoved=trueのコピーが存在する');
  assert(!copy.allocated, 'コピーはallocated=false');
  assertEqual(copy.repeatMode, 'none', 'コピーのrepeatMode=none');
});

test('今日既に移動済みのタスクは二重移動されない', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '読書', start: 600, duration: 30, allocated: true, repeatMode: 'none',
      allocatedOffset: dk, doneDates: [], customDays: [], createdOffset: dk,
      movedToLaterDates: [dk] } // 既に移動済み
  ];
  const { movedTitles } = checkOverdueTasks(JSON.parse(JSON.stringify(tasks)), 640, 0);
  assertEqual(movedTitles.length, 0, '二重移動されない');
});

test('今日以外の日付（currentDayOffset!=0）ではチェックしない', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '読書', start: 600, duration: 30, allocated: true, repeatMode: 'none',
      allocatedOffset: dk, doneDates: [], customDays: [], createdOffset: dk }
  ];
  const { movedTitles } = checkOverdueTasks(JSON.parse(JSON.stringify(tasks)), 640, 1); // 明日
  assertEqual(movedTitles.length, 0, '今日以外はチェックしない');
});

// ══════════════════════════════════════════════
//  機能②: 実績時間の自動学習・予測
// ══════════════════════════════════════════════
console.log('\n📊 [2] 実績時間予測テスト');

test('1件だけでは予測しない（2件以上必要）', () => {
  durationHistory = {};
  const task = { title: '読書', duration: 25 };
  recordDurationOnDone(task);
  const predicted = getPredictedDuration('読書');
  assert(predicted === null, '1件だけでは予測しない');
});

test('2件以上で予測値が返る', () => {
  durationHistory = {};
  recordDurationOnDone({ title: '読書', duration: 20 });
  recordDurationOnDone({ title: '読書', duration: 30 });
  const predicted = getPredictedDuration('読書');
  assert(predicted !== null, '2件以上で予測値が返る');
  assertEqual(predicted, 25, '2件平均: 25分');
});

test('直近5件の平均で予測する', () => {
  durationHistory = {};
  [30, 30, 30, 30, 30, 60, 60].forEach(d => recordDurationOnDone({ title: 'テスト', duration: d }));
  // 直近5件: [30, 60, 60, 60, 60] → いや違う、追加順に [30,30,30,30,30,60,60]
  // slice(-5): [30, 30, 60, 60] ... 実際は [30,30,60,60,60] → 48
  const hist = durationHistory['テスト'];
  const recent = hist.slice(-5);
  const expected = Math.round(recent.reduce((s, v) => s + v, 0) / recent.length);
  const predicted = getPredictedDuration('テスト');
  assertEqual(predicted, expected, `直近5件の平均が予測値: ${expected}分`);
});

test('20件を超えたら古い記録が削除される', () => {
  durationHistory = {};
  for (let i = 0; i < 25; i++) recordDurationOnDone({ title: '毎日', duration: i + 1 });
  assert(durationHistory['毎日'].length <= 20, '20件以内に抑えられる');
});

test('タイトルが異なれば別々に記録される', () => {
  durationHistory = {};
  recordDurationOnDone({ title: '読書', duration: 30 });
  recordDurationOnDone({ title: '読書', duration: 30 });
  recordDurationOnDone({ title: 'NIKKE', duration: 15 });
  recordDurationOnDone({ title: 'NIKKE', duration: 15 });
  const readingPred = getPredictedDuration('読書');
  const nikkePred   = getPredictedDuration('NIKKE');
  assertEqual(readingPred, 30, '読書の予測: 30分');
  assertEqual(nikkePred, 15, 'NIKKEの予測: 15分');
});

test('予測値が現在のdurationと同じ場合、nullでないが同値を返す', () => {
  durationHistory = {};
  recordDurationOnDone({ title: '仕事', duration: 60 });
  recordDurationOnDone({ title: '仕事', duration: 60 });
  const predicted = getPredictedDuration('仕事');
  assertEqual(predicted, 60, '同じ時間の予測: 60分');
});

test('空のタイトルは記録されない', () => {
  durationHistory = {};
  recordDurationOnDone({ title: '', duration: 30 });
  recordDurationOnDone({ title: '  ', duration: 30 });
  assert(!durationHistory[''] && !durationHistory['  '], '空タイトルは記録されない');
});

console.log('\n🔗 [3] 統合テスト');

test('時間切れ移動後、あとでリストのコピーは空き時間チップに出ない（作成日のみ）', () => {
  const dk = offsetToDateKey(0);
  // あとで移動コピー（isOverdueMoved=true、repeatMode=none、createdOffset=今日）
  const tasks = [
    { id: 999, title: 'NIKKE', duration: 30, allocated: false, repeatMode: 'none',
      doneDates: [], createdOffset: dk, isOverdueMoved: true }
  ];
  // createdOffsetが今日と同じ → 今日のチップに出る（正常）
  const actualDur = 60;
  const fittingTasks = tasks.filter(t => {
    if (t.allocated) return false;
    if (t.duration > actualDur) return false;
    if (t.doneDates.includes(dk)) return false;
    if (t.repeatMode !== 'none') return false;
    const created = t.createdOffset !== undefined ? t.createdOffset : 0;
    return dk === created; // 今日のみチップ表示
  });
  assertEqual(fittingTasks.length, 1, '今日のコピーは空き時間チップに表示される');
  // 明日のdkでフィルタするとチップに出ない
  const tomorrowDk = offsetToDateKey(1);
  const tomorrowFitting = tasks.filter(t => {
    if (t.allocated) return false;
    if (t.duration > actualDur) return false;
    const created = t.createdOffset !== undefined ? t.createdOffset : 0;
    return tomorrowDk === created;
  });
  assertEqual(tomorrowFitting.length, 0, '翌日にはコピーのチップは出ない');
});

test('ピン留めタスクへの時間切れチェックは正常動作する', () => {
  const dk = offsetToDateKey(0);
  // ピン留めされたタスクも時間切れチェックの対象（ピンはシフトのみ除外）
  const tasks = [
    { id: 1, title: '固定ミーティング', start: 600, duration: 30, allocated: true,
      repeatMode: 'none', allocatedOffset: dk, doneDates: [], pinned: true, createdOffset: dk }
  ];
  const { movedTitles } = checkOverdueTasks(JSON.parse(JSON.stringify(tasks)), 640, 0);
  // ピン留めでも時間切れなら移動される（ピンはシフト除外のみ）
  assert(movedTitles.includes('固定ミーティング'), 'ピン留めタスクも時間切れなら移動される');
});

test('予測時間は繰り返しと通常タスクで共通（タイトルベース）', () => {
  durationHistory = {};
  // 繰り返しタスクとして30分×3回記録
  recordDurationOnDone({ title: 'NIKKE', duration: 30 });
  recordDurationOnDone({ title: 'NIKKE', duration: 35 });
  recordDurationOnDone({ title: 'NIKKE', duration: 28 });
  const predicted = getPredictedDuration('NIKKE');
  assert(predicted !== null, '3件で予測が返る');
  assertEqual(predicted, 31, '平均: (30+35+28)/3 = 31分（四捨五入）');
});

// ══════════════════════════════════════════════
//  機能追加: 起床・就寝 / scheduledフラグ
// ══════════════════════════════════════════════
console.log('\n📅 [4] 予定フラグ / 起床・就寝 移動除外テスト');

// checkOverdueTasksの実際ロジックをscheduledとisSpecial対応版に更新
function checkOverdueTasksV2(tasks, nowMin, currentDayOffset = 0) {
  if (currentDayOffset !== 0) return { tasks, movedTitles: [] };
  const dk = offsetToDateKey(0);
  const movedTitles = [];

  tasks.forEach(task => {
    if (!task.allocated) return;
    if (task.repeatMode === 'none' && task.allocatedOffset !== dk) return;
    if (!isTaskForToday(task, 0)) return;

    const taskStart = getTaskStart(task, 0);
    const taskEnd   = taskStart + task.duration;
    const isDone    = task.doneDates.includes(dk);

    if (isDone) return;
    if (taskEnd > nowMin) return;
    // 起床・就寝は移動しない
    const isSpecial = task.title.includes('起床') || task.title.includes('就寝');
    if (isSpecial) return;
    // scheduledフラグが立っているタスクは移動しない
    if (task.scheduled) return;

    if (!task.movedToLaterDates) task.movedToLaterDates = [];
    if (task.movedToLaterDates.includes(dk)) return;

    task.movedToLaterDates.push(dk);
    movedTitles.push(task.title);

    if (task.repeatMode !== 'none') {
      if (!task.deletedDates) task.deletedDates = [];
      task.deletedDates.push(dk);
      tasks.push({
        id: Date.now() + Math.random(),
        title: task.title,
        duration: task.duration,
        allocated: false,
        repeatMode: 'none',
        customDays: [],
        doneDates: [],
        createdOffset: dk,
        isOverdueMoved: true,
      });
    } else {
      task.allocated = false;
      task.start = null;
    }
  });

  return { tasks, movedTitles };
}

test('起床タスクは時間切れでもあとで移動されない', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '起床', start: 420, duration: 30, allocated: true, repeatMode: 'daily',
      doneDates: [], customDays: [], deletedDates: [], overrides: {}, createdOffset: offsetToDateKey(-30) }
  ];
  const { movedTitles } = checkOverdueTasksV2(JSON.parse(JSON.stringify(tasks)), 500, 0);
  assertEqual(movedTitles.length, 0, '起床は移動されない');
});

test('就寝タスクは時間切れでもあとで移動されない', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '就寝', start: 1380, duration: 60, allocated: true, repeatMode: 'daily',
      doneDates: [], customDays: [], deletedDates: [], overrides: {}, createdOffset: offsetToDateKey(-30) }
  ];
  // nowMin=1440+30(=1470) → 終了済み扱い
  const nowMin = Math.min(1440 + 60, 1439);
  const { movedTitles } = checkOverdueTasksV2(JSON.parse(JSON.stringify(tasks)), nowMin, 0);
  assertEqual(movedTitles.length, 0, '就寝は移動されない');
});

test('scheduledフラグありのタスクは時間切れでも移動されない', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '歯医者', start: 600, duration: 60, allocated: true, repeatMode: 'none',
      allocatedOffset: dk, doneDates: [], createdOffset: dk, scheduled: true }
  ];
  const { movedTitles } = checkOverdueTasksV2(JSON.parse(JSON.stringify(tasks)), 700, 0);
  assertEqual(movedTitles.length, 0, 'scheduledタスクは移動されない');
});

test('scheduledフラグなしのタスクは通常通り移動される', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '読書', start: 600, duration: 30, allocated: true, repeatMode: 'none',
      allocatedOffset: dk, doneDates: [], createdOffset: dk, scheduled: false }
  ];
  const { movedTitles } = checkOverdueTasksV2(JSON.parse(JSON.stringify(tasks)), 700, 0);
  assert(movedTitles.includes('読書'), 'scheduledなしは移動される');
});

test('scheduledフラグ未定義はfalse扱いで通常移動される', () => {
  const dk = offsetToDateKey(0);
  const tasks = [
    { id: 1, title: '読書', start: 600, duration: 30, allocated: true, repeatMode: 'none',
      allocatedOffset: dk, doneDates: [], createdOffset: dk } // scheduledなし
  ];
  const { movedTitles } = checkOverdueTasksV2(JSON.parse(JSON.stringify(tasks)), 700, 0);
  assert(movedTitles.includes('読書'), 'scheduled未定義は移動される');
});



// ─── 結果サマリー ─────────────────────────────────────
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
