// api/db/version.js — 版本自检端点(2026-07-07)。
// 目的: 出问题时一眼看出"线上实际跑的是哪个commit、几点部署/重启的",别再靠SSH现查。
// 防不住依赖包损坏/并发部署互相覆盖这类问题,只是让人更快发现漂移——见 feedback_deploy_isolate_from_dirty_worktree 同类记忆。
import { execSync } from "child_process";
import { setCors } from "../db.js";

let cached = null;
function computeVersionInfo() {
  if (cached) return cached;
  const run = (cmd) => { try { return execSync(cmd, { cwd: process.cwd(), timeout: 3000 }).toString().trim(); } catch (_) { return ""; } };
  cached = {
    commit: run("git rev-parse --short HEAD") || "unknown",
    commit_full: run("git rev-parse HEAD") || "",
    commit_date: run("git log -1 --format=%cI") || "",
    commit_subject: run("git log -1 --format=%s") || "",
    process_started_at: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    node_version: process.version,
  };
  return cached;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  return res.status(200).json(computeVersionInfo());
}
