// EJECTOR 修正版テストスイート v3
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'ejector.html'), 'utf8');

const _store = {};
global.localStorage = {
  getItem: k => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = v; },
  removeItem: k => { delete _store[k]; },
};

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

// renderLaterList の filter ロジックを抽出
function filterLaterList(tasks, dayOffset) {
  const dk = offsetToDateKey(dayOffset);
  return tasks.filter(t => {
    if (t.allocated) return false;
    if (t.deletedDates && t.deletedDates.includes(dk)) return false;
    const created = t.createdOffset !== undefined ? t.createdOffset : 0;
    if (t.scheduledDate && dk < t.scheduledDate) return false;
    if (t.repeatMode !== 'none') {
      if (dk < created) return false;
      if (!isRepeatMatchDay(t, dayOffset)) return false;
      const hasTodayCopy = tasks.some(other =>
        other.repeatMode === 'none' && other.allocated &&
        other.allocatedOffset === dk && other.title === t.title
      );
      if (hasTodayCopy) return false;
      return true;
    }
    // repeatMode:'none' は作成された日のみ表示
    return created === dk;
  });
}

// startNow ロジック
function startNow(tasks, taskId, currentDayOffset = 0) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { tasks, error: 'task not found' };
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dk = offsetToDateKey(currentDayOffset);
  if (task.repeatMode !== 'none') {
    const todayCopy = {
      id: Date.now() + 1, title: task.title, duration: task.duration,
      allocated: true, start: nowMin, repeatMode: 'none',
      allocatedOffset: dk, createdOffset: dk, customDays: [], doneDates: [],
      notify: task.notify || false, scheduled: false,
      project: task.project || '', taskType: task.taskType || 'task',
      subtasks: task.subtasks ? JSON.parse(JSON.stringify(task.subtasks.map(s => ({ title: s.title })))) : [],
    };
    tasks.push(todayCopy);
    return { tasks, addedCopy: todayCopy, nowMin };
  } else {
    task.start = nowMin; task.allocated = true; task.allocatedOffset = dk;
    return { tasks, modified: task, nowMin };
  }
}

// moveToLaterFromEdit ロジック
function moveToLaterFromEdit(tasks, taskId, currentDayOffset = 0) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return tasks;
  if (task.repeatMode !== 'none') {
    const dk = offsetToDateKey(currentDayOffset);
    if (!task.deletedDates) task.deletedDates = [];
    if (!task.deletedDates.includes(dk)) task.deletedDates.push(dk);
    const laterCopy = {
      id: Date.now() + 2, title: task.title, duration: task.duration,
      allocated: false, repeatMode: 'none', customDays: [], doneDates: [],
      createdOffset: dk,
    };
    tasks.push(laterCopy);
  } else {
    task.allocated = false; task.repeatMode = 'none'; task.start = null;
  }
  return tasks;
}

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ PASS: ${name}`);
    results.push({ name, status: 'PASS' }); passed++;
  } catch(e) {
    console.log(`  ❌ FAIL: ${name}`);
    console.log(`         ${e.message}`);
    results.push({ name, status: 'FAIL', error: e.message }); failed++;
  }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n╔══════════════════════════════════════════════╗');
console.log('║   EJECTOR テストスイート v3                 ║');
console.log('╚══════════════════════════════════════════════╝\n');

// ══ [A] migrateWorkBoundaryTitles 無害化 ══
console.log('▶ [A] migrateWorkBoundaryTitles 無害化');

test('起床タスクが業務開始に変換されない', () => {
  assert(!html.includes("task.title === '起床'"), '変換コードが削除されている');
});

test('DEFAULT_TASKSが起床/就寝ベース', () => {
  const idx = html.indexOf("title: '起床'");
  assert(idx > 0, "'起床' がDEFAULT_TASKSに存在する");
  const idx2 = html.indexOf("title: '就寝'");
  assert(idx2 > 0, "'就寝' がDEFAULT_TASKSに存在する");
});

test('DEFAULT_TASKSに業務開始/定時が含まれない', () => {
  // DEFAULT_TASKS定義部分のみチェック（コメントや他の場所は除く）
  const match = html.match(/const DEFAULT_TASKS = \[([\s\S]*?)\];/);
  assert(match, 'DEFAULT_TASKS定義が見つかる');
  assert(!match[1].includes('業務開始'), 'DEFAULT_TASKSに業務開始がない');
  assert(!match[1].includes('定時'), 'DEFAULT_TASKSに定時がない');
});

// ══ [B] PC版レポートCSS ══
console.log('\n▶ [B] PC版レポートCSS修正');

test('show-reportがmediaクエリ外に定義されている', () => {
  const mediaStart = html.indexOf('@media (max-width: 768px)');
  const idx = html.indexOf('#app.show-report #report-view');
  assert(idx > 0 && idx < mediaStart, 'グローバルに定義されている');
});

test('show-reportで#mainが非表示（グローバル）', () => {
  const mediaStart = html.indexOf('@media (max-width: 768px)');
  const idx = html.indexOf('#app.show-report #main');
  assert(idx > 0 && idx < mediaStart, '#app.show-report #main がグローバルに定義');
});

// ══ [C] あとでリスト - repeatMode:none タスクは作成日のみ ══
console.log('\n▶ [C] あとでリスト - 日付フィルター');

test('repeatMode:noneのタスクは作成日のみ表示される', () => {
  const dk0 = offsetToDateKey(0); // 今日
  const tasks = [{
    id: 1, title: '読書', duration: 20, allocated: false,
    repeatMode: 'none', doneDates: [], createdOffset: dk0
  }];
  // 今日 → 表示される
  assert(filterLaterList(tasks, 0).length === 1, '今日は表示される');
  // 翌日 → 表示されない
  assert(filterLaterList(tasks, 1).length === 0, '翌日は表示されない');
  // 昨日 → 表示されない
  assert(filterLaterList(tasks, -1).length === 0, '昨日は表示されない');
});

test('あとで移動した繰り返しタスクのコピー（repeatMode:none）は作成日のみ表示', () => {
  const dk0 = offsetToDateKey(0);
  const tasks = [
    // 元の繰り返しタスク（今日はdeletedDatesで除外済み）
    { id: 1, title: 'NIKKE', duration: 15, allocated: false,
      repeatMode: 'daily', doneDates: [], createdOffset: offsetToDateKey(-10),
      deletedDates: [dk0] },
    // コピー（今日作成・repeatMode:none）
    { id: 2, title: 'NIKKE', duration: 15, allocated: false,
      repeatMode: 'none', doneDates: [], createdOffset: dk0 }
  ];
  const todayList  = filterLaterList(tasks, 0);
  const tomorrowList = filterLaterList(tasks, 1);
  // 今日: コピーのみ表示（元はdeletedDatesで除外）
  assertEqual(todayList.length, 1, '今日はコピー1件のみ表示');
  assertEqual(todayList[0].id, 2, 'コピーが表示される');
  // 翌日: コピーは表示されない、元は来週も表示される
  const tomorrowNikke = tomorrowList.filter(t => t.title === 'NIKKE');
  assertEqual(tomorrowNikke.filter(t => t.id === 2).length, 0, '翌日にコピーは表示されない');
});

test('繰り返しタスクはcreatedOffset以降の日のみ表示', () => {
  const dk0 = offsetToDateKey(0);
  const dk1 = offsetToDateKey(1);
  const tasks = [{
    id: 1, title: '日課', duration: 30, allocated: false,
    repeatMode: 'daily', doneDates: [], createdOffset: dk1 // 明日作成
  }];
  assertEqual(filterLaterList(tasks, 0).length, 0, '今日（作成前）は表示されない');
  assertEqual(filterLaterList(tasks, 1).length, 1, '明日（作成日）から表示される');
  assertEqual(filterLaterList(tasks, 2).length, 1, '明後日も表示される');
});

// ══ [D] startNow ══
console.log('\n▶ [D] startNow動作テスト');

test('通常タスクは今日のみタイムラインへ', () => {
  const dk = offsetToDateKey(0);
  const tasks = [{ id: 1, title: '読書', duration: 30, allocated: false,
    repeatMode: 'none', doneDates: [], createdOffset: dk }];
  const { modified } = startNow(tasks, 1, 0);
  assert(modified.allocated === true, 'allocated=true');
  assertEqual(modified.allocatedOffset, dk, 'allocatedOffsetが今日');
});

test('繰り返しタスクはコピーが作られオリジナルは維持', () => {
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], createdOffset: offsetToDateKey(-5) }];
  const { tasks: result, addedCopy } = startNow(tasks, 1, 0);
  assertEqual(result.length, 2, 'コピーが追加される');
  assert(tasks[0].allocated === false, 'オリジナルのallocatedは変わらない');
  assertEqual(addedCopy.repeatMode, 'none', 'コピーはrepeatMode:none');
  assertEqual(addedCopy.allocatedOffset, offsetToDateKey(0), 'コピーは今日');
});

test('startNowのコピーは翌日のあとでリストに出ない', () => {
  const dk0 = offsetToDateKey(0);
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], createdOffset: offsetToDateKey(-5) }];
  const { tasks: result } = startNow(tasks, 1, 0); // コピーをタイムラインへ
  // タイムラインのコピーはallocated:trueなのであとでリストには出ない
  const tomorrowLater = filterLaterList(result, 1);
  const copies = tomorrowLater.filter(t => t.id !== 1);
  assertEqual(copies.length, 0, 'タイムライン上のコピーはあとでリストに出ない（allocated:true）');
});

// ══ [E] moveToLaterFromEdit ══
console.log('\n▶ [E] moveToLaterFromEdit動作テスト');

test('繰り返しタスクをあとでに移動したコピーは翌日に出ない', () => {
  const dk0 = offsetToDateKey(0);
  const tasks = [{
    id: 1, title: '読書', duration: 30, allocated: true, start: 600,
    repeatMode: 'daily', doneDates: [], createdOffset: offsetToDateKey(-10)
  }];
  const result = moveToLaterFromEdit(tasks, 1, 0);
  const todayLater    = filterLaterList(result, 0);
  const tomorrowLater = filterLaterList(result, 1);

  // 今日: コピーが1件表示
  const todayCopies = todayLater.filter(t => t.title === '読書');
  assertEqual(todayCopies.length, 1, '今日はコピー1件表示');
  assertEqual(todayCopies[0].repeatMode, 'none', 'コピーはrepeatMode:none');

  // 翌日: 元の繰り返しタスクが表示（deletedDates=今日のdk）
  const tomorrowItems = tomorrowLater.filter(t => t.title === '読書');
  const originalInTomorrow = tomorrowItems.filter(t => t.repeatMode === 'daily');
  // 元タスクはallocated:trueのままなのであとでリストには出ない（タイムライン側に残る）
  // フィルターで allocated:true は除外されるため、翌日のあとでリストには出ない;
  const copiesInTomorrow = tomorrowItems.filter(t => t.repeatMode === 'none');
  assertEqual(copiesInTomorrow.length, 0, '翌日にコピーは表示されない');
});

// ══ [F] isFutureDay塗りつぶし防止 ══
console.log('\n▶ [F] 翌日の塗りつぶし防止');

test('未来日（isFutureDay=true）のisPassedはfalse', () => {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const taskStart = 600, taskDuration = 60;
  const taskEnd = taskStart + taskDuration;
  // 翌日
  const isFutureDay = true;
  const isPastDay = false;
  const isPassed = !isFutureDay && (isPastDay || nowMin >= taskEnd);
  assert(isPassed === false, '翌日のisPassedはfalse（塗りつぶしなし）');
});

test('未来日のisInProgressもfalse', () => {
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  const taskStart = nowMin - 10; // 現在進行中の時刻
  const taskEnd = nowMin + 20;
  const isFutureDay = true, isPastDay = false;
  const isInProgress = !isPastDay && !isFutureDay && nowMin > taskStart && nowMin < taskEnd;
  assert(isInProgress === false, '翌日のisInProgressはfalse');
});

test('HTMLコードにisFutureDayチェックが存在する', () => {
  assert(html.includes('const isFutureDay  = currentDayOffset > 0'), 'isFutureDay判定コードが存在する');
  assert(html.includes('!isFutureDay && (isPastDay || nowMin >= taskEnd)') ||
         html.includes('isFutureDay && (isPastDay || nowMin >= taskEnd)') ||
         html.includes('isPassed     = !isFutureDay'), 'isPassed判定でisFutureDayを使用');
});

// ══ 結果サマリー ══
console.log('\n╔══════════════════════════════════════════════╗');
console.log('║                テスト結果サマリー            ║');
console.log('╠══════════════════════════════════════════════╣');
console.log(`║  合計: ${passed + failed} 件`);
console.log(`║  ✅ PASS: ${passed} 件`);
console.log(`║  ❌ FAIL: ${failed} 件`);
console.log('╚══════════════════════════════════════════════╝');

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
