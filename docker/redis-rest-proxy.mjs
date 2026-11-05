#!/usr/bin/env node
/**
 * Upstash-compatible Redis REST proxy.
 * Translates REST URL paths to raw Redis commands via redis npm package.
 *
 * Supports:
 *   GET  /{command}/{arg1}/{arg2}/...  → Redis command
 *   POST /                            → JSON body ["COMMAND", "arg1", ...]
 *   POST /pipeline                    → JSON body [["CMD1",...], ["CMD2",...]]
 *   POST /multi-exec                  → JSON body [["CMD1",...], ["CMD2",...]]
 *
 * Env:
 *   REDIS_URL  - Redis connection string (default: redis://redis:6379)
 *   SRH_TOKEN  - Bearer token for auth (default: none)
 *   PORT       - Listen port (default: 80)
 *   MAX_BODY_BYTES - Request body cap (default: 32 MB)
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createClient } from 'redis';

const REDIS_URL = process.env.SRH_CONNECTION_STRING || process.env.REDIS_URL || 'redis://redis:6379';
const TOKEN = process.env.SRH_TOKEN || '';
const PORT = parseInt(process.env.PORT || '80', 10);

// Redact userinfo before a connection string ever reaches stdout — REDIS_URL
// carries the Redis password (SRH_CONNECTION_STRING: redis://:<password>@host:port)
// and docker logs are readable by anyone with docker/compose access.
function maskRedisUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '<unparsable redis URL>';
  }
}

const client = createClient({ url: REDIS_URL });
client.on('error', (err) => console.error('Redis error:', err.message));
await client.connect();
console.log(`Connected to Redis at ${maskRedisUrl(REDIS_URL)}`);

function checkAuth(req) {
  if (!TOKEN) return true;
  const auth = req.headers.authorization || '';
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) return false;
  const provided = auth.slice(prefix.length);
  if (provided.length !== TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(TOKEN));
}

// Command safety: allowlist of expected Redis commands.
// Blocks dangerous operations like FLUSHALL, CONFIG SET, EVAL, DEBUG, SLAVEOF.
const ALLOWED_COMMANDS = new Set([
  'GET', 'SET', 'DEL', 'MGET', 'MSET', 'SCAN',
  'TTL', 'EXPIRE', 'PEXPIRE', 'EXISTS', 'TYPE',
  'HGET', 'HSET', 'HDEL', 'HGETALL', 'HMGET', 'HMSET', 'HKEYS', 'HVALS', 'HEXISTS', 'HLEN',
  'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'LRANGE', 'LLEN', 'LTRIM', 'LREM',
  'SADD', 'SREM', 'SMEMBERS', 'SISMEMBER', 'SCARD',
  'ZADD', 'ZREM', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZSCORE', 'ZCARD', 'ZRANDMEMBER',
  'GEOADD', 'GEOSEARCH', 'GEOPOS', 'GEODIST',
  'INCR', 'DECR', 'INCRBY', 'DECRBY',
  'PING', 'ECHO', 'INFO', 'DBSIZE',
  'PUBLISH', 'SUBSCRIBE',
  'SETNX', 'SETEX', 'PSETEX', 'GETSET',
  'APPEND', 'STRLEN',
]);

async function runCommand(args) {
  const cmd = args[0].toUpperCase();
  if (!ALLOWED_COMMANDS.has(cmd)) {
    throw new Error(`Command not allowed: ${cmd}`);
  }
  const cmdArgs = args.slice(1);
  return client.sendCommand([cmd, ...cmdArgs.map(String)]);
}

// Request bodies are capped so a client can't make the proxy buffer without
// bound, but the cap has to fit what seeders write through Upstash, which
// accepts multi-megabyte values: the GDELT materializer state alone is ~3 MB on
// a cold start and ~8 MB at its 5,000-record GKG cap. The old 1 MB cap reset
// that write ("fetch failed: other side closed"), so the cursor and the 24h
// rolling windows were never saved.
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;

function parseBodyLimit(raw) {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

const MAX_BODY_BYTES = parseBodyLimit(process.env.MAX_BODY_BYTES);

class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`Request body too large (limit ${limit} bytes)`);
    this.status = 413;
  }
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let totalLength = 0;
  for await (const chunk of req) {
    totalLength += chunk.length;
    // Past the limit, stop buffering but keep draining, so the client gets a
    // readable 413 instead of a reset socket.
    if (totalLength <= limit) chunks.push(chunk);
  }
  if (totalLength > limit) throw new BodyTooLargeError(limit);
  return Buffer.concat(chunks).toString();
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');

  if (!checkAuth(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    // POST / — single command
    if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
      const body = JSON.parse(await readBody(req));
      const result = await runCommand(body);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // POST /pipeline — batch commands
    if (req.method === 'POST' && req.url === '/pipeline') {
      const commands = JSON.parse(await readBody(req));
      const results = [];
      for (const cmd of commands) {
        try {
          const result = await runCommand(cmd);
          results.push({ result });
        } catch (err) {
          results.push({ error: err.message });
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify(results));
      return;
    }

    // POST /multi-exec — transaction
    if (req.method === 'POST' && req.url === '/multi-exec') {
      const commands = JSON.parse(await readBody(req));
      const multi = client.multi();
      for (const cmd of commands) {
        const cmdName = cmd[0].toUpperCase();
        if (!ALLOWED_COMMANDS.has(cmdName)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: `Command not allowed: ${cmdName}` }));
          return;
        }
        multi.sendCommand(cmd.map(String));
      }
      const results = await multi.exec();
      res.writeHead(200);
      res.end(JSON.stringify(results.map((r) => ({ result: r }))));
      return;
    }

    // GET / — welcome
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
      res.writeHead(200);
      res.end('"Welcome to Serverless Redis HTTP!"');
      return;
    }

    // GET /{command}/{args...} — REST style
    if (req.method === 'GET') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const parts = pathname.slice(1).split('/').map(decodeURIComponent);
      if (parts.length === 0 || !parts[0]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No command specified' }));
        return;
      }
      const result = await runCommand(parts);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // POST /{command}/{args...} — Upstash-compatible path-based POST
    // Used by setCachedJson(): POST /set/<key>/<value>/EX/<ttl>
    if (req.method === 'POST') {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const parts = pathname.slice(1).split('/').map(decodeURIComponent);
      if (parts.length === 0 || !parts[0]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No command specified' }));
        return;
      }
      const result = await runCommand(parts);
      res.writeHead(200);
      res.end(JSON.stringify({ result }));
      return;
    }

    // OPTIONS
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(err.status || 500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Redis REST proxy listening on 0.0.0.0:${PORT}`);
});
