import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Local research client: credentials and account responses never enter research/.
const origin = 'https://mcp.canva.com';
const endpoint = `${origin}/mcp`;
const writeAuthorization = process.argv.includes('--write');
if (writeAuthorization && process.argv.includes('--reuse')) throw new Error('Use --write to perform a fresh consent flow; refresh cannot expand an existing read grant.');
const tokenFile = writeAuthorization ? '.local/oauth-write-tokens.json' : '.local/oauth-tokens.json';
const writeScopes = ['design:content:write', 'folder:write', 'comment:write'];
const redirect = 'http://127.0.0.1:8976/callback';
await mkdir('.local', { recursive: true, mode: 0o700 });
await mkdir('research', { recursive: true });
const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`).then(r => r.json());
await writeFile('research/oauth-authorization-server.json', JSON.stringify(metadata, null, 2) + '\n');
const resourceMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`).then(r => r.json());
await writeFile('research/oauth-protected-resource.json', JSON.stringify(resourceMetadata, null, 2) + '\n');
let client;
try {
  client = JSON.parse(await readFile('.local/oauth-client.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const response = await fetch(metadata.registration_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Canva Gatekeeper Research', redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  if (!response.ok) throw new Error(`Client registration HTTP ${response.status}; a registered Canva client may be required.`);
  client = await response.json();
  await writeFile('.local/oauth-client.json', JSON.stringify(client), { mode: 0o600 });
}
if (!client.client_id) throw new Error('Missing registered OAuth client ID');
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const scopes = resourceMetadata.scopes_supported.filter(s => s.endsWith(':read') || writeAuthorization && writeScopes.includes(s));
const authorize = new URL(metadata.authorization_endpoint);
authorize.search = new URLSearchParams({
  response_type: 'code', client_id: client.client_id, redirect_uri: redirect,
  code_challenge: challenge, code_challenge_method: 'S256', state,
  scope: scopes.join(' '), resource: endpoint,
}).toString();
let tokens;
let rpcId = 0;
let sessionId;
let protocol = '2025-03-26';
async function rpc(method, params) {
  const notification = method.startsWith('notifications/');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      'MCP-Protocol-Version': protocol,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++rpcId }), method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  sessionId = response.headers.get('mcp-session-id') ?? sessionId;
  if (!response.ok) throw new Error(`MCP ${method} HTTP ${response.status}`);
  const body = await response.text();
  if (notification || !body) return;
  let value;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const messages = body.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      return data ? [JSON.parse(data)] : [];
    });
    value = messages.find(message => message.id === rpcId);
  } else value = JSON.parse(body);
  if (!value) throw new Error(`No response for ${method}`);
  if (value.error) throw new Error(`MCP ${method}: ${JSON.stringify(value.error)}`);
  return value.result;
}
async function discover() {
  const init = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'canva-gatekeeper-research', version: '0.1.0' } });
  protocol = init.protocolVersion;
  await rpc('notifications/initialized');
  const tools = [];
  let cursor;
  const seen = new Set();
  do {
    const page = await rpc('tools/list', cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('Repeated catalog cursor');
    if (cursor) seen.add(cursor);
  } while (cursor);
  await writeFile('research/initialize.json', JSON.stringify(init, null, 2) + '\n');
  await writeFile('research/tools.json', JSON.stringify({ discoveredAt: new Date().toISOString(), endpoint, requestedScopes: scopes, grantedScopes: tokens.scope?.split(' '), tools }, null, 2) + '\n');
  console.log(`Authenticated discovery complete: ${tools.length} tools. Catalog: research/tools.json`);
  console.log(tools.map(tool => tool.name).join('\n'));
  if (process.argv.includes('--probe')) {
    const shapes = {};
    function shape(value) {
      if (value === null || typeof value === 'boolean') return value;
      if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
      if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)]));
      return `<${typeof value}>`;
    }
    function payload(result) {
      if (result.structuredContent) return result.structuredContent;
      const content = result.content?.find(item => item.type === 'text')?.text;
      try { return JSON.parse(content); } catch { return { text: content }; }
    }
    const allowed = new Set(['search-designs','search-folders','list-folder-items','get-design','get-design-pages','get-design-content','get-presenter-notes','get-export-formats','list-comments','get-design-dataset']);
    async function probe(name, args) {
      if (!allowed.has(name)) throw new Error('Unapproved research probe');
      const result = await rpc('tools/call', { name, arguments: { ...args, user_intent: 'Discover read-only response shapes for the account owner’s Canva Gatekeeper.' } });
      await writeFile(`.local/probe-${name}.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
      const body = payload(result);
      shapes[name] = { isError: result.isError ?? false, envelope: shape(result), payload: shape(body) };
      console.log(`Probe ${name}: ${result.isError ? 'tool error' : 'ok'}`);
      return result.isError ? null : body;
    }
    const designs = await probe('search-designs', { limit: 1 });
    await probe('search-folders', { limit: 1 });
    await probe('list-folder-items', { folder_id: 'root' });
    const first = designs?.results?.[0] ?? designs?.items?.[0];
    const designId = first?.design_id ?? first?.id ?? first?.design?.id;
    if (designId) {
      for (const [name, args] of [
        ['get-design', {}], ['get-design-pages', { limit: 1 }],
        ['get-design-content', { content_types: ['richtexts'], pages: [1] }],
        ['get-export-formats', {}], ['list-comments', { limit: 1 }],
        ['get-design-dataset', {}],
      ]) await probe(name, { design_id: designId, ...args });
    }
    await writeFile('research/probe-shapes.json', JSON.stringify(shapes, null, 2) + '\n');
  }
}
if (process.argv.includes('--reuse')) {
  tokens = JSON.parse(await readFile('.local/oauth-tokens.json', 'utf8'));
  await discover();
} else {
  let exchanged = false;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(request.url, 'http://127.0.0.1:8976');
    if (url.pathname === '/login') {
      response.writeHead(302, { Location: authorize.href }); response.end(); return;
    }
    if (url.pathname !== '/callback') { response.writeHead(404); response.end('Not found'); return; }
    const receivedState = Buffer.from(url.searchParams.get('state') ?? '');
    const expectedState = Buffer.from(state);
    if (receivedState.length !== expectedState.length || !timingSafeEqual(receivedState, expectedState)) {
      response.writeHead(400); response.end('Invalid OAuth state'); return;
    }
    if (url.searchParams.has('error')) {
      console.error('OAuth rejected:', url.searchParams.get('error'));
      response.writeHead(400); response.end('Canva authorization was not completed.'); return;
    }
    if (exchanged || !url.searchParams.get('code')) { response.writeHead(400); response.end('Invalid callback'); return; }
    exchanged = true;
    try {
      const result = await fetch(metadata.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), client_id: client.client_id, code_verifier: verifier, redirect_uri: redirect, resource: endpoint }) });
      if (!result.ok) throw new Error(`Token exchange HTTP ${result.status}`);
      tokens = await result.json();
      await writeFile(tokenFile, JSON.stringify(tokens), { mode: 0o600 });
      if (writeAuthorization) {
        const granted = new Set((tokens.scope ?? '').split(' '));
        if (!writeScopes.every(s => granted.has(s))) throw new Error('Canva did not grant all requested write scopes');
        console.log('Write authorization complete. Credentials remain in ignored .local/; no writes performed.');
      } else await discover();
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(writeAuthorization ? 'Canva write authorization completed. You may return to Codex.' : 'Canva connected. Tool discovery is complete. You may return to Codex.');
      server.close();
    } catch (error) {
      console.error(error.message);
      response.writeHead(500); response.end('Discovery failed; see the local terminal for the sanitized error.');
      server.close();
    }
  });
  server.listen(8976, '127.0.0.1', () => console.log('Open http://127.0.0.1:8976/login to authenticate with Canva. Requested scopes:', scopes.join(' ')));
  server.on('close', () => clearTimeout(timeout));
  const timeout = setTimeout(() => { console.error('OAuth flow timed out.'); server.close(); }, 15 * 60_000);
}
