import { createInterface } from "readline";
import { setApiKey, deleteApiKey, getApiKey } from "../keystore";

async function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(prompt);
    const origWrite = (rl as any).output.write.bind((rl as any).output);
    (rl as any).output.write = () => true;
    rl.once("line", (line) => {
      (rl as any).output.write = origWrite;
      process.stdout.write("\n");
      rl.close();
      resolve(line.trim());
    });
  });
}

export async function keyCommand(action: string, provider: string | undefined) {
  if (!provider) {
    console.error("Usage: ysa key set <provider>");
    console.error("       ysa key delete <provider>");
    console.error("       ysa key check <provider>");
    process.exit(1);
  }

  switch (action) {
    case "set": {
      const key = await readSecret(`Enter API key for ${provider}: `);
      if (!key) {
        console.error("No key entered.");
        process.exit(1);
      }
      await setApiKey(provider, key);
      console.log(`API key stored for ${provider}`);
      break;
    }
    case "delete": {
      await deleteApiKey(provider);
      console.log(`API key deleted for ${provider}`);
      break;
    }
    case "check": {
      const stored = await getApiKey(provider);
      if (stored) {
        console.log(`API key for ${provider} is configured (${stored.slice(0, 8)}...)`);
      } else {
        console.log(`No API key configured for ${provider}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(`Unknown action: ${action}. Use set, delete, or check.`);
      process.exit(1);
  }
}
