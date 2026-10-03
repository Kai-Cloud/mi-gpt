// MiGPT v4.2.0 runtime adapter: bind-mount this file and app.js into /app.
// Enable with MIGPT_VOICE_BRIDGE=true, OPENAI_MODEL=voice-agent and the existing
// OPENAI_BASE_URL / OPENAI_API_KEY. No dist rebuild or extra runtime dependency.
import { createRequire } from 'node:module';

// The official image already includes this SDK. Load it only in bridge mode.
const require = createRequire(import.meta.url);

function voiceStream(getSDK, user, model, timeoutMs) {
  const controller = new AbortController();
  let status = 'responding', result, consumed = false;
  let settle;
  const final = new Promise(resolve => { settle = resolve; });
  const finish = (text, canceled = false) => {
    if (status !== 'responding') return;
    status = canceled ? 'canceled' : 'finished';
    result = text;
    clearTimeout(timer);
    controller.abort();
    settle(text);
  };
  // SDK timeout bounds response headers, not the entire SSE iterator.
  const timer = setTimeout(() => finish('请求超时，请稍后重试。'), timeoutMs);
  const response = {
    get status() { return status; },
    cancel() { finish(undefined, true); return status === 'canceled'; },
    getFinalResult() { return final; },
    getNextResponse() {
      const nextSentence = !consumed ? result : undefined;
      if (status !== 'responding') consumed = true;
      return { nextSentence, noMore: status !== 'responding' };
    },
  };
  // Keep the catch on the WHOLE producer, including the real SDK for-await.
  // Buffer until successful completion; never speak a partial failed answer.
  void (async () => {
    const stream = await getSDK().chat.completions.create({
      model, stream: true, messages: [{ role: 'user', content: user }],
    }, { signal: controller.signal, timeout: timeoutMs, maxRetries: 0 });
    let text = '', complete = false;
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      text += choice?.delta?.content || '';
      if (choice?.finish_reason === 'stop') complete = true;
    }
    if (text && !complete) throw new Error('Incomplete voice response');
    finish(text || undefined);
  })().catch(error => {
    const timeout = error?.code === 504 || error?.status === 504 || error?.type === 'timeout'
      || error?.name === 'APIConnectionTimeoutError';
    finish(timeout ? '请求超时，请稍后重试。' : '请求失败，请稍后重试。');
  });
  return response;
}

export function createClient(MiGPT, config, env = process.env) {
  if (env.MIGPT_VOICE_BRIDGE !== 'true') {
    return MiGPT.create(config);
  }
  if (MiGPT.instance) {
    throw new Error('Install the voice bridge before MiGPT.create()');
  }

  // v4.2.0 retains this array and appends two built-in persona commands in
  // MyBot's constructor. Restore the caller commands before starting the loop,
  // without accessing _commands or changing any global class/prototype.
  const commands = [...(config.speaker.commands ?? [])];
  const count = commands.length;
  const client = MiGPT.create({
    ...config,
    speaker: { ...config.speaker, commands },
  });
  commands.splice(count);

  // The public bot property is `ai`, not `bot`. Changing askAI alone is not
  // sufficient: MyBot.run normally overwrites it and initializes local memory.
  const ai = client.ai;
  const timeoutMs = Number(env.MIGPT_VOICE_TIMEOUT_MS ?? 85000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 360000) {
    throw new Error('MIGPT_VOICE_TIMEOUT_MS must be 1-360000 ms');
  }
  const OpenAI = require('openai');
  let sdk;
  const getSDK = () => sdk ??= new OpenAI({ timeout: timeoutMs, maxRetries: 0, fetch: globalThis.fetch });
  // Do not call v4.2.0 chatWithStreamResponse: its detached .then has no catch.
  // This instance-only SpeakerAnswer stream implements the same consumer API.
  ai.ask = async (msg) => ({
    stream: voiceStream(getSDK, msg.text, env.OPENAI_MODEL ?? process.env.OPENAI_MODEL, timeoutMs),
  });
  ai.run = async () => {
    client.speaker.askAI = (msg) => ai.ask(msg);
    return client.speaker.run();
  };
  return client;
}
