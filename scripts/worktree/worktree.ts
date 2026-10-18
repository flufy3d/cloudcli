/**
 * 并行开发工作树的建、合、收、查（机制见 docs/design/并行开发工作树.md；移植自 nexus-kit
 * packages/devflow，源头取材 MirLite scripts/worktree.mjs）。
 *
 * git worktree 只检出被跟踪的文件，不入 git 的共享资源（构建计数器、大素材目录）新工作树天然
 * 没有——建树时按 worktree.share 软链回主仓库；isolate 把某个共享目录改为本树独立的一份。
 * 端口登记在工作树自己的 git 目录（<git-dir>/worktree-port），随工作树一起消失；分配时避开所有
 * 已登记端口与正在监听的端口，并发建树靠目录锁串行。
 *
 * 合入只快进：分支必须先在工作树变基到最新主干并验证，分叉即拒绝；被引用钩子（发版锁）拦下时
 * 把主仓库残留还原到 HEAD。全程持合入锁，并发合入 Fail-Fast 拒绝，不排队死等。合入后在主仓库
 * 跑 worktree.postMerge，失败非零退出。
 *
 * 回收先停服务再删目录：git worktree remove 只删文件，里面起的预览服务、pm2 应用会继续占着端口。
 * 未提交改动和不可再生的被忽略文件让回收拒绝执行。
 *
 * git 走真子进程（测试用临时仓库跑真 git）；进程探测与命令执行经 WorktreeEnv 注入。
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WorktreeConfig } from "./config.ts";
import { pidAlive, sleepMs } from "./worktree-procs.ts";
import {
  branchOfWorktreeArg,
  classifyLeftovers,
  dirOfSymlinksOnly,
  formatMergeConflictNotice,
  isInside,
  isLockStale,
  mergeIntoBase,
  parseWorktreeList,
  pickPort,
  restoreAfterFailedMerge,
  type WorktreeEntry,
} from "./worktree-lib.ts";

/** 本机进程探测与处置（生产实现见 worktree-procs.ts） */
export interface ProcessProbe {
  /** pid → 监听端口 */
  listening(): Map<number, number[]>;
  /** pid → 工作目录 */
  cwdOf(pids: readonly number[]): Map<number, string>;
  /** 本进程及其祖先：回收钩子可能就跑在该工作树的会话里，不能停掉自己 */
  ancestors(): Set<number>;
  describe(pid: number): string;
  /** SIGTERM，等 3 秒不退再 SIGKILL */
  stop(pid: number): void;
  /** 工作目录落在 root 内的 pm2 应用名；不先删掉的话杀进程会被 pm2 拉起来 */
  pm2AppsIn(root: string): string[];
  pm2Delete(name: string): void;
}

export interface WorktreeEnv {
  /** 调用方所在目录（主仓库或任一工作树内） */
  cwd: string;
  config: WorktreeConfig;
  log(message: string): void;
  procs: ProcessProbe;
  /** 执行命令（输出不进 stdout，钩子模式下 stdout 只许输出路径）；非零退出抛错 */
  run(cmd: string, args: readonly string[], cwd: string): void;
}

const PORT_FILE = "worktree-port";
const CREATE_LOCK = "worktree-create.lock";
const MERGE_LOCK = "worktree-merge.lock";
/** Claude 建树钩子起的分支前缀：合并过就随回收删除 */
const HOOK_BRANCH_PREFIX = "worktree-";

function git(cwd: string, ...argv: string[]): string {
  return gitRaw(cwd, ...argv).trim();
}

/** 只去行尾空白：porcelain 行首的状态列含空格（如 " M a.ts"），trim 会截掉第一行路径的首字符 */
function gitRaw(cwd: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    // 精确解析 refs/heads/<名>：branch --list 是通配匹配，fix/* 这类输入会误中别的分支
    git(cwd, "rev-parse", "-q", "--verify", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

/** 钩子 stdin 的 JSON：只认对象 */
function objectInput(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

/** 判定锁残留时看到的样子：锁目录 mtime 与锁内 pid 文件内容 */
export interface LockSnapshot {
  mtimeMs: number;
  pid: string | null;
}

/**
 * 清残锁：先改名到唯一名字（rename 原子，两个进程同时清只有一个成功），再核对搬走的正是判定残留时看到的
 * 那把锁（mtime 与 pid 都相同）。判定与改名之间别人可能已清掉旧锁并建了新锁——搬错了就原样放回，
 * 不把别人刚拿到的锁删掉。返回是否真清掉了残锁。
 */
export function removeStaleLock(lock: string, seen: LockSnapshot): boolean {
  const grave = `${lock}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lock, grave);
  } catch (error) {
    if (errCode(error) === "ENOENT") return false;
    throw error;
  }
  let same = false;
  try {
    same = statSync(grave).mtimeMs === seen.mtimeMs && readText(join(grave, "pid")) === seen.pid;
  } catch {}
  if (!same) {
    try {
      renameSync(grave, lock);
    } catch (error) {
      throw new Error(`[worktree] 清残锁时误搬了别人刚建的锁且放不回去：${grave} → ${lock}，请手动检查`, { cause: error });
    }
    return false;
  }
  rmSync(grave, { recursive: true, force: true });
  return true;
}

function snapshotLock(lock: string): LockSnapshot | null {
  try {
    return { mtimeMs: statSync(lock).mtimeMs, pid: readText(join(lock, "pid")) };
  } catch {
    return null;
  }
}

/** 释放锁：只删锁内 pid 是本进程的（锁被当成残锁清掉、又被别人重建时，不删别人的） */
function releaseLock(lock: string): void {
  if (readText(join(lock, "pid")) === String(process.pid)) rmSync(lock, { recursive: true, force: true });
}

function errCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** 解析出的仓库布局：主仓库根、git 公共目录、工作树父目录 */
interface Layout {
  mainRoot: string;
  commonDir: string;
  worktreesDir: string;
}

function layoutOf(env: WorktreeEnv): Layout {
  const commonDir = realpathSync(git(env.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const mainRoot = dirname(commonDir);
  const worktreesDir = resolve(mainRoot, env.config.dir);
  return { mainRoot, commonDir, worktreesDir };
}

function worktrees(layout: Layout): WorktreeEntry[] {
  return parseWorktreeList(git(layout.mainRoot, "worktree", "list", "--porcelain"));
}

function registeredPorts(layout: Layout): Map<string, number> {
  const result = new Map<string, number>();
  for (const wt of worktrees(layout)) {
    if (wt.main || !existsSync(wt.path)) continue;
    let gitDir: string;
    try {
      gitDir = git(wt.path, "rev-parse", "--absolute-git-dir");
    } catch {
      continue; // 损坏的工作树（.git 文件失效）：不登记端口，不拖垮 new/ls
    }
    const file = join(gitDir, PORT_FILE);
    if (existsSync(file)) result.set(wt.path, Number(readFileSync(file, "utf8").trim()));
  }
  return result;
}

/** 目录锁：mkdir 原子；正常持锁只有几秒，超过一分钟视为崩溃残留 */
function withCreateLock<T>(layout: Layout, fn: () => T): T {
  const lock = join(layout.commonDir, CREATE_LOCK);
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
      const seen = snapshotLock(lock);
      if (seen !== null && Date.now() - seen.mtimeMs > 60_000) removeStaleLock(lock, seen);
      if (Date.now() > deadline) throw new Error(`[worktree] 等建树锁超时：${lock}`, { cause: error });
      sleepMs(100);
    }
  }
  try {
    writeFileSync(join(lock, "pid"), String(process.pid));
    return fn();
  } finally {
    releaseLock(lock);
  }
}

// ───────────── new ─────────────

export interface NewOptions {
  branch: string;
  /** 新分支起点，默认主干 */
  from?: string;
  /** 不挂软链、留空目录的共享项 */
  isolate?: readonly string[];
}

function assertShareNames(config: WorktreeConfig, names: readonly string[]): void {
  const unknown = names.filter((n) => !config.share.includes(n.replace(/\/+$/, "")));
  if (unknown.length > 0) {
    throw new Error(`[worktree] 未知共享项：${unknown.join(",")}；可选 ${config.share.join(",") || "（worktree.share 为空）"}`);
  }
}

/** 建树 + 挂软链 + 登记端口 + postCreate；返回工作树根与端口。任一步失败整体回滚 */
export function worktreeNew(env: WorktreeEnv, opts: NewOptions): { root: string; port: number } {
  if (opts.branch === "" || opts.branch.startsWith("-")) throw new Error(`[worktree] 非法分支名：${opts.branch}`);
  if (opts.from?.startsWith("-") === true) throw new Error(`[worktree] 非法起点：${opts.from}`);
  const isolate = (opts.isolate ?? []).map((n) => n.replace(/\/+$/, ""));
  assertShareNames(env.config, isolate);
  const layout = layoutOf(env);
  const root = resolve(layout.worktreesDir, basename(opts.branch));
  if (existsSync(root)) throw new Error(`[worktree] 目标已存在：${root}`);
  return createWorktree(env, layout, root, opts.branch, opts.from ?? env.config.base, new Set(isolate));
}

function createWorktree(
  env: WorktreeEnv,
  layout: Layout,
  root: string,
  branch: string,
  from: string,
  isolate: ReadonlySet<string>,
): { root: string; port: number } {
  const existed = branchExists(layout.mainRoot, branch);
  let added = false;
  try {
    const port = withCreateLock(layout, () => {
      mkdirSync(layout.worktreesDir, { recursive: true });
      git(layout.mainRoot, "worktree", "add", ...(existed ? [root, branch] : [root, "-b", branch, from]));
      added = true;
      const taken = new Set([...registeredPorts(layout).values(), ...[...env.procs.listening().values()].flat()]);
      const picked = pickPort(taken, env.config.portBase, env.config.portStep);
      writeFileSync(join(git(root, "rev-parse", "--absolute-git-dir"), PORT_FILE), `${picked}\n`);
      return picked;
    });
    env.log(`[worktree] 已创建 ${root}（${existed ? "检出既有分支" : `自 ${from} 新建`} ${branch}），预览端口 ${port}`);
    linkShares(env, layout, root, isolate);
    warnMissingHooks(env, root);
    for (const [cmd, ...args] of env.config.postCreate) env.run(cmd!, args, root);
    buildCodeGraph(env, layout, root);
    return { root, port };
  } catch (error) {
    if (added) {
      // 回滚自己失败时不能盖住真正的失败原因：原错误照抛，回滚问题附在日志里
      try {
        git(layout.mainRoot, "worktree", "remove", "--force", root);
        if (!existed) git(layout.mainRoot, "branch", "-D", branch);
        env.log(`[worktree] 建树失败，已回滚 ${root}`);
      } catch (rollbackError) {
        env.log(`[worktree] ⚠ 建树失败且回滚未完成（${String(rollbackError).slice(0, 200)}）——手动检查 ${root} 与分支 ${branch}`);
      }
    }
    throw error;
  }
}

function linkShares(env: WorktreeEnv, layout: Layout, root: string, isolate: ReadonlySet<string>): void {
  const shared: string[] = [];
  for (const rel of env.config.share) {
    const link = join(root, rel);
    if (isolate.has(rel)) {
      mkdirSync(link, { recursive: true });
      env.log(`[worktree] ${rel} 已隔离为空目录，由本工作树自己生成`);
      continue;
    }
    const target = join(layout.mainRoot, rel);
    if (!existsSync(target)) {
      env.log(`[worktree] 主仓库没有 ${rel}，跳过共享——本树会各用各的一份`);
      continue;
    }
    // 被跟踪的同名文件会被检出：共享项必须是不入 git 的路径，撞上直接报错而不是覆盖
    if (statOrNull(link) !== null) throw new Error(`[worktree] 共享项 ${rel} 在工作树里已存在（被 git 跟踪？）——共享项必须不入 git`);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link);
    shared.push(rel);
  }
  if (shared.length > 0) env.log(`[worktree] 已软链回主仓库共享：${shared.join("、")}`);
}

/**
 * core.hooksPath 是相对路径时，git 在每个工作树里按该树的根目录找钩子：钩子目录没入库，新树里就没有
 * CHANGELOG 门禁和发版锁，而且不报任何错。这里只警告不阻断（入库是宿主仓库的事）。
 */
function warnMissingHooks(env: WorktreeEnv, root: string): void {
  let hooksPath: string;
  try {
    hooksPath = git(root, "config", "core.hooksPath");
  } catch {
    return; // 未配置：用 .git/hooks，各工作树共享
  }
  if (hooksPath === "" || hooksPath.startsWith("/") || hooksPath.startsWith("~")) return;
  if (!existsSync(join(root, hooksPath))) {
    env.log(
      `[worktree] ⚠ 工作树里没有 ${hooksPath}/：core.hooksPath 按工作树相对解析，钩子目录没入库，本树的提交门禁与发版锁不生效——把 ${hooksPath}/ 提交入库`,
    );
  }
}

/**
 * CodeGraph 索引 db 不随 git 检出，工作树里只有空壳；索引要反映本树代码（含未提交改动），
 * 所以主仓库建过索引时每树独立重建，不软链共享。失败不阻断建树。
 */
function buildCodeGraph(env: WorktreeEnv, layout: Layout, root: string): void {
  if (!existsSync(join(layout.mainRoot, ".codegraph"))) return;
  try {
    env.run("codegraph", ["init", "-y"], root);
    env.log("[worktree] CodeGraph 索引已在本树建好（改码后跑 codegraph sync 追平）");
  } catch (error) {
    env.log(`[worktree] CodeGraph 索引建失败（不阻断，需要时手动 codegraph init -y）：${String(error).slice(0, 200)}`);
  }
}

// ───────────── isolate ─────────────

/**
 * 在当前工作树把共享项改为本树独立：默认复制主仓库现有内容，empty 留空目录；已是本地目录的保留。
 * 先全部预检、再全部暂存副本：任一项复制失败时所有共享关系不变。替换阶段某项改名失败，该项恢复软链，
 * 之前已替换的项保持独立（已替换的项是完整副本，不需要回退）。
 */
export function worktreeIsolate(env: WorktreeEnv, names: readonly string[], empty: boolean): void {
  const rels = names.map((n) => n.replace(/\/+$/, ""));
  assertShareNames(env.config, rels);
  const layout = layoutOf(env);
  const root = realpathSync(git(env.cwd, "rev-parse", "--show-toplevel"));
  if (root === layout.mainRoot) throw new Error("[worktree] isolate 只能在工作树里执行");

  const pending: Array<{ path: string; target: string | null }> = [];
  for (const rel of rels) {
    const path = join(root, rel);
    const st = statOrNull(path);
    if (st?.isSymbolicLink()) {
      const expected = join(layout.mainRoot, rel);
      const target = readlinkSync(path);
      if (resolve(dirname(path), target) !== expected || !statOrNull(expected)?.isDirectory()) {
        throw new Error(`[worktree] ${rel} 不是指向主仓库目录的共享软链（${target}），无法隔离`);
      }
      pending.push({ path, target: expected });
    } else if (st === null) {
      pending.push({ path, target: null });
    } else if (!st.isDirectory()) {
      throw new Error(`[worktree] 隔离目标不是目录：${path}`);
    }
  }
  const staged: Array<{ path: string; target: string | null; temp: string }> = [];
  try {
    for (const item of pending) {
      mkdirSync(dirname(item.path), { recursive: true });
      const temp = mkdtempSync(join(dirname(item.path), ".isolate-"));
      staged.push({ ...item, temp });
      if (!empty && item.target !== null) cpSync(item.target, temp, { recursive: true, dereference: true });
    }
    for (const item of staged) {
      if (item.target !== null) unlinkSync(item.path);
      try {
        renameSync(item.temp, item.path);
      } catch (error) {
        if (item.target !== null) symlinkSync(item.target, item.path);
        throw error;
      }
    }
  } finally {
    for (const item of staged) rmSync(item.temp, { recursive: true, force: true });
  }
  env.log(`[worktree] ${rels.join("、")} 已隔离为本树独立${empty ? "（空目录）" : "（复制自主仓库）"}`);
}

// ───────────── merge ─────────────

/** merge 的参数 → 分支名：分支名优先，没命中再按目录名/路径反查（与 rm 同口径） */
function resolveBranchArg(layout: Layout, arg: string): string {
  if (branchExists(layout.mainRoot, arg)) return arg;
  const list = worktrees(layout);
  const root = resolveWorktreeArg(layout, list, arg);
  const branch = root === null ? null : branchOfWorktreeArg(root, layout.worktreesDir, list);
  if (branch === null) throw new Error(`[worktree] 分支不存在：${arg}（pnpm worktree:ls 查看全部工作树与分支）`);
  return branch;
}

/**
 * 工作树名或路径 → 已登记的工作树根：先按工作树目录下的名字找，再按路径找（当前目录里恰好有同名
 * 目录时不被它带偏）。都不是已登记的工作树返回 null。
 */
function resolveWorktreeArg(layout: Layout, list: readonly WorktreeEntry[], arg: string): string | null {
  const candidates = [resolve(layout.worktreesDir, arg), ...(existsSync(arg) ? [realpathSync(arg)] : [])];
  return candidates.find((c) => list.some((w) => w.path === c)) ?? null;
}

/** 合回主干（只快进）+ 合入后命令；返回 "ff" 或 "up-to-date" */
export function worktreeMerge(env: WorktreeEnv, arg: string): "ff" | "up-to-date" {
  const base = env.config.base;
  if (arg === "" || arg.startsWith("-")) throw new Error(`[worktree] 非法分支名：${arg}`);
  const layout = layoutOf(env);
  const branch = resolveBranchArg(layout, arg);
  if (branch === base) throw new Error(`[worktree] ${base} 合入 ${base} 没有事可做`);
  return withMergeLock(layout, branch, base, () => {
    const runMain = (...a: string[]): string => git(layout.mainRoot, ...a);
    const on = runMain("branch", "--show-current");
    if (on !== base) throw new Error(`[worktree] 主仓库当前检出 ${on || "（detached）"}，合入目标是 ${base}，先切回 ${base} 再合`);
    const dirty = gitRaw(layout.mainRoot, "status", "--porcelain");
    if (dirty !== "") throw new Error(`[worktree] 主仓库工作区不干净，先提交或挪走：\n${dirty}`);

    const headBefore = runMain("rev-parse", "HEAD");
    let mode: "ff" | "up-to-date";
    try {
      mode = mergeIntoBase(runMain, base, branch);
    } catch (error) {
      let restored = false;
      let restoreNote = "";
      try {
        restored = restoreAfterFailedMerge(runMain, headBefore);
      } catch (restoreError) {
        // 善后失败不能盖住合入失败的原因：照报原错误，附上还原问题
        restoreNote = `\n[worktree] ⚠ 主仓库残留还原失败（${String(restoreError).slice(0, 200)}）——手动 git status 检查`;
      }
      const detail = [stderrOf(error)].filter((s) => s !== "").join("\n");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${detail === "" ? "" : `\n${detail}`}` +
          (restored ? `\n[worktree] ${base} 未前移，合入残留已还原，主仓库干净` : "") +
          restoreNote,
        { cause: error },
      );
    }
    if (mode === "up-to-date") {
      env.log(`[worktree] ${branch} 已全部在 ${base} 里，无事可做`);
      return mode;
    }
    env.log(`[worktree] 已快进合入 ${branch}：${base} 前移，无合并节点`);
    for (const [cmd, ...args] of env.config.postMerge) {
      const line = [cmd, ...args].join(" ");
      env.log(`[worktree] 合入后验证：${line}`);
      try {
        env.run(cmd!, args, layout.mainRoot);
      } catch (error) {
        throw new Error(
          `[worktree] ✖ ${branch} 已合入 ${base}，但主仓库 ${line} 失败（输出见上方）——${base} 当前没通过合入后验证，` +
            "必须继续排查修复（修复同样走工作树合回），不得当成功收工" +
            // 按锁文件安装失败，多半是依赖改动没提交全，不是构建坏了：直接点明检查方向
            (/\binstall\b/.test(line) && line.includes("--frozen-lockfile")
              ? "。按锁文件安装失败通常是 package.json 与锁文件没一起提交：回工作树检查两者是否同步"
              : ""),
          { cause: error },
        );
      }
    }
    env.log(`[worktree] 合入完成。回收：pnpm worktree:rm ${basename(branch)}；分支不再需要可 git branch -d ${branch}`);
    return mode;
  });
}

function stderrOf(error: unknown): string {
  if (typeof error !== "object" || error === null || !("stderr" in error)) return "";
  const s = (error as { stderr: unknown }).stderr;
  return (typeof s === "string" ? s : Buffer.isBuffer(s) ? s.toString("utf8") : "").trimEnd();
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * 主仓库合入锁：保护从主仓检查、快进到合入后命令的完整过程。另一个合入正在进行时 Fail-Fast
 * 拒绝——排队等到的时候主干已前移，快进资格早没了。锁目录内写持锁 pid 与分支，持锁进程已死或
 * 超时即视为残锁清理。
 */
function withMergeLock<T>(layout: Layout, branch: string, base: string, fn: () => T): T {
  const lock = join(layout.commonDir, MERGE_LOCK);
  const pidFile = join(lock, "pid");
  const branchFile = join(lock, "branch");
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw error;
      const seen = snapshotLock(lock);
      if (seen === null) continue; // 刚被释放，重抢
      if (isLockStale({ pidText: seen.pid, ageMs: Date.now() - seen.mtimeMs, alive: pidAlive })) {
        removeStaleLock(lock, seen);
        continue;
      }
      const pid = readText(pidFile);
      const holder = readText(branchFile);
      // 锁刚建、pid/分支还没写完：稍等再看，拿到持锁信息再报
      if ((pid === null || holder === null) && attempt < 4) {
        sleepMs(100);
        continue;
      }
      throw new Error(formatMergeConflictNotice({ branch: holder, pid, base }), { cause: error });
    }
  }
  try {
    writeFileSync(pidFile, String(process.pid));
    writeFileSync(branchFile, branch);
    return fn();
  } finally {
    releaseLock(lock);
  }
}

// ───────────── rm ─────────────

function leftovers(env: WorktreeEnv, root: string): { blocking: string[]; disposable: string[] } {
  const lines = gitRaw(root, "-c", "core.quotePath=false", "status", "--porcelain", "--ignored").split("\n");
  return classifyLeftovers(
    lines,
    (p) => {
      try {
        const abs = join(root, p);
        if (lstatSync(abs).isSymbolicLink()) return true;
        if (!p.endsWith("/")) return false;
        return dirOfSymlinksOnly(abs, (dir) => readdirSync(dir, { withFileTypes: true }));
      } catch {
        return false;
      }
    },
    // 共享项的软链本身已按软链放行；isolate 出的本地目录是真文件，可能有本树生成或手写的内容，
    // 照样拦下——确属可再生的由宿主登记进 worktree.disposable
    env.config.disposable,
  );
}

function servicesIn(env: WorktreeEnv, root: string): Array<{ pid: number; ports: number[] }> {
  const listen = env.procs.listening();
  if (listen.size === 0) return [];
  const cwds = env.procs.cwdOf([...listen.keys()]);
  const ancestors = env.procs.ancestors();
  return [...listen].filter(([pid]) => !ancestors.has(pid) && isInside(cwds.get(pid) ?? "", root)).map(([pid, ports]) => ({ pid, ports }));
}

/** 回收工作树：先停服务，再查残留，最后删目录。分支保留 */
export function worktreeRemove(env: WorktreeEnv, arg: string, opts: { force: boolean }): void {
  const layout = layoutOf(env);
  const root = resolveWorktreeArg(layout, worktrees(layout), arg) ?? resolve(layout.worktreesDir, arg);
  removeWorktree(env, layout, root, { force: opts.force, deleteMergedHookBranch: false });
}

function removeWorktree(env: WorktreeEnv, layout: Layout, root: string, opts: { force: boolean; deleteMergedHookBranch: boolean }): void {
  const wt = worktrees(layout).find((w) => w.path === root);
  if (wt === undefined) throw new Error(`[worktree] 不是本仓库的工作树：${root}（pnpm worktree:ls 查看全部）`);
  if (wt.main) throw new Error("[worktree] 不能回收主仓库");
  if (wt.locked) {
    throw new Error(`[worktree] ${root} 已锁定，通常是有 Claude 会话正在用。确认没人在用后 git worktree unlock ${root} 再回收`);
  }
  const { blocking } = leftovers(env, root);
  if (blocking.length > 0 && !opts.force) {
    throw new Error(
      `[worktree] 拒绝回收 ${root}：以下内容回收后找不回来\n${blocking.map((p) => `    ${p}`).join("\n")}\n` +
        "  提交或挪走后重试；确认都不要了再加 --force",
    );
  }

  for (const app of env.procs.pm2AppsIn(root)) {
    env.procs.pm2Delete(app);
    env.log(`[worktree] 已删除 pm2 应用 ${app}`);
  }
  for (const svc of servicesIn(env, root)) {
    // 查到 pid 到动手之间进程可能已退出、pid 被复用：动手前再核对一次工作目录
    const cwd = env.procs.cwdOf([svc.pid]).get(svc.pid);
    if (cwd === undefined || !isInside(cwd, root)) continue;
    const what = env.procs.describe(svc.pid);
    env.procs.stop(svc.pid);
    env.log(`[worktree] 已停止 pid ${svc.pid}（端口 ${svc.ports.join("/")}）：${what}`);
  }

  // 被忽略文件 git 自己不拦（上面已查）；未提交改动只有 --force 才放行
  git(layout.mainRoot, "worktree", "remove", ...(opts.force ? ["--force"] : []), root);
  env.log(`[worktree] 已回收 ${root}`);
  if (wt.branch === null) return;
  const merged = (() => {
    try {
      git(layout.mainRoot, "merge-base", "--is-ancestor", wt.branch, env.config.base);
      return true;
    } catch {
      return false;
    }
  })();
  // 只删本工具建的：钩子分支前缀 + 位于工作树目录下（用户手建的同前缀工作树不碰其分支）
  const ours = wt.branch.startsWith(HOOK_BRANCH_PREFIX) && dirname(root) === layout.worktreesDir;
  if (opts.deleteMergedHookBranch && ours && merged) {
    git(layout.mainRoot, "branch", "-D", wt.branch);
    env.log(`[worktree] 分支 ${wt.branch} 已全部合入 ${env.config.base}，已删除`);
  } else {
    env.log(`[worktree] 分支 ${wt.branch} 保留`);
  }
}

// ───────────── ls ─────────────

/** 每个工作树一行：路径、分支、端口与服务、领先主干的提交数、是否干净、是否锁定 */
export function worktreeList(env: WorktreeEnv): string[] {
  const layout = layoutOf(env);
  const ports = registeredPorts(layout);
  const listening = [...env.procs.listening().values()].flat();
  const base = env.config.base;
  return worktrees(layout).map((wt) => {
    if (wt.main) return `${wt.path}  [${wt.branch ?? "detached"}]  主仓库（开发端口 ${env.config.portBase}）`;
    if (!existsSync(wt.path)) return `${wt.path}  [${wt.branch ?? "detached"}]  目录已不存在，执行 git worktree prune 清理登记`;
    const port = ports.get(wt.path);
    const ahead = wt.branch === null ? "?" : git(layout.mainRoot, "rev-list", "--count", `${base}..${wt.branch}`);
    const { blocking } = leftovers(env, wt.path);
    const facts = [
      port === undefined ? "端口未登记" : `端口 ${port}${listening.includes(port) ? "（服务在跑）" : ""}`,
      `领先 ${base} ${ahead} 个提交`,
      blocking.length > 0 ? `${blocking.length} 处未提交/不可再生文件` : "干净",
      ...(wt.locked ? ["已锁定（有 Claude 会话在用）"] : []),
    ];
    return `${wt.path}  [${wt.branch ?? "detached"}]  ${facts.join("，")}`;
  });
}

// ───────────── Claude Code 钩子 ─────────────

/**
 * WorktreeCreate：替代 Claude 自带的 git worktree add，让 claude --worktree 与子 Agent 的
 * isolation: "worktree" 也拿到共享软链和登记端口。返回工作树路径（调用方打印到 stdout，
 * 其余输出一律走 stderr）。起点取发起会话当前的 HEAD：子 Agent 通常要在进行中的分支上接着干。
 * 同名再开时复用既有工作树（恢复会话走这条路）。
 */
export function hookCreate(env: WorktreeEnv, input: unknown): string {
  const raw = objectInput(input);
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!/^[\w.-]+$/.test(name) || /^\.+$/.test(name)) throw new Error(`[worktree] 钩子收到非法工作树名：${JSON.stringify(raw.name)}`);
  const layout = layoutOf(env);
  const branch = `${HOOK_BRANCH_PREFIX}${name}`;
  const root = resolve(layout.worktreesDir, name);
  if (existsSync(root)) {
    const wt = worktrees(layout).find((w) => w.path === realpathSync(root));
    if (wt?.branch !== branch) throw new Error(`[worktree] ${root} 已被 ${wt?.branch ?? "非工作树目录"} 占用，换个名字`);
    env.log(`[worktree] 复用既有工作树 ${root}`);
    return root;
  }
  const from = typeof raw.cwd === "string" && existsSync(raw.cwd) ? git(raw.cwd, "rev-parse", "HEAD") : env.config.base;
  return createWorktree(env, layout, root, branch, from, new Set()).root;
}

/** WorktreeRemove：同 rm，另外删除已合入的 worktree-* 分支；拒绝时抛错，Claude 会把工作树留在磁盘上 */
export function hookRemove(env: WorktreeEnv, input: unknown): void {
  const path = objectInput(input).worktree_path;
  if (typeof path !== "string" || path === "") throw new Error("[worktree] 钩子输入缺少 worktree_path");
  const layout = layoutOf(env);
  removeWorktree(env, layout, existsSync(path) ? realpathSync(path) : resolve(path), { force: false, deleteMergedHookBranch: true });
}
