/**
 * dsh-session-migration — 把 ZCode 的会话与 Token 用量迁移到 DSH。
 *
 * 数据源（只读）：`~/.zcode/cli/db/db.sqlite`（node:sqlite DatabaseSync，WAL 并发读安全）
 *   - session(id,directory,title,time_created,time_updated) / message(data.role,time) /
 *     part(data.type==='text') → 会话内容
 *   - model_usage(model_id, started_at, computed_total_tokens) → 用量
 *
 * 两条迁移路径（都可重复执行，幂等）：
 *  1. 用量叠加：按 本地日×模型 聚合 model_usage，写 `~/.dsh/usage-stats/migrated-usage.json`；
 *     dsh-usage-stats 的 summary() 会把它叠加进所有视图。
 *  2. 会话导入：为每个有实际对话的 ZCode 会话新建一个 DSH 会话（ctx.sessions.create，
 *     meta.cwd=原工作区），把整段对话格式化成一条 user 消息追加并 flush；尝试写入 session/title。
 *     DSH 原有会话完全不触碰；已迁移的 ZCode 会话记录在状态文件里自动跳过。
 *
 * 刻意零 @deepseek-ai 裸导入（外部 link 插件解析不到宿主 SDK），全部走 ctx 服务 + node 内置。
 */
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOG = "[dsh-session-migration]";
const RPC_PATH = "/api/dsh-session-migration";
function jsonSafe(value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}
const MSG_CAP = 4000; // 单条消息文本截断
const TR_CAP = 180_000; // 单会话转录上限

export const inject = ["sessions", "connection", "sessionPersistence", "workspaceRegistry"];

export function apply(ctx, config = {}) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const zcodeDb =
    typeof config.zcodeDb === "string" && config.zcodeDb.trim()
      ? config.zcodeDb.trim()
      : path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
  const migratedUsageFile =
    typeof config.migratedUsageFile === "string" && config.migratedUsageFile.trim()
      ? config.migratedUsageFile.trim()
      : path.join(dshHome, "usage-stats", "migrated-usage.json");
  const targetCwd =
    typeof config.targetCwd === 'string' && config.targetCwd.trim()
      ? path.resolve(config.targetCwd.trim())
      : path.join(dshHome, 'zcode-migrated'); // 迁移会话统一挂到「ZCode 迁移」工作区
  const stateFile =
    typeof config.stateFile === "string" && config.stateFile.trim()
      ? config.stateFile.trim()
      : path.join(dshHome, "session-migration", "state.json");

  let running = null; // 并发去重

  async function readState() {
    try {
      const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
      if (raw && typeof raw === "object") {
        return { sessions: raw.sessions ?? {}, usage: raw.usage ?? null };
      }
    } catch {}
    return { sessions: {}, usage: null };
  }

  async function writeState(state) {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
  }

  function openDb() {
    // readOnly：绝不写用户的 ZCode 库（WAL 模式允许并发读）
    return new DatabaseSync(zcodeDb, { readOnly: true });
  }

  function dayKeyOf(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // ── 扫描 ────────────────────────────────────────────────────────────────
  async function scan() {
    let db;
    try {
      db = openDb();
    } catch (error) {
      return { dbFound: false, error: `无法打开 ZCode 数据库: ${error.message}` };
    }
    try {
      const sessionsTotal = db.prepare("SELECT COUNT(*) c FROM session").get().c;
      const messagesTotal = db.prepare("SELECT COUNT(*) c FROM message").get().c;
      const usage = db
        .prepare("SELECT COUNT(*) rows, CAST(SUM(computed_total_tokens) AS REAL) tokens, MIN(started_at) minT, MAX(started_at) maxT FROM model_usage WHERE computed_total_tokens > 0")
        .get();
      const byModel = db
        .prepare("SELECT model_id name, CAST(SUM(computed_total_tokens) AS REAL) tokens FROM model_usage WHERE computed_total_tokens > 0 GROUP BY model_id ORDER BY tokens DESC LIMIT 6")
        .all();
      // 可迁移会话数：session 表自带 project/message 关联索引，用轻量子查询避免
      // 对 4.7 万条 message.data 做 JSON_EXTRACT 全表相关扫描（原实现会卡到超时）。
      let contentSessions = sessionsTotal;
      try {
        contentSessions = db
          .prepare(
            `SELECT COUNT(*) c FROM session s
             WHERE (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) >= 2`,
          )
          .get().c;
      } catch {
        contentSessions = sessionsTotal;
      }
      // 最近会话预览（LIMIT 30 走 session 时间索引，开销可控）
      let recent = [];
      try {
        recent = db
          .prepare(
            `SELECT s.id, s.title, s.directory, s.time_updated,
               (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) msgs
             FROM session s ORDER BY s.time_updated DESC LIMIT 30`,
          )
          .all()
          .map((r) => ({ id: r.id, title: r.title ?? "(无标题)", directory: r.directory, updated: r.time_updated, msgs: r.msgs }));
      } catch {
        recent = [];
      }
      const state = await readState();
      for (const r of recent) r.migrated = !!state.sessions[r.id];
      return {
        dbFound: true,
        dbPath: zcodeDb,
        sessionsTotal,
        contentSessions,
        messagesTotal,
        usageRows: usage.rows,
        tokensTotal: usage.tokens ?? 0,
        range: usage.minT ? [usage.minT, usage.maxT] : null,
        byModel,
        migratedCount: Object.keys(state.sessions).length,
        usageMigratedAt: state.usage?.at ?? null,
        recent,
      };
    } finally {
      db.close();
    }
  }

  // ── 用量迁移（叠加源文件） ──────────────────────────────────────────────
  async function migrateUsage() {
    const db = openDb();
    try {
      const rows = db
        .prepare("SELECT model_id, started_at, computed_total_tokens FROM model_usage WHERE computed_total_tokens > 0")
        .all();
      const daily = {};
      for (const r of rows) {
        const day = dayKeyOf(r.started_at);
        let e = daily[day];
        if (!e) {
          e = { tokens: 0, byModel: {} };
          daily[day] = e;
        }
        e.tokens += r.computed_total_tokens;
        e.byModel[r.model_id] = (e.byModel[r.model_id] ?? 0) + r.computed_total_tokens;
      }
      const payload = {
        version: 1,
        source: "zcode",
        generatedAt: Date.now(),
        rows: rows.length,
        daily,
      };
      await fs.mkdir(path.dirname(migratedUsageFile), { recursive: true });
      await fs.writeFile(migratedUsageFile, JSON.stringify(payload), "utf8");
      const state = await readState();
      state.usage = { at: payload.generatedAt, rows: rows.length, file: migratedUsageFile };
      await writeState(state);
      return { rows: rows.length, days: Object.keys(daily).length, tokens: rows.reduce((s, r) => s + r.computed_total_tokens, 0), file: migratedUsageFile };
    } finally {
      db.close();
    }
  }

  // ── 会话导入 ────────────────────────────────────────────────────────────
  function buildTranscript(db, sessionRow, displayTitle) {
    const msgs = db
      .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, sequence")
      .all(sessionRow.id);
    const partsByMsg = new Map();
    const partRows = db.prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY sequence").all(sessionRow.id);
    for (const p of partRows) {
      let j;
      try {
        j = JSON.parse(p.data);
      } catch {
        continue;
      }
      if (j.type !== "text" || typeof j.text !== "string" || !j.text.trim()) continue;
      let list = partsByMsg.get(p.message_id);
      if (!list) {
        list = [];
        partsByMsg.set(p.message_id, list);
      }
      list.push(j.text.trim().slice(0, MSG_CAP));
    }
    const created = new Date(sessionRow.time_created);
    const head = `# ${displayTitle ?? sessionRow.title ?? "(无标题)"}\n\n> 迁移自 ZCode · ${created.toLocaleString("zh-CN")} · ${path.basename(sessionRow.directory ?? "") || "未知工作区"}\n`;
    const blocks = [head];
    for (const msg of msgs) {
      let d;
      try {
        d = JSON.parse(msg.data);
      } catch {
        continue;
      }
      if (d.role !== "user" && d.role !== "assistant") continue;
      const texts = partsByMsg.get(msg.id) ?? [];
      const text = texts.join("\n\n").trim();
      if (!text) continue;
      blocks.push(`**${d.role === "user" ? "用户" : "助手"}**\n\n${text.slice(0, MSG_CAP)}`);
    }
    let body = blocks.join("\n\n---\n\n");
    if (body.length > TR_CAP) body = body.slice(0, TR_CAP) + "\n\n…（内容过长已截断）";
    return body;
  }

  async function migrateSessions(limit) {
    const db = openDb();
    const state = await readState();
    const eligible = db
      .prepare(
        `SELECT s.id, s.title, s.directory, s.time_created, s.time_updated
         FROM session s
         WHERE EXISTS (SELECT 1 FROM message um WHERE um.session_id = s.id AND JSON_EXTRACT(um.data, '$.role') = 'user')
           AND EXISTS (SELECT 1 FROM message am WHERE am.session_id = s.id AND JSON_EXTRACT(am.data, '$.role') = 'assistant')
         ORDER BY s.time_updated DESC`,
      )
      .all()
      .filter((s) => !state.sessions[s.id]);
    const batch = eligible.slice(0, Math.max(1, Math.min(limit ?? 400, 1000)));
    // 工作流子会话（dwf_actor）没有可读标题，ZCode 只给 "workflow subagent actor#N@M"。
    // 用「工作流名 · 角色名」适配，并对同名追加序号；这类会话迁移后自动归档。
    const actorBySession = new Map();
    if (batch.length > 0) {
      const placeholders = batch.map(() => "?").join(",");
      for (const a of db.prepare(
        `SELECT a.session_id sid, a.name an, r.name rn FROM dwf_actor a LEFT JOIN dwf_run r ON r.id=a.run_id WHERE a.session_id IN (${placeholders})`,
      ).all(...batch.map((s) => s.id))) {
        if (a.sid) actorBySession.set(a.sid, a);
      }
    }
    const cleanTitle = (x) => (x ?? "").replace(/\s+/gu, " ").trim();
    const titleCounts = new Map();
    for (const s of batch) {
      const a = actorBySession.get(s.id);
      let base = a ? [cleanTitle(a.rn), cleanTitle(a.an)].filter(Boolean).join(" · ") : cleanTitle(s.title);
      if (!base) base = a ? "工作流子代理" : "迁移自 ZCode 的会话";
      const n = (titleCounts.get(base) || 0) + 1;
      titleCounts.set(base, n);
      s.__title = n > 1 ? `${base} #${n}` : base;
      s.__child = !!a;
    }
    let created = 0;
    let failed = 0;
    const createdIds = [];
    const failures = [];
    try {
      for (const s of batch) {
        try {
          const isChild = actorBySession.has(s.id);
          const transcript = buildTranscript(db, s, s.__title);
          if (transcript.length < 40) continue;
          // 关键：先开持久化写句柄（sessionPersistence.create 会把它登记为该 id 的 live 路由），
          // 再建 store 会话——否则 session/event 事件没有写句柄，flush 不会落盘。
          const dshId = `session-${crypto.randomUUID()}`;
          const cwd = targetCwd;
          const createdAt = s.time_created || Date.now();
          const persistence = ctx.sessionPersistence ?? ctx.get?.('sessionPersistence');
          if (!persistence?.create) throw new Error('sessionPersistence 服务不可用');
          await persistence.create({ version: 4, id: dshId, createdAt, cwd, isSeeded: false });
          const session = ctx.sessions.create(dshId, {
            meta: { cwd, createdAt },
          });
          const userEvent = session.append(
            "user/message",
            {
              // v4 冷读要求 identified message：data.id 必须是非空字符串
              // （实时 append 不校验，落盘后 sessionQuery 校验，缺了就整库判 corrupt）
              id: crypto.randomUUID(),
              role: "user",
              content: [{ type: "text", text: transcript }],
              source: { kind: "user" },
            },
            { surfaceOp: "append" },
          );
          try {
            // session/title 的 v4 契约：messageSeqs 必须是数组、source 必须是对象
            session.append("session/title", {
              title: String(s.__title ?? s.title ?? "迁移会话").slice(0, 80),
              messageSeqs: userEvent?.seq != null ? [userEvent.seq] : [],
              source: { kind: "fallback" },
            });
          } catch {
            // 标题事件写不进去就交给 DSH 自动起名
          }
          await ctx.sessions.flush(session);
          // 挂到「ZCode 迁移」工作区；工作流子会话同时归档，别和真正的对话混在主列表
          let archived = false;
          try {
            const registry = ctx.workspaceRegistry ?? ctx.get?.('workspaceRegistry');
            const entity = registry?.list?.().find((w) => w.record?.path === cwd);
            await entity?.attachSession?.(dshId);
            if (isChild) { await registry?.archiveSession?.(dshId); archived = true; }
          } catch (e) {
            console.warn(`${LOG} 挂接/归档失败（会话已创建）: ${e?.message ?? e}`);
          }
          state.sessions[s.id] = { dshId, at: Date.now(), title: s.__title ?? s.title, archived };
          createdIds.push(dshId);
          created += 1;
          if (created % 25 === 0) await writeState(state);
        } catch (error) {
          failed += 1;
          failures.push(`${s.title ?? s.id}: ${error instanceof Error ? error.message : String(error)}`);
          if (failures.length >= 5) break;
        }
      }
    } finally {
      db.close();
      if (created > 0) await writeState(state);
    }
    await attachInRegistryFile(createdIds);
    return { created, failed, failures, remaining: eligible.length - created };
  }

  // ── RPC ────────────────────────────────────────────────────────────────
  ctx.inject(["sessions", "connection"], (connectionCtx) => {
    const connection = connectionCtx.connection ?? connectionCtx.get?.("connection");
    if (!connection?.fetch?.register) {
      console.warn(`${LOG} connection.fetch 不可用，迁移端点未注册`);
      return;
    }
    const reply = (rpcId, result) => new Response(jsonSafe({ type: "server-response", rpcId, result }), { headers: { "content-type": "application/json" } });
    connection.fetch.register({
      path: RPC_PATH,
      methods: ["POST"],
      requestBody: "buffered",
      async fetch(request) {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        let message;
        try {
          message = await request.json();
        } catch {
          return new Response("body is not JSON", { status: 400 });
        }
        const rpcId = typeof message?.rpcId === "string" ? message.rpcId : "invalid";
        const call = message?.payload;
        try {
          if (call?.method === "migration.attach") {
            // 活体挂接：把已迁移 dshId 并入注册表文件（entity.attachSession 对无 agent
            // 的冷会话会挂起，文件级合并 + 宿主重启即生效）。
            const state = await readState();
            const ids = Object.values(state.sessions).map((r) => r.dshId).filter(Boolean);
            const added = await attachInRegistryFile(ids);
            return reply(rpcId, { ok: true, value: { attached: added, already: ids.length - added, total: ids.length } });
          }
          if (call?.method === "migration.debugList") {
            const persistence = ctx.sessionPersistence ?? ctx.get?.("sessionPersistence");
            const list = await persistence.list();
            const target = list.filter((snap) => snap.header.cwd && snap.header.cwd.includes("zcode-migrated"));
            const probe = list.find((snap) => snap.header.id === (call.payload?.probeId || ""));
            const cwds = {};
            for (const snap of list) { const c = snap.header.cwd || "(none)"; cwds[c] = (cwds[c] || 0) + 1; }
            return reply(rpcId, { ok: true, value: { total: list.length, zcodeMigrated: target.length, cwds, probe: probe ? { id: probe.header.id, cwd: probe.header.cwd } : null } });
          }
                    if (call?.method === "migration.scan") {
            return reply(rpcId, { ok: true, value: await scan() });
          }
          if (call?.method === "migration.run") {
            if (running) return reply(rpcId, { ok: false, error: { code: "migration/busy", message: "已有迁移在执行中" } });
            const payload = call.payload ?? {};
            running = true;
            try {
              const usage = payload.usage === false ? null : await migrateUsage();
              const sessions = payload.importSessions === false ? null : await migrateSessions(payload.limit);
              return reply(rpcId, { ok: true, value: { usage, sessions } });
            } finally {
              running = false;
            }
          }
          return reply(rpcId, { ok: false, error: { code: "migration/bad-method", message: `unknown method: ${call?.method}` } });
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          console.warn(`${LOG} ${call?.method} 失败: ${text}`);
          return reply(rpcId, { ok: false, error: { code: "migration/failed", message: text } });
        }
      },
    });
    console.log(`${LOG} 迁移端点已注册 ${RPC_PATH}（ZCode 库 ${zcodeDb}）`);
  });

  // 把新迁移的 dshId 直接并入工作区注册表（走文件而非 entity.attachSession —— 后者
  // 依赖 agent 注册表里的会话头，迁移会话没有 agent 会卡住）。重启 DSH 后侧栏生效。
  async function attachInRegistryFile(dshIds, archiveIds) {
    if (dshIds.length === 0) return 0;
    const wf = path.join(dshHome, "storages", "workspace.json");
    let j;
    try {
      j = JSON.parse(await fs.readFile(wf, "utf8"));
    } catch {
      return 0;
    }
    j.tables ??= {};
    j.tables.workspaces ??= {};
    j.global ??= {};
    j.global.workspaceIds ??= [];
    let wsId = Object.entries(j.tables.workspaces).find(([, w]) => w.path === targetCwd)?.[0];
    const now = new Date().toISOString();
    if (!wsId) {
      wsId = crypto.randomUUID();
      j.tables.workspaces[wsId] = { path: targetCwd, title: "ZCode 迁移", sessionIds: [], createdAt: now, updatedAt: now };
      j.global.workspaceIds.push(wsId);
    }
    const record = j.tables.workspaces[wsId];
    record.title ??= "ZCode 迁移";
    const set = new Set(record.sessionIds ?? []);
    let added = 0;
    for (const id of dshIds) {
      if (!set.has(id)) {
        set.add(id);
        added += 1;
      }
    }
    record.sessionIds = [...set];
    record.updatedAt = now;
    if (archiveIds?.length) {
      const arch = new Set(j.global.archivedSessionIds ?? []);
      for (const id of archiveIds) arch.add(id);
      j.global.archivedSessionIds = [...arch];
    }
    await fs.writeFile(wf, JSON.stringify(j, null, 2), "utf8");
    return added;
  }

  // ── 标题说明 ───────────────────────────────────────────────────────────
  // 侧栏标题在宿主冷读会话日志时由 title 投影自然折叠出来，无需额外预热。
  // 此前“未命名”的根因是 v4 user/message 缺 data.id 导致冷读判 corrupt，
  // migrateSessions 现已补齐 id（见上），标题即正常显示。

  // 后台补挂：把已迁移但未挂到工作区的会话直接并入注册表文件（每次启动跑一遍）。
  // 不走 entity.attachSession —— 它依赖 agent 注册表的会话头，迁移会话会卡住。
  void (async () => {
    try {
      const state = await readState();
      const all = Object.values(state.sessions);
      const ids = all.map((r) => r.dshId).filter(Boolean);
      const archivedIds = all.filter((r) => r.archived).map((r) => r.dshId).filter(Boolean);
      const added = await attachInRegistryFile(ids, archivedIds);
      if (added > 0) console.log(`${LOG} 启动补挂完成：${added} 个会话已并入「ZCode 迁移」工作区记录`);
    } catch (e) {
      console.warn(`${LOG} 启动补挂失败: ${e?.message ?? e}`);
    }
  })();

  console.log(`${LOG} 已激活`);
}
