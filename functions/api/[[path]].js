/**
 * 文件站后端：Cloudflare Pages Functions
 * 放在仓库的  functions/api/[[path]].js
 *
 * 路由：
 *   GET  /api/list              列出已上传的文件
 *   POST /api/upload?name=xxx   上传（请求体就是文件本身）
 *   GET  /api/file/<key>        下载/预览（图片视频内联，危险类型强制下载）
 *   POST /api/delete?key=&password=   删除（密码对了才删，连错会被锁）
 *
 * 存储：**同一个文件支持三种，配了哪个就用哪个**（不用改代码就能换）
 *   ① GitHub Releases —— Secret GITHUB_TOKEN + 变量 GITHUB_REPO
 *                        （**免绑卡**，总量和流量都不限，单文件受 CF 的 100MB 限制）★ 推荐
 *   ② R2 桶           —— 绑定变量名 BUCKET （免费 10GB，单文件可到 5TB，但开通要绑支付方式）
 *   ③ KV 命名空间      —— 绑定变量名 FILES  （免费 1GB，单值 25MB，免绑卡但最小）
 *   优先级 R2 > GitHub > KV；想强行指定就设 STORE=r2 / gh / kv
 *
 * 必须在 Pages → Settings → Environment variables 里配：
 *   UPLOAD_PASSWORD = 上传密码（不配 = 上传关闭，谁都不能传）
 *   ADMIN_PASSWORD  = 删除密码（不配 = 删除关闭）
 *   ⚠️ 两个密码故意都不写在这个文件里——仓库是公开的，写进去等于公开密码。
 *      不想限制上传就别配 UPLOAD_PASSWORD，但那样上传功能是关的，不是放开的。
 *
 * 可选变量：
 *   SITE_NAME     页面标题，默认「文件站」
 *   GITHUB_BRANCH 仓库分支名（用于列出仓库里的 files/ 文件夹），默认 main
 *   GITHUB_TAG    Release 标签名，默认 uploads；一个 Release 满 1000 个文件就换一个
 *   MAX_MB        单文件上限，默认 100（免费套餐的请求体上限）
 *   STORE         强制指定存储：r2 / gh / kv
 */

// 三个不一样的数，别混：
//   · Function 能收到的请求体上限 = 100MB（CF 免费套餐，按账号套餐算，超了由 CF 边缘回 413）
//   · 仓库里的静态文件（files/ 那些）单个 25MiB —— 只管仓库，不管上传
//   · KV 单个值硬上限 25MiB —— 真限制，所以 KV 模式下会被夹到 25
const MAX_MB_DEFAULT = 100;
const KV_MAX_BYTES = 25 * 1024 * 1024;
const KV_MAX_MB = 25;
const DANGEROUS_EXT = new Set([
  'html', 'htm', 'xhtml', 'shtml', 'svg', 'xml', 'js', 'mjs', 'cjs', 'css',
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'psm1', 'sh', 'bash',
  'jar', 'apk', 'dll', 'vbs', 'hta', 'reg', 'lnk', 'swf', 'jsp', 'asp', 'php'
]);
const TYPE_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  pdf: 'application/pdf', zip: 'application/zip', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', json: 'application/json', csv: 'text/csv'
};
const RL_PREFIX = '_rl/';             // 密码尝试次数记在这
const RL_MAX_FAIL = 5;
const RL_LOCK_MIN = 15;

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const seg = [].concat(params.path || []);
  const route = seg.join('/');

  const store = makeStore(env);
  if (!store) {
    const hint = env.GITHUB_TOKEN && !env.GITHUB_REPO
      ? '配了 GITHUB_TOKEN 但没配 GITHUB_REPO：再加上 GITHUB_REPO = 你的用户名/仓库名'
      : '还没配存储：加一个 GITHUB_TOKEN + GITHUB_REPO（GitHub Releases），或绑定 R2（变量名 BUCKET）/ KV（变量名 FILES）';
    return json({ ok: false, error: hint }, 500);
  }

  try {
    if (route === 'list' && request.method === 'GET') return await listFiles(env, store);
    if (route === 'upload' && request.method === 'POST') return await upload(request, env, store, url);
    if (route.startsWith('file/')) return await serve(request, env, store, url, route.slice(5));
    if (route === 'delete' && request.method === 'POST') return await remove(request, env, store, url);
    return json({ ok: false, error: '接口不存在' }, 404);
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) }, (err && err.status) || 500);
  }
}

/* ==================== 存储适配层（R2 / KV 各一套） ==================== */

function makeStore(env) {
  // STORE 可以强制指定（r2 / gh / kv）；不指定就按能力从强到弱挑
  const want = (env.STORE || '').toLowerCase();
  if (want === 'r2' && env.BUCKET) return r2Store(env.BUCKET);
  if (want === 'gh' && env.GITHUB_TOKEN && env.GITHUB_REPO) return ghStore(env);
  if (want === 'kv' && env.FILES) return kvStore(env.FILES);
  if (env.BUCKET) return r2Store(env.BUCKET);
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) return ghStore(env);
  if (env.FILES) return kvStore(env.FILES);
  return null;
}

function r2Store(bucket) {
  return {
    kind: 'r2',
    async put(key, request, meta) {
      const obj = await bucket.put(key, request.body, {
        httpMetadata: { contentType: meta.type },
        customMetadata: { name: meta.name, size: String(meta.size || 0), ip: meta.ip, ua: meta.ua, uploaded: String(meta.uploaded) }
      });
      return { size: obj.size };
    },
    async get(key) {
      const o = await bucket.get(key);
      if (!o) return null;
      const headers = new Headers();
      o.writeHttpMetadata(headers);
      return {
        body: o.body,
        size: o.size,
        type: headers.get('content-type') || 'application/octet-stream',
        name: (o.customMetadata && o.customMetadata.name) || key
      };
    },
    async list() {
      // ponytail: 同 KV，只取前 1000 个对象，不跟 truncated 翻页；文件破千再补。
      const out = await bucket.list({ limit: 1000, include: ['httpMetadata', 'customMetadata'] });
      return out.objects.map((o) => ({
        key: o.key,
        name: (o.customMetadata && o.customMetadata.name) || o.key,
        size: o.size,
        uploaded: o.uploaded,
        type: (o.httpMetadata && o.httpMetadata.contentType) || ''
      }));
    },
    async del(key) { await bucket.delete(key); },
    async getText(key) { const o = await bucket.get(key); return o ? await o.text() : null; },
    async putText(key, text) { await bucket.put(key, text, { httpMetadata: { contentType: 'application/json' } }); }
  };
}

function kvStore(kv) {
  return {
    kind: 'kv',
    async put(key, request, meta) {
      // KV 拿不到流式写入后的大小，所以先读成 ArrayBuffer，量好大小再带 metadata 写进去
      const buf = await request.arrayBuffer();
      // 读完了才知道多大，所以"超限"这一关在这里兜；状态码带出去让上层回 413 而不是 500
      if (buf.byteLength > KV_MAX_BYTES) {
        const e = new Error('超过 25MB 上限（KV 单个文件最大 25MB，想传更大的请换 R2）');
        e.status = 413;
        throw e;
      }
      await kv.put(key, buf, {
        metadata: {
          name: String(meta.name || '').slice(0, 200),
          type: meta.type || 'application/octet-stream',
          size: buf.byteLength,
          uploaded: meta.uploaded || Date.now(),
          ip: meta.ip || '',
          ua: String(meta.ua || '').slice(0, 120)
        }
      });
      return { size: buf.byteLength };
    },
    async get(key) {
      const r = await kv.getWithMetadata(key, 'arrayBuffer');
      if (!r || r.value === null) return null;
      const m = r.metadata || {};
      return {
        body: r.value,
        size: (r.value && r.value.byteLength) || m.size || 0,
        type: m.type || 'application/octet-stream',
        name: m.name || key
      };
    },
    async list() {
      // ponytail: 只取前 1000 个 key，不翻页。KV 免费额度 1GB，到 1000 个文件时再补 cursor 循环。
      const out = await kv.list({ limit: 1000 });
      return (out.keys || []).map((k) => {
        const m = k.metadata || {};
        return {
          key: k.name,
          name: m.name || k.name,
          size: m.size || 0,
          uploaded: m.uploaded ? new Date(m.uploaded) : null,
          type: m.type || ''
        };
      });
    },
    async del(key) { await kv.delete(key); },
    async getText(key) { return await kv.get(key, 'text'); },
    async putText(key, text) { await kv.put(key, text); }
  };
}

/* ==================== GitHub Releases 适配层 ====================
 * 为什么用 Releases 而不是往仓库里塞文件：
 *   · 官方原话：不限制 release 里二进制文件的总大小，也不限制分发带宽 → 免绑卡、总量无限
 *   · 文件不在 git 历史里 → 不占仓库体积，别人 clone 也不会拉下来
 *   · 单文件上限受 **CF 请求体 100MB** 限制（这是 CF 的，不是 GitHub 的）
 * 需要 env：GITHUB_TOKEN（细粒度 PAT，只要 Contents: Read and write）
 * 必需 env：GITHUB_TOKEN + GITHUB_REPO；可选：GITHUB_TAG（默认 uploads）、GITHUB_BRANCH（默认 main）
 */
const GH_TAG_DEFAULT = 'uploads';
const GH_STATE_PREFIX = '_rl_';       // GitHub 的 asset 名不能带 "/"，所以把 _rl/xxx 映射成 _rl_xxx

function ghStore(env) {
  const repo = env.GITHUB_REPO;
  const tag = env.GITHUB_TAG || GH_TAG_DEFAULT;
  const token = env.GITHUB_TOKEN;
  const apiBase = 'https://api.github.com/repos/' + repo;
  const upBase = 'https://uploads.github.com/repos/' + repo;
  const dlBase = 'https://github.com/' + repo + '/releases/download/' + tag + '/';
  const H = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'cf-pages-filebox'
  };
  const assetName = (key) => String(key).replace(/\//g, '_');
  let relCache = null;      // release 对象（很少变，缓存在 isolate 里）
  let listCache = null;     // { at, items }，用来把 asset 名映射回原始文件名

  function die(msg, status) {
    const e = new Error(msg);
    e.status = status || 502;
    throw e;
  }
  async function ghApi(path, init) {
    const r = await fetch(apiBase + path, {
      method: (init && init.method) || 'GET',
      headers: Object.assign({}, H, (init && init.headers) || {}),
      body: init && init.body
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      let msg = r.status + '';
      try { msg = (await r.json()).message || msg; } catch (e) {}
      if (r.status === 401) die('GITHUB_TOKEN 无效或已过期：' + msg, 500);
      if (r.status === 403) die('GITHUB_TOKEN 权限不够（需要 Contents: Read and write）或触发限流：' + msg, 500);
      die('GitHub 接口报错：' + msg, 502);
    }
    return r.status === 204 ? {} : r.json();
  }
  async function release(create) {
    if (relCache) return relCache;
    let rel = await ghApi('/releases/tags/' + tag);
    if (!rel && create) {
      rel = await ghApi('/releases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag_name: tag, name: '上传的文件', body: '由文件站自动创建，请勿删除。', draft: false, prerelease: false })
      });
    }
    if (rel) relCache = rel;
    return rel;
  }
  async function allAssets(force, includeState) {
    // ponytail: 最多翻 10 页 = 1000 个 asset（GitHub 单 release 上限就是 1000）。到顶了再建新 tag。
    if (!force && listCache && Date.now() - listCache.at < 60000) return listCache.items;
    const rel = await release(false);
    if (!rel) return [];
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const arr = await ghApi('/releases/' + rel.id + '/assets?per_page=100&page=' + page);
      if (!arr || !arr.length) break;
      for (const a of arr) {
        // 密码尝试次数默认不进文件列表；但删它的时候必须能看见它，否则会撞 already_exists
        if (!includeState && a.name.startsWith(GH_STATE_PREFIX)) continue;
        items.push({ key: a.name, name: a.label || a.name, size: a.size || 0, uploaded: a.created_at || null, type: a.content_type || '', id: a.id });
      }
      if (arr.length < 100) break;
    }
    if (!includeState) listCache = { at: Date.now(), items };   // 带状态的那份不缓存，免得被列表用上
    return items;
  }
  async function upload(key, body, meta) {
    const rel = await release(true);
    // asset 名只能是我们生成的 key（安全、可做 URL），原始文件名存进 label，下载时换回来
    const label = meta.label ? '&label=' + encodeURIComponent(meta.label.slice(0, 200)) : '';
    // ponytail: 直接把 request.body 流给 GitHub。若 GitHub 拒收 chunked（411/400），
    //           改成先 await request.arrayBuffer() 再传——代价是 100MB 会吃掉 isolate 内存。
    const r = await fetch(upBase + '/releases/' + rel.id + '/assets?name=' + encodeURIComponent(assetName(key)) + label, {
      method: 'POST',
      headers: Object.assign({}, H, {
        'Content-Type': meta.type || 'application/octet-stream',
        'Content-Length': String(meta.size || 0)
      }),
      body
    });
    if (!r.ok) {
      let msg = r.status + '';
      try { msg = (await r.json()).message || msg; } catch (e) {}
      die('GitHub 拒收这个文件（' + msg + '）', 502);
    }
    listCache = null;
    return await r.json();
  }

  return {
    kind: 'gh',
    async put(key, request, meta) {
      const a = await upload(key, request.body, { type: meta.type, size: meta.size, label: meta.name });
      return { size: a.size || 0 };
    },
    async get(key) {
      // 文件名存在 label 里，asset 名是我们自己生成的 key，所以要从列表里换回原始名字
      const items = await allAssets(false);
      const hit = items.find((x) => x.key === assetName(key));
      const r = await fetch(dlBase + encodeURIComponent(assetName(key)));
      if (!r.ok || !r.body) return null;
      return {
        body: r.body,
        size: (hit && hit.size) || Number(r.headers.get('content-length')) || 0,
        type: (hit && hit.type) || r.headers.get('content-type') || 'application/octet-stream',
        name: (hit && hit.name) || key
      };
    },
    async list() { return await allAssets(false); },
    async del(key) {
      const name = assetName(key);
      const items = await allAssets(false, true);
      const hit = items.find((x) => x.key === name);
      if (hit) await ghApi('/releases/assets/' + hit.id, { method: 'DELETE' });
      listCache = null;
    },
    async getText(key) {
      const r = await fetch(dlBase + encodeURIComponent(assetName(key)));
      return r.ok ? await r.text() : null;
    },
    async putText(key, text) {
      const name = assetName(key);
      const items = await allAssets(true, true);
      const hit = items.find((x) => x.key === name);
      // asset 不能覆盖写，只能先删再传（只发生在密码输错时，频率很低）
      if (hit) await ghApi('/releases/assets/' + hit.id, { method: 'DELETE' });
      await upload(name, text, { type: 'application/json', size: text.length, label: '' });
      listCache = null;
    }
  };
}

/* 上传 / 删除共用的密码门禁：密码对了返回 { ok:true }，不对就返回 { res } 直接当响应发出去。
 * 连错 RL_MAX_FAIL 次锁 RL_LOCK_MIN 分钟（按 IP 记），上传和删除各记一份，互不牵连。 */
async function passwordGate(store, request, expected, submitted, tag, missingMsg) {
  if (!expected) return { res: json({ ok: false, error: missingMsg }, 500) };
  const lockKey = RL_PREFIX + tag + '-' + (await sha(clientIp(request))).slice(0, 20);
  let state = { fails: 0, lockedUntil: 0 };
  try { const t = await store.getText(lockKey); if (t) state = JSON.parse(t); } catch (e) {}
  const now = Date.now();

  if (state.lockedUntil && now < state.lockedUntil) {
    return { res: json({ ok: false, error: '密码错误次数太多，请 ' + Math.ceil((state.lockedUntil - now) / 60000) + ' 分钟后再试' }, 429) };
  }
  if (submitted !== expected) {
    state.fails = (state.fails || 0) + 1;
    if (state.fails >= RL_MAX_FAIL) { state.lockedUntil = now + RL_LOCK_MIN * 60000; state.fails = 0; }
    await store.putText(lockKey, JSON.stringify(state));
    return { res: json({ ok: false, error: '密码不对', left: state.lockedUntil ? 0 : RL_MAX_FAIL - state.fails }, 403) };
  }
  // 只有之前失败过才写回状态，否则每次正常上传都要多一次读写
  if (state.fails || state.lockedUntil) await store.putText(lockKey, JSON.stringify({ fails: 0, lockedUntil: 0 }));
  return { ok: true };
}

/* ==================== 接口实现 ==================== */

async function listFiles(env, store) {
  const all = await store.list();
  const files = all
    .filter((f) => !f.key.startsWith(RL_PREFIX))
    .map((f) => ({
      key: f.key,
      name: f.name,
      size: f.size,
      uploaded: f.uploaded,
      type: f.type,
      src: 'upload',   // 前端据此判断"这是上传来的文件"（相对的是 src:'repo' 的仓库文件）
      url: '/api/file/' + f.key,
      download: '/api/file/' + f.key + '?dl=1'
    }))
    .sort((a, b) => new Date(b.uploaded || 0) - new Date(a.uploaded || 0));
  return json({
    ok: true, count: files.length, maxMB: maxMBFor(env, store),
    site: env.SITE_NAME || '文件站',
    storage: STORE_LABEL[store.kind] || store.kind,
    needUploadPw: !!env.UPLOAD_PASSWORD,
    repo: env.GITHUB_REPO || '',      // 前端拿它去列仓库里的 files/ 文件夹
    branch: env.GITHUB_BRANCH || 'main',
    files
  });
}

async function upload(request, env, store, url) {
  // 上传密码走请求头（不放 URL，免得密码进日志/Referer）
  const gate = await passwordGate(store, request, env.UPLOAD_PASSWORD, request.headers.get('x-upload-password') || '', 'up',
    '上传已关闭：Pages → Settings → Environment variables 加一个 UPLOAD_PASSWORD 才会开启上传');
  if (gate.res) return gate.res;

  const maxMB = maxMBFor(env, store);
  const maxBytes = maxMB * 1024 * 1024;
  const declared = num(request.headers.get('content-length'), 0);
  if (declared && declared > maxBytes) return json({ ok: false, error: '超过 ' + maxMB + 'MB 上限' }, 413);
  if (!request.body) return json({ ok: false, error: '请求体为空' }, 400);

  const name = safeName(url.searchParams.get('name') || 'file');
  const ext = extOf(name);
  const key = shortId() + (ext ? '.' + ext : '');
  const type = request.headers.get('content-type') || TYPE_MAP[ext] || 'application/octet-stream';

  const res = await store.put(key, request, {
    name, type, size: declared, ip: clientIp(request),
    ua: request.headers.get('user-agent') || '', uploaded: Date.now()
  });

  // 事后兜底：分块上传没有 content-length 时也要拦得住
  if (res.size > maxBytes) {
    await store.del(key);
    return json({ ok: false, error: '超过 ' + maxMB + 'MB 上限，已拒绝' }, 413);
  }

  return json({ ok: true, key, name, size: res.size, url: '/api/file/' + key, download: '/api/file/' + key + '?dl=1' });
}

async function serve(request, env, store, url, key) {
  key = decodeURIComponent(key);
  const obj = await store.get(key);
  if (!obj) return new Response('文件不存在', { status: 404 });

  const ext = extOf(key);
  const force = DANGEROUS_EXT.has(ext) || url.searchParams.get('dl') === '1';
  const headers = new Headers();
  headers.set('Content-Type', obj.type || 'application/octet-stream');
  headers.set('Content-Disposition', (force ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(obj.name));
  headers.set('X-Content-Type-Options', 'nosniff');
  if (obj.size) headers.set('Content-Length', String(obj.size));
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(obj.body, { headers });
}

async function remove(request, env, store, url) {
  const key = url.searchParams.get('key') || '';
  if (!key) return json({ ok: false, error: '缺少 key' }, 400);

  const gate = await passwordGate(store, request, env.ADMIN_PASSWORD, url.searchParams.get('password') || '', 'del',
    '还没设置删除密码：Pages → Settings → Environment variables 加一个 ADMIN_PASSWORD');
  if (gate.res) return gate.res;

  await store.del(decodeURIComponent(key));
  return json({ ok: true, deleted: key });
}

/* ==================== 工具 ==================== */
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function num(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
const STORE_LABEL = { r2: 'R2', gh: 'GitHub Releases', kv: 'KV' };
// 单文件上限只有一个出处：前端靠 /api/list 拿到的 maxMB 显示提示，所以这里算给两边共用
function maxMBFor(env, store) {
  const m = num(env.MAX_MB, MAX_MB_DEFAULT);
  return store.kind === 'kv' && m > KV_MAX_MB ? KV_MAX_MB : m;
}
function extOf(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
function safeName(input) {
  let n = String(input).replace(/\\/g, '/');
  n = n.slice(n.lastIndexOf('/') + 1);
  n = n.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '');
  if (!n) n = 'file';
  return n.length > 120 ? n.slice(-120) : n;
}
function shortId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 12);
}
function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
}
async function sha(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
