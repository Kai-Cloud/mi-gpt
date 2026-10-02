// MiGPT v4.2.0 runtime adapter: bind-mount this file and app.js into /app.
// Enable with MIGPT_VOICE_BRIDGE=true, OPENAI_MODEL=voice-agent and the existing
// OPENAI_BASE_URL / OPENAI_API_KEY. No dist rebuild or extra runtime dependency.
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
  ai.ask = async (msg) => ({
    stream: await ai.constructor.chatWithStreamResponse({
      user: msg.text,
      enableSearch: false,
    }),
  });
  ai.run = async () => {
    client.speaker.askAI = (msg) => ai.ask(msg);
    return client.speaker.run();
  };
  return client;
}
