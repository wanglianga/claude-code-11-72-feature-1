import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SampleManifest } from '../src/domain/types';
import { parseBalanceFromDisk } from '../scripts/sampleIo';
import { computeBalance } from '../src/domain/balance/solver';
import { buildAnalysis, detectLateNarrowing, reviewAnalysis } from '../src/domain/balance/service';
import { reconcile } from '../src/domain/balance/reconcile';
import { mergeBalanceData } from '../src/sample/ingestBalance';
import { matchLag, inTransitLoad } from '../src/domain/balance/lag';
import { supportedRemoval, unexplainedResidual } from '../src/domain/balance/removal';

const sampleDir = resolve(__dirname, '../public/sample');
const manifest = JSON.parse(readFileSync(resolve(sampleDir, 'manifest.json'), 'utf8')) as SampleManifest;
const { balance, lateBalanceReadings, fingerprints } = parseBalanceFromDisk(sampleDir, manifest);
const PLANT = 'P1';
const DAY = '2026-11-18';
const result = computeBalance(balance, PLANT, DAY);

describe('样例平衡资料', () => {
  it('指纹与清单一致', () => {
    expect(fingerprints.length).toBeGreaterThan(0);
    for (const f of fingerprints) expect(f.ok, f.fileName).toBe(true);
  });

  it('边界登记覆盖进出水/回流/排泥/反冲洗与停用支路', () => {
    const kinds = new Set(balance.streams.map((s) => s.kind));
    for (const k of ['IN', 'OUT', 'RETURN', 'SLUDGE', 'BACKWASH']) expect(kinds.has(k as never)).toBe(true);
    const byp = balance.streams.find((s) => s.streamId === 'S-BYP')!;
    expect(byp.effectiveTo).not.toBeNull();
    expect(byp.registeredAt).toBeGreaterThan(byp.effectiveTo!);
  });

  it('不确定度库含精度、共用校准组与可接受调整范围', () => {
    for (const m of balance.meters) {
      expect(m.relSigma).toBeGreaterThanOrEqual(0);
      expect(m.calGroup.length).toBeGreaterThan(0);
      expect(m.adjustLimitRel).toBeGreaterThan(0);
    }
    const groups = new Set(balance.meters.map((m) => m.calGroup));
    expect(groups.size).toBeGreaterThanOrEqual(4);
  });
});

describe('水量与示踪闭合（路径 A）', () => {
  it('水量残差区间保证不越界且含 0（缺测时显著偏宽）', () => {
    const r = result.plant.water.residual;
    expect(r.min).toBeLessThanOrEqual(r.best);
    expect(r.best).toBeLessThanOrEqual(r.max);
    expect(result.plant.water.closes).toBe(true);
    expect(r.max - r.min).toBeGreaterThan(400);
  });

  it('示踪闭合与水量结构一致（守恒项）', () => {
    expect(result.plant.tracer.closes).toBe(true);
    const labels = result.plant.tracer.terms.map((t) => t.label).join('|');
    expect(labels).toContain('进水示踪');
    expect(labels).toContain('反冲洗示踪');
    expect(labels).toContain('存量示踪');
  });

  it('回流从主线闭合拆出（内部循环）', () => {
    expect(result.plant.water.terms.every((t) => !t.streamId?.startsWith('S-RET'))).toBe(true);
    const legs = result.streamTotals.filter((t) => t.streamId.startsWith('S-RET'));
    expect(legs.length).toBe(2);
    expect(legs.every((t) => t.total.best > 0)).toBe(true);
  });

  it('停用支路参与当日登记但不改写历史', () => {
    expect(result.caveats.some((c) => c.includes('S-BYP'))).toBe(true);
    expect(result.caveats.some((c) => c.includes('不改写') || c.includes('不被改写'))).toBe(true);
  });
});

describe('去除范围与不可解释残差', () => {
  it('去除只依据工艺记录形成范围', () => {
    for (const rem of result.plant.removal) {
      expect(rem.contributions.length).toBeGreaterThan(0);
      for (const c of rem.contributions) {
        expect(c.recordId.length).toBeGreaterThan(0);
        expect(c.paramIds.length).toBeGreaterThan(0);
      }
    }
  });

  it('观测超出支持的部分保留为不可解释残差', () => {
    const cod = result.plant.removal.find((r) => r.pollutant === 'COD')!;
    expect(cod.unexplained.best).toBeGreaterThan(0);
    expect(cod.unexplained.max).toBeGreaterThanOrEqual(cod.unexplained.best);
    const nh3n = result.plant.removal.find((r) => r.pollutant === 'NH3N')!;
    expect(nh3n.unexplained.best).toBeGreaterThan(0);
  });

  it('无工艺记录时去除范围为 0（不凭空放宽）', () => {
    const empty = { ...balance, processRecords: [] };
    const sup = supportedRemoval(empty, 'COD', result.windowFrom, result.windowTo);
    expect(sup.supported.best).toBe(0);
    const un = unexplainedResidual({ min: 90, best: 100, max: 110 }, sup.supported);
    expect(un.best).toBe(100);
  });

  it('DO 低于登记下限时好氧去除折减', () => {
    const lowDo = {
      ...balance,
      processRecords: balance.processRecords.map((r) => (r.kind === 'DO' ? { ...r, value: 0.5 } : r)),
    };
    const sup = supportedRemoval(lowDo, 'COD', result.windowFrom, result.windowTo);
    expect(sup.supported.best).toBeLessThan(result.plant.removal.find((r) => r.pollutant === 'COD')!.supported.best);
  });
});

describe('滞后匹配器', () => {
  it('22:30 进水升高保持在水力滞后在途，不强行配对', () => {
    const pending = result.lagEvents.filter((e) => e.status === 'PENDING');
    expect(pending.length).toBeGreaterThanOrEqual(2);
    for (const e of pending) {
      expect(e.matchedEventId).toBeNull();
      expect(e.reachableFrom!).toBeGreaterThanOrEqual(result.windowTo);
    }
  });

  it('带内同向事件允许配对', () => {
    const matched = result.lagEvents.filter((e) => e.status === 'MATCHED');
    expect(matched.length).toBeGreaterThanOrEqual(2);
    const byId = new Map(result.lagEvents.map((e) => [e.eventId, e]));
    for (const e of matched.filter((x) => x.side === 'IN')) {
      const out = byId.get(e.matchedEventId!)!;
      expect(out.at).toBeGreaterThanOrEqual(e.reachableFrom!);
      expect(out.at).toBeLessThanOrEqual(e.reachableTo!);
    }
  });

  it('在途量区间有序且非负', () => {
    for (const t of result.plant.inTransit) {
      expect(t.load.min).toBeGreaterThanOrEqual(0);
      expect(t.load.min).toBeLessThanOrEqual(t.load.best);
      expect(t.load.best).toBeLessThanOrEqual(t.load.max);
    }
  });

  it('时槽模型：窗口末端前的负荷全部在途（最晚模型）', () => {
    const slots = [{ from: 1000, load: 10 }];
    const t = inTransitLoad(slots, 2000, 500, 1500);
    expect(t.min).toBe(0);
    expect(t.max).toBe(10);
  });

  it('进水事件晚于可达时间带起点即 PENDING', () => {
    const pending: string[] = [];
    const m = matchLag(
      {
        metric: 'FLOW',
        inSeries: [
          { at: 0, value: 100 },
          { at: 3_000_000, value: 100 },
          { at: 5_400_000, value: 100 },
          { at: 5_460_000, value: 200 },
          { at: 6_000_000, value: 200 },
          { at: 7_200_000, value: 200 },
        ],
        outSeries: [{ at: 0, value: 100 }],
        windowFrom: 0,
        windowTo: 7_200_000,
        lagMinMs: 1_800_000,
        lagMaxMs: 2_400_000,
      },
      null,
      pending,
    );
    expect(m.events.some((e) => e.status === 'PENDING')).toBe(true);
    expect(m.events.filter((e) => e.status === 'PENDING').every((e) => e.matchedEventId === null)).toBe(true);
  });
});

describe('受约束测量协调（路径 B）', () => {
  it('只调整水量与示踪量，COD/氨氮被拒绝', () => {
    expect(result.reconcile).not.toBeNull();
    for (const a of result.reconcile!.adjustments) {
      expect(['FLOW', 'TRACER']).toContain(a.metric);
    }
    expect(() =>
      reconcile(
        [{ meterId: 'X', metric: 'COD', label: 'x', measured: 1, sigma: 0.1, adjustLimit: 1, calGroup: '', groupCorrelation: 0 }],
        [{ a: [1], b: 0, label: 'c', unit: 'kg' }],
      ),
    ).toThrow(/只允许水量与无反应示踪量/);
  });

  it('调整都在证书边界内且协方差依据可追溯', () => {
    for (const a of result.reconcile!.adjustments) expect(a.withinCertificate).toBe(true);
    expect(result.reconcile!.covarianceBasis.length).toBeGreaterThan(0);
  });

  it('超出证书边界的需求被钳制并保留不可协调残差', () => {
    const r = reconcile(
      [
        { meterId: 'A', metric: 'FLOW', label: 'A', measured: 100, sigma: 1, adjustLimit: 5, calGroup: 'g', groupCorrelation: 0 },
        { meterId: 'B', metric: 'FLOW', label: 'B', measured: 90, sigma: 1, adjustLimit: 5, calGroup: 'g', groupCorrelation: 0 },
      ],
      [{ a: [1, -1], b: 30, label: 'closure', unit: 'm³' }],
    );
    // 需要 +30 的净调整，但两表合计只能 ±10 → 剩余 20 不可协调
    const clamped = r.result.adjustments.filter((a) => a.clamped);
    expect(clamped.length).toBeGreaterThan(0);
    expect(r.constraintResiduals[0]).toBeGreaterThan(0);
    expect(r.result.irreconcilable.best).toBeGreaterThan(0);
  });
});

describe('分析版本与补传流量', () => {
  const now = Date.UTC(2026, 10, 19, 9, 0, 0);
  const v1 = buildAnalysis(balance, [], { plantId: PLANT, day: DAY, trigger: 'MANUAL', createdBy: 'test', now }, []);
  const v1r = reviewAnalysis(v1, ['BACKWASH'], '初核', 'test', now + 1000);
  const augmented = mergeBalanceData(balance, { readings: lateBalanceReadings });

  it('版本不可改写且复核只追加结论', () => {
    expect(v1r.status).toBe('REVIEWED');
    expect(v1r.review?.causes).toContain('BACKWASH');
    expect(v1r.result).toBe(v1.result);
    const again = reviewAnalysis(v1r, ['OTHER'], '改写尝试', 'x', now + 2000);
    expect(again.review?.causes).toContain('BACKWASH');
  });

  it('补传流量缩窄已审核残差 → 生成新版本', () => {
    const detection = detectLateNarrowing(augmented, [], PLANT, DAY, [v1r], now + 2000, 'test');
    expect(detection.narrowed).toBe(true);
    expect(detection.analysis).not.toBeNull();
    expect(detection.analysis!.trigger).toBe('LATE_DATA');
    expect(detection.analysis!.supersedesId).toBe(v1.analysisId);
    expect(detection.analysis!.version).toBe(v1.version + 1);
    const wBefore = v1.result.plant.water.residual;
    const wAfter = detection.analysis!.result.plant.water.residual;
    expect(wAfter.max - wAfter.min).toBeLessThan(wBefore.max - wBefore.min);
  });

  it('无已审核版本时不生成新版本', () => {
    const detection = detectLateNarrowing(augmented, [], PLANT, DAY, [v1], now + 2000, 'test');
    expect(detection.narrowed).toBe(false);
    expect(detection.analysis).toBeNull();
  });

  it('补传后反冲洗量落到登记估计区间内', () => {
    const after = computeBalance(augmented, PLANT, DAY);
    const bw = after.streamTotals.find((t) => t.streamId === 'S-BW' && t.metric === 'FLOW')!;
    expect(bw.total.best).toBeGreaterThan(400);
    expect(bw.total.best).toBeLessThan(800);
    expect(bw.gapSeconds).toBe(0);
  });
});
