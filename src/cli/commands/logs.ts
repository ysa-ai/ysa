import { readFile } from "fs/promises";
import { join } from "path";
import { resolveProjectRoot } from "../git-root";
import { resolveTaskId, logsDir } from "../logs-dir";
import { getProvider } from "../../providers";

export async function logsCommand(
  taskIdArg: string,
  opts: { follow?: boolean; tail?: string; project?: string },
) {
  const projectRoot = await resolveProjectRoot(opts.project);

  const taskId = await resolveTaskId(projectRoot, taskIdArg);
  if (!taskId) {
    console.error(`Task ${taskIdArg} not found in ${logsDir(projectRoot)}`);
    process.exit(1);
  }

  const logPath = join(logsDir(projectRoot), `${taskId}.log`);
  const adapter = getProvider("claude");

  const renderLines = (lines: string[]) => {
    for (const line of lines) {
      try {
        const entry = adapter.parseLogLine(line);
        if (!entry) continue;
        if (entry.type === "assistant" && entry.text) {
          console.log(entry.text);
        } else if (entry.type === "tool_call" && entry.tool) {
          const detail = entry.text ? ` ${entry.text}` : "";
          console.log(`\x1b[90m[${entry.tool}${detail}]\x1b[0m`);
        } else if (entry.type === "result") {
          console.log(`\x1b[90m${entry.text}\x1b[0m`);
        }
      } catch {
        // skip unparseable lines
      }
    }
  };

  let raw: string;
  try {
    raw = await readFile(logPath, "utf-8");
  } catch {
    console.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  const tailN = opts.tail ? parseInt(opts.tail) : undefined;
  renderLines(tailN ? lines.slice(-tailN) : lines);

  if (opts.follow) {
    let offset = raw.length;
    const interval = setInterval(async () => {
      try {
        const content = await readFile(logPath, "utf-8");
        if (content.length > offset) {
          const chunk = content.slice(offset);
          offset = content.length;
          renderLines(chunk.split("\n").filter((l) => l.trim()));
        }
      } catch {
        clearInterval(interval);
      }
    }, 500);
  }
}
