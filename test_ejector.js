// EJECTOR 修正版テストスイート
// 対象: 1. PC版レポートCSS修正  2. startNow機能

const _store = {};
global.localStorage = {
  getItem: k => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = v; },
  removeItem: k => { delete _store[k]; },
};

// ── ユーティリティ ──────────────────────────
function offsetToDateKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// ── startNow ロジック（ejector.htmlと同一） ──
function startNow(tasks, taskId, currentDayOffset = 0) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return { tasks, error: 'task not found' };

  const now    = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dk     = offsetToDateKey(currentDayOffset);

  if (task.repeatMode !== 'none') {
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
      project: task.project || '',
      taskType: task.taskType || 'task',
      subtasks: task.subtasks ? JSON.parse(JSON.stringify(task.subtasks.map(s => ({ title: s.title })))) : [],
    };
    tasks.push(todayCopy);
    return { tasks, addedCopy: todayCopy, nowMin };
  } else {
    task.start = nowMin;
    task.allocated = true;
    task.allocatedOffset = dk;
    return { tasks, modified: task, nowMin };
  }
}

// ── テストフレームワーク ────────────────────
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

console.log('\n╔══════════════════════════════════════════════╗');
console.log('║   EJECTOR 修正版テストスイート v2           ║');
console.log('╚══════════════════════════════════════════════╝\n');

// ══════════════════════════════════════════
// [A] PC版レポートCSS修正の検証
// ══════════════════════════════════════════
console.log('▶ [A] PC版レポートCSS修正の検証');
const fs = require('fs');
const html = fs.readFileSync('/home/claude/ejector.html', 'utf8');

test('show-reportのCSSがmediaクエリ外に存在する', () => {
  // @media (max-width: 768px) より前に #app.show-report #report-view があるか
  const mediaStart = html.indexOf('@media (max-width: 768px)');
  const showReportGlobal = html.indexOf('#app.show-report #report-view');
  assert(showReportGlobal > 0, '#app.show-report #report-view が存在する');
  assert(showReportGlobal < mediaStart, 'mediaクエリより前（グローバル）に定義されている');
});

test('show-reportで#mainが非表示になるCSSがある（グローバル）', () => {
  const mediaStart = html.indexOf('@media (max-width: 768px)');
  const idx = html.indexOf('#app.show-report #main');
  assert(idx > 0 && idx < mediaStart, '#app.show-report #main がグローバルに定義されている');
});

test('show-reportで#rpanelがフル幅になるCSSがある（グローバル）', () => {
  const mediaStart = html.indexOf('@media (max-width: 768px)');
  const idx = html.indexOf('#app.show-report #rpanel');
  assert(idx > 0 && idx < mediaStart, '#app.show-report #rpanel がグローバルに定義されている');
});

test('show-reportで#later-viewが非表示になるCSSがある（グローバル）', () => {
  const mediaStart = html.indexOf('@media (max-width: 768px)');
  const idx = html.indexOf('#app.show-report #later-view');
  assert(idx > 0 && idx < mediaStart, '#app.show-report #later-view がグローバルに定義されている');
});

// ══════════════════════════════════════════
// [B] startNow関数の存在検証
// ══════════════════════════════════════════
console.log('\n▶ [B] startNow関数の検証');

test('startNow関数がejector.htmlに定義されている', () => {
  assert(html.includes('function startNow('), 'startNow関数が存在する');
});

test('あとでリストカードに今すぐボタンのHTMLがある', () => {
  assert(html.includes('startNow(${t.id})'), 'カードHTMLにstartNow呼び出しがある');
  assert(html.includes('▶ 今すぐ'), 'ボタンラベルが存在する');
});

// ══════════════════════════════════════════
// [C] startNow動作テスト（通常タスク）
// ══════════════════════════════════════════
console.log('\n▶ [C] startNow動作テスト（通常タスク）');

test('通常タスクがallocated=trueになる', () => {
  const tasks = [{ id: 1, title: '読書', duration: 30, allocated: false,
    repeatMode: 'none', doneDates: [], customDays: [], createdOffset: offsetToDateKey(0) }];
  const { tasks: result } = startNow(tasks, 1, 0);
  assert(result.find(t => t.id === 1).allocated === true, 'allocated=trueになる');
});

test('通常タスクのstartが現在時刻（分）にセットされる', () => {
  const tasks = [{ id: 1, title: '読書', duration: 30, allocated: false,
    repeatMode: 'none', doneDates: [], customDays: [], createdOffset: offsetToDateKey(0) }];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const { modified } = startNow(tasks, 1, 0);
  assertEqual(modified.start, nowMin, '開始時間が現在時刻になる');
});

test('通常タスクのallocatedOffsetが今日のdateKeyになる', () => {
  const tasks = [{ id: 1, title: '読書', duration: 30, allocated: false,
    repeatMode: 'none', doneDates: [], customDays: [], createdOffset: offsetToDateKey(0) }];
  const { modified } = startNow(tasks, 1, 0);
  assertEqual(modified.allocatedOffset, offsetToDateKey(0), '今日のdateKey');
});

test('通常タスクはタスク数が増えない', () => {
  const tasks = [{ id: 1, title: '読書', duration: 30, allocated: false,
    repeatMode: 'none', doneDates: [], customDays: [], createdOffset: offsetToDateKey(0) }];
  const { tasks: result } = startNow([...tasks], 1, 0);
  assertEqual(result.length, 1, 'タスク数は1のまま');
});

test('存在しないIDはerrorを返す', () => {
  const { error } = startNow([], 999, 0);
  assertEqual(error, 'task not found', 'エラーが返る');
});

// ══════════════════════════════════════════
// [D] startNow動作テスト（繰り返しタスク）
// ══════════════════════════════════════════
console.log('\n▶ [D] startNow動作テスト（繰り返しタスク）');

test('繰り返しタスクはオリジナルを変更しない', () => {
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }];
  startNow(tasks, 1, 0);
  assert(tasks[0].allocated === false, 'オリジナルのallocatedは変わらない');
  assert(tasks[0].start === undefined, 'オリジナルのstartは変わらない');
});

test('繰り返しタスクはコピーが追加される', () => {
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }];
  const { tasks: result } = startNow(tasks, 1, 0);
  assertEqual(result.length, 2, 'コピーが追加されて2件になる');
});

test('繰り返しタスクのコピーはrepeatMode=none', () => {
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }];
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.repeatMode, 'none', 'コピーのrepeatMode=none');
});

test('繰り返しタスクのコピーのstartが現在時刻', () => {
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10) }];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.start, nowMin, 'コピーの開始時間が現在時刻');
});

test('繰り返しタスクのコピーのdoneDatesは空', () => {
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [offsetToDateKey(-1)], customDays: [],
    createdOffset: offsetToDateKey(-10) }];
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.doneDates.length, 0, 'コピーのdoneDatesは空');
});

test('繰り返しタスクのコピーのscheduledはfalse', () => {
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], customDays: [], scheduled: true,
    createdOffset: offsetToDateKey(-10) }];
  const { addedCopy } = startNow(tasks, 1, 0);
  assert(addedCopy.scheduled === false, 'コピーのscheduledはfalse');
});

test('projectフィールドがコピーに引き継がれる', () => {
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], customDays: [], project: '開発',
    createdOffset: offsetToDateKey(-10) }];
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.project, '開発', 'projectが引き継がれる');
});

test('サブタスクはtitleのみコピーされ完了状態はリセット', () => {
  const dk = offsetToDateKey(0);
  const tasks = [{ id: 1, title: 'NIKKE', duration: 15, allocated: false,
    repeatMode: 'daily', doneDates: [], customDays: [], createdOffset: offsetToDateKey(-10),
    subtasks: [{ title: 'ミッション1', [`done_${dk}`]: true }] }];
  const { addedCopy } = startNow(tasks, 1, 0);
  assertEqual(addedCopy.subtasks[0].title, 'ミッション1', 'タイトル保持');
  assert(!addedCopy.subtasks[0][`done_${dk}`], '完了状態はリセット');
});

// ══════════════════════════════════════════
// 結果サマリー
// ══════════════════════════════════════════
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
