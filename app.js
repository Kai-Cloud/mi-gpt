import config from "./.migpt.js";
import { MiGPT } from "./dist/index.cjs";
import { createClient } from "./voice-bridge.js";

async function main() {
  const client = createClient(MiGPT, config);
  await client.start();
}

main();
