// docker/redis-rest-proxy.mjs connects to Redis and listens on import, so (as in
// redis-rest-proxy-url-masking.test.mjs) the body-limit helpers are extracted
// from source and evaluated standalone.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const proxySrc = readFileSync(resolve(here, '../docker/redis-rest-proxy.mjs'), 'utf8');

const pick = (re, name) => {
  const src = proxySrc.match(re)?.[0];
  assert.ok(src, `${name} not found in docker/redis-rest-proxy.mjs`);
  return src;
};

const helpers = new Function([
  pick(/const DEFAULT_MAX_BODY_BYTES = [^;]+;/, 'DEFAULT_MAX_BODY_BYTES'),
  pick(/function parseBodyLimit\([\s\S]*?\n\}/, 'parseBodyLimit'),
  'const MAX_BODY_BYTES = DEFAULT_MAX_BODY_BYTES;',
  pick(/class BodyTooLargeError [\s\S]*?\n\}/, 'BodyTooLargeError'),
  pick(/async function readBody\([\s\S]*?\n\}/, 'readBody'),
  'return { DEFAULT_MAX_BODY_BYTES, parseBodyLimit, readBody };',
].join('\n'))();

const body = (...chunks) => Readable.from(chunks.map((c) => Buffer.from(c)));

describe('redis-rest-proxy request body limit', () => {
  it('fits the GDELT materializer state (~8 MB at its GKG cap) by default', () => {
    assert.ok(helpers.DEFAULT_MAX_BODY_BYTES >= 16 * 1024 * 1024);
  });

  it('reads a body within the limit', async () => {
    assert.equal(await helpers.readBody(body('["SET",', '"k","v"]'), 64), '["SET","k","v"]');
  });

  it('rejects an oversized body with a 413 after draining it, not a reset socket', async () => {
    const stream = body('x'.repeat(40), 'y'.repeat(40));
    await assert.rejects(helpers.readBody(stream, 64), (err) => {
      assert.equal(err.status, 413);
      assert.match(err.message, /Request body too large \(limit 64 bytes\)/);
      return true;
    });
    assert.equal(stream.readableEnded, true, 'body drained so the 413 can be delivered');
    assert.doesNotMatch(proxySrc, /req\.destroy\(\)/);
    assert.match(proxySrc, /res\.writeHead\(err\.status \|\| 500\)/);
  });

  it('takes MAX_BODY_BYTES from the environment, ignoring junk', () => {
    assert.equal(helpers.parseBodyLimit('1048576'), 1048576);
    for (const junk of [undefined, '', 'abc', '-5', '0', '1.5']) {
      assert.equal(helpers.parseBodyLimit(junk), helpers.DEFAULT_MAX_BODY_BYTES, `junk ${junk}`);
    }
    assert.match(proxySrc, /const MAX_BODY_BYTES = parseBodyLimit\(process\.env\.MAX_BODY_BYTES\);/);
  });
});
