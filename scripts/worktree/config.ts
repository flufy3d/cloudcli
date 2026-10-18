/**
 * 工作树配置：类型 + 校验 + cloudcli 默认值（移植自 nexus-kit packages/devflow/src/config.ts
 * 的工作树段）。机制与端口约定见 docs/design/并行开发工作树.md；默认值要改只动这里的
 * parseWorktreeConfig 入参兜底值，字段含义以本文件的注释为准，文档不抄字段表。
 */

export interface WorktreeConfig {
  /** 工作树父目录（相对主仓库根）；本仓固定 .worktrees/（已 gitignore，存量树都在这里） */
  dir: string;
  /** 主干分支：合入目标，也是新工作树的默认起点 */
  base: string;
  /** 主仓库开发服务端端口；工作树从 portBase + portStep 起按 portStep 分配（vite 用端口 +1） */
  portBase: number;
  portStep: number;
  /** 不入 git、建树时软链回主仓库共享的路径（相对仓库根），也是 isolate 可选的名字；本仓默认无 */
  share: string[];
  /** 回收时视为可再生的额外被忽略路径（相对仓库根，按路径段前缀） */
  disposable: string[];
  /** 建树后在新工作树里依次执行的命令（argv 数组） */
  postCreate: string[][];
  /** 合入后在主仓库依次执行的命令；失败即非零退出 */
  postMerge: string[][];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Obj, key: string, fallback: string): string {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || v === "") throw new Error(`[worktree.config] ${key} 必须是非空字符串`);
  return v;
}

function posInt(o: Obj, key: string, fallback: number): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`[worktree.config] ${key} 必须是正整数`);
  return v;
}

function strList(o: Obj, key: string, fallback: string[]): string[] {
  const v = o[key];
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`[worktree.config] ${key} 必须是字符串数组`);
  return v as string[];
}

/** 仓库内相对路径：不得绝对、不得含 .. 段（会拼进软链与删除判定）；尾斜杠去掉 */
function relPathList(o: Obj, key: string, fallback: string[]): string[] {
  return strList(o, key, fallback).map((p) => {
    if (p === "" || p.startsWith("/") || p.split("/").includes("..")) {
      throw new Error(`[worktree.config] ${key} 的 ${JSON.stringify(p)} 必须是仓库内相对路径（不以 / 开头、不含 ..）`);
    }
    return p.replace(/\/+$/, "");
  });
}

/** 命令清单：每条是非空字符串数组（argv，不经 shell） */
function commandList(o: Obj, key: string, fallback: string[][], allowEmpty: boolean): string[][] {
  const v = o[key];
  if (v === undefined) return fallback;
  const ok =
    Array.isArray(v) &&
    (allowEmpty || v.length > 0) &&
    v.every((c) => Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === "string" && x !== ""));
  if (!ok) throw new Error(`[worktree.config] ${key} 必须是${allowEmpty ? "" : "非空的"}命令数组，每条形如 ["npm", "run", "build"]`);
  return v as string[][];
}

/**
 * 从字面量解析工作树配置，缺省字段落 cloudcli 默认值，字段类型不对即抛错指明哪一项
 * （不静默套默认值掩盖写错的配置）。CLI 用 parseWorktreeConfig({}) 拿默认配置；
 * 测试用它构造各种配置形状。
 */
export function parseWorktreeConfig(raw: unknown): WorktreeConfig {
  const o = isObj(raw) ? raw : {};
  const base = str(o, "base", "main");
  if (!/^[\w./-]+$/.test(base) || base.startsWith("-")) throw new Error("[worktree.config] base 不是合法分支名");
  const dir = str(o, "dir", ".worktrees");
  if (/^\//.test(dir) || dir.split("/").includes("..")) throw new Error("[worktree.config] dir 必须是仓库内相对路径");
  const portBase = posInt(o, "portBase", 3001);
  if (portBase > 65_000) throw new Error("[worktree.config] portBase 必须小于 65000");
  return {
    dir,
    base,
    portBase,
    portStep: posInt(o, "portStep", 10),
    share: relPathList(o, "share", []),
    // 内置可再生白名单（worktree-lib.ts 的 DISPOSABLE）之外，本仓特有的构建/打包产物。
    // temp/、tmp/ 刻意不进来：本仓习惯在里面放手写脚本，回收时必须拦下确认
    disposable: relPathList(o, "disposable", ["dist-server", "dist-server.next", "dist-server.old", "release", ".desktop-build"]),
    // npm ci 在 package.json 与锁文件不同步时大声报错（合入代码据此给出诊断提示）；
    // 代价是每次建树/合入全量装依赖
    postCreate: commandList(o, "postCreate", [["npm", "ci"]], true),
    postMerge: commandList(
      o,
      "postMerge",
      [
        ["npm", "ci"],
        ["npm", "run", "build"],
      ],
      true,
    ),
  };
}

/** CLI 入口用的配置：本仓默认值 */
export const worktreeConfig: WorktreeConfig = parseWorktreeConfig({});
