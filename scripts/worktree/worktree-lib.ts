/**
 * 工作树工具的纯逻辑部分（取材 MirLite scripts/worktree-lib.mjs）：端口分配、git/lsof 输出解析、
 * 回收前的残留分类、合入裁决与失败善后、锁残留判定。不碰文件系统；需要 git 的函数经 runGit 注入，
 * 副作用都在 worktree.ts。
 */
import { resolve, sep } from "node:path";

export type RunGit = (...argv: string[]) => string;

export interface WorktreeEntry {
  path: string;
  /** 检出的分支名（不带 refs/heads/）；detached 为 null */
  branch: string | null;
  /** 被 git worktree lock 锁定（通常是有 Claude 会话在用） */
  locked: boolean;
  /** 第一条是主仓库 */
  main: boolean;
}

/** 解析 `git worktree list --porcelain`；第一条是主仓库 */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const result: WorktreeEntry[] = [];
  for (const block of out.split("\n\n")) {
    const lines = block.split("\n").filter((l) => l !== "");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (path === undefined) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice("branch refs/heads/".length) ?? null;
    const locked = lines.some((l) => l === "locked" || l.startsWith("locked "));
    result.push({ path, branch, locked, main: result.length === 0 });
  }
  return result;
}

/**
 * merge/rm 的目标参数 → 工作树检出的分支名：参数是绝对路径或 worktreesDir 下的目录名
 * （resolve 同时吃两种形态）。命中非主仓库且非 detached 的工作树才返回分支名，否则 null。
 */
export function branchOfWorktreeArg(target: string, worktreesDir: string, list: readonly WorktreeEntry[]): string | null {
  const root = resolve(worktreesDir, target);
  const wt = list.find((w) => w.path === root);
  return wt !== undefined && !wt.main ? wt.branch : null;
}

/** a 是否为 b 的祖先（含同点）；git 异常（引用不存在等）按「不是」处理 */
export function isAncestor(runGit: RunGit, a: string, b: string): boolean {
  try {
    runGit("merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 branch 合入 base（合入纪律）：合入前分支必须已变基到最新 base 并在其上验证，所以这里只接受
 * 「base 是分支祖先」，按快进前移——合进主干的就是验证过的那份代码。分支已并入 → "up-to-date"；
 * 可快进 → "ff"；分叉（base 有分支没有的提交）→ 抛错，不在主仓库做真合并（合出的组合没人验证过，
 * 冲突还会留在主仓库）。runGit 的 cwd 必须是检出 base 的主仓库。
 */
export function mergeIntoBase(runGit: RunGit, base: string, branch: string): "up-to-date" | "ff" {
  if (isAncestor(runGit, branch, base)) return "up-to-date";
  if (!isAncestor(runGit, base, branch)) {
    throw new Error(`[worktree] ${branch} 与 ${base} 已分叉（${base} 有新提交）：回工作树 git rebase ${base}，解决冲突后重新验证再合入`);
  }
  runGit("merge", "--ff-only", branch);
  return "ff";
}

/**
 * 合入失败后的主仓库善后：调用方合入前已确认主仓库干净。若失败后 HEAD 未动而工作区/暂存区有改动，
 * 这些改动只可能是这次合入留下的——实例：快进被发版锁的 reference-transaction 钩子在 prepared 阶段
 * 拒绝，git 已改了工作区与暂存区、引用却没动。用 read-tree 还原到 HEAD（不改任何引用，钩子不拦；
 * 未跟踪文件不碰）。返回是否做了还原；HEAD 已变（合入其实成功）时不动并返回 false。
 */
export function restoreAfterFailedMerge(runGit: RunGit, headBefore: string): boolean {
  if (runGit("rev-parse", "HEAD").trim() !== headBefore) return false;
  if (runGit("status", "--porcelain").trim() === "") return false;
  runGit("read-tree", "--reset", "-u", "HEAD");
  return true;
}

const PORT_SLOTS = 50;

/** 取最小的未占用端口：base 归主仓库，工作树从 base+step 起按 step 递增；taken = 已登记 ∪ 正在监听 */
export function pickPort(taken: ReadonlySet<number>, base: number, step: number): number {
  for (let slot = 1; slot <= PORT_SLOTS; slot++) {
    const port = base + step * slot;
    if (!taken.has(port)) return port;
  }
  throw new Error(`[worktree] ${PORT_SLOTS} 个端口段全部占满，先回收不用的工作树`);
}

/** 解析 `lsof -nP -iTCP -sTCP:LISTEN -Fpn` → pid → 端口列表 */
export function parseLsofListen(out: string): Map<number, number[]> {
  const result = new Map<number, number[]>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid > 0) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (!Number.isInteger(port)) continue;
      const ports = result.get(pid) ?? [];
      if (!ports.includes(port)) ports.push(port);
      result.set(pid, ports);
    }
  }
  return result;
}

/** 解析 `lsof -a -d cwd -Fpn` → pid → 工作目录 */
export function parseLsofCwd(out: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid > 0) result.set(pid, line.slice(1));
  }
  return result;
}

export function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** 仓库相对路径 path 是否落在 prefix 之下（按路径段，prefix 尾斜杠可有可无） */
export function matchesPathPrefix(path: string, prefix: string): boolean {
  const p = prefix.replace(/\/+$/, "");
  return path === p || path.startsWith(`${p}/`);
}

/**
 * 回收后可以重新生成的被忽略路径：依赖、构建产物、缓存、系统垃圾、CodeGraph 索引。生成目录只认
 * 仓库根与 apps/、packages/ 下的包根，同名手工目录落在更深处时照样拦下。宿主的其余产物目录
 * 经 worktree.disposable 配置追加。
 */
const DISPOSABLE = [
  /(^|\/)node_modules\/$/,
  /^((apps|packages)\/[^/]+\/)?(dist|build|out|coverage|\.cache|\.tmp|\.vite|logs)\/$/,
  /\.(tsbuildinfo|log)$/,
  /(^|\/)\.DS_Store$/,
  // CodeGraph 索引 db 不入 git，建树时在本树重建；目录里跟踪着 .gitignore 壳，git 逐文件列行
  /^\.codegraph\//,
];

/**
 * 把 `git status --porcelain --ignored` 的行分成「回收会丢、必须拦」和「可再生、直接删」。
 * 可删 = 内置产物白名单、宿主登记的可再生路径（extraDisposable，按路径段前缀），或路径本身是软链
 * （删链不删目标）。isDisposableSymlink 对文件行回答「路径本身是软链」，对 dir/ 行回答「目录里
 * 是否只有软链」——git 把全部内容被忽略的目录坍缩成一条 dir/ 行，只有整目录纯软链才可随树删。
 */
export function classifyLeftovers(
  lines: readonly string[],
  isDisposableSymlink: (path: string) => boolean,
  extraDisposable: readonly string[] = [],
): { blocking: string[]; disposable: string[] } {
  const blocking: string[] = [];
  const disposable: string[] = [];
  for (const line of lines) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).replace(/^"(.*)"$/, "$1");
    if (code !== "!!") {
      blocking.push(path);
      continue;
    }
    const regenerable =
      DISPOSABLE.some((re) => re.test(path)) ||
      extraDisposable.some((prefix) => matchesPathPrefix(path, prefix)) ||
      isDisposableSymlink(path);
    (regenerable ? disposable : blocking).push(path);
  }
  return { blocking, disposable };
}

/** readdir 结果的最小形状（生产传 `(dir) => readdirSync(dir, { withFileTypes: true })`） */
export interface DirEntryLike {
  name: string;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
}

/** 目录里是否只有软链（真子目录递归同判；空目录没有可丢内容，视同为真） */
export function dirOfSymlinksOnly(dir: string, readdir: (dir: string) => readonly DirEntryLike[]): boolean {
  for (const entry of readdir(dir)) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) return false;
    if (!dirOfSymlinksOnly(`${dir}/${entry.name}`, readdir)) return false;
  }
  return true;
}

export const DEFAULT_LOCK_MAX_AGE_MS = 20 * 60_000;

/**
 * 目录锁残留判定（合入锁）。pidText = 锁内 pid 文件内容（没有为 null），ageMs = 锁目录存在时长，
 * alive(pid) = 进程是否还在。超过 maxAgeMs 无论进程死活都算残留（防卡死挂起）；pid 有效看进程
 * 死活；没写或写坏的，刚建的锁可能正在写，超过 10 秒才算残留。
 */
export function isLockStale(input: { pidText: string | null; ageMs: number; alive: (pid: number) => boolean; maxAgeMs?: number }): boolean {
  if (input.ageMs > (input.maxAgeMs ?? DEFAULT_LOCK_MAX_AGE_MS)) return true;
  const text = input.pidText?.trim() ?? "";
  const pid = /^\d+$/.test(text) ? Number(text) : 0;
  if (pid > 0) return !input.alive(pid);
  return input.ageMs > 10_000;
}

/** 并发合入被拒（Fail-Fast）时的提示：谁在合、PID、被拒者接下来做什么 */
export function formatMergeConflictNotice(input: { branch: string | null; pid: string | null; base: string }): string {
  const branch = input.branch?.trim() ?? "";
  const pid = input.pid?.trim() ?? "";
  const who = branch === "" ? "另一个分支" : `分支 ${branch}`;
  const pidInfo = /^\d+$/.test(pid) ? `（PID ${pid}）` : "";
  return (
    `[worktree] ✖ 无法合入：${who} 正在合入 ${input.base} 并做合入后验证${pidInfo}。\n` +
    `等它完成后，回你的工作树 git rebase ${input.base} 并重新验证，再执行合入。`
  );
}
