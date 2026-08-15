#!/usr/bin/env node
import { spawn } from "node:child_process";
import { reportFailure } from "../api/db/lib/report-failure.mjs";

const source = process.argv[2];
const cmd = process.argv[3];
const args = process.argv.slice(4);

if (!source || !cmd) {
  console.error("usage: report-cron-failure.mjs <source> <cmd> [...args]");
  process.exit(64);
}

const child = spawn(cmd, args, { stdio: "inherit", shell: false });
child.on("error", async (err) => {
  await reportFailure(`cron:${source}`, err, {
    impact: "cron 无法启动，产物可能停止更新",
    command: [cmd, ...args].join(" "),
  });
  process.exit(127);
});
child.on("exit", async (code, signal) => {
  if (code === 0) return process.exit(0);
  await reportFailure(`cron:${source}`, new Error(signal ? `signal ${signal}` : `exit ${code}`), {
    impact: "cron 非零退出，相关看板数据可能过期",
    command: [cmd, ...args].join(" "),
    exit_code: code,
    signal,
  });
  process.exit(code || 1);
});
