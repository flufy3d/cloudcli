/**
 * 工作树纯逻辑单测（取材 MirLite scripts/worktree-lib.test.mjs）：端口分配、git/lsof 输出解析、
 * 回收残留分类、锁残留判定、并发合入提示。合入裁决用真 git 验收，见 worktree.test.ts。
 */
import type { Dirent } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  branchOfWorktreeArg,
  classifyLeftovers,
  dirOfSymlinksOnly,
  formatMergeConflictNotice,
  isInside,
  isLockStale,
  matchesPathPrefix,
  parseLsofCwd,
  parseLsofListen,
  parseWorktreeList,
  pickPort,
} from "./worktree-lib.ts";

describe("branchOfWorktreeArg", () => {
  const list = parseWorktreeList(
    [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /wt/struck-once",
      "HEAD bbb",
      "branch refs/heads/fix/struck-once",
      "",
      "worktree /wt/detached",
      "HEAD ccc",
      "detached",
      "",
    ].join("\n"),
  );

  it("目录名或绝对路径命中 → 完整分支名", () => {
    expect(branchOfWorktreeArg("struck-once", "/wt", list)).toBe("fix/struck-once");
    expect(branchOfWorktreeArg("/wt/struck-once", "/wt", list)).toBe("fix/struck-once");
  });

  it("没命中、主仓库、detached → null", () => {
    expect(branchOfWorktreeArg("nope", "/wt", list)).toBeNull();
    expect(branchOfWorktreeArg("/repo", "/wt", list)).toBeNull();
    expect(branchOfWorktreeArg("detached", "/wt", list)).toBeNull();
  });
});

describe("pickPort", () => {
  it("从 base+step 起按 step 递增，不占主仓库的 base", () => {
    expect(pickPort(new Set(), 4173, 10)).toBe(4183);
    expect(pickPort(new Set(), 5000, 1)).toBe(5001);
  });

  it("删掉中间的工作树后再建，补回空位而不是按数量算", () => {
    expect(pickPort(new Set([4193]), 4173, 10)).toBe(4183);
    expect(pickPort(new Set([4183, 4193]), 4173, 10)).toBe(4203);
  });

  it("端口段耗尽时抛错而不是返回重复端口", () => {
    const all = new Set(Array.from({ length: 50 }, (_, i) => 4183 + 10 * i));
    expect(() => pickPort(all, 4173, 10)).toThrow(/端口/);
  });
});

describe("parseWorktreeList", () => {
  it("解析 porcelain 输出，区分主仓库、分支、锁定状态", () => {
    const out = [
      "worktree /repo",
      "HEAD aaa",
      "branch refs/heads/main",
      "",
      "worktree /wt/feat",
      "HEAD bbb",
      "branch refs/heads/feat/x",
      "locked claude agent",
      "",
      "worktree /wt/detached",
      "HEAD ccc",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/repo", branch: "main", locked: false, main: true },
      { path: "/wt/feat", branch: "feat/x", locked: true, main: false },
      { path: "/wt/detached", branch: null, locked: false, main: false },
    ]);
  });
});

describe("parseLsofListen / parseLsofCwd", () => {
  it("监听输出按 pid 聚合端口，IPv4/IPv6 重复只记一次，坏行跳过", () => {
    const out = ["p100", "n*:4183", "n[::1]:4183", "n*:abc", "p200", "n127.0.0.1:8888"].join("\n");
    expect(parseLsofListen(out)).toEqual(
      new Map([
        [100, [4183]],
        [200, [8888]],
      ]),
    );
  });

  it("cwd 输出得到 pid → 目录", () => {
    const out = ["p100", "fcwd", "n/wt/feat/apps/web", "p200", "fcwd", "n/repo"].join("\n");
    expect(parseLsofCwd(out)).toEqual(
      new Map([
        [100, "/wt/feat/apps/web"],
        [200, "/repo"],
      ]),
    );
  });
});

describe("isInside", () => {
  it("只认目录边界，不把同前缀的兄弟目录算进来", () => {
    expect(isInside("/wt/feat", "/wt/feat")).toBe(true);
    expect(isInside("/wt/feat/apps/web", "/wt/feat")).toBe(true);
    expect(isInside("/wt/feat-2/apps", "/wt/feat")).toBe(false);
  });
});

describe("matchesPathPrefix", () => {
  it("按路径段匹配：目录前缀管住其下全部内容，不误伤同前缀兄弟", () => {
    expect(matchesPathPrefix("research", "research")).toBe(true);
    expect(matchesPathPrefix("research/", "research")).toBe(true);
    expect(matchesPathPrefix("research/a.md", "research/")).toBe(true);
    expect(matchesPathPrefix("research-old/", "research")).toBe(false);
    expect(matchesPathPrefix(".build-number", ".build-number")).toBe(true);
    expect(matchesPathPrefix(".build-number.lock", ".build-number")).toBe(false);
  });
});

describe("classifyLeftovers", () => {
  const symlinks = new Set(["research/archive", "public/atlas"]);
  const isSymlink = (p: string): boolean => symlinks.has(p);

  it("未提交改动和未跟踪文件一律拦下", () => {
    const r = classifyLeftovers([" M src/a.ts", "?? src/new.ts"], isSymlink);
    expect(r.blocking).toEqual(["src/a.ts", "src/new.ts"]);
  });

  it("依赖、构建产物、缓存、CodeGraph 索引、软链都可再生，不拦", () => {
    const r = classifyLeftovers(
      [
        "!! node_modules/",
        "!! apps/web/node_modules/",
        "!! apps/web/dist/",
        "!! dist/",
        "!! coverage/",
        "!! packages/core/tsconfig.tsbuildinfo",
        "!! vite-debug.log",
        "!! .DS_Store",
        "!! .codegraph/codegraph.db",
        "!! research/archive",
        "!! public/atlas",
      ],
      isSymlink,
    );
    expect(r.blocking).toEqual([]);
    expect(r.disposable).toHaveLength(11);
  });

  it("宿主登记的可再生路径（共享项、额外产物目录）放行", () => {
    const r = classifyLeftovers(["!! .build-number", "!! public/sound/", "!! public/sound-extra/"], () => false, [
      ".build-number",
      "public/sound",
    ]);
    expect(r.disposable).toEqual([".build-number", "public/sound/"]);
    expect(r.blocking).toEqual(["public/sound-extra/"]);
  });

  it("被忽略但不可再生的文件要拦：临时目录、本地配置、深层同名手工目录", () => {
    const r = classifyLeftovers(["!! temp/", "!! .env", "!! .claude/settings.local.json", "!! docs/设计/dist/"], isSymlink);
    expect(r.blocking).toEqual(["temp/", ".env", ".claude/settings.local.json", "docs/设计/dist/"]);
  });

  it("整目录只含软链的坍缩目录可随树删；带引号的路径去掉引号；过短行跳过", () => {
    const r = classifyLeftovers(["!! assets/", '?? "docs/\\346\\226\\260.md"', "!"], (p) => p === "assets/");
    expect(r.disposable).toEqual(["assets/"]);
    expect(r.blocking).toEqual(["docs/\\346\\226\\260.md"]);
  });
});

describe("dirOfSymlinksOnly", () => {
  type Entry = Pick<Dirent, "name" | "isSymbolicLink" | "isDirectory">;
  const fsOf =
    (tree: Record<string, Entry[]>) =>
    (dir: string): Entry[] => {
      const entries = tree[dir];
      if (entries === undefined) throw new Error(`ENOENT: ${dir}`);
      return entries;
    };
  const link = (name: string): Entry => ({ name, isSymbolicLink: () => true, isDirectory: () => false });
  const file = (name: string): Entry => ({ name, isSymbolicLink: () => false, isDirectory: () => false });
  const sub = (name: string): Entry => ({ name, isSymbolicLink: () => false, isDirectory: () => true });

  it("纯软链目录与空目录为真", () => {
    expect(dirOfSymlinksOnly("/wt/assets", fsOf({ "/wt/assets": [link("raw")] }))).toBe(true);
    expect(dirOfSymlinksOnly("/wt/assets", fsOf({ "/wt/assets": [] }))).toBe(true);
  });

  it("混进真文件、或真子目录里有真文件，为假", () => {
    expect(dirOfSymlinksOnly("/wt/assets", fsOf({ "/wt/assets": [link("raw"), file("手工.bin")] }))).toBe(false);
    const nested = fsOf({ "/wt/assets": [sub("real")], "/wt/assets/real": [file("x.bin")] });
    expect(dirOfSymlinksOnly("/wt/assets", nested)).toBe(false);
  });
});

describe("isLockStale", () => {
  const alive = (pid: number): boolean => pid === 100;

  it("pid 有效：持锁进程活着不算残留，已死算残留", () => {
    expect(isLockStale({ pidText: "100", ageMs: 60_000, alive })).toBe(false);
    expect(isLockStale({ pidText: "200\n", ageMs: 0, alive })).toBe(true);
  });

  it("没写 pid 或 pid 损坏：10 秒内视为正在写，之后算残留", () => {
    for (const pidText of [null, "", "abc", "-5", "1.5"]) {
      expect(isLockStale({ pidText, ageMs: 5_000, alive })).toBe(false);
      expect(isLockStale({ pidText, ageMs: 10_001, alive })).toBe(true);
    }
  });

  it("超过最大持锁时长（默认 20 分钟）即使进程活着也算残留", () => {
    expect(isLockStale({ pidText: "100", ageMs: 19 * 60_000, alive })).toBe(false);
    expect(isLockStale({ pidText: "100", ageMs: 20 * 60_000 + 1, alive })).toBe(true);
    expect(isLockStale({ pidText: "100", ageMs: 501, alive, maxAgeMs: 500 })).toBe(true);
  });
});

describe("formatMergeConflictNotice", () => {
  it("写明谁在合入、PID 与后续做法", () => {
    const msg = formatMergeConflictNotice({ branch: "feat/x", pid: "12345", base: "main" });
    expect(msg).toContain("分支 feat/x");
    expect(msg).toContain("PID 12345");
    expect(msg).toContain("git rebase main");
  });

  it("分支名或 PID 缺失时兜底，不输出 null", () => {
    const msg = formatMergeConflictNotice({ branch: null, pid: null, base: "main" });
    expect(msg).toContain("另一个分支");
    expect(msg).not.toContain("null");
  });
});
