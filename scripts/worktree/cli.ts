#!/usr/bin/env node
/**
 * 工作树命令入口（移植自 nexus-kit packages/devflow/src/cli.ts 的 worktree 子命令）。
 * 配置取 scripts/worktree/config.ts 的 cloudcli 默认值；机制见 docs/design/并行开发工作树.md。
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { worktreeConfig } from "./config.ts";
import {
  hookCreate,
  hookRemove,
  worktreeIsolate,
  worktreeList,
  worktreeMerge,
  worktreeNew,
  worktreeRemove,
  type WorktreeEnv,
} from "./worktree.ts";
import { systemProcessProbe } from "./worktree-procs.ts";

const WORKTREE_USAGE = `用法：
  npm run worktree:new <分支名> [--from=<起点>] [--isolate=<共享项,共享项>]
  npm run worktree:merge <分支名|工作树目录名|路径>
  npm run worktree:rm <工作树目录名|路径> [--force]
  npm run worktree:ls
  npm run worktree:isolate <共享项,共享项> [--empty]   （在工作树里执行）
  npm run worktree:hook-create | worktree:hook-remove  （Claude Code 钩子，读 stdin JSON）

  new      在 .worktrees/ 下建树：自主干新建分支、共享项软链回主仓库、登记开发端口、
           跑 worktree.postCreate（默认 npm ci）。--isolate 列出的共享项留空目录，由本树自己生成。
  merge    把分支合回主干：分支须先在工作树 git rebase main 并验证，这里只快进；分叉即拒绝；被钩子
           拦下时自动还原主仓库残留；合入后在主仓库跑 worktree.postMerge，失败非零退出。单独执行，
           不与检查、回收串在一条命令里。
  rm       回收：先停该树起的服务与 pm2 应用，再删目录；未提交改动或不可再生的被忽略文件拒绝回收，
           确认都不要了加 --force。分支保留。
  isolate  把共享项改为本树独立：默认复制主仓库现有内容，--empty 留空。

  标志经 npm 透传时要加 --：npm run worktree:rm <名> -- --force`;

/** 子命令输出走 stderr：钩子模式下 stdout 只许输出工作树路径 */
function runToStderr(cmd: string, args: readonly string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: ["ignore", 2, 2] });
}

async function worktreeCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      from: { type: "string" },
      isolate: { type: "string" },
      force: { type: "boolean" },
      empty: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (sub === undefined || values.help === true) {
    console.log(WORKTREE_USAGE);
    return sub === undefined ? 2 : 0;
  }
  const hookMode = sub === "hook-create" || sub === "hook-remove";
  const env: WorktreeEnv = {
    cwd: process.cwd(),
    config: worktreeConfig,
    log: (m) => (hookMode ? console.error(m) : console.log(m)),
    procs: systemProcessProbe(),
    run: runToStderr,
  };
  const need = (what: string): string => {
    const v = positionals[0];
    if (v === undefined) throw new Error(`[worktree] 缺少${what}\n${WORKTREE_USAGE}`);
    return v;
  };
  const list = (v: string | undefined): string[] => (v === undefined ? [] : v.split(",").filter(Boolean));
  switch (sub) {
    case "new": {
      const branch = need("分支名");
      const { root, port } = worktreeNew(env, {
        branch,
        isolate: list(values.isolate),
        ...(values.from === undefined ? {} : { from: values.from }),
      });
      console.log(`
[worktree] 就绪：${root}
  本树开发端口 ${port}（已登记到本工作树）：在本树里 SERVER_PORT=${port} VITE_PORT=$((port + 1)) npm run dev。
  做完且验证全绿后：在本工作树 git rebase ${env.config.base} 并在变基后的代码上重新验证，
  然后回主仓库单独执行合回：npm run worktree:merge ${branch}
  确认合入成功后回收：npm run worktree:rm ${root.split("/").pop() ?? branch}`);
      return 0;
    }
    case "merge":
      worktreeMerge(env, need("分支名"));
      return 0;
    case "rm":
      worktreeRemove(env, need("工作树名"), { force: values.force === true });
      return 0;
    case "ls":
      for (const line of worktreeList(env)) console.log(line);
      return 0;
    case "isolate":
      worktreeIsolate(env, list(need("共享项")), values.empty === true);
      return 0;
    case "hook-create":
      console.log(hookCreate(env, JSON.parse(readFileSync(0, "utf8")) as unknown));
      return 0;
    case "hook-remove":
      hookRemove(env, JSON.parse(readFileSync(0, "utf8")) as unknown);
      return 0;
    default:
      console.error(WORKTREE_USAGE);
      return 2;
  }
}

worktreeCmd(process.argv.slice(3)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
