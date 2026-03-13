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
  'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, DELETE, OPTIONS',
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

    // ── Notion重複タスク削除: POST /notion/dedup ─────
    if (path === '/notion/dedup' && request.method === 'POST') {
      const notionToken = env.NOTION_TOKEN;
      if (!notionToken) return json({ error: 'NOTION_TOKEN not configured in Worker environment' }, 500);
      const { databaseId } = await request.json();
      if (!databaseId) return json({ error: 'databaseId required' }, 400);
      try {
        const result = await notionDedupTasks(notionToken, databaseId);
        return json({ ok: true, ...result });
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Notion単一タスク更新: PATCH /notion/update ───
    // タスク完了時などにNotionへ書き戻す
    if (path === '/notion/update' && request.method === 'PATCH') {
      const notionToken = env.NOTION_TOKEN;
      if (!notionToken) return json({ error: 'NOTION_TOKEN not configured in Worker environment' }, 500);
      const { pageId, properties } = await request.json();
      if (!pageId || !properties) return json({ error: 'pageId and properties required' }, 400);
      try {
        const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
          method: 'PATCH',
          headers: notionHeaders(notionToken),
          body: JSON.stringify({ properties }),
        });
        if (!res.ok) throw new Error(`Notion update error: ${res.status} ${await res.text()}`);
        return json({ ok: true });
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
//  Notion API ヘルパー
// ═══════════════════════════════════════════════════════
const NOTION_API = 'https://api.notion.com/v1';

function notionHeaders(token) {
  return {
    'Authorization':  `Bearer ${token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };
}

/** 提供されたIDをDBとして直接確認、なければページ子ブロックから "EJECTOR Tasks" DBを探す */
async function notionFindDatabase(token, pageId) {
  // まずIDをデータベースとして直接取得を試みる（ユーザーがDB IDを直接入力した場合）
  const dbRes = await fetch(`${NOTION_API}/databases/${pageId}`, {
    headers: notionHeaders(token),
  });
  if (dbRes.ok) return pageId; // 既存DBをそのまま使用

  // データベースでなければ、ページの子ブロックから "EJECTOR Tasks" を検索
  const res = await fetch(`${NOTION_API}/blocks/${pageId}/children`, {
    headers: notionHeaders(token),
  });
  if (!res.ok) throw new Error(`Notion error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  for (const block of data.results || []) {
    if (block.type === 'child_database' && block.child_database?.title === 'EJECTOR Tasks') {
      return block.id;
    }
  }
  return null;
}

/** "EJECTOR Tasks" データベースを新規作成する */
async function notionCreateDatabase(token, pageId) {
  const res = await fetch(`${NOTION_API}/databases`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { type: 'page_id', page_id: pageId },
      title: [{ type: 'text', text: { content: 'EJECTOR Tasks' } }],
      properties: {
        'Name':      { title: {} },
        'Date':      { date: {} },
        'Start':     { number: { format: 'number' } },
        'Duration':  { number: { format: 'number' } },
        'Done':      { checkbox: {} },
        'DoneDates': { rich_text: {} },
        'Category':  { select: {} },
        'Memo':      { rich_text: {} },
      },
    }),
  });
  if (!res.ok) throw new Error(`Notion create DB error ${res.status}: ${await res.text()}`);
  return await res.json();
}

/** データベースの「今日」のタスクを取得してEJECTOR形式に変換する */
async function notionPullAllTasks(token, databaseId) {
  const tasks = [];
  let cursor;

  // 今日の日付をJST（UTC+9）で取得
  const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const today  = jstNow.toISOString().slice(0, 10); // YYYY-MM-DD

  do {
    const body = {
      page_size: 100,
      filter: { property: '実行予定日', date: { equals: today } },
    };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Notion query error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const page of data.results || []) {
      const p = page.properties || {};

      // タイトルプロパティを動的に検出
      let name = '';
      for (const val of Object.values(p)) {
        if (val.type === 'title') { name = (val.title || []).map(t => t.plain_text).join(''); break; }
      }
      if (!name) continue;

      // 開始時刻をパース（date / rich_text / formula の各型に対応）
      let start = null;
      const startProp = p['開始時刻'];
      if (startProp) {
        let timeStr = '';
        if (startProp.type === 'date')       timeStr = startProp.date?.start || '';
        else if (startProp.type === 'rich_text')  timeStr = (startProp.rich_text || []).map(t => t.plain_text).join('');
        else if (startProp.type === 'formula') timeStr = startProp.formula?.string || '';
        const m = timeStr.match(/(\d{1,2}):(\d{2})/);
        if (m) start = parseInt(m[1]) * 60 + parseInt(m[2]);
      }

      // 終了時刻をパースして duration を計算（date 型）
      let duration = p['予定時間（分）']?.number || 30;
      const endProp = p['終了時刻'];
      if (endProp?.type === 'date' && endProp.date?.start) {
        const m = endProp.date.start.match(/(\d{1,2}):(\d{2})/);
        if (m) {
          const end = parseInt(m[1]) * 60 + parseInt(m[2]);
          if (start !== null && end > start) duration = end - start;
        }
      }

      // 仕分け → category（select / multi_select 両対応）
      const category = p['仕分け']?.select?.name || p['仕分け']?.multi_select?.[0]?.name || '';

      // ステータスが「完了」なら今日の日付キーをdoneDatesに設定
      const statusName = p['ステータス']?.status?.name || '';
      const jstDateKey = jstNow.getUTCFullYear() * 10000 + (jstNow.getUTCMonth() + 1) * 100 + jstNow.getUTCDate();
      const doneDates  = statusName === '完了' ? [jstDateKey] : [];

      tasks.push({
        id:              parseInt(page.id.replace(/-/g, '').substring(0, 10), 16),
        _notionPageId:   page.id,
        title:           name,   // EJECTORは task.title を使用（name ではない）
        allocated:       start !== null,
        start:           start ?? 9 * 60,
        duration,
        category,
        repeatMode:      'none', // 繰り返しなし（未設定だと繰り返しタスク扱いになる）
        memo:            '',
        doneDates,
        createdOffset:   0,
        allocatedOffset: 0,
      });
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return tasks;
}

/** Notionデータベースの重複タスク（同じタイトル・今日の日付）をアーカイブして削除する */
async function notionDedupTasks(token, databaseId) {
  const pages = [];
  let cursor;

  // 今日の日付（JST）
  const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const today  = jstNow.toISOString().slice(0, 10);

  // 今日のタスクを全件取得
  do {
    const body = {
      page_size: 100,
      filter: { property: '実行予定日', date: { equals: today } },
    };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Notion query error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    for (const page of data.results || []) {
      if (!page.archived) pages.push(page);
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);

  // タイトルでグループ化
  const byTitle = new Map();
  for (const page of pages) {
    let title = '';
    for (const val of Object.values(page.properties || {})) {
      if (val.type === 'title') { title = (val.title || []).map(t => t.plain_text).join(''); break; }
    }
    if (!title) continue;
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title).push(page);
  }

  // 重複があれば最終編集日時が新しい1件を残し、残りをアーカイブ
  let archived = 0;
  for (const [, group] of byTitle) {
    if (group.length <= 1) continue;
    group.sort((a, b) => new Date(b.last_edited_time) - new Date(a.last_edited_time));
    for (const page of group.slice(1)) {
      const res = await fetch(`${NOTION_API}/pages/${page.id}`, {
        method: 'PATCH',
        headers: notionHeaders(token),
        body: JSON.stringify({ archived: true }),
      });
      if (!res.ok) throw new Error(`Archive error ${res.status}: ${await res.text()}`);
      archived++;
    }
  }

  return { archived, total: pages.length };
}

/** EJECTORタスクをNotionへ同期する（ユーザーDBのプロパティ名に合わせてマッピング） */
async function notionPushTasks(token, databaseId, tasks) {
  // DBスキーマを取得してタイトルプロパティ名と書き込み可能プロパティを確認
  const dbRes = await fetch(`${NOTION_API}/databases/${databaseId}`, { headers: notionHeaders(token) });
  if (!dbRes.ok) throw new Error(`DB schema fetch error ${dbRes.status}`);
  const dbSchema = await dbRes.json();
  const schemaProps = dbSchema.properties || {};

  // タイトルプロパティ名を動的に取得
  let titlePropName = '名前';
  for (const [name, prop] of Object.entries(schemaProps)) {
    if (prop.type === 'title') { titlePropName = name; break; }
  }

  // 書き込み可能なプロパティかチェック（formula/rollup/unique_id/created_by等は読み取り専用）
  const READONLY_TYPES = new Set(['formula', 'rollup', 'unique_id', 'created_by', 'created_time', 'last_edited_by', 'last_edited_time']);
  const isWritable = (name) => schemaProps[name] && !READONLY_TYPES.has(schemaProps[name].type);

  // 今日の日付（JST）
  const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
  const todayISO = jstNow.toISOString().slice(0, 10);

  const created = [];
  for (const task of tasks) {
    const props = {
      [titlePropName]: { title: [{ text: { content: task.title || '' } }] },
    };
    if (isWritable('実行予定日'))  props['実行予定日']    = { date: { start: todayISO } };
    if (isWritable('予定時間（分）')) props['予定時間（分）'] = { number: task.duration ?? 30 };
    if (task.category && isWritable('仕分け')) props['仕分け'] = { select: { name: task.category } };

    // 開始時刻（テキスト型の場合のみ書き込み）
    if (task.allocated && isWritable('開始時刻') && schemaProps['開始時刻']?.type === 'rich_text') {
      const hh = String(Math.floor((task.start ?? 540) / 60)).padStart(2, '0');
      const mm = String((task.start ?? 540) % 60).padStart(2, '0');
      props['開始時刻'] = { rich_text: [{ text: { content: `${hh}:${mm}` } }] };
    }

    const res = await fetch(`${NOTION_API}/pages`, {
      method: 'POST',
      headers: notionHeaders(token),
      body: JSON.stringify({ parent: { type: 'database_id', database_id: databaseId }, properties: props }),
    });
    if (!res.ok) throw new Error(`Notion create error ${res.status}: ${await res.text()}`);
    const page = await res.json();
    created.push({ ejectorId: task.id, notionPageId: page.id });
  }
  return { created };
}

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
