/**
 * dsh-session-migration 设置页（Client 半边）。
 * 扫描 ZCode 数据 → 展示概览 → 选项（用量叠加 / 会话导入）→ 执行迁移 → 结果。
 * 样式与 dsh-memory / dsh-usage-stats 同一约定：--dsw-* token + 内联 SVG。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-session-migration",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const STYLES = `
.dshmig-wrap { display: flex; flex-direction: column; gap: 16px; width: 100%; min-width: 0; color: var(--dsw-alias-label-primary); }
.dshmig-title { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary); margin: 0; }
.dshmig-panel { border: 1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2)); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); padding: 16px 18px; }
.dshmig-paneltitle { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.dshmig-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.dshmig-stat { background: var(--dsw-alias-bg-layer-2); border-radius: 10px; padding: 10px 12px; }
.dshmig-stat-num { font-size: 16px; font-weight: 700; }
.dshmig-stat-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin-top: 3px; }
.dshmig-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-top: 8px; line-height: 1.6; word-break: break-all; }
.dshmig-opt { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 12px 0; }
.dshmig-opt + .dshmig-opt { border-top: 1px solid var(--dsw-alias-border-l2); }
.dshmig-opt-title { font-size: 13px; font-weight: 600; }
.dshmig-opt-desc { font-size: 12px; color: var(--dsw-alias-label-tertiary); margin-top: 4px; line-height: 1.6; }
.dshmig-switch { position: relative; width: 46px; height: 25px; border-radius: 13px; background: var(--dsw-alias-bg-layer-3); border: 1px solid var(--dsw-alias-border-l2); cursor: pointer; flex: 0 0 auto; transition: background .15s ease, border-color .15s ease; padding: 0; }
.dshmig-switch[aria-checked="true"] { background: var(--dsw-static-deepseek-500, #4176e6); border-color: transparent; }
.dshmig-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 19px; height: 19px; border-radius: 50%; background: #fff; transition: left .15s ease; box-shadow: 0 1px 3px rgba(0,0,0,.35); }
.dshmig-switch[aria-checked="true"]::after { left: 23px; }
.dshmig-btn { display: flex; align-items: center; gap: 6px; border: none; background: var(--dsw-static-deepseek-500, #4176e6); color: #fff; border-radius: 10px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
.dshmig-btn:disabled { opacity: .55; cursor: default; }
.dshmig-result { background: var(--dsw-alias-bg-layer-2); border-radius: 10px; padding: 12px 14px; font-size: 12px; line-height: 1.8; color: var(--dshus-alias-label-primary, var(--dsw-alias-label-primary)); }
.dshmig-models { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.dshmig-chip { font-size: 11px; padding: 3px 8px; border-radius: 7px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dshmig-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
.dshmig-recent { max-height: 200px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; }
.dshmig-recent-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.dshmig-recent-row:last-child { border-bottom: none; }
.dshmig-recent-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshmig-recent-meta { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.dshmig-tag { font-size: 10px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary); flex: 0 0 auto; }
`;

    const svgProps = { width: 14, height: 14, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
    const IconRefresh = () => h("svg", svgProps, h("path", { d: "M21 12a9 9 0 1 1-2.64-6.36" }), h("path", { d: "M21 3v6h-6" }));

    function fmtTokens(v) {
      if (!Number.isFinite(v) || v <= 0) return "0";
      if (v >= 1e8) return `${(v / 1e8).toFixed(v / 1e8 >= 10 ? 1 : 2).replace(/\.0+$/, "")}亿`;
      if (v >= 1e4) return `${(v / 1e4).toFixed(v / 1e4 >= 100 ? 0 : 1).replace(/\.0$/, "")}万`;
      return String(Math.round(v));
    }

    function Switch({ checked, onChange, label }) {
      return h("button", {
        type: "button", role: "switch", "aria-checked": checked ? "true" : "false",
        "aria-label": label, className: "dshmig-switch", onClick: () => onChange(!checked),
      });
    }

    function MigrationPage({ rpcCall }) {
      const [scan, setScan] = useState(null);
      const [scanBusy, setScanBusy] = useState(true);
      const [scanError, setScanError] = useState(null);
      const [usageOpt, setUsageOpt] = useState(true);
      const [importOpt, setImportOpt] = useState(true);
      const [running, setRunning] = useState(false);
      const [result, setResult] = useState(null);
      const [runError, setRunError] = useState(null);

      const call = useCallback(async (method, payload) => {
        const raw = await rpcCall(method, payload);
        if (raw && raw.ok === false) throw new Error(raw.error?.message || "迁移请求失败");
        return raw && raw.ok === true ? raw.value : raw;
      }, [rpcCall]);

      const doScan = useCallback(async () => {
        setScanBusy(true);
        setScanError(null);
        try {
          setScan(await call("migration.scan", {}));
        } catch (e) {
          setScanError(e?.message ?? String(e));
        } finally {
          setScanBusy(false);
        }
      }, [call]);

      useEffect(() => { void doScan(); }, [doScan]);

      const doRun = useCallback(async () => {
        setRunning(true);
        setRunError(null);
        setResult(null);
        try {
          setResult(await call("migration.run", { usage: usageOpt, importSessions: importOpt }));
          void doScan();
        } catch (e) {
          setRunError(e?.message ?? String(e));
        } finally {
          setRunning(false);
        }
      }, [call, usageOpt, importOpt, doScan]);

      return h("div", { className: "dshmig-wrap" },
        h("h2", { className: "dshmig-title" }, "会话迁移"),
        h("div", { className: "dshmig-panel" },
          h("div", { className: "dshmig-paneltitle" }, "ZCode 数据概览"),
          scanError ? h("div", { className: "dshmig-error" }, scanError) : null,
          scan?.dbFound ? h("div", null,
            h("div", { className: "dshmig-stats" },
              h("div", { className: "dshmig-stat" },
                h("div", { className: "dshmig-stat-num" }, String(scan.contentSessions)),
                h("div", { className: "dshmig-stat-label" }, "可迁移会话"),
              ),
              h("div", { className: "dshmig-stat" },
                h("div", { className: "dshmig-stat-num" }, fmtTokens(scan.tokensTotal)),
                h("div", { className: "dshmig-stat-label" }, "Token 总量"),
              ),
              h("div", { className: "dshmig-stat" },
                h("div", { className: "dshmig-stat-num" }, String(scan.messagesTotal)),
                h("div", { className: "dshmig-stat-label" }, "消息数"),
              ),
              h("div", { className: "dshmig-stat" },
                h("div", { className: "dshmig-stat-num" }, String(scan.migratedCount)),
                h("div", { className: "dshmig-stat-label" }, "已迁移会话"),
              ),
            ),
            h("div", { className: "dshmig-sub" },
              "模型分布：",
              h("span", { className: "dshmig-models" },
                (scan.byModel ?? []).map((m) => h("span", { key: m.name, className: "dshmig-chip" }, `${m.name} ${fmtTokens(m.tokens)}`)),
              ),
            ),
            scan.usageMigratedAt ? h("div", { className: "dshmig-sub" }, `用量已叠加（${new Date(scan.usageMigratedAt).toLocaleString("zh-CN")}）——使用统计会自动合并。`) : null,
          ) : (!scanError && h("div", { className: "dshmig-sub" }, scanBusy ? "扫描中…" : "未找到 ZCode 数据库")),
          h("div", { style: { marginTop: 10 } },
            h("button", { className: "dshmig-btn", style: { background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" }, onClick: () => void doScan(), disabled: scanBusy },
              h(IconRefresh, null), "重新扫描",
            ),
          ),
        ),
        scan?.dbFound ? h("div", { className: "dshmig-panel" },
          h("div", { className: "dshmig-paneltitle" }, "迁移选项"),
          h("div", { className: "dshmig-opt" },
            h("div", null,
              h("div", { className: "dshmig-opt-title" }, "迁移 Token 用量（叠加）"),
              h("div", { className: "dshmig-opt-desc" }, "按 日 × 模型 聚合 ZCode 的全部模型用量，叠加进「使用统计」的累计、热力图、趋势与环形图。可重复执行。"),
            ),
            h(Switch, { checked: usageOpt, onChange: setUsageOpt, label: "迁移 Token 用量" }),
          ),
          h("div", { className: "dshmig-opt" },
            h("div", null,
              h("div", { className: "dshmig-opt-title" }, "导入会话内容"),
              h("div", { className: "dshmig-opt-desc" }, "为每个有实际对话的 ZCode 会话新建一个 DSH 会话，原对话格式化为可读记录（现有 DSH 会话不受影响；已迁移的自动跳过；每批最多 400 个，可多次执行）。"),
            ),
            h(Switch, { checked: importOpt, onChange: setImportOpt, label: "导入会话内容" }),
          ),
          h("div", { style: { display: "flex", alignItems: "center", gap: 12, marginTop: 8 } },
            h("button", { className: "dshmig-btn", onClick: () => void doRun(), disabled: running || (!usageOpt && !importOpt) },
              running ? "迁移中…（会话较多时需要一分钟）" : "开始迁移",
            ),
          ),
          runError ? h("div", { className: "dshmig-error", style: { marginTop: 8 } }, runError) : null,
          result ? h("div", { className: "dshmig-result", style: { marginTop: 10 } },
            result.usage ? h("div", null, `✓ 用量叠加完成：${result.usage.rows} 条记录 / ${result.usage.days} 天 / ${fmtTokens(result.usage.tokens)} tokens`) : null,
            result.sessions ? h("div", null, `✓ 会话导入完成：新建 ${result.sessions.created} 个，失败 ${result.sessions.failed}，剩余待迁 ${result.sessions.remaining}${result.sessions.failures?.length ? "；失败样例: " + result.sessions.failures.join("；") : ""}`) : null,
            h("div", null, "打开「使用统计」即可看到叠加后的数据。"),
          ) : null,
        ) : null,
        scan?.dbFound && (scan.recent ?? []).length ? h("div", { className: "dshmig-panel" },
          h("div", { className: "dshmig-paneltitle" }, "最近的 ZCode 会话"),
          h("div", { className: "dshmig-recent" },
            scan.recent.map((r) => h("div", { key: r.id, className: "dshmig-recent-row" },
              h("span", { className: "dshmig-recent-name" }, r.title),
              h("span", { className: "dshmig-recent-meta" }, `${r.msgs} 条`),
              r.migrated ? h("span", { className: "dshmig-tag" }, "已迁移") : null,
            )),
          ),
        ) : null,
      );
    }

    return {
      inject: ["slots", "connection"],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement("style");
          style.textContent = STYLES;
          document.head.appendChild(style);
          return () => style.remove();
        }, "dsh-session-migration: styles");

        const rpcCall = async (method, payload, signal) => {
          const raw = await ctx.connection.rpc.call("/api", "dsh-session-migration", { method, payload }, signal);
          if (raw && typeof raw === "object" && "ok" in raw) return raw;
          return raw?.result ?? raw;
        };

        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "session-migration",
          order: 62,
          label: () => "会话迁移",
          inject: () => ({ rpcCall }),
        }, MigrationPage));
      },
    };
  },
});
