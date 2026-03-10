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

/** データベースの全タスクを取得してEJECTOR形式に変換する */
async function notionPullAllTasks(token, databaseId) {
  const tasks = [];
  let cursor;
  do {
    const body = { page_size: 100 };
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
      // タイトルプロパティを名前に関わらず動的に検出
      let name = '';
      for (const val of Object.values(p)) {
        if (val.type === 'title') { name = (val.title || []).map(t => t.plain_text).join(''); break; }
      }
      if (!name) continue;
      const start    = typeof p.Start?.number === 'number' ? p.Start.number : null;
      const duration = p.Duration?.number || 30;
      const doneDatesRaw = (p.DoneDates?.rich_text || []).map(t => t.plain_text).join('');
      let doneDates = [];
      try { doneDates = JSON.parse(doneDatesRaw); } catch {}
      tasks.push({
        id:            page.id.replace(/-/g, ''),
        _notionPageId: page.id,
        name,
        allocated:     start !== null,
        start:         start ?? 9 * 60,
        duration,
        category:      p.Category?.select?.name || '',
        memo:          (p.Memo?.rich_text || []).map(t => t.plain_text).join(''),
        doneDates,
        createdOffset: 0,
      });
    }
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return tasks;
}

/** EJECTORタスクをNotionへ同期する */
async function notionPushTasks(token, databaseId, tasks) {
  let created = 0, updated = 0;
  for (const task of tasks) {
    const props = {
      'Name':      { title: [{ text: { content: task.name || '' } }] },
      'Start':     { number: task.start ?? null },
      'Duration':  { number: task.duration ?? 30 },
      'Done':      { checkbox: (task.doneDates || []).length > 0 },
      'DoneDates': { rich_text: [{ text: { content: JSON.stringify(task.doneDates || []) } }] },
    };
    if (task.category) props['Category'] = { select: { name: task.category } };
    if (task.memo)     props['Memo']     = { rich_text: [{ text: { content: task.memo } }] };
    if (task._notionPageId) {
      const res = await fetch(`${NOTION_API}/pages/${task._notionPageId}`, {
        method: 'PATCH',
        headers: notionHeaders(token),
        body: JSON.stringify({ properties: props }),
      });
      if (!res.ok) throw new Error(`Notion update error ${res.status}: ${await res.text()}`);
      updated++;
    } else {
      const res = await fetch(`${NOTION_API}/pages`, {
        method: 'POST',
        headers: notionHeaders(token),
        body: JSON.stringify({ parent: { type: 'database_id', database_id: databaseId }, properties: props }),
      });
      if (!res.ok) throw new Error(`Notion create error ${res.status}: ${await res.text()}`);
      created++;
    }
  }
  return { created, updated };
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
