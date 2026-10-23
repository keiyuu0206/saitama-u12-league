const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 長さに依存しない比較（両方をHMACにかけてから比べる）
export async function safeEqual(secret, a, b) {
  const [x, y] = await Promise.all([hmac(secret, `cmp:${a}`), hmac(secret, `cmp:${b}`)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function sign(secret, payload) {
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function verify(secret, token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const ok = await safeEqual(secret, await hmac(secret, payload), token.slice(i + 1));
  return ok ? payload : null;
}

export function getCookie(req, name) {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const ADMIN_TTL = 60 * 60 * 24 * 7; // 7日
const REL_TTL = 60 * 60 * 24 * 3; // 3日

// 管理者のログイン状態：管理者ID と「パスワード変更の版」を含める（変更・停止で古いログインを無効にする）
export async function issueAdmin(env, uid, ver = 0) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL;
  return cookie('adm', await sign(env.SESSION_SECRET, `admin|${uid}|${ver}|${exp}`), ADMIN_TTL);
}

export async function readAdmin(req, env) {
  const p = await verify(env.SESSION_SECRET, getCookie(req, 'adm'));
  if (!p) return null;
  const [kind, uid, ver, exp] = p.split('|');
  if (kind !== 'admin' || !uid || !exp || Number(exp) <= Date.now() / 1000) return null;
  return { uid, ver: Number(ver) };
}

// ---------- パスワード（PBKDF2-SHA256。元に戻せない形で保存する） ----------
const ITER = 100000; // Workers で使える上限
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, ITER);
  return { hash: b64(bits), salt: b64(salt), iterations: ITER };
}

export async function verifyPassword(password, rec) {
  // 存在しない管理者IDでも同じだけ時間をかけ、IDの有無を推測されにくくする
  const salt = rec ? unb64(rec.pass_salt) : new Uint8Array(16);
  const bits = b64(await pbkdf2(password, salt, rec ? rec.iterations : ITER));
  if (!rec) return false;
  let diff = bits.length ^ rec.pass_hash.length;
  for (let i = 0; i < Math.min(bits.length, rec.pass_hash.length); i++) diff |= bits.charCodeAt(i) ^ rec.pass_hash.charCodeAt(i);
  return diff === 0;
}

// 関係者セッション: PINを再発行すると pin_version が変わり、既存のセッションは無効になる
export async function issueRelative(env, t) {
  const exp = Math.floor(Date.now() / 1000) + REL_TTL;
  return cookie(`rel_${t.slug}`, await sign(env.SESSION_SECRET, `rel|${t.id}|${t.pin_version}|${exp}`), REL_TTL);
}

export async function isRelative(req, env, t) {
  const p = await verify(env.SESSION_SECRET, getCookie(req, `rel_${t.slug}`));
  if (!p) return false;
  const [kind, id, ver, exp] = p.split('|');
  return kind === 'rel' && id === t.id && Number(ver) === t.pin_version && Number(exp) > Date.now() / 1000;
}

// 10分間に max 回まで
export async function rateLimit(db, key, max = 5, windowSec = 600) {
  const now = Math.floor(Date.now() / 1000);
  // 期限切れの記録が溜まり続けないよう、ときどき掃除する
  if (Math.random() < 0.02) await db.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(now).run();
  const row = await db.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || row.reset_at < now) {
    await db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?)').bind(key, now + windowSec).run();
    return { ok: true };
  }
  if (row.count >= max) return { ok: false, retryAfter: row.reset_at - now };
  await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return { ok: true };
}

export async function clearRateLimit(db, key) {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}
