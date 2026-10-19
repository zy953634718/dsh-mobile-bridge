/**
 * Phase-0 self-check: verifies the DSH auth mechanics our E2E suite depends on,
 * directly against the isolated DSH instance (no bridge/plugin involved).
 *
 *   node tests/harness/selfcheck-dsh.mjs
 *
 * Checks:
 *  1. unauthenticated GET / -> 401 with the DSH auth message
 *  2. GET token URL -> 303 + dsh-auth Set-Cookie
 *  3. replay cookie -> GET / -> 200 real DSH HTML (contains <html / dsh)
 *  4. WS /api/remote.mux cookie-less -> DSH 401/403, settles fast, no hang
 *  5. WS /api/remote.mux with cookie + Origin=instance origin -> 101
 *  6. wrong Origin -> rejected (403), proving the Origin fence is real
 */
import { start } from './boot-dsh.mjs';
import { Phone, closeWs } from './phone.mjs';

let failures = 0;
function check(name, cond, detail = '') {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`);
  return ok;
}

const rt = await start({ bootTimeoutMs: 90000 });
const origin = `http://${rt.host}:${rt.port}`;
console.log(`# DSH ${origin} (reused=${rt.reused}, owned=${rt.owned})`);

try {
  // 1. unauthenticated
  const anon = new Phone(origin);
  const r1 = await anon.get('/');
  check('unauthenticated GET / -> 401', r1.status === 401, `status=${r1.status} body=${JSON.stringify(r1.text.slice(0, 80))}`);

  // 2. token exchange
  const phone = new Phone(origin);
  const ex = await phone.get(rt.tokenUrl);
  check('token URL -> 303', ex.status === 303, `status=${ex.status} location=${ex.location}`);
  check('token URL -> dsh-auth Set-Cookie', ex.setCookies.some((c) => c.startsWith('dsh-auth-')), `cookies=${ex.setCookies.map((c) => c.split('=')[0]).join(',') || '(none)'}`);

  // 3. cookie replay
  const r3 = await phone.get('/');
  const isHtml = /<html/i.test(r3.text) && /<title/i.test(r3.text);
  check('cookie replay GET / -> 200 DSH HTML', r3.status === 200 && isHtml, `status=${r3.status} len=${r3.text.length} title=${(r3.text.match(/<title[^>]*>([^<]*)/i) || [])[1] || ''}`);

  // 4. cookie-less WS
  const wsAnon = await anon.wsUpgrade('/api/remote.mux', { headers: { origin } });
  check('cookie-less WS -> DSH 401/403 (no hang)', [401, 403].includes(wsAnon.status), `status=${wsAnon.status} ${Math.round(wsAnon.elapsedMs)}ms body=${JSON.stringify((wsAnon.body || '').slice(0, 80))}`);

  // 5. authenticated WS with correct Origin
  const wsOk = await phone.wsUpgrade('/api/remote.mux', { headers: { origin } });
  check('authenticated WS + right Origin -> 101', wsOk.status === 101, `status=${wsOk.status} ${Math.round(wsOk.elapsedMs)}ms headers=${JSON.stringify({ upgrade: wsOk.headers?.upgrade, connection: wsOk.headers?.connection })}`);
  if (wsOk.status === 101) {
    check('WS 101 has Sec-WebSocket-Accept', !!wsOk.headers['sec-websocket-accept'], `accept=${wsOk.headers['sec-websocket-accept'] || ''}`);
    closeWs(wsOk);
  }

  // 6. bad Origin must be fenced by DSH
  const wsBadOrigin = await phone.wsUpgrade('/api/remote.mux', { headers: { origin: 'http://evil.example' } });
  check('authenticated WS + bad Origin -> rejected (403)', wsBadOrigin.status === 403, `status=${wsBadOrigin.status} ${Math.round(wsBadOrigin.elapsedMs)}ms`);
  closeWs(wsBadOrigin);
} finally {
  const stopped = await stopIfOwned(rt);
  console.log('# teardown:', JSON.stringify(stopped));
}
console.log(failures === 0 ? 'SELFCHECK-DSH: PASS' : `SELFCHECK-DSH: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);

async function stopIfOwned(rt) {
  const { stop } = await import('./boot-dsh.mjs');
  return stop({ port: rt.port });
}
