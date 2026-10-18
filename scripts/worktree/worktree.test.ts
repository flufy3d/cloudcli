/**
 * 工作树命令验收：每个用例在临时目录建真 git 仓库跑真 git（合入语义、钩子拦截、回收判定都以 git
 * 的真实行为为准）；进程探测用假件（不碰本机真进程），命令执行记录调用并可指定失败。
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorktreeConfig, type WorktreeConfig } from "./config.ts";
import {
  hookCreate,
  hookRemove,
  removeStaleLock,
  worktreeIsolate,
  worktreeList,
  worktreeMerge,
  worktreeNew,
  worktreeRemove,
  type ProcessProbe,
  type WorktreeEnv,
} from "./worktree.ts";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 临时目录下的主仓库：一个提交、忽略构建计数器与 research 与 .worktrees，钩子目录指向仓库外的空目录 */
function newRepo(): { base: string; main: string; hooks: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wt-")));
  temps.push(base);
  const main = join(base, "app");
  const hooks = join(base, "hooks");
  mkdirSync(main);
  mkdirSync(hooks);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@wt.local");
  git(main, "config", "user.name", "t");
  git(main, "config", "core.hooksPath", hooks);
  writeFileSync(join(main, ".gitignore"), ".build-number\nresearch\nnode_modules/\ntemp/\n.worktrees/\n");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "base");
  writeFileSync(join(main, ".build-number"), "7\n");
  mkdirSync(join(main, "research"));
  writeFileSync(join(main, "research/doc.md"), "档案\n");
  return { base, main, hooks };
}

function commitIn(root: string, name: string): void {
  writeFileSync(join(root, `${name}.txt`), `${name}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", name);
}

interface FakeProcs extends ProcessProbe {
  listen: Map<number, number[]>;
  cwds: Map<number, string>;
  pm2: Map<string, string>;
  stopped: number[];
  pm2Deleted: string[];
}

function fakeProcs(): FakeProcs {
  const p: FakeProcs = {
    listen: new Map(),
    cwds: new Map(),
    pm2: new Map(),
    stopped: [],
    pm2Deleted: [],
    listening: () => new Map([...p.listen].filter(([pid]) => !p.stopped.includes(pid))),
    cwdOf: (pids) => new Map([...p.cwds].filter(([pid]) => pids.includes(pid))),
    ancestors: () => new Set([process.pid]),
    describe: (pid) => `fake ${pid}`,
    stop: (pid) => void p.stopped.push(pid),
    pm2AppsIn: (root) => [...p.pm2].filter(([, cwd]) => cwd.startsWith(root)).map(([name]) => name),
    pm2Delete: (name) => void p.pm2Deleted.push(name),
  };
  return p;
}

function harness(over: Partial<WorktreeConfig> = {}, failOn: (line: string) => boolean = () => false) {
  const repo = newRepo();
  const logs: string[] = [];
  const runs: Array<{ line: string; cwd: string }> = [];
  const config: WorktreeConfig = {
    ...parseWorktreeConfig({ share: [".build-number", "research"], postCreate: [["setup"]], postMerge: [["verify"]] }),
    ...over,
  };
  const procs = fakeProcs();
  const env = (cwd = repo.main): WorktreeEnv => ({
    cwd,
    config,
    log: (m) => void logs.push(m),
    procs,
    run: (cmd, args, at) => {
      const line = [cmd, ...args].join(" ");
      runs.push({ line, cwd: at });
      if (failOn(line)) throw new Error(`${line} 失败`);
    },
  });
  const wtDir = join(repo.main, ".worktrees");
  return { ...repo, logs, runs, procs, env, wtDir };
}

describe("worktree new", () => {
  it("建在主仓库同级目录、自主干新建分支、共享项软链回主仓库、登记端口、跑 postCreate", () => {
    const h = harness();
    const { root, port } = worktreeNew(h.env(), { branch: "feat/x" });
    expect(root).toBe(join(h.wtDir, "x"));
    expect(git(root, "branch", "--show-current")).toBe("feat/x");
    expect(readlinkSync(join(root, ".build-number"))).toBe(join(h.main, ".build-number"));
    expect(readFileSync(join(root, "research/doc.md"), "utf8")).toBe("档案\n");
    expect(port).toBe(3011);
    expect(h.runs).toEqual([{ line: "setup", cwd: root }]);
  });

  it("端口避开已登记与正在监听的；目标已存在拒绝；未知隔离项拒绝", () => {
    const h = harness();
    h.procs.listen.set(42, [3021]);
    worktreeNew(h.env(), { branch: "a" });
    expect(worktreeNew(h.env(), { branch: "b" }).port).toBe(3031);
    expect(() => worktreeNew(h.env(), { branch: "a" })).toThrow(/目标已存在/);
    expect(() => worktreeNew(h.env(), { branch: "c", isolate: ["nope"] })).toThrow(/未知共享项/);
    expect(() => worktreeNew(h.env(), { branch: "-x" })).toThrow(/非法分支名/);
    expect(() => worktreeNew(h.env(), { branch: "c", from: "--help" })).toThrow(/非法起点/);
  });

  it("隔离项留空目录不挂软链；主仓库缺的共享项跳过并说明", () => {
    const h = harness();
    rmSync(join(h.main, ".build-number"));
    const { root } = worktreeNew(h.env(), { branch: "iso", isolate: ["research/"] });
    expect(lstatSync(join(root, "research")).isDirectory()).toBe(true);
    expect(existsSync(join(root, "research/doc.md"))).toBe(false);
    expect(existsSync(join(root, ".build-number"))).toBe(false);
    expect(h.logs.join("\n")).toMatch(/主仓库没有 \.build-number/);
  });

  it("postCreate 失败整体回滚：目录与新建分支都不留", () => {
    const h = harness({}, (line) => line === "setup");
    expect(() => worktreeNew(h.env(), { branch: "broken" })).toThrow(/setup 失败/);
    expect(existsSync(join(h.wtDir, "broken"))).toBe(false);
    expect(git(h.main, "branch", "--list", "broken")).toBe("");
  });

  it("共享项被 git 跟踪（工作树里已检出）时报错回滚，不覆盖", () => {
    const h = harness({ share: ["a.txt"] });
    writeFileSync(join(h.main, "a.txt"), "a\n");
    expect(() => worktreeNew(h.env(), { branch: "dup" })).toThrow(/必须不入 git/);
    expect(existsSync(join(h.wtDir, "dup"))).toBe(false);
  });

  it("相对 core.hooksPath 指向的钩子目录没入库：新树里没有钩子，建树时警告", () => {
    const h = harness();
    git(h.main, "config", "core.hooksPath", ".githooks");
    mkdirSync(join(h.main, ".githooks"));
    writeFileSync(join(h.main, ".githooks/pre-commit"), "#!/bin/sh\n");
    worktreeNew(h.env(), { branch: "nohooks" });
    expect(h.logs.join("\n")).toMatch(/工作树里没有 \.githooks/);

    git(h.main, "add", ".githooks");
    git(h.main, "commit", "-q", "--no-verify", "-m", "hooks");
    h.logs.length = 0;
    worktreeNew(h.env(), { branch: "withhooks" });
    expect(h.logs.join("\n")).not.toMatch(/工作树里没有/);
  });

  it("主仓库建过 CodeGraph 索引时在新树里重建；失败不阻断", () => {
    const h = harness({}, (line) => line.startsWith("codegraph"));
    mkdirSync(join(h.main, ".codegraph"));
    const { root } = worktreeNew(h.env(), { branch: "cg" });
    expect(h.runs.map((r) => r.line)).toEqual(["setup", "codegraph init -y"]);
    expect(existsSync(root)).toBe(true);
    expect(h.logs.join("\n")).toMatch(/CodeGraph 索引建失败/);
  });
});

describe("worktree isolate", () => {
  it("把共享软链换成主仓库内容的本地副本；--empty 留空；主仓库原件不动", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "iso" });
    worktreeIsolate(h.env(root), ["research"], false);
    expect(lstatSync(join(root, "research")).isSymbolicLink()).toBe(false);
    writeFileSync(join(root, "research/doc.md"), "本树改的\n");
    expect(readFileSync(join(h.main, "research/doc.md"), "utf8")).toBe("档案\n");

    const other = worktreeNew(h.env(), { branch: "iso2" }).root;
    worktreeIsolate(h.env(other), ["research"], true);
    expect(existsSync(join(other, "research/doc.md"))).toBe(false);
  });

  it("在主仓库执行、隔离文件型共享项、未知项一律拒绝", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "iso" });
    expect(() => worktreeIsolate(h.env(), ["research"], false)).toThrow(/只能在工作树/);
    expect(() => worktreeIsolate(h.env(root), [".build-number"], false)).toThrow(/无法隔离/);
    expect(() => worktreeIsolate(h.env(root), ["x"], false)).toThrow(/未知共享项/);
  });
});

describe("worktree merge", () => {
  it("快进合入（分支名或目录名都收），不造合并节点，主仓库跑 postMerge", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "feat/x" });
    commitIn(root, "b1");
    expect(worktreeMerge(h.env(), "x")).toBe("ff");
    expect(git(h.main, "rev-parse", "main")).toBe(git(h.main, "rev-parse", "feat/x"));
    expect(git(h.main, "rev-list", "--merges", "main")).toBe("");
    expect(h.runs.at(-1)).toEqual({ line: "verify", cwd: h.main });
    expect(worktreeMerge(h.env(), "feat/x")).toBe("up-to-date");
  });

  it("分叉拒绝：主干不动、主仓库干净，提示回工作树变基", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    commitIn(root, "b1");
    commitIn(h.main, "m1");
    const before = git(h.main, "rev-parse", "main");
    expect(() => worktreeMerge(h.env(), "side")).toThrow(/git rebase main/);
    expect(git(h.main, "rev-parse", "main")).toBe(before);
    expect(git(h.main, "status", "--porcelain")).toBe("");
  });

  it("主仓库不在主干、工作区不干净、分支不存在、合主干自己：拒绝", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    commitIn(root, "b1");
    expect(() => worktreeMerge(h.env(), "nope")).toThrow(/分支不存在/);
    expect(() => worktreeMerge(h.env(), "main")).toThrow(/没有事可做/);
    expect(() => worktreeMerge(h.env(), "--force")).toThrow(/非法分支名/);
    writeFileSync(join(h.main, "a.txt"), "dirty\n");
    expect(() => worktreeMerge(h.env(), "side")).toThrow(/不干净/);
    git(h.main, "checkout", "-q", "--", "a.txt");
    git(h.main, "switch", "-qc", "other");
    expect(() => worktreeMerge(h.env(), "side")).toThrow(/先切回 main/);
  });

  it("快进被 reference-transaction 钩子拒绝：主干不动，合入残留自动还原", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    commitIn(root, "b1");
    writeFileSync(
      join(h.hooks, "reference-transaction"),
      '#!/bin/sh\n[ "$1" = "prepared" ] || exit 0\nwhile read -r _o _n ref; do [ "$ref" = "refs/heads/main" ] && { echo 锁定 >&2; exit 1; }; done\nexit 0\n',
    );
    chmodSync(join(h.hooks, "reference-transaction"), 0o755);
    const before = git(h.main, "rev-parse", "main");
    expect(() => worktreeMerge(h.env(), "side")).toThrow(/残留已还原/);
    expect(git(h.main, "rev-parse", "main")).toBe(before);
    expect(git(h.main, "status", "--porcelain")).toBe("");
  });

  it("合入后安装依赖失败：报错点明多半是 package.json 与锁文件没一起提交，后面的验证不再跑", () => {
    const h = harness({ postMerge: [["pnpm", "install", "--frozen-lockfile"], ["verify"]] }, (line) => line.startsWith("pnpm install"));
    const { root } = worktreeNew(h.env(), { branch: "side" });
    commitIn(root, "b1");
    expect(() => worktreeMerge(h.env(), "side")).toThrow(/package\.json 与锁文件/);
    expect(h.runs.map((r) => r.line)).not.toContain("verify");
  });

  it("postMerge 失败：合入保留，非零报错写明已合入未通过验证", () => {
    const h = harness({}, (line) => line === "verify");
    const { root } = worktreeNew(h.env(), { branch: "side" });
    commitIn(root, "b1");
    expect(() => worktreeMerge(h.env(), "side")).toThrow(/已合入 main，但主仓库 verify 失败/);
    expect(git(h.main, "rev-parse", "main")).toBe(git(h.main, "rev-parse", "side"));
  });

  it("另一个合入持锁时 Fail-Fast 拒绝；持锁进程已死的残锁自动清掉；合入后锁释放", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    commitIn(root, "b1");
    const lock = join(h.main, ".git/worktree-merge.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(process.pid));
    writeFileSync(join(lock, "branch"), "feat/other");
    expect(() => worktreeMerge(h.env(), "side")).toThrow(/分支 feat\/other 正在合入 main/);
    writeFileSync(join(lock, "pid"), "999999");
    expect(worktreeMerge(h.env(), "side")).toBe("ff");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("removeStaleLock", () => {
  it("搬走的正是判定时那把残锁才删；判定后锁已被别人换成新的，原样放回不删", () => {
    const h = harness();
    const lock = join(h.main, ".git/worktree-merge.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "999999");
    const seen = { mtimeMs: statSync(lock).mtimeMs, pid: "999999" };
    // 判定之后别人清掉了旧锁并建了自己的新锁（pid 不同）
    writeFileSync(join(lock, "pid"), "12345");
    expect(removeStaleLock(lock, seen)).toBe(false);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe("12345");
    expect(readdirSync(join(h.main, ".git")).filter((n) => n.includes(".stale-"))).toEqual([]);

    const fresh = { mtimeMs: statSync(lock).mtimeMs, pid: "12345" };
    expect(removeStaleLock(lock, fresh)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(removeStaleLock(lock, fresh)).toBe(false);
  });
});

describe("worktree rm", () => {
  it("先停 pm2 应用与工作目录在树内的监听进程，再删目录；软链与依赖不拦；分支保留", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    mkdirSync(join(root, "node_modules/x"), { recursive: true });
    h.procs.listen.set(500, [3011]);
    h.procs.cwds.set(500, join(root, "sub"));
    h.procs.listen.set(501, [3001]);
    h.procs.cwds.set(501, h.main);
    h.procs.pm2.set("side-preview", root);
    worktreeRemove(h.env(), "side", { force: false });
    expect(h.procs.pm2Deleted).toEqual(["side-preview"]);
    expect(h.procs.stopped).toEqual([500]);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(h.main, "research/doc.md"))).toBe(true);
    expect(git(h.main, "branch", "--list", "side")).not.toBe("");
  });

  it("未提交改动或不可再生的被忽略文件拒绝回收，--force 放行", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    mkdirSync(join(root, "temp"));
    writeFileSync(join(root, "temp/notes.md"), "手写\n");
    expect(() => worktreeRemove(h.env(), root, { force: false })).toThrow(/temp\//);
    expect(existsSync(root)).toBe(true);
    worktreeRemove(h.env(), root, { force: true });
    expect(existsSync(root)).toBe(false);
  });

  it("isolate 出的本地目录是真文件，回收时拦下（可能有本树手写内容）；登记进 disposable 才放行", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    worktreeIsolate(h.env(root), ["research"], true);
    writeFileSync(join(root, "research/本树手写.md"), "x\n");
    expect(() => worktreeRemove(h.env(), "side", { force: false })).toThrow(/research/);
    expect(existsSync(join(root, "research/本树手写.md"))).toBe(true);

    const h2 = harness({ disposable: ["research"] });
    const r2 = worktreeNew(h2.env(), { branch: "side" }).root;
    worktreeIsolate(h2.env(r2), ["research"], false);
    worktreeRemove(h2.env(), "side", { force: false });
    expect(existsSync(r2)).toBe(false);
  });

  it("拒绝清单里第一行是未暂存修改时路径完整（porcelain 行首空格不被吃掉）", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    writeFileSync(join(root, "a.txt"), "changed\n");
    expect(() => worktreeRemove(h.env(), "side", { force: false })).toThrow(/\n {4}a\.txt/);
  });

  it("当前目录恰有同名目录时，rm 仍按工作树名找到目标", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    const cwd = process.cwd();
    const decoy = join(h.base, "decoy");
    mkdirSync(join(decoy, "side"), { recursive: true });
    process.chdir(decoy);
    try {
      worktreeRemove(h.env(), "side", { force: false });
    } finally {
      process.chdir(cwd);
    }
    expect(existsSync(root)).toBe(false);
  });

  it("主仓库、锁定的工作树、非工作树路径拒绝", () => {
    const h = harness();
    const { root } = worktreeNew(h.env(), { branch: "side" });
    expect(() => worktreeRemove(h.env(), h.main, { force: false })).toThrow(/不能回收主仓库/);
    expect(() => worktreeRemove(h.env(), "nope", { force: false })).toThrow(/不是本仓库的工作树/);
    git(h.main, "worktree", "lock", root);
    expect(() => worktreeRemove(h.env(), "side", { force: false })).toThrow(/已锁定/);
  });
});

describe("worktree ls", () => {
  it("列出主仓库与各工作树的端口、服务、领先提交数与干净度", () => {
    const h = harness();
    const a = worktreeNew(h.env(), { branch: "a" }).root;
    commitIn(a, "a1");
    writeFileSync(join(a, "wip.txt"), "x\n");
    h.procs.listen.set(9, [3011]);
    const lines = worktreeList(h.env());
    expect(lines[0]).toContain("主仓库（开发端口 3001）");
    expect(lines[1]).toMatch(/\[a\].*端口 3011（服务在跑）.*领先 main 1 个提交.*1 处未提交/);
  });
});

describe("Claude Code 钩子", () => {
  it("hook-create 以发起会话的 HEAD 为起点建 worktree-<名> 分支；同名复用；非法名拒绝", () => {
    const h = harness();
    const parent = worktreeNew(h.env(), { branch: "feat" }).root;
    commitIn(parent, "f1");
    const root = hookCreate(h.env(), { name: "agent-1", cwd: parent });
    expect(root).toBe(join(h.wtDir, "agent-1"));
    expect(git(root, "branch", "--show-current")).toBe("worktree-agent-1");
    expect(git(root, "rev-parse", "HEAD")).toBe(git(parent, "rev-parse", "HEAD"));
    expect(hookCreate(h.env(), { name: "agent-1" })).toBe(root);
    expect(() => hookCreate(h.env(), { name: "feat" })).toThrow(/已被 feat 占用/);
    expect(() => hookCreate(h.env(), { name: "../x" })).toThrow(/非法工作树名/);
    expect(() => hookCreate(h.env(), null)).toThrow(/非法工作树名/);
  });

  it("hook-remove 回收并删除已合入主干的 worktree-* 分支，未合入的保留", () => {
    const h = harness();
    const merged = hookCreate(h.env(), { name: "done" });
    hookRemove(h.env(), { worktree_path: merged });
    expect(git(h.main, "branch", "--list", "worktree-done")).toBe("");

    // 不在工作树目录下的 worktree-* 工作树（用户手建）：回收但不删分支
    const manual = join(h.base, "manual");
    git(h.main, "worktree", "add", "-q", manual, "-b", "worktree-manual");
    hookRemove(h.env(), { worktree_path: manual });
    expect(git(h.main, "branch", "--list", "worktree-manual")).not.toBe("");

    const open = hookCreate(h.env(), { name: "open" });
    commitIn(open, "o1");
    hookRemove(h.env(), { worktree_path: open });
    expect(git(h.main, "branch", "--list", "worktree-open")).not.toBe("");
    expect(() => hookRemove(h.env(), {})).toThrow(/worktree_path/);
  });
});
