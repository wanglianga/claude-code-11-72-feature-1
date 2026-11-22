import type { AppActions, AppState } from '../useAppState';
import { fmtDateTime, fmtNum, shortTime } from '../format';
import { STREAM_KIND_LABELS } from '../../domain/balance/types';

interface Props {
  state: AppState;
  actions: AppActions;
}

/** 边界配置：工艺单元、边界流（进出水/回流/排泥/反冲洗/旁通）、液位与泵切换登记 */
export function BoundaryPage({ state }: Props) {
  const { balance, balanceDay } = state;
  const dayStreams = balance.streams
    .filter((s) => s.plantId === state.balancePlantId)
    .sort((a, b) => a.streamId.localeCompare(b.streamId));
  const switches = [...balance.pumpSwitches].sort((a, b) => a.at - b.at);
  const dayMs = (d: string) => new Date(`${d}T00:00:00+08:00`).getTime();
  const windowTo = dayMs(balanceDay) + 86_400_000;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>工艺单元登记</h2>
          <span className="sub">水面面积 → 存量变化；滞后时间带 → 可达配对</span>
        </div>
        <div className="card-pad">
          {balance.units.length === 0 ? (
            <div className="empty">尚未装载平衡分析资料。请在「概览」页装载样例资料。</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>单元</th>
                  <th>类型</th>
                  <th className="num">水面面积 m²</th>
                  <th className="num">滞后带 min</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {balance.units.map((u) => (
                  <tr key={u.unitId}>
                    <td>
                      <strong>{u.name}</strong> <span className="tiny muted mono">{u.unitId}</span>
                    </td>
                    <td className="tiny">{u.kind}</td>
                    <td className="num">{fmtNum(u.surfaceAreaM2, 0)}</td>
                    <td className="num">
                      {u.lagMinMinutes}–{u.lagMaxMinutes}
                    </td>
                    <td className="tiny muted">{u.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>边界流登记（{dayStreams.length} 条支路）</h2>
          <span className="sub">支路有效期决定其参与哪些日的平衡；停用确认不改写生效日之前的分析</span>
        </div>
        <div className="card-pad table-wrap">
          <table>
            <thead>
              <tr>
                <th>支路</th>
                <th>类型</th>
                <th>单元</th>
                <th>流量计</th>
                <th>内部循环</th>
                <th>有效期</th>
                <th>缺测登记估计</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {dayStreams.map((s) => {
                const decommissioned = s.effectiveTo !== null;
                const activeInWindow = s.effectiveFrom < windowTo && (s.effectiveTo === null || s.effectiveTo > windowTo - 86_400_000);
                return (
                  <tr key={s.streamId}>
                    <td>
                      <strong className="mono">{s.streamId}</strong>
                      <div className="tiny muted">{s.note}</div>
                    </td>
                    <td>{STREAM_KIND_LABELS[s.kind]}</td>
                    <td className="tiny">{s.unitId}</td>
                    <td className="mono tiny">{s.flowMeterId ?? '—（无量计）'}</td>
                    <td>{s.internal ? <span className="badge neutral">内部</span> : <span className="badge info">厂界</span>}</td>
                    <td className="tiny mono">
                      {fmtDateTime(s.effectiveFrom).slice(0, 10)} → {s.effectiveTo ? fmtDateTime(s.effectiveTo).slice(0, 10) : '在役'}
                    </td>
                    <td className="tiny">
                      {s.gapFlowHighM3h > 0 ? (
                        <span>
                          {s.gapFlowLowM3h}–{s.gapFlowHighM3h} m³/h；浓度 {s.gapConcLowMgL.COD}–{s.gapConcHighMgL.COD} mg/L(COD)
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      {decommissioned ? (
                        <span className="badge warn" title={`登记于 ${fmtDateTime(s.registeredAt)}`}>
                          {fmtDateTime(s.effectiveTo!).slice(0, 10)} 停用
                        </span>
                      ) : activeInWindow ? (
                        <span className="badge ok">在役</span>
                      ) : (
                        <span className="badge neutral">窗口外</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="card-pad" style={{ paddingTop: 0 }}>
          <div className="note">
            规则：停用支路按「生效时刻」参与历史平衡——例如 S-BYP 于 2026-11-20 停用（2026-11-22 登记确认），
            2026-11-18 的分析仍按其有效登记计算且永不被改写；2026-11-20 起的新分析自动不再包含该支路。
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>回流泵切换事件</h2>
            <span className="sub">RETURN 支路据此拆腿，内部循环不计入主线闭合</span>
          </div>
          <div className="card-pad">
            {switches.length === 0 ? (
              <div className="empty">无切换事件</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>时刻</th>
                    <th>泵</th>
                    <th>切换</th>
                    <th>工单</th>
                  </tr>
                </thead>
                <tbody>
                  {switches.map((sw) => (
                    <tr key={sw.switchId}>
                      <td className="mono tiny">{shortTime(sw.at)}</td>
                      <td className="mono">{sw.pumpId}</td>
                      <td className="tiny">
                        <span className="mono">{sw.fromStreamId}</span> → <span className="mono">{sw.toStreamId}</span>
                        <div className="tiny muted">{sw.reason}</div>
                      </td>
                      <td className="mono tiny">{sw.workOrder}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>液位记录（{balanceDay}）</h2>
            <span className="sub">ΔV = (末液位 − 初液位) × 水面面积</span>
          </div>
          <div className="card-pad">
            {balance.units.filter((u) => balance.levels.some((l) => l.unitId === u.unitId)).length === 0 ? (
              <div className="empty">无液位记录</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>单元</th>
                    <th className="num">记录数</th>
                    <th className="num">初液位 m</th>
                    <th className="num">末液位 m</th>
                    <th className="num">日内幅度 m</th>
                  </tr>
                </thead>
                <tbody>
                  {balance.units
                    .filter((u) => balance.levels.some((l) => l.unitId === u.unitId))
                    .map((u) => {
                      const recs = balance.levels
                        .filter((l) => l.unitId === u.unitId && l.at >= dayMs(balanceDay) && l.at <= windowTo)
                        .sort((a, b) => a.at - b.at);
                      const first = recs[0];
                      const last = recs[recs.length - 1];
                      const levels = recs.map((r) => r.levelM);
                      return (
                        <tr key={u.unitId}>
                          <td>{u.name}</td>
                          <td className="num">{recs.length}</td>
                          <td className="num">{first ? first.levelM.toFixed(2) : '—'}</td>
                          <td className="num">{last ? last.levelM.toFixed(2) : '—'}</td>
                          <td className="num">
                            {recs.length > 0 ? `${Math.min(...levels).toFixed(2)}–${Math.max(...levels).toFixed(2)}` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
