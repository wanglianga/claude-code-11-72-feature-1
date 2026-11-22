/**
 * 平衡分析版本服务：
 * - 分析创建后不可改写；版本号按（厂站, 日）递增，supersedesId 串起版本链；
 * - 补传流量使已审核残差缩窄时生成新版本（trigger=LATE_DATA），前版保持 REVIEWED；
 * - 复核只追加 review 字段与状态迁移（OPEN → REVIEWED），结果体不变。
 */

import type { IntakeFile } from '../types';
import type { AttributionCause, BalanceAnalysis, BalanceData, BalanceResult } from './types';
import { BALANCE_ENGINE_VERSION } from './types';
import { computeBalance } from './solver';

export interface BuildAnalysisInput {
  plantId: string;
  day: string;
  trigger: BalanceAnalysis['trigger'];
  createdBy: string;
  now: number;
}

function residualWidths(result: BalanceResult): { water: number; tracer: number; cod: number; nh3n: number } {
  const w = (b: { min: number; max: number }) => b.max - b.min;
  const cod = result.plant.removal.find((r) => r.pollutant === 'COD');
  const nh3n = result.plant.removal.find((r) => r.pollutant === 'NH3N');
  return {
    water: w(result.plant.water.residual),
    tracer: w(result.plant.tracer.residual),
    cod: cod ? w(cod.unexplained) : 0,
    nh3n: nh3n ? w(nh3n.unexplained) : 0,
  };
}

export function buildAnalysis(
  data: BalanceData,
  files: IntakeFile[],
  input: BuildAnalysisInput,
  existing: BalanceAnalysis[],
): BalanceAnalysis {
  const result = computeBalance(data, input.plantId, input.day);
  const siblings = existing
    .filter((a) => a.plantId === input.plantId && a.day === input.day)
    .sort((a, b) => b.version - a.version);
  const previous = siblings[0] ?? null;
  const sourceReadingIds = [...new Set(result.streamTotals.flatMap((t) => t.sourceReadingIds))].sort();
  const fileIds = [...new Set(result.streamTotals.flatMap((t) => t.sourceFileIds))].sort();
  const sourceFileHashes = fileIds.map((id) => {
    const f = files.find((x) => x.fileId === id);
    return f ? `${f.fileId}:${f.sha256}` : id;
  });
  const activeStreams = data.streams.filter((s) => s.plantId === input.plantId);
  return {
    analysisId: `BA-${input.plantId}-${input.day}-v${(previous?.version ?? 0) + 1}-${input.now}`,
    version: (previous?.version ?? 0) + 1,
    plantId: input.plantId,
    day: input.day,
    createdAt: input.now,
    createdBy: input.createdBy,
    status: 'OPEN',
    supersedesId: previous?.analysisId ?? null,
    trigger: input.trigger,
    sourceReadingIds,
    sourceFileHashes,
    registryNote: `边界登记 ${activeStreams.length} 条支路 / 不确定度库 ${data.meters.length} 台仪表 / 去除参数 ${data.removalParams.length} 项；引擎 ${BALANCE_ENGINE_VERSION}`,
    result,
  };
}

export interface LateNarrowing {
  narrowed: boolean;
  analysis: BalanceAnalysis | null;
  evidence: string;
}

/**
 * 补传流量后的检测：用当前资料重算，与最新 REVIEWED 版本比较残差区间宽度。
 * 任一守恒残差或不可解释残差显著缩窄（且其余未变宽）→ 生成新版本；
 * 已审核版本保持原状，绝不改写。
 */
export function detectLateNarrowing(
  data: BalanceData,
  files: IntakeFile[],
  plantId: string,
  day: string,
  analyses: BalanceAnalysis[],
  now: number,
  createdBy: string,
): LateNarrowing {
  const reviewed = analyses
    .filter((a) => a.plantId === plantId && a.day === day && a.status === 'REVIEWED')
    .sort((a, b) => b.version - a.version)[0];
  if (!reviewed) return { narrowed: false, analysis: null, evidence: '没有已审核版本可作比较' };
  const fresh = buildAnalysis(data, files, { plantId, day, trigger: 'LATE_DATA', createdBy, now }, analyses);
  const before = residualWidths(reviewed.result);
  const after = residualWidths(fresh.result);
  const labels: [keyof typeof before, string][] = [
    ['water', '水量残差'],
    ['tracer', '示踪残差'],
    ['cod', 'COD 不可解释残差'],
    ['nh3n', '氨氮不可解释残差'],
  ];
  const narrowedParts: string[] = [];
  const widenedParts: string[] = [];
  for (const [key, label] of labels) {
    const delta = before[key] - after[key];
    if (delta > Math.max(1e-6, before[key] * 0.02)) {
      narrowedParts.push(`${label} ${before[key].toFixed(2)} → ${after[key].toFixed(2)}`);
    } else if (delta < -Math.max(1e-6, before[key] * 0.02)) {
      widenedParts.push(label);
    }
  }
  if (narrowedParts.length === 0 || widenedParts.length > 0) {
    return {
      narrowed: false,
      analysis: null,
      evidence:
        narrowedParts.length === 0
          ? '补传资料未显著缩窄已审核残差区间，不生成新版本'
          : `部分残差反而变宽（${widenedParts.join('、')}），需人工核查后再决定是否生成新版本`,
    };
  }
  return {
    narrowed: true,
    analysis: fresh,
    evidence: `补传流量缩窄了已审核残差：${narrowedParts.join('；')}。已生成 v${fresh.version}，v${reviewed.version} 保持 REVIEWED 不改写。`,
  };
}

export function reviewAnalysis(
  analysis: BalanceAnalysis,
  causes: AttributionCause[],
  note: string,
  reviewedBy: string,
  reviewedAt: number,
): BalanceAnalysis {
  if (analysis.status === 'REVIEWED') return analysis;
  return {
    ...analysis,
    status: 'REVIEWED',
    review: { causes, note, reviewedBy, reviewedAt },
  };
}
