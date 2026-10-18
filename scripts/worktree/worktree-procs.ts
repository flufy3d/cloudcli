/**
 * ProcessProbe 的本机实现：lsof 查监听端口与工作目录、ps 查祖先链与命令行、pm2 jlist 查应用。
 * 只支持 macOS / Linux（依赖 lsof、ps）；没装 pm2 视为没有 pm2 应用。
 */
import { execFileSync } from "node:child_process";
import type { ProcessProbe } from "./worktree.ts";
import { isInside, parseLsofCwd, parseLsofListen } from "./worktree-lib.ts";

function errField(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null && key in error ? (error as Record<string, unknown>)[key] : undefined;
}

/** lsof 无匹配时退出码为 1，这不是错误 */
function lsof(argv: readonly string[]): string {
  try {
    return execFileSync("lsof", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    if (errField(error, "status") === 1) {
      const out = errField(error, "stdout");
      return typeof out === "string" ? out : "";
    }
    throw error;
  }
}

/** 进程是否还在：只有 ESRCH 算不在（EPERM = 在，只是无权发信号） */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errField(error, "code") !== "ESRCH";
  }
}

/** 同步睡眠（锁轮询、等进程退出用） */
export function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * pm2 jlist 输出 → 应用列表。daemon 没在跑时 pm2 会先往 stdout 打「[PM2] Spawning...」之类的横幅，
 * JSON 在单独一行：从后往前取第一行能解析成数组的。解析不出返回 null（调用方当作没有 pm2 应用并告警）。
 */
export function parsePm2List(raw: string): Array<{ name: string; cwd: string }> | null {
  let apps: unknown[] | null = null;
  for (const line of raw.split("\n").reverse()) {
    if (!line.trim().startsWith("[")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (Array.isArray(parsed)) {
        apps = parsed;
        break;
      }
    } catch {
      // 横幅行，继续往前找
    }
  }
  if (apps === null) return null;
  return apps.flatMap((a: unknown) => {
    const name = errField(a, "name");
    const cwd = errField(errField(a, "pm2_env"), "pm_cwd");
    return typeof cwd === "string" && name !== undefined ? [{ name: String(name), cwd }] : [];
  });
}

export function systemProcessProbe(): ProcessProbe {
  return {
    listening: () => parseLsofListen(lsof(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"])),
    cwdOf: (pids) => (pids.length === 0 ? new Map() : parseLsofCwd(lsof(["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]))),
    ancestors: () => {
      const result = new Set<number>();
      let pid = process.pid;
      while (pid > 1 && !result.has(pid)) {
        result.add(pid);
        try {
          pid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
        } catch {
          break; // 祖先刚好退出：链到此为止
        }
      }
      return result;
    },
    describe: (pid) => {
      try {
        return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" })
          .trim()
          .slice(0, 120);
      } catch {
        return "?";
      }
    },
    stop: (pid) => {
      // 查到 pid 到动手之间进程可能已自行退出：ESRCH 视为已停
      const signal = (sig: NodeJS.Signals): void => {
        try {
          process.kill(pid, sig);
        } catch (error) {
          if (errField(error, "code") !== "ESRCH") throw error;
        }
      };
      signal("SIGTERM");
      for (let i = 0; i < 30 && pidAlive(pid); i++) sleepMs(100);
      if (pidAlive(pid)) signal("SIGKILL");
    },
    pm2AppsIn: (root) => {
      let raw: string;
      try {
        raw = execFileSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch (error) {
        if (errField(error, "code") === "ENOENT") return [];
        throw error;
      }
      const apps = parsePm2List(raw);
      if (apps === null) {
        process.stderr.write(`[worktree] ⚠ pm2 jlist 输出解析不出，按没有 pm2 应用处理（前 80 字符：${raw.slice(0, 80)}）\n`);
        return [];
      }
      return apps.filter((a) => isInside(a.cwd, root)).map((a) => a.name);
    },
    pm2Delete: (name) => {
      execFileSync("pm2", ["delete", name], { stdio: "ignore" });
    },
  };
}
