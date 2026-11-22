import { useMemo } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { fmtDateTime, fmtNum, pct, shortTime } from '../format';
import type { ClosureResult, LagEvent } from '../../domain/balance/types';
import { ATTRIBUTION_LABELS, BALANCE_METRIC_LABELS, PROCESS_KIND_LABELS } from '../../domain/balance/types';
import type { LoadBounds } from '../../domain/types';

interface Props {
  state: AppState;
  actions: AppActions;
}

function bounds(b: LoadBounds, digits = 1): string {
  return `${fmtNum(b.min, digits)} – ${fmtNum(b.best, digits)} – ${fmtNum(b.max, digits)}`;
}

/** 区间条：min–max 区间与 best 标记，0 点位置用于判断闭合 */
function IntervalBar({ b, zero = true }: { b: LoadBounds; zero?: boolean }) {
  const span = Math.max(Math.abs(b.min), Math.abs(b.max), zero ? 0 : 1e-9);
  if (span <= 0) return <span className="tiny muted">0</span>;
  const left = ((b.min + span) / (2 * span)) * 100;
  const width = ((b.max - b.min) / (2 * span)) * 100;
  const bestPos = ((b.best + span) / (2 * span)) * 100;
  return (
    <span style={{ display: 'inline-block', width: 140, height: 10, position: 'relative', background: 'var(--surface-2)', borderRadius: 4, verticalAlign: 'middle' }}>
      {zero && <span style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'var(--line-strong, #888)' }} />}
      <span style={{ position: 'absolute', left: `${left}%`, width: `${Math.max(width, 1)}%`, top: 2, bottom: 2, background: 'var(--accent, #3a7)', borderRadius: 3, opacity: 0.45 }} />
      <span style={{ position: 'absolute', left: `${bestPos}%`, top: 0, bottom: 0, width: 2, marginLeft: -1, background: 'var(--accent, #3a7)' }} />
    </span>
  );
}

function ClosureCard({ title, closure, unit }: { title: string; closure: ClosureResult; unit: string }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className={`badge ${closure.closes ? 'ok' : 'bad'}`}>{closure.closes ? '区间内闭合' : '不闭合'}</span>
      </div>
      <div className="card-pad">
        <div className="row" style={{ alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <span className="stat-value small">残差 {bounds(closure.residual)} {unit}</span>
          <IntervalBar b={closure.residual} />
          <span className="tiny muted">区间宽 {fmtNum(closure.residual.max - closure.residual.min, 1)} {unit}（保证不越界）</span>
        </div>
        <table style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th>分项</th>
              <th className="num">区间 ({unit})</th>
              <th>依据</th>
            </tr>
          </thead>
          <tbody>
            {closure.terms.map((t, i) => (
              <tr key={i}>
                <td>
                  <span className="mono">{t.sign > 0 ? '＋' : '－'}</span> {t.label}
                </td>
                <td className="num tiny">{bounds(t.amount)}</td>
                <td className="tiny muted">{t.basis}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {closure.note && <div className="note" style={{ marginTop: 8 }}>{closure.note}</div>}
      </div>
    </div>
  );
}

const LAG_STATUS_LABEL: Record<LagEvent['status'], { cls: string; label: string }> = {
  MATCHED: { cls: 'ok', label: '允许配对' },
  PENDING: { cls: 'warn', label: '在途未到达' },
  UNMATCHED: { cls: 'bad', label: '带内无配对' },
  ORPHAN: { cls: 'neutral', label: '无进水前驱' },
};

export function BalancePage({ state, actions }: Props) {
  const { balance, balanceDay, balanceResult: r, balanceComputing } = state;
  const days = useMemo(() => [...new Set(balance.readings.map((x) => x.dayKey))].sort(), [balance.readings]);
  const lagBand = useMemo(() => {
    const units = balance.units.filter((u) => u.plantId === state.balancePlantId);
    return {
      min: units.reduce((a, u) => a + u.lagMinMinutes, 0),
      max: units.reduce((a, u) => a + u.lagMaxMinutes, 0),
    };
  }, [balance.units, state.balancePlantId]);

  if (balance.units.length === 0) {
    return (
      <div className="card card-pad">
        <div className="empty">尚未装载平衡分析资料。请在「概览」页装载样例资料（含边界登记与不确定度库）。</div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>工艺段平衡分析 · {state.balancePlantId}</h2>
          <span className="sub">路径 A 误差传播（保证不越界）＋ 路径 B 受约束测量协调（仅水量/示踪）</span>
          <div className="spacer" />
          <div className="field" style={{ minWidth: 130 }}>
            <label>分析日</label>
            <select value={balanceDay} onChange={(e) => actions.setBalanceDay(e.target.value)}>
              {days.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>
          <button className="btn primary" onClick={() => void actions.runBalanceAnalysis()} disabled={balanceComputing || !r}>
            {balanceComputing ? '计算中…' : '生成分析版本（不可改写）'}
          </button>
        </div>
        <div className="card-pad">
          {!r ? (
            <div className="empty"><span className="spinner" /> 正在计算平衡分析…</div>
          ) : (
            <div className="grid cols-4">
              <div className="card stat">
                <div className="stat-label">水量残差</div>
                <div className="stat-value small">{fmtNum(r.plant.water.residual.best, 0)} m³</div>
                <div className="stat-foot">区间 {fmtNum(r.plant.water.residual.min, 0)} – {fmtNum(r.plant.water.residual.max, 0)}</div>
              </div>
              <div className="card stat">
                <div className="stat-label">示踪残差</div>
                <div className="stat-value small">{fmtNum(r.plant.tracer.residual.best, 1)} kg</div>
                <div className="stat-foot">区间 {fmtNum(r.plant.tracer.residual.min, 1)} – {fmtNum(r.plant.tracer.residual.max, 1)}</div>
              </div>
              {r.plant.removal.map((rem) => (
                <div className="card stat" key={rem.pollutant}>
                  <div className="stat-label">{BALANCE_METRIC_LABELS[rem.pollutant]} 不可解释残差</div>
                  <div className="stat-value small">{fmtNum(rem.unexplained.best, 1)} kg</div>
                  <div className="stat-foot">区间 {fmtNum(rem.unexplained.min, 1)} – {fmtNum(rem.unexplained.max, 1)}（必须保留）</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {r && (
        <>
          <ClosureCard title="水量闭合（守恒项 · 路径 A 区间传播）" closure={r.plant.water} unit="m³" />
          <ClosureCard title="无反应示踪量闭合（守恒项 · 路径 A 区间传播）" closure={r.plant.tracer} unit="kg" />

          <div className="card">
            <div className="card-head">
              <h2>观测去除与去除范围（COD / 氨氮）</h2>
              <span className="sub">去除只能依据工艺记录形成范围；超出部分保留为不可解释残差，绝不调成测量误差</span>
            </div>
            <div className="card-pad stack">
              {r.plant.removal.map((rem) => (
                <div key={rem.pollutant}>
                  <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                    <strong>{BALANCE_METRIC_LABELS[rem.pollutant]}</strong>
                    <span className={`badge ${rem.unexplained.best !== 0 || rem.unexplained.min !== 0 ? 'warn' : 'ok'}`}>
                      {rem.unexplained.best !== 0 || rem.unexplained.min !== 0 ? '存在不可解释残差' : '支持范围内'}
                    </span>
                  </div>
                  <table style={{ marginTop: 6 }}>
                    <thead>
                      <tr>
                        <th>项目</th>
                        <th className="num">区间 (kg)</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>观测去除（进 − 出 − 反冲洗 − 存量）</td>
                        <td className="num tiny">{bounds(rem.observed)}</td>
                        <td><IntervalBar b={rem.observed} zero={false} /></td>
                      </tr>
                      <tr>
                        <td>工艺记录支持范围</td>
                        <td className="num tiny">{bounds(rem.supported)}</td>
                        <td><IntervalBar b={rem.supported} zero={false} /></td>
                      </tr>
                      <tr>
                        <td><strong>不可解释残差（保留）</strong></td>
                        <td className="num tiny"><strong>{bounds(rem.unexplained)}</strong></td>
                        <td><IntervalBar b={rem.unexplained} /></td>
                      </tr>
                    </tbody>
                  </table>
                  <table style={{ marginTop: 6 }}>
                    <thead>
                      <tr>
                        <th>去除贡献</th>
                        <th className="num">范围 (kg)</th>
                        <th>依据（工艺记录 × 参数台账）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rem.contributions.map((c, i) => (
                        <tr key={i}>
                          <td><span className="badge neutral">{PROCESS_KIND_LABELS[c.kind]}</span></td>
                          <td className="num tiny">{bounds(c.range)}</td>
                          <td className="tiny muted">{c.basis}（参数：{c.paramIds.join('、')}）</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="note" style={{ marginTop: 6 }}>{rem.note}</div>
                </div>
              ))}
            </div>
          </div>

          {r.reconcile && (
            <div className="card">
              <div className="card-head">
                <h2>路径 B：受约束测量协调（调整依据）</h2>
                <span className="sub">仅水量与示踪量参与；χ²={fmtNum(r.reconcile.chi2, 2)}，自由度 {r.reconcile.degreesOfFreedom}</span>
              </div>
              <div className="card-pad">
                <table>
                  <thead>
                    <tr>
                      <th>仪表</th>
                      <th className="num">测量值</th>
                      <th className="num">协调值</th>
                      <th className="num">调整量</th>
                      <th className="num">相对调整</th>
                      <th className="num">σ 倍数</th>
                      <th>证书边界</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.reconcile.adjustments.map((a) => (
                      <tr key={`${a.meterId}-${a.metric}`}>
                        <td>
                          <strong className="mono">{a.meterId}</strong>
                          <div className="tiny muted">{a.label} · {a.calGroup}</div>
                        </td>
                        <td className="num">{fmtNum(a.measured, 1)}</td>
                        <td className="num">{fmtNum(a.adjusted, 1)}</td>
                        <td className="num">{a.adjustment >= 0 ? '+' : ''}{fmtNum(a.adjustment, 1)}</td>
                        <td className="num">{(a.adjustmentRel * 100).toFixed(2)}%</td>
                        <td className="num">{fmtNum(Math.abs(a.adjustment) / Math.max(a.sigma, 1e-9), 2)}σ</td>
                        <td>
                          {a.clamped ? (
                            <span className="badge bad" title="调整触及证书边界被钳制，超出部分保留为不可协调残差">触及边界</span>
                          ) : (
                            <span className="badge ok">界内</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="note" style={{ marginTop: 8 }}>
                  协方差依据：{r.reconcile.covarianceBasis.join('；')}。COD/氨氮不在变量集内，去除量不参与协调。
                  不可协调残差 {fmtNum(r.reconcile.irreconcilable.best, 2)}（触及证书边界后仍剩余的部分，保留复核）。
                </div>
              </div>
            </div>
          )}

          <div className="grid cols-2">
            <div className="card">
              <div className="card-head">
                <h2>滞后匹配（可达时间带 {lagBand.min}–{lagBand.max} min）</h2>
                <span className="sub">进水升高未到达可达时间带时保持在水力滞后在途，不强行配对</span>
              </div>
              <div className="card-pad table-wrap" style={{ maxHeight: 320 }}>
                <table>
                  <thead>
                    <tr>
                      <th>事件</th>
                      <th>指标</th>
                      <th>时刻</th>
                      <th>状态</th>
                      <th>说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.lagEvents.map((e) => (
                      <tr key={e.eventId}>
                        <td className="tiny mono">{e.side === 'IN' ? '进水' : '出水'} {e.direction === 'RISE' ? '↗' : '↘'}</td>
                        <td className="tiny">{BALANCE_METRIC_LABELS[e.metric]}</td>
                        <td className="tiny mono">{shortTime(e.at)}</td>
                        <td><span className={`badge ${LAG_STATUS_LABEL[e.status].cls}`}>{LAG_STATUS_LABEL[e.status].label}</span></td>
                        <td className="tiny muted">{e.note}{e.matchedEventId ? `（↔ ${e.matchedEventId}）` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-pad" style={{ paddingTop: 0 }}>
                {r.plant.inTransit.map((t) => (
                  <div className="note warn" key={t.metric} style={{ marginTop: 6 }}>
                    在途 {BALANCE_METRIC_LABELS[t.metric]}：{bounds(t.load, 2)} kg（{t.note}）
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h2>单元存量与归因候选</h2>
                <span className="sub">候选由规则生成，最终归因由工艺人员在「归因复核」确认</span>
              </div>
              <div className="card-pad stack">
                <table>
                  <thead>
                    <tr>
                      <th>单元</th>
                      <th className="num">ΔV (m³)</th>
                      <th>液位证据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.units.map((u) => (
                      <tr key={u.unitId}>
                        <td className="tiny">{u.name}</td>
                        <td className="num tiny">{u.storageDeltaV ? bounds(u.storageDeltaV, 0) : '—'}</td>
                        <td className="tiny muted">{u.levelEvidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {r.suggestedCauses.map((s, i) => (
                  <div className="note" key={i}>
                    <span className="badge info">{ATTRIBUTION_LABELS[s.cause]}</span> {s.evidence}
                  </div>
                ))}
                {r.caveats.map((c, i) => (
                  <div className="note warn" key={`c-${i}`}>{c}</div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>支路总量与来源追溯</h2>
              <span className="sub">每个总量都可回溯到读数与来源文件</span>
            </div>
            <div className="card-pad table-wrap" style={{ maxHeight: 360 }}>
              <table>
                <thead>
                  <tr>
                    <th>支路</th>
                    <th>指标</th>
                    <th className="num">总量区间</th>
                    <th className="num">读数</th>
                    <th className="num">缺测 s</th>
                    <th>来源文件</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {r.streamTotals.map((t) => (
                    <tr key={`${t.streamId}-${t.metric}`}>
                      <td className="mono tiny">{t.streamId}</td>
                      <td className="tiny">{BALANCE_METRIC_LABELS[t.metric]}</td>
                      <td className="num tiny">{bounds(t.total, t.metric === 'FLOW' ? 1 : 2)} {t.metric === 'FLOW' ? 'm³' : 'kg'}</td>
                      <td className="num tiny">{t.readingCount}</td>
                      <td className="num tiny">{t.gapSeconds > 0 ? fmtNum(t.gapSeconds, 0) : '—'}</td>
                      <td className="tiny mono">{t.sourceFileIds.map((f) => f.replace(/^file:/, '').replace(/:[0-9a-f]{16}$/, '')).join('、')}</td>
                      <td className="tiny muted">{t.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-pad" style={{ paddingTop: 0 }}>
              <div className="tiny muted">
                计算耗时 {fmtNum(r.computeMs, 0)} ms · 窗口 {fmtDateTime(r.windowFrom)} → {fmtDateTime(r.windowTo)} · 覆盖 {pct(r.streamTotals.filter((t) => t.gapSeconds === 0).length / Math.max(1, r.streamTotals.length), 0)} 支路指标全程有计量
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
