// Offline compatibility tests against the published mi-gpt@4.2.0 bundle.
// Setup (no Prisma engines, lifecycle scripts, or device access):
// mkdir -p node_modules/.voice-bridge-test
// npm pack mi-gpt@4.2.0 --pack-destination node_modules/.voice-bridge-test --ignore-scripts
// tar -xzf node_modules/.voice-bridge-test/mi-gpt-4.2.0.tgz -C node_modules/.voice-bridge-test
// Then install only the SDK (never run npm install at the repository root):
// npm install --prefix node_modules/.voice-bridge-test --no-save --package-lock=false --ignore-scripts openai@4.56.0
// node --test tests/voice-bridge.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInThisContext, runInNewContext } from 'node:vm';
import { createServer, Agent } from 'node:http';
import { once } from 'node:events';

const root = new URL('../', import.meta.url);
const bundleURL = process.env.MIGPT_TEST_BUNDLE
  ? new URL(`file:///${process.env.MIGPT_TEST_BUNDLE.replaceAll('\\', '/')}`)
  : new URL('node_modules/.voice-bridge-test/package/dist/index.cjs', root);
const bundlePath = fileURLToPath(bundleURL);
const requireBundle = createRequire(bundleURL);
const { createClient } = await import(new URL('voice-bridge.js', root));

function forbidden() { throw new Error('Unexpected database/filesystem/device access'); }
function loadMiGPT() {
  const module = { exports: {} };
  // Only external device/persistence/proxy boundaries are substituted. MyBot,
  // AISpeaker, StreamResponse and the OpenAI wrapper/SDK are the real release.
  const boundary = {
    'mi-service-lite': { getMiNA: forbidden, getMiIOT: forbidden },
    '@prisma/client': { PrismaClient: class {} },
    'fs-extra': new Proxy({}, { get: () => forbidden }),
    'proxy-agent': { ProxyAgent: Agent },
  };
  const execute = runInThisContext(
    `(function(require, module, exports, __filename, __dirname) {${readFileSync(bundlePath, 'utf8')}\n})`,
    { filename: bundlePath },
  );
  execute((id) => boundary[id] ?? requireBundle(id), module, module.exports,
    bundlePath, fileURLToPath(new URL('.', bundleURL)));
  return module.exports.MiGPT;
}

function config(commands = []) {
  return {
    bot: { name: 'LOCAL_PERSONA', profile: 'DO_NOT_SEND_PERSONA' },
    systemTemplate: 'DO_NOT_SEND_SYSTEM',
    speaker: { userId: 'test-only', password: 'test-only', commands },
  };
}

async function ingress(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
    respond(res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const values = {
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
    OPENAI_API_KEY: 'local-test-key', OPENAI_MODEL: 'voice-agent',
    AZURE_OPENAI_API_KEY: undefined, AZURE_OPENAI_DEPLOYMENT: undefined,
    QWEN_ENABLE_SEARCH: 'true',
  };
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
  }
  return requests;
}

test('app entry actually installs the bridge before starting the client', async (t) => {
  await ingress(t, sse);
  const oldFlag = process.env.MIGPT_VOICE_BRIDGE;
  process.env.MIGPT_VOICE_BRIDGE = 'true';
  t.after(() => { if (oldFlag === undefined) delete process.env.MIGPT_VOICE_BRIDGE; else process.env.MIGPT_VOICE_BRIDGE = oldFlag; });
  const MiGPT = loadMiGPT();
  let client;
  MiGPT.prototype.start = async function () { client = this; };
  // Run the real entry with only its imports supplied by this offline harness.
  const source = readFileSync(new URL('app.js', root), 'utf8').replace(/^import .*;\r?\n/gm, '');
  await runInNewContext(source, { config: config(), MiGPT, createClient });
  assert.ok(client);
  client.ai.manager = new Proxy({}, { get: forbidden });
  const { stream } = await client.ai.ask({ text: '入口测试', timestamp: 123 });
  assert.equal(await stream.getFinalResult(), '桥接回答。');
});

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
  res.write('data: {"choices":[{"delta":{"content":"桥接"}}]}\n\n');
  res.end('data: {"choices":[{"delta":{"content":"回答。"}}]}\n\ndata: [DONE]\n\n');
}

for (const flag of [undefined, 'false', 'TRUE']) {
  test(`default behavior stays intact for MIGPT_VOICE_BRIDGE=${flag}`, () => {
    const MiGPT = loadMiGPT();
    const client = createClient(MiGPT, config(), { MIGPT_VOICE_BRIDGE: flag });
    assert.equal(client.ai.ask, client.ai.constructor.prototype.ask);
    assert.equal(client.ai.run, client.ai.constructor.prototype.run);
    assert.equal(client.speaker.commands.filter(c => c.match({ text: '你是测试你喜欢读书' })).length, 2);
  });
}

test('bridge sends only QueryMessage.text over HTTP and returns a real consumable SpeakerAnswer stream', { timeout: 5000 }, async (t) => {
  const requests = await ingress(t, sse);
  const MiGPT = loadMiGPT();
  const client = createClient(MiGPT, config(), { MIGPT_VOICE_BRIDGE: 'true' });
  client.ai.manager = new Proxy({}, { get: forbidden });
  // Stop only the device loop; exercise the real adapter run and askAI binding.
  client.speaker.run = async () => 'device-loop-disabled';
  assert.equal(await client.ai.run(), 'device-loop-disabled');
  const answer = await client.speaker.askAI({
    text: '  请问今天适合散步吗？\n', answer: 'DO_NOT_SEND_XIAOAI', timestamp: 123,
  });
  assert.deepEqual(Object.keys(answer), ['stream']);
  assert.equal(await answer.stream.getFinalResult(), '桥接回答。');
  assert.deepEqual(answer.stream.getNextResponse(), { nextSentence: '桥接回答。', noMore: true });
  assert.deepEqual(requests, [{
    method: 'POST', url: '/v1/chat/completions', auth: 'Bearer local-test-key',
    body: { model: 'voice-agent', stream: true, messages: [{ role: 'user', content: '  请问今天适合散步吗？\n' }] },
  }]);
});

test('bridge removes built-in persona commands but preserves caller commands and wake/exit routing', async () => {
  const MiGPT = loadMiGPT();
  const custom = { match: msg => msg.text === '自定义指令', run: async () => ({ text: '自定义回答' }) };
  const commands = [custom];
  const client = createClient(MiGPT, config(commands), { MIGPT_VOICE_BRIDGE: 'true' });
  assert.deepEqual(commands, [custom], 'must not mutate the caller command array');
  assert.equal(client.speaker.commands.find(c => c.match({ text: '自定义指令' })), custom);
  client.ai.manager = new Proxy({}, { get: forbidden });
  client.speaker.keepAlive = true;
  const forwarded = [];
  client.speaker.askAIForAnswer = async msg => { forwarded.push(msg.text); };
  for (const text of ['你是测试你喜欢读书', '我是测试我喜欢读书']) {
    await client.speaker.commands.find(c => c.match({ text })).run({ text, timestamp: 123 });
  }
  assert.deepEqual(forwarded, ['你是测试你喜欢读书', '我是测试我喜欢读书']);
  let exited = false;
  client.speaker.exitKeepAlive = async () => { exited = true; };
  await client.speaker.commands.find(c => c.match({ text: '退出' })).run({ text: '退出' });
  assert.equal(exited, true);
  client.speaker.keepAlive = false;
  let entered = false;
  client.speaker.enterKeepAlive = async () => { entered = true; };
  await client.speaker.commands.find(c => c.match({ text: '进入' })).run({ text: '进入' });
  assert.equal(entered, true);
});

test('bridge refuses a pre-existing singleton instead of leaving persona commands active', () => {
  const MiGPT = loadMiGPT();
  MiGPT.create(config());
  assert.throws(() => createClient(MiGPT, config(), { MIGPT_VOICE_BRIDGE: 'true' }), /before.*create/i);
});

test('empty SSE terminates with no spoken result rather than waiting forever', { timeout: 5000 }, async (t) => {
  await ingress(t, res => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const client = createClient(loadMiGPT(), config(), { MIGPT_VOICE_BRIDGE: 'true' });
  client.ai.manager = new Proxy({}, { get: forbidden });
  const { stream } = await client.ai.ask({ text: '问题', timestamp: 123 });
  assert.equal(await stream.getFinalResult(), undefined);
  assert.equal(stream.getNextResponse().noMore, true);
});
