// ═══════════════════════════════════════════════════════
//  EJECTOR Cloudflare Worker - データ同期 + Web Push通知
//  KV Bindings: KV (データ), VAPID_PRIVATE_KEY (環境変数)
//  Cron Trigger: */1 * * * * （毎分実行）
// ═══════════════════════════════════════════════════════

const VAPID_PUBLIC_KEY  = 'BKA3ETkb7y1UslBTOCURZKrRZUPSb19xUTZlE60OCJDlNW0CrxB5hdvNkdxaZJ9GHrmhZlr3zkCvk4I6tILjnug';
const VAPID_SUBJECT     = 'mailto:ejector-app@example.com';

// ── CORS ──────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Secret',
};
const cors  = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { ...CORS, ...extra } });
const json  = (obj,  status = 200) =>
  cors(JSON.stringify(obj), status, { 'Content-Type': 'application/json' });

// ── Auth ──────────────────────────────────────────────
async function checkAuth(request, env) {
  const secret = request.headers.get('X-Secret') || '';
  const stored = await env.KV.get('__secret__');
  if (stored && stored !== secret) return false;
  if (!stored && secret) await env.KV.put('__secret__', secret);
  return true;
}

// ═══════════════════════════════════════════════════════
//  FETCH ハンドラ
// ═══════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!await checkAuth(request, env)) return cors('Unauthorized', 401);

    const url = new URL(request.url);
    const path = url.pathname;

    // ── タスクデータ GET/PUT ──────────────────────────
    if (path === '/' || path === '') {
      if (request.method === 'GET') {
        const data = await env.KV.get('ejector_data');
        return cors(data || '{}', 200, { 'Content-Type': 'application/json' });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        await env.KV.put('ejector_data', body);
        return cors('ok');
      }
    }

    // ── Push サブスクリプション登録 POST /subscribe ───
    if (path === '/subscribe' && request.method === 'POST') {
      const sub = await request.json();
      // 既存サブスクリプション一覧を取得
      const existing = JSON.parse(await env.KV.get('push_subscriptions') || '[]');
      // 同じendpointは重複登録しない
      const filtered = existing.filter(s => s.endpoint !== sub.endpoint);
      filtered.push(sub);
      await env.KV.put('push_subscriptions', JSON.stringify(filtered));
      return json({ ok: true });
    }

    // ── Push サブスクリプション削除 DELETE /subscribe ─
    if (path === '/subscribe' && request.method === 'DELETE') {
      const { endpoint } = await request.json();
      const existing = JSON.parse(await env.KV.get('push_subscriptions') || '[]');
      await env.KV.put('push_subscriptions', JSON.stringify(existing.filter(s => s.endpoint !== endpoint)));
      return json({ ok: true });
    }

    // ── VAPID 公開鍵を返す GET /vapid-public-key ──────
    if (path === '/vapid-public-key' && request.method === 'GET') {
      return json({ key: VAPID_PUBLIC_KEY });
    }

    // ═══════════════════════════════════════════════
    //  Notion API プロキシ
    // ═══════════════════════════════════════════════

    // ── Notion DB初期化: POST /notion/init ──────────
    // 指定ページ内にEJECTOR用データベースを作成
    if (path === '/notion/init' && request.method === 'POST') {
      const notionToken = env.NOTION_TOKEN;
      if (!notionToken) return json({ error: 'NOTION_TOKEN not configured in Worker environment' }, 500);
      const { pageId } = await request.json();
      if (!pageId) return json({ error: 'pageId required' }, 400);
      try {
        const db = await notionCreateDatabase(notionToken, pageId);
        return json({ ok: true, databaseId: db.id });
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Notion DBを検索: POST /notion/find-db ───────
    // ページ内の既存EJECTORデータベースを探す
    if (path === '/notion/find-db' && request.method === 'POST') {
      const notionToken = env.NOTION_TOKEN;
      if (!notionToken) return json({ error: 'NOTION_TOKEN not configured in Worker environment' }, 500);
      const { pageId } = await request.json();
      if (!pageId) return json({ error: 'pageId required' }, 400);
      try {
        const dbId = await notionFindDatabase(notionToken, pageId);
        return json({ ok: true, databaseId: dbId });
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Notion全タスク取得: POST /notion/pull ────────
    if (path === '/notion/pull' && request.method === 'POST') {
      const notionToken = env.NOTION_TOKEN;
      if (!notionToken) return json({ error: 'NOTION_TOKEN not configured in Worker environment' }, 500);
      const { databaseId } = await request.json();
      if (!databaseId) return json({ error: 'databaseId required' }, 400);
      try {
        const tasks = await notionPullAllTasks(notionToken, databaseId);
        return json({ ok: true, tasks });
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Notionへタスク同期: POST /notion/push ────────
    if (path === '/notion/push' && request.method === 'POST') {
      const notionToken = env.NOTION_TOKEN;
      if (!notionToken) return json({ error: 'NOTION_TOKEN not configured in Worker environment' }, 500);
      const { databaseId, tasks } = await request.json();
      if (!databaseId || !tasks) return json({ error: 'databaseId and tasks required' }, 400);
      try {
        const result = await notionPushTasks(notionToken, databaseId, tasks);
        return json({ ok: true, ...result });
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    return cors('Not found', 404);
  },

  // ═══════════════════════════════════════════════════
  //  CRON ハンドラ（毎分実行）
  // ═══════════════════════════════════════════════════
  async scheduled(event, env) {
    await checkAndPushNotifications(env);
  }
};

// ═══════════════════════════════════════════════════════
//  通知ロジック
// ═══════════════════════════════════════════════════════
async function checkAndPushNotifications(env) {
  // 現在のJST時刻を取得（分単位）
  const now = new Date();
  const jstOffset = 9 * 60; // JST = UTC+9
  const jstMin = now.getUTCHours() * 60 + now.getUTCMinutes() + jstOffset;
  const todayJstMin = jstMin % (24 * 60); // 0〜1439

  // タスクデータ取得
  const dataRaw = await env.KV.get('ejector_data');
  if (!dataRaw) return;
  const data = JSON.parse(dataRaw);
  if (!data.tasks) return;

  // 今日の日付オフセット = 0（Worker側は常に「今日」のタスクだけチェック）
  const tasksToNotify = data.tasks.filter(task => {
    if (!task.notify) return false;
    if (!task.allocated) return false;
    if (task.deletedDates && task.deletedDates.includes(0)) return false;

    // 繰り返し判定
    const dowJst = new Date(now.getTime() + jstOffset * 60000).getUTCDay();
    if (!isTaskForToday(task, dowJst, jstMin)) return false;

    // 開始時刻が今の分と一致するか
    const taskStart = task.start; // 分単位
    return taskStart === todayJstMin;
  });

  if (tasksToNotify.length === 0) return;

  // 登録済みサブスクリプション取得
  const subsRaw = await env.KV.get('push_subscriptions');
  if (!subsRaw) return;
  const subs = JSON.parse(subsRaw);
  if (subs.length === 0) return;

  // VAPID秘密鍵取得（環境変数から）
  const privateKeyB64 = env.VAPID_PRIVATE_KEY;
  if (!privateKeyB64) { console.error('VAPID_PRIVATE_KEY not set'); return; }

  // 各タスクを各サブスクリプションに送信
  const deadSubs = [];
  for (const task of tasksToNotify) {
    for (const sub of subs) {
      try {
        await sendWebPush(sub, {
          title: `⏰ ${task.title}`,
          body:  '開始時刻になりました',
          icon:  'https://mogmog11.github.io/ejector/icon-192.png',
          badge: 'https://mogmog11.github.io/ejector/icon-192.png',
          tag:   `ejector-${task.id}`,
        }, privateKeyB64);
      } catch(e) {
        // 410 Gone = サブスクリプション無効 → 削除対象
        if (e.status === 410) deadSubs.push(sub.endpoint);
        console.error('Push failed:', e.message);
      }
    }
  }

  // 無効なサブスクリプションを削除
  if (deadSubs.length > 0) {
    const cleaned = subs.filter(s => !deadSubs.includes(s.endpoint));
    await env.KV.put('push_subscriptions', JSON.stringify(cleaned));
  }
}

function isTaskForToday(task, dowJst, jstMin) {
  if (task.repeatMode === 'daily') return true;
  if (task.repeatMode === 'weekday') return dowJst >= 1 && dowJst <= 5;
  if (task.repeatMode === 'weekend') return dowJst === 0 || dowJst === 6;
  if (task.repeatMode === 'custom')  return task.customDays.includes(dowJst);
  if (task.repeatMode === 'none')    return true; // allocatedOffsetチェックはWorker側では省略
  if (task.repeatMode === 'month-end') {
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    return tomorrow.getUTCDate() === 1;
  }
  return false;
}

// ═══════════════════════════════════════════════════════
//  Web Push 送信（VAPID署名付き）
// ═══════════════════════════════════════════════════════
async function sendWebPush(subscription, payload, privateKeyB64) {
  const endpoint  = subscription.endpoint;
  const p256dh    = subscription.keys.p256dh;
  const auth      = subscription.keys.auth;

  // JWTを生成
  const jwt = await buildVapidJwt(endpoint, privateKeyB64);

  // ペイロードを暗号化
  const encrypted = await encryptPayload(JSON.stringify(payload), p256dh, auth);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization':  `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
      'Content-Type':   'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':            '60',
    },
    body: encrypted,
  });

  if (!res.ok && res.status !== 201) {
    const err = new Error(`Push failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
}

// ── VAPID JWT 生成 ──────────────────────────────────
async function buildVapidJwt(endpoint, privateKeyB64) {
  const url      = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const exp      = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud: audience, exp, sub: VAPID_SUBJECT }));
  const unsigned = `${header}.${payload}`;

  // PKCS8形式の秘密鍵をインポート
  const keyBytes  = base64ToBytes(privateKeyB64);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${b64url(sig)}`;
}

// ── ペイロード暗号化（RFC 8291 aes128gcm） ──────────
async function encryptPayload(plaintext, p256dhB64, authB64) {
  const encoder    = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);

  // 受信者の公開鍵（p256dh）
  const receiverPub = await crypto.subtle.importKey(
    'raw', base64ToBytes(p256dhB64),
    { name: 'ECDH', namedCurve: 'P-256' },
    true, []
  );

  // 送信者の鍵ペアを一時生成
  const senderKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true, ['deriveKey', 'deriveBits']
  );
  const senderPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', senderKeys.publicKey));

  // auth secret と salt
  const authBytes = base64ToBytes(authB64);
  const salt      = crypto.getRandomValues(new Uint8Array(16));

  // ECDH共有鍵
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: receiverPub },
    senderKeys.privateKey, 256
  );

  // HKDF で IKM (PRK) を導出
  const ikm = await hkdf(
    new Uint8Array(sharedBits), authBytes,
    concat(encoder.encode('WebPush: info\x00'), receiverPub_raw(await crypto.subtle.exportKey('raw', receiverPub)), senderPubRaw),
    32
  );

  // HKDF で CEK と nonce を導出
  const cek   = await hkdf(ikm, salt, encoder.encode('Content-Encryption-Key\x01'), 16);
  const nonce = await hkdf(ikm, salt, encoder.encode('Nonce\x01'), 12);

  // AES-128-GCM で暗号化
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(0), tagLength: 128 },
    cekKey,
    concat(plaintextBytes, new Uint8Array([2])) // padding delimiter
  ));

  // aes128gcm record: salt(16) + recordSize(4) + keyIdLen(1) + keyId(senderPub 65) + ciphertext
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);

  return concat(salt, recordSize, new Uint8Array([65]), senderPubRaw, ciphertext);
}

function receiverPub_raw(raw) { return new Uint8Array(raw); }

async function hkdf(ikm, salt, info, length) {
  const keyMaterial = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    keyMaterial, length * 8
  );
  return new Uint8Array(bits);
}

function concat(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

function base64ToBytes(b64) {
  const b64std = b64.replace(/-/g,'+').replace(/_/g,'/');
  const bin    = atob(b64std);
  const bytes  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ═══════════════════════════════════════════════════════
//  Notion API ヘルパー
// ═══════════════════════════════════════════════════════
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function notionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// ── ページ内の既存EJECTORデータベースを検索 ──────────
async function notionFindDatabase(token, pageId) {
  // ページの子ブロックを取得してデータベースを探す
  const res = await fetch(`${NOTION_API}/blocks/${pageId}/children?page_size=100`, {
    headers: notionHeaders(token),
  });
  if (!res.ok) throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  for (const block of data.results) {
    if (block.type === 'child_database' && block.child_database.title === 'EJECTOR Tasks') {
      return block.id;
    }
  }
  return null;
}

// ── データベース作成 ──────────────────────────────────
async function notionCreateDatabase(token, pageId) {
  const body = {
    parent: { type: 'page_id', page_id: pageId },
    title: [{ type: 'text', text: { content: 'EJECTOR Tasks' } }],
    properties: {
      'Title':       { title: {} },
      'EjectorId':   { number: {} },
      'Duration':    { number: {} },
      'Start':       { number: {} },
      'Allocated':   { checkbox: {} },
      'RepeatMode':  { select: { options: [
        { name: 'none', color: 'default' },
        { name: 'daily', color: 'blue' },
        { name: 'weekday', color: 'green' },
        { name: 'weekend', color: 'orange' },
        { name: 'custom', color: 'purple' },
        { name: 'month-end', color: 'red' },
      ]}},
      'Priority':    { select: { options: [
        { name: 'high', color: 'red' },
        { name: 'mid', color: 'orange' },
        { name: 'low', color: 'blue' },
      ]}},
      'TaskType':    { select: { options: [
        { name: 'task', color: 'default' },
        { name: 'event', color: 'blue' },
      ]}},
      'Project':     { rich_text: {} },
      'CustomDays':  { rich_text: {} },
      'DoneDates':   { rich_text: {} },
      'DeletedDates':{ rich_text: {} },
      'Overrides':   { rich_text: {} },
      'Notify':      { checkbox: {} },
      'IsWakeUp':    { checkbox: {} },
      'IsSleep':     { checkbox: {} },
      'TodayFlag':   { checkbox: {} },
      'AllocatedOffset': { number: {} },
      'CreatedOffset':   { number: {} },
      'DueDate':     { number: {} },
      'Subtasks':    { rich_text: {} },
      'LastSynced':  { number: {} },
    },
  };
  const res = await fetch(`${NOTION_API}/databases`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion DB create error: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ── Notionからタスクを全件取得 ────────────────────────
async function notionPullAllTasks(token, databaseId) {
  const allPages = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Notion query error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    allPages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return allPages.map(notionPageToTask);
}

// ── Notionページ → EJECTORタスク変換 ─────────────────
function notionPageToTask(page) {
  const p = page.properties;
  const task = {
    id: getNotionNumber(p.EjectorId),
    title: getNotionTitle(p.Title),
    duration: getNotionNumber(p.Duration) || 30,
    start: getNotionNumber(p.Start) || 540,
    allocated: getNotionCheckbox(p.Allocated),
    repeatMode: getNotionSelect(p.RepeatMode) || 'none',
    customDays: parseJsonProp(getNotionRichText(p.CustomDays)) || [],
    doneDates: parseJsonProp(getNotionRichText(p.DoneDates)) || [],
    taskType: getNotionSelect(p.TaskType) || 'task',
    _notionPageId: page.id,
  };
  const deletedDates = parseJsonProp(getNotionRichText(p.DeletedDates));
  if (deletedDates && deletedDates.length > 0) task.deletedDates = deletedDates;
  const overrides = parseJsonProp(getNotionRichText(p.Overrides));
  if (overrides && Object.keys(overrides).length > 0) task.overrides = overrides;
  const project = getNotionRichText(p.Project);
  if (project) task.project = project;
  const priority = getNotionSelect(p.Priority);
  if (priority) task.priority = priority;
  if (getNotionCheckbox(p.Notify)) task.notify = true;
  if (getNotionCheckbox(p.IsWakeUp)) task.isWakeUp = true;
  if (getNotionCheckbox(p.IsSleep)) task.isSleep = true;
  if (getNotionCheckbox(p.TodayFlag)) task.todayFlag = true;
  const allocOff = getNotionNumber(p.AllocatedOffset);
  if (allocOff) task.allocatedOffset = allocOff;
  const creatOff = getNotionNumber(p.CreatedOffset);
  if (creatOff) task.createdOffset = creatOff;
  const dueDate = getNotionNumber(p.DueDate);
  if (dueDate) task.dueDate = dueDate;
  const subtasks = parseJsonProp(getNotionRichText(p.Subtasks));
  if (subtasks && subtasks.length > 0) task.subtasks = subtasks;
  const lastSynced = getNotionNumber(p.LastSynced);
  if (lastSynced) task._notionLastSynced = lastSynced;
  return task;
}

// ── EJECTORタスク → Notionプロパティ変換 ─────────────
function taskToNotionProperties(task) {
  const props = {
    'Title':       { title: [{ text: { content: task.title || '' } }] },
    'EjectorId':   { number: task.id || 0 },
    'Duration':    { number: task.duration || 30 },
    'Start':       { number: task.start || 0 },
    'Allocated':   { checkbox: !!task.allocated },
    'RepeatMode':  { select: { name: task.repeatMode || 'none' } },
    'TaskType':    { select: { name: task.taskType || 'task' } },
    'Notify':      { checkbox: !!task.notify },
    'IsWakeUp':    { checkbox: !!task.isWakeUp },
    'IsSleep':     { checkbox: !!task.isSleep },
    'TodayFlag':   { checkbox: !!task.todayFlag },
    'CustomDays':  { rich_text: [{ text: { content: JSON.stringify(task.customDays || []) } }] },
    'DoneDates':   { rich_text: [{ text: { content: JSON.stringify(task.doneDates || []) } }] },
    'DeletedDates':{ rich_text: [{ text: { content: JSON.stringify(task.deletedDates || []) } }] },
    'Overrides':   { rich_text: [{ text: { content: truncateStr(JSON.stringify(task.overrides || {}), 2000) } }] },
    'Subtasks':    { rich_text: [{ text: { content: truncateStr(JSON.stringify(task.subtasks || []), 2000) } }] },
    'LastSynced':  { number: Date.now() },
  };
  if (task.project) props['Project'] = { rich_text: [{ text: { content: task.project } }] };
  else props['Project'] = { rich_text: [] };
  if (task.priority) props['Priority'] = { select: { name: task.priority } };
  else props['Priority'] = { select: null };
  if (task.allocatedOffset) props['AllocatedOffset'] = { number: task.allocatedOffset };
  else props['AllocatedOffset'] = { number: null };
  if (task.createdOffset) props['CreatedOffset'] = { number: task.createdOffset };
  else props['CreatedOffset'] = { number: null };
  if (task.dueDate) props['DueDate'] = { number: task.dueDate };
  else props['DueDate'] = { number: null };
  return props;
}

function truncateStr(s, max) { return s.length > max ? s.slice(0, max) : s; }

// ── タスク一括同期（双方向マージ） ────────────────────
async function notionPushTasks(token, databaseId, localTasks) {
  // Notion側の現在のタスクを取得
  const remoteTasks = await notionPullAllTasks(token, databaseId);
  const remoteMap = new Map();
  for (const rt of remoteTasks) {
    remoteMap.set(rt.id, rt);
  }

  let created = 0, updated = 0;
  const processedIds = new Set();

  for (const task of localTasks) {
    processedIds.add(task.id);
    const remote = remoteMap.get(task.id);

    if (!remote) {
      // ローカルにあるがNotionにない → 新規作成
      await notionCreatePage(token, databaseId, task);
      created++;
    } else {
      // 両方にある → ローカルをNotionに反映（ローカル優先）
      await notionUpdatePage(token, remote._notionPageId, task);
      updated++;
    }
  }

  // Notionにあるがローカルにない → ローカルには追加しない（pullで取得済み）
  return { created, updated };
}

// ── Notionページ作成 ──────────────────────────────────
async function notionCreatePage(token, databaseId, task) {
  const res = await fetch(`${NOTION_API}/pages`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties: taskToNotionProperties(task),
    }),
  });
  if (!res.ok) throw new Error(`Notion create page error: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ── Notionページ更新 ──────────────────────────────────
async function notionUpdatePage(token, pageId, task) {
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({
      properties: taskToNotionProperties(task),
    }),
  });
  if (!res.ok) throw new Error(`Notion update page error: ${res.status} ${await res.text()}`);
  return await res.json();
}

// ── Notionプロパティ読み取りヘルパー ──────────────────
function getNotionTitle(prop) {
  if (!prop || !prop.title || prop.title.length === 0) return '';
  return prop.title.map(t => t.plain_text).join('');
}
function getNotionNumber(prop) {
  if (!prop || prop.number === null || prop.number === undefined) return null;
  return prop.number;
}
function getNotionCheckbox(prop) {
  if (!prop) return false;
  return !!prop.checkbox;
}
function getNotionSelect(prop) {
  if (!prop || !prop.select) return null;
  return prop.select.name;
}
function getNotionRichText(prop) {
  if (!prop || !prop.rich_text || prop.rich_text.length === 0) return '';
  return prop.rich_text.map(t => t.plain_text).join('');
}
function parseJsonProp(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch(e) { return null; }
}
