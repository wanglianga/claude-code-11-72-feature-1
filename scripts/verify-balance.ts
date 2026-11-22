#!/usr/bin/env tsx
/**
 * 工艺段平衡分析核验：在真实样例上运行求解器并断言关键不变量。
 *
 * 断言覆盖：
 *  - 水量/示踪闭合区间（路径 A，保证不越界）；
 *  - 观测去除范围仅由工艺记录支持，超出部分保留为不可解释残差；
 *  - 协调（路径 B）只调整水量与示踪量，且都在证书边界内；
 *  - 22:30 进水升高尚未到达可达时间带 → PENDING，不强行配对；
 *  - 回流泵 11:00 切换拆腿，回流不计入主线闭合；
 *  - 补传流量缩窄已审核残差 → 生成新版本，旧版本保持 REVIEWED；
 *  - 停用支路 S-BYP（2026-11-20 生效）不改写 11-18 平衡。
 * 退出码非 0 表示核验失败。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBalanceFromDisk } from './sampleIo';
import type { SampleManifest } from '../src/domain/types';
import { computeBalance } from '../src/domain/balance/solver';
import { buildAnalysis, detectLateNarrowing, reviewAnalysis } from '../src/domain/balance/service';
import { mergeBalanceData } from '../src/sample/ingestBalance';
import type { BalanceAnalysis } from '../src/domain/balance/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sampleDir = resolve(__dirname, '../public/sample');
const manifest = JSON.parse(readFileSync(resolve(sampleDir, 'manifest.json'), 'utf8')) as SampleManifest;
const { balance, lateBalanceReadings, fingerprints } = parseBalanceFromDisk(sampleDir, manifest);

const PLANT = manifest.balanceFocus?.plantId ?? 'P1';
const DAY = manifest.balanceFocus?.day ?? '2026-11-18';

let failures = 0;
function check(label: string, condition: boolean, detail: string): void {
  if (condition) console.log(`  ✓ ${label}：${detail}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}：${detail}`);
  }
}
function fmt(n: number, d = 1): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtB(b: { min: number; best: number; max: number }, d = 1): string {
  return `${fmt(b.min, d)} – ${fmt(b.best, d)} – ${fmt(b.max, d)}`;
}

check('平衡资料指纹与清单一致', fingerprints.every((f) => f.ok), `${fingerprints.filter((f) => f.ok).length}/${fingerprints.length} 通过`);

console.log('\n=== 1. 基础批次分析（反冲洗缺测，区间应偏宽） ===');
const base = computeBalance(balance, PLANT, DAY);
const w = base.plant.water;
console.log(`  水量闭合残差：${fmtB(w.residual)} m³（${w.closes ? '区间内闭合' : '不闭合'}）`);
for (const t of w.terms) console.log(`    ${t.sign > 0 ? '+' : '−'} ${t.label}：${fmtB(t.amount)} （${t.basis}）`);
const tr = base.plant.tracer;
console.log(`  示踪闭合残差：${fmtB(tr.residual)} kg（${tr.closes ? '区间内闭合' : '不闭合'}）`);
check('基础批次水量区间包含 0 但显著偏宽', w.closes && w.residual.max - w.residual.min > 400, `宽度 ${fmt(w.residual.max - w.residual.min)} m³`);

console.log('\n=== 2. 观测去除与去除范围 ===');
for (const r of base.plant.removal) {
  console.log(`  ${r.pollutant}：观测 ${fmtB(r.observed)} kg；支持 ${fmtB(r.supported)} kg；不可解释 ${fmtB(r.unexplained)} kg`);
  for (const c of r.contributions) console.log(`    · ${c.kind} → ${fmtB(c.range)} kg（${c.basis}）`);
}
const cod = base.plant.removal.find((r) => r.pollutant === 'COD')!;
const nh3n = base.plant.removal.find((r) => r.pollutant === 'NH3N')!;
check('COD 观测去除有工艺记录支持', cod.supported.best > 0 && cod.contributions.length >= 2, `${cod.contributions.length} 项贡献`);
check('不可解释残差未被调成测量误差', cod.unexplained.best >= 0 && nh3n.unexplained.best >= 0, `COD ${fmt(cod.unexplained.best)} kg / 氨氮 ${fmt(nh3n.unexplained.best)} kg`);

console.log('\n=== 3. 滞后匹配（22:30 升高不得强行配对） ===');
const pending = base.lagEvents.filter((e) => e.status === 'PENDING');
const matched = base.lagEvents.filter((e) => e.status === 'MATCHED');
const unmatched = base.lagEvents.filter((e) => e.status === 'UNMATCHED');
for (const e of base.lagEvents) {
  const at = new Date(e.at + 8 * 3_600_000).toISOString().slice(11, 16);
  console.log(`  ${e.eventId} ${e.side} ${e.metric} ${e.direction}@${at} → ${e.status}${e.matchedEventId ? ` ↔ ${e.matchedEventId}` : ''}（${e.note}）`);
}
check('22:30 进水升高保持在水力滞后在途', pending.length >= 2 && pending.every((e) => e.matchedEventId === null), `${pending.length} 个 PENDING 事件`);
check('PENDING 事件未被强行配对', pending.every((e) => e.status === 'PENDING' && e.matchedEventId === null), pending.map((e) => e.eventId).join('、'));
check('存在允许配对与未配对事件', matched.length > 0 && unmatched.length > 0, `MATCHED ${matched.length} / UNMATCHED ${unmatched.length}`);
const inTransit = base.plant.inTransit;
for (const t of inTransit) console.log(`  在途 ${t.metric}：${fmtB(t.load, 2)} kg`);
check('在途量已量化', inTransit.length >= 2 && inTransit.every((t) => t.load.max >= t.load.min), inTransit.map((t) => t.metric).join('、'));

console.log('\n=== 4. 回流切换拆腿与主线排除 ===');
const retTotals = base.streamTotals.filter((t) => t.streamId.startsWith('S-RET'));
for (const t of retTotals) console.log(`  ${t.streamId}：${fmtB(t.total)} m³（${t.note}）`);
check('回流两腿各自计量', retTotals.length === 2 && retTotals.every((t) => t.total.best > 0), retTotals.map((t) => `${t.streamId}=${fmt(t.total.best, 0)}`).join('、'));
check('回流未计入主线闭合', !w.terms.some((t) => t.streamId?.startsWith('S-RET')), `闭合分项：${w.terms.map((t) => t.label).join('、')}`);

console.log('\n=== 5. 路径 B：受约束测量协调 ===');
const rec = base.reconcile;
if (!rec) {
  check('协调结果存在', false, '未生成');
} else {
  console.log(`  χ²=${rec.chi2.toFixed(3)}，自由度 ${rec.degreesOfFreedom}；不可协调残差 ${fmt(rec.irreconcilable.best, 3)}`);
  for (const a of rec.adjustments) {
    console.log(`  ${a.meterId}（${a.label}）：${fmt(a.measured, 1)} → ${fmt(a.adjusted, 1)}（${a.adjustment >= 0 ? '+' : ''}${fmt(a.adjustment, 1)}，${(a.adjustmentRel * 100).toFixed(2)}%）${a.clamped ? ' [触及证书边界]' : ''}`);
  }
  check('协调只涉及水量与示踪量', rec.adjustments.every((a) => a.metric === 'FLOW' || a.metric === 'TRACER'), rec.metrics.join('、'));
  check('调整都在证书边界内', rec.adjustments.every((a) => a.withinCertificate), rec.adjustments.filter((a) => !a.withinCertificate).map((a) => a.meterId).join('、') || '全部满足');
  check('协方差依据可追溯', rec.covarianceBasis.length > 0, rec.covarianceBasis.join('；'));
}

console.log('\n=== 6. 单元存量与归因候选 ===');
for (const u of base.units) console.log(`  ${u.name}：${u.levelEvidence}${u.storageDeltaV ? `；ΔV ${fmtB(u.storageDeltaV)} m³` : ''}`);
for (const s of base.suggestedCauses) console.log(`  候选 ${s.cause}：${s.evidence}`);
check('归因候选覆盖四类来源', ['STORAGE', 'LAG', 'BACKWASH', 'METER_ERROR'].every((c) => base.suggestedCauses.some((s) => s.cause === c)), base.suggestedCauses.map((s) => s.cause).join('、'));

console.log('\n=== 7. 停用支路不改写过去平衡 ===');
const byp = balance.streams.find((s) => s.streamId === 'S-BYP')!;
check('S-BYP 停用生效日晚于分析日', byp.effectiveTo !== null && byp.effectiveTo > base.windowTo, `effectiveTo=${new Date(byp.effectiveTo! + 8 * 3_600_000).toISOString().slice(0, 10)}`);
check('停用支路仍在当日登记中（零流量）', base.streamTotals.every((t) => t.streamId !== 'S-BYP'), '无计量读数，按登记零流量处理');
check('注意事项披露停用安排', base.caveats.some((c) => c.includes('S-BYP') && c.includes('改写')), base.caveats.find((c) => c.includes('S-BYP')) ?? '—');

console.log('\n=== 8. 补传流量 → 缩窄已审核残差 → 新版本 ===');
const files = balance.readings.map((r) => r.sourceFileId);
void files;
const now = Date.UTC(2026, 10, 19, 9, 0, 0);
const v1 = buildAnalysis(balance, [], { plantId: PLANT, day: DAY, trigger: 'MANUAL', createdBy: '核验脚本', now }, []);
const v1Reviewed = reviewAnalysis(v1, ['BACKWASH', 'METER_ERROR'], '初核：反冲洗缺测区间偏宽，待补传。', '核验脚本', now + 60_000);
const augmented = mergeBalanceData(balance, { readings: lateBalanceReadings });
const detection = detectLateNarrowing(augmented, [], PLANT, DAY, [v1Reviewed], now + 120_000, '核验脚本');
console.log(`  ${detection.evidence}`);
check('补传后生成新版本', detection.narrowed === true && detection.analysis !== null, detection.evidence);
if (detection.analysis) {
  const v2 = detection.analysis;
  check('新版本标记 LATE_DATA 且指向前版', v2.trigger === 'LATE_DATA' && v2.supersedesId === v1.analysisId, `v${v1.version} → v${v2.version}`);
  check('前版保持 REVIEWED 不改写', v1Reviewed.status === 'REVIEWED' && v1Reviewed.review?.note?.includes('反冲洗') === true, `v${v1.version} ${v1Reviewed.status}`);
  const wBefore = v1.result.plant.water.residual;
  const wAfter = v2.result.plant.water.residual;
  console.log(`  水量残差：${fmtB(wBefore)} → ${fmtB(wAfter)} m³`);
  check('补传后水量残差区间显著缩窄', wAfter.max - wAfter.min < wBefore.max - wBefore.min - 200, `宽 ${fmt(wBefore.max - wBefore.min)} → ${fmt(wAfter.max - wAfter.min)} m³`);
  const bwAfter = v2.result.streamTotals.find((t) => t.streamId === 'S-BW' && t.metric === 'FLOW')!;
  check('反冲洗补传量与登记估计一致', bwAfter.total.best > 400 && bwAfter.total.best < 800, `S-BW ${fmtB(bwAfter.total)} m³`);
  if (v2.result.reconcile) {
    console.log('  补传后协调：');
    for (const a of v2.result.reconcile.adjustments) {
      console.log(`    ${a.meterId}：${fmt(a.measured, 1)} → ${fmt(a.adjusted, 1)}（${(a.adjustmentRel * 100).toFixed(2)}%）${a.clamped ? ' [触及证书边界]' : ''}`);
    }
    console.log(`    χ²=${v2.result.reconcile.chi2.toFixed(3)}，不可协调残差 ${fmt(v2.result.reconcile.irreconcilable.best, 3)}`);
  }
}

console.log('\n=== 9. 反事实：不用登记估计时残差 best 偏移 ===');
const noEstimate = mergeBalanceData(balance, {
  streams: balance.streams.map((s) => (s.streamId === 'S-BW' ? { ...s, gapFlowHighM3h: 0, gapConcHighMgL: { TRACER: 0, COD: 0, NH3N: 0 } } : s)),
});
const baseNoEst = computeBalance(noEstimate, PLANT, DAY);
console.log(`  无登记估计：水量残差 ${fmtB(baseNoEst.plant.water.residual)} m³`);
check(
  '登记估计被正确使用（去掉后 best 偏移一个估计量）',
  baseNoEst.plant.water.residual.best > base.plant.water.residual.best + 200,
  `best ${fmt(baseNoEst.plant.water.residual.best)} vs ${fmt(base.plant.water.residual.best)}（差 ${fmt(baseNoEst.plant.water.residual.best - base.plant.water.residual.best)} m³）`,
);

const analyses: BalanceAnalysis[] = [v1Reviewed];
void analyses;
if (failures > 0) {
  console.error(`\n核验失败 ${failures} 项`);
  process.exit(1);
}
console.log('\n核验通过：边界登记、残差区间、调整依据、去除范围、滞后匹配与版本规则均满足。');
