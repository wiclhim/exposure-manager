const LIMIT = 40;
const WINDOW_MS = 60_000;
const REDIS_KEY = 'betree:fugle:rest:rolling:v1';

const RESERVE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local nonce = ARGV[2]
local units = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local window = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count + units > limit then
  local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if #first >= 2 then retry = tonumber(first[2]) + window - now end
  if retry < 1 then retry = 1 end
  return {0, count, retry}
end
for i = 1, units do
  redis.call('ZADD', key, now, nonce .. ':' .. i)
end
redis.call('PEXPIRE', key, window * 2)
return {1, count + units, 0}
`;

const USAGE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = 0
if #first >= 2 then retry = tonumber(first[2]) + window - now end
return {count, math.max(0, retry)}
`;

function configured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function evalRedis(script, args) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error('Global REST rate limiter is not configured');
  const response = await fetch(`${base.replace(/\/+$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['EVAL', script, '1', REDIS_KEY, ...args.map(String)]])
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload) || payload[0]?.error) {
    throw new Error(payload?.[0]?.error || `Redis rate limiter error (${response.status})`);
  }
  return payload[0].result;
}

function setHeaders(res, used, retryMs = 0) {
  const remaining = Math.max(0, LIMIT - Number(used || 0));
  res.setHeader('X-RateLimit-Limit', String(LIMIT));
  res.setHeader('X-RateLimit-Used', String(Number(used || 0)));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Window', String(WINDOW_MS));
  res.setHeader('X-RateLimit-Retry-Ms', String(Math.max(0, Number(retryMs || 0))));
}

async function reserveFugleCalls(res, units = 1) {
  if (!configured()) {
    setHeaders(res, 0);
    return { allowed: false, status: 503, code: 'RATE_LIMITER_NOT_CONFIGURED', used: 0, limit: LIMIT, message: '為避免 Fugle REST 額度超限，請先設定 Upstash Redis 全域計數器。' };
  }
  const now = Date.now();
  const nonce = `${now}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  try {
    const result = await evalRedis(RESERVE_SCRIPT, [now, nonce, units, LIMIT, WINDOW_MS]);
    const allowed = Number(result?.[0]) === 1;
    const used = Number(result?.[1] || 0);
    const retryMs = Number(result?.[2] || 0);
    setHeaders(res, used, retryMs);
    return allowed
      ? { allowed: true, used, limit: LIMIT, remaining: Math.max(0, LIMIT - used) }
      : { allowed: false, status: 429, code: 'FUGLE_REST_RATE_LIMIT', used, limit: LIMIT, remaining: Math.max(0, LIMIT - used), retryMs, message: `Fugle REST 全域安全上限為每 60 秒 ${LIMIT} 次，已暫停本次查詢。` };
  } catch (error) {
    setHeaders(res, 0);
    return { allowed: false, status: 503, code: 'RATE_LIMITER_UNAVAILABLE', used: null, limit: LIMIT, message: '全域額度計數器暫時無法連線，為避免超額已停止 Fugle REST 查詢。', detail: error.message };
  }
}

async function getFugleUsage() {
  if (!configured()) return { configured: false, limit: LIMIT, used: null, remaining: null, windowMs: WINDOW_MS };
  try {
    const result = await evalRedis(USAGE_SCRIPT, [Date.now(), WINDOW_MS]);
    const used = Number(result?.[0] || 0);
    return { configured: true, limit: LIMIT, used, remaining: Math.max(0, LIMIT - used), windowMs: WINDOW_MS, retryMs: Number(result?.[1] || 0) };
  } catch (error) {
    return { configured: true, available: false, limit: LIMIT, used: null, remaining: null, windowMs: WINDOW_MS, error: error.message };
  }
}

function rateLimitResponse(res, result) {
  return res.status(result.status || 429).json({
    error: result.message,
    code: result.code,
    used: result.used,
    limit: result.limit,
    remaining: result.remaining,
    retryMs: result.retryMs || 0,
    detail: result.detail
  });
}

module.exports = { LIMIT, WINDOW_MS, configured, reserveFugleCalls, getFugleUsage, rateLimitResponse };
