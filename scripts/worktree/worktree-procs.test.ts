/**
 * 本机进程探测的冒烟：起一个真监听进程，验证能查到它的端口与工作目录、能停掉它；祖先链含本进程。
 * 只读本机状态 + 自己起的进程，不碰别的进程。监听进程经 sh 后台起、成为孤儿：真实回收场景里
 * 被停的服务都不是本进程的子进程；若是子进程，SIGTERM 后成僵尸（同步等待期间无人回收），
 * kill(pid, 0) 会一直判活。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parsePm2List, pidAlive, systemProcessProbe } from "./worktree-procs.ts";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("systemProcessProbe", () => {
  it("查到子进程的监听端口与工作目录，stop 能停掉；祖先链含本进程；pm2 未装或无应用返回数组", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "wt-procs-")));
    temps.push(cwd);
    const script = "require('node:net').createServer().listen(0,'127.0.0.1',function(){console.log(process.pid+' '+this.address().port)})";
    const sh = spawn("sh", ["-c", `"$0" -e "$1" &`, process.execPath, script], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    const [pid, port] = await new Promise<number[]>((done) =>
      sh.stdout.once("data", (b: Buffer) => done(String(b).trim().split(" ").map(Number))),
    );
    if (pid === undefined || port === undefined) throw new Error("监听进程没报出 pid 与端口");
    const probe = systemProcessProbe();
    expect(probe.listening().get(pid)).toContain(port);
    expect(probe.cwdOf([pid]).get(pid)).toBe(cwd);
    expect(probe.cwdOf([]).size).toBe(0);
    expect(probe.describe(pid)).toContain("createServer");
    expect(probe.ancestors().has(process.pid)).toBe(true);
    expect(Array.isArray(probe.pm2AppsIn(cwd))).toBe(true);
    probe.stop(pid);
    expect(probe.listening().has(pid)).toBe(false);
  });
});

describe("parsePm2List", () => {
  it("daemon 启动横幅（同样以 [ 开头）混在 stdout 前面时，取后面那行 JSON；缺 cwd 的应用跳过", () => {
    const raw =
      '[PM2] Spawning PM2 daemon\n[PM2] PM2 Successfully daemonized\n[{"name":"web","pm2_env":{"pm_cwd":"/wt/a"}},{"name":"x"}]\n';
    expect(parsePm2List(raw)).toEqual([{ name: "web", cwd: "/wt/a" }]);
    expect(parsePm2List("PM2 starting...\n[]")).toEqual([]);
    expect(parsePm2List("garbage")).toBeNull();
    expect(parsePm2List("[PM2] 只有横幅")).toBeNull();
    expect(parsePm2List('{"a":1}')).toBeNull();
  });
});

describe("pidAlive", () => {
  it("本进程在，不存在的 pid 不在", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
