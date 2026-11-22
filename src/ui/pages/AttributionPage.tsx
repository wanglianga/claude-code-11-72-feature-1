import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { fmtDateTime, fmtNum } from '../format';
import type { AttributionCause, BalanceAnalysis } from '../../domain/balance/types';
import { ATTRIBUTION_LABELS, BALANCE_METRIC_LABELS } from '../../domain/balance/types';

interface Props {
  state: AppState;
  actions: AppActions;
}

const CAUSES: AttributionCause[] = ['STORAGE', 'LAG', 'BACKWASH', 'METER_ERROR', 'REMOVAL_SUPPORT', 'OTHER'];

function residualSummary(a: BalanceAnalysis): string {
  const w = a.result.plant.water.residual;
  const cod = a.result.plant.removal.find((r) => r.pollutant === 'COD')?.unexplained;
  return `水量 ${fmtNum(w.best, 0)} m³（宽 ${fmtNum(w.max - w.min, 0)}）· COD 不可解释 ${fmtNum(cod?.best ?? 0, 1)} kg`;
}

export function AttributionPage({ state, actions }: Props) {
  const { balanceAnalyses, balanceDay, manifest, balance } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [causes, setCauses] = useState<AttributionCause[]>([]);
  const [note, setNote] = useState('');

  const versions = useMemo(
    () =>
      balanceAnalyses
        .filter((a) => a.day === balanceDay && a.plantId === state.balancePlantId)
        .sort((a, b) => b.version - a.version),
    [balanceAnalyses, balanceDay, state.balancePlantId],
  );
  const active = versions.find((a) => a.analysisId === selectedId) ?? versions[0] ?? null;
  const lateFile = manifest?.lateBalanceFile;
  const lateImported = balance.readings.some((r) => r.sourceFileId.includes(lateFile?.fileName.replace('.csv', '') ?? 'none'));

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>归因复核 · {state.balancePlantId} · {balanceDay}</h2>
          <span className="sub">分析版本不可改写；补传流量缩窄已审核残差时生成新版本</span>
          <div className="spacer" />
          <button className="btn" onClick={() => void actions.importLateBalance()} disabled={state.balanceComputing || !lateFile}>
            {lateImported ? '重新导入补传流量' : '导入补传流量'}
          </button>
          <button className="btn primary" onClick={() => void actions.runBalanceAnalysis()} disabled={state.balanceComputing}>
            生成人工分析版本
          </button>
        </div>
        <div className="card-pad">
          {lateFile && (
            <div className={`note ${lateImported ? 'ok' : 'warn'}`}>
              补传流量文件 <span className="mono">{lateFile.fileName}</span>（接收 {fmtDateTime(Date.parse(lateFile.receivedAt))}，{lateFile.rowCount} 行）：
              {lateImported ? '已入库。若其缩窄了已审核残差，系统已自动生成新分析版本。' : '尚未导入。'}
            </div>
          )}
          {versions.length === 0 ? (
            <div className="empty">
              当前还没有分析版本。请先在「平衡分析」页或此处点「生成人工分析版本」；版本一经生成不可改写。
            </div>
          ) : (
            <div className="grid cols-2">
              <div className="stack">
                <div className="field">
                  <label>分析版本（{versions.length}）</label>
                  <select value={active?.analysisId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
                    {versions.map((a) => (
                      <option key={a.analysisId} value={a.analysisId}>
                        v{a.version} · {a.status} · {a.trigger} · {fmtDateTime(a.createdAt).slice(5, 16)}
                      </option>
                    ))}
                  </select>
                </div>
                {active && (
                  <dl className="kv">
                    <dt>状态</dt>
                    <dd><span className={`badge ${active.status === 'REVIEWED' ? 'ok' : 'warn'}`}>{active.status}</span>（结果体不可改写）</dd>
                    <dt>触发</dt>
                    <dd>{active.trigger === 'MANUAL' ? '人工生成' : active.trigger === 'LATE_DATA' ? '补传流量触发' : '登记变更触发'}</dd>
                    <dt>版本链</dt>
                    <dd className="tiny">{active.supersedesId ? `替代 ${active.supersedesId.slice(0, 28)}…` : '首个版本'}</dd>
                    <dt>来源指纹</dt>
                    <dd className="tiny">{active.sourceReadingIds.length} 条读数 · {active.sourceFileHashes.length} 个文件哈希</dd>
                    <dt>登记台账</dt>
                    <dd className="tiny">{active.registryNote}</dd>
                    <dt>残差概览</dt>
                    <dd className="tiny">{residualSummary(active)}</dd>
                  </dl>
                )}
              </div>
              <div className="stack">
                {active && (
                  <>
                    <div className="note">
                      建议归因（规则生成，需人工确认）：
                      {active.result.suggestedCauses.map((s, i) => (
                        <div key={i} className="tiny" style={{ marginTop: 4 }}>
                          <span className="badge info">{ATTRIBUTION_LABELS[s.cause]}</span> {s.evidence}
                        </div>
                      ))}
                    </div>
                    {active.review ? (
                      <div className="note ok">
                        已复核：{active.review.causes.map((c) => ATTRIBUTION_LABELS[c]).join('、') || '未选择归因'}
                        <div className="tiny" style={{ marginTop: 4 }}>
                          {active.review.note}（{active.review.reviewedBy} · {fmtDateTime(active.review.reviewedAt)}）
                        </div>
                      </div>
                    ) : (
                      <div className="note warn">本版本尚未复核。请在下方选择归因并填写附注。</div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {active && (
        <div className="card">
          <div className="card-head">
            <h2>v{active.version} 结果详情</h2>
            <span className="sub">残差区间 · 调整依据 · 去除范围 · 来源追溯</span>
          </div>
          <div className="card-pad stack">
            <div className="grid cols-4">
              <div className="card stat">
                <div className="stat-label">水量残差</div>
                <div className="stat-value small">{fmtNum(active.result.plant.water.residual.best, 0)} m³</div>
                <div className="stat-foot">区间 {fmtNum(active.result.plant.water.residual.min, 0)} – {fmtNum(active.result.plant.water.residual.max, 0)}</div>
              </div>
              <div className="card stat">
                <div className="stat-label">示踪残差</div>
                <div className="stat-value small">{fmtNum(active.result.plant.tracer.residual.best, 1)} kg</div>
                <div className="stat-foot">区间 {fmtNum(active.result.plant.tracer.residual.min, 1)} – {fmtNum(active.result.plant.tracer.residual.max, 1)}</div>
              </div>
              {active.result.plant.removal.map((rem) => (
                <div className="card stat" key={rem.pollutant}>
                  <div className="stat-label">{BALANCE_METRIC_LABELS[rem.pollutant]} 不可解释残差</div>
                  <div className="stat-value small">{fmtNum(rem.unexplained.best, 1)} kg</div>
                  <div className="stat-foot">区间 {fmtNum(rem.unexplained.min, 1)} – {fmtNum(rem.unexplained.max, 1)}</div>
                </div>
              ))}
            </div>

            {active.result.reconcile && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>协调调整（路径 B）</th>
                      <th className="num">测量 → 协调</th>
                      <th className="num">相对调整</th>
                      <th>证书边界</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.result.reconcile.adjustments.map((a) => (
                      <tr key={`${a.meterId}-${a.metric}`}>
                        <td><span className="mono">{a.meterId}</span> <span className="tiny muted">{a.label}</span></td>
                        <td className="num tiny">{fmtNum(a.measured, 1)} → {fmtNum(a.adjusted, 1)}</td>
                        <td className="num tiny">{(a.adjustmentRel * 100).toFixed(2)}%</td>
                        <td>{a.clamped ? <span className="badge bad">触及边界</span> : <span className="badge ok">界内</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="table-wrap" style={{ maxHeight: 240 }}>
              <table>
                <thead>
                  <tr>
                    <th>来源追溯（支路 × 指标）</th>
                    <th className="num">总量区间</th>
                    <th className="num">读数</th>
                    <th>来源文件</th>
                  </tr>
                </thead>
                <tbody>
                  {active.result.streamTotals.map((t) => (
                    <tr key={`${t.streamId}-${t.metric}`}>
                      <td className="tiny"><span className="mono">{t.streamId}</span> · {BALANCE_METRIC_LABELS[t.metric]}</td>
                      <td className="num tiny">{fmtNum(t.total.min, 1)} – {fmtNum(t.total.max, 1)}</td>
                      <td className="num tiny">{t.readingCount}</td>
                      <td className="tiny mono">{t.sourceFileIds.map((f) => f.replace(/^file:/, '').replace(/:[0-9a-f]{16}$/, '')).join('、')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {active && active.status !== 'REVIEWED' && (
        <div className="card card-pad">
          <div className="field">
            <label>归因选择（可多选）</label>
            <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
              {CAUSES.map((c) => (
                <label key={c} className="checkline">
                  <input
                    type="checkbox"
                    checked={causes.includes(c)}
                    onChange={(e) => setCauses((prev) => (e.target.checked ? [...prev, c] : prev.filter((x) => x !== c)))}
                  />
                  {ATTRIBUTION_LABELS[c]}
                </label>
              ))}
            </div>
          </div>
          <div className="row" style={{ alignItems: 'flex-end', gap: 12, marginTop: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>复核附注</label>
              <input
                type="text"
                value={note}
                placeholder="例如：确认反冲洗水混入主线为主因，仪表误差叠加次之；不可解释残差保留待工艺排查"
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <button
              className="btn primary"
              disabled={causes.length === 0}
              onClick={async () => {
                await actions.reviewBalance(active.analysisId, causes, note);
                setCauses([]);
                setNote('');
              }}
            >
              标记复核完成（结果体不变）
            </button>
          </div>
          <div className="tiny muted" style={{ marginTop: 8 }}>
            复核只追加归因与附注；分析结果、来源指纹与版本链保持不变。后续若补传资料缩窄残差，将生成新版本而非改写本版。
          </div>
        </div>
      )}
    </div>
  );
}
