import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { Row } from "./types";

type RunPythonOptions = {
  code: string;
  rows: Row[];
  timeoutMs?: number;
  logger?: { write: (obj: Record<string, unknown>) => Promise<void> } | null;
  runId?: string;
};

function safeTempFile(prefix = "um_py_") {
  const dir = os.tmpdir();
  const name = `${prefix}${Date.now()}_${Math.random().toString(36).slice(2,6)}.py`;
  return path.join(dir, name);
}

/**
 * Run user-provided Python code with a small wrapper. The user's code is placed
 * inside a function and will receive `rows` as input. The function should return
 * a JSON-serializable list of rows.
 *
 * Example user code to put in `code`:
 *   # build a new list
 *   out = [ {"a": r['x']*2} for r in rows ]
 *   return out
 *
 */
export async function runPythonTransform(opts: RunPythonOptions): Promise<any[]> {
  const { code, rows, timeoutMs = 30_000, logger = null, runId } = opts;

  // Build wrapper that defines __user_transform(rows) and calls it
  const wrapped = `import sys, json\n\n` +
    `def __user_transform(rows):\n` +
    code
      .split(/\r?\n/)
      .map((l) => (l.trim().length ? `    ${l}` : ""))
      .join("\n") +
    `\n\nif __name__ == '__main__':\n` +
    `    try:\n` +
    `        data = json.load(sys.stdin)\n` +
    `        out = __user_transform(data)\n` +
    `        json.dump(out, sys.stdout)\n` +
    `    except Exception as e:\n` +
    `        import traceback\n` +
    `        traceback.print_exc(file=sys.stderr)\n` +
    `        sys.exit(2)\n`;

  const tmp = safeTempFile();
  await fs.promises.writeFile(tmp, wrapped, "utf8");

  return await new Promise<any[]>((resolve, reject) => {
    const child = spawn("py", [tmp], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const cleanup = () => {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        // ignore
      }
    };

    const onError = (err: Error | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(err);
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill("SIGKILL");
      } catch (e) {}
      cleanup();
      const err = new Error("Python script timed out");
      void logger?.write?.({ ev: "SCRIPT_TIMEOUT", runId, message: (err as Error).message }).catch(() => {});
      reject(err);
    }, timeoutMs);

    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("error", onError);
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      if (stderr && logger) {
        void logger.write({ ev: "SCRIPT_STDERR", runId, stderr }).catch(() => {});
      }
      if (code !== 0) {
        return reject(new Error(`Python exited with code ${code}: ${stderr.slice(0, 2000)}`));
      }
      try {
        const parsed = JSON.parse(stdout || "null");
        if (!Array.isArray(parsed)) {
          return reject(new Error("Python script did not return a JSON array"));
        }
        return resolve(parsed);
      } catch (err) {
        return reject(new Error("Failed to parse JSON output from Python script: " + (err as Error).message + "\nStdout:" + stdout + "\nStderr:" + stderr));
      }
    });

    // send rows on stdin
    try {
      child.stdin.write(JSON.stringify(rows));
      child.stdin.end();
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to write to stdin: " + String(err));
      onError(error);
    }
  });
}
