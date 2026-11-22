/**
 * 工艺段平衡分析：领域模型
 *
 * 统一语义（与排口复核主引擎一致的约定之外，本子系统额外约定）：
 * - 边界登记：每个工艺单元的进出水、回流、排泥、反冲洗与液位变化都登记为
 *   BoundaryStream / LevelRecord；支路有有效期 [effectiveFrom, effectiveTo)，
 *   今天确认的停用支路只影响生效日之后的分析，不改写过去的平衡。
 * - 三类守恒对象分开：水量（FLOW）、无反应示踪量（TRACER，保守）、
 *   可生物化学去除的 COD / 氨氮（去除只能依据工艺记录形成范围）。
 * - 滞后匹配：进水事件在 [lagMin, lagMax] 可达时间带内才允许与出水事件配对；
 *   进水升高尚未到达可达时间带时保持“在途”，绝不强行配对。
 * - 回流泵中途切换：RETURN 支路按切换事件拆腿，且回流属于内部循环，
 *   任何时候都不计入主线（厂界）闭合。
 * - 两条分析路径：
 *   A. 误差传播：每项测量按误差范围直接传播，给出保证不越界的残差区间；
 *   B. 受约束测量协调：仅对水量与无反应示踪量在已知误差与相关关系下求
 *      最可能调整值；COD/氨氮永不参与协调。
 * - 分析版本不可改写：补传流量缩窄已审核残差时生成新版本，旧版本保持原状。
 */

import type { LoadBounds, Pollutant } from '../types';

/** 平衡子系统观测对象：水量 / 无反应示踪 / 可去除污染物 */
export type BalanceMetric = 'FLOW' | 'TRACER' | 'COD' | 'NH3N';

export const BALANCE_METRIC_LABELS: Record<BalanceMetric, string> = {
  FLOW: '水量',
  TRACER: '示踪量(Cl⁻)',
  COD: 'COD',
  NH3N: '氨氮',
};

/** 守恒项（可参与测量协调）与可去除项（绝不参与协调） */
export const CONSERVATIVE_METRICS: BalanceMetric[] = ['FLOW', 'TRACER'];
export const REMOVABLE_METRICS: Pollutant[] = ['COD', 'NH3N'];

export type StreamKind = 'IN' | 'OUT' | 'RETURN' | 'SLUDGE' | 'BACKWASH';

export const STREAM_KIND_LABELS: Record<StreamKind, string> = {
  IN: '进水',
  OUT: '出水',
  RETURN: '回流',
  SLUDGE: '排泥',
  BACKWASH: '反冲洗',
};

/** 工艺单元（池体）：液位→存量、滞后时间带都挂在单元上 */
export interface ProcessUnit {
  unitId: string;
  plantId: string;
  name: string;
  kind: string;
  /** 水面面积 m²：ΔV = Δ液位 × 面积 */
  surfaceAreaM2: number;
  /** 可达时间带：进水扰动到达该单元出口所需 [lagMin, lagMax] 分钟 */
  lagMinMinutes: number;
  lagMaxMinutes: number;
  note: string;
}

/**
 * 边界流登记：每个单元各方向的支路。
 * 支路有效期 [effectiveFrom, effectiveTo) 半开；停用确认只改有效期，
 * 生效日之前的分析保持原样（分析版本本身亦不可改写）。
 */
export interface BoundaryStream {
  streamId: string;
  plantId: string;
  unitId: string;
  kind: StreamKind;
  /** 流量计（MeterSpec.meterId）；null 表示无量计（只登记不计量） */
  flowMeterId: string | null;
  /** 内部循环（回流/反冲洗回流）不计入厂界主线闭合 */
  internal: boolean;
  /** 支路有效期（停用支路：effectiveTo 为停用生效时刻） */
  effectiveFrom: number;
  effectiveTo: number | null;
  /** 停用/变更登记时刻（审计证据：今天确认不改写过去） */
  registeredAt: number;
  /** 缺测时段的登记估计（m³/h）：无量计或计量中断时使用，0 表示无估计 */
  gapFlowLowM3h: number;
  gapFlowHighM3h: number;
  /** 缺测时段浓度的登记估计（mg/L，按指标分开） */
  gapConcLowMgL: Record<'TRACER' | 'COD' | 'NH3N', number>;
  gapConcHighMgL: Record<'TRACER' | 'COD' | 'NH3N', number>;
  note: string;
}

/**
 * 不确定度库：每台计量仪表的精度、共用校准来源与可接受调整范围。
 * - relSigma / absSigma：1σ 相对/绝对误差（区间传播按 k 倍膨胀）；
 * - calGroup：共用同一校准来源（同一次率定/同一标准物质）的仪表编组，
 *   组内误差相关，协调时按 groupCorrelation 构造协方差；
 * - adjustLimitRel：证书允许的最大相对调整量，超出即“超出证书边界”，
 *   该部分必须保留为不可协调残差。
 */
export interface MeterSpec {
  meterId: string;
  metric: BalanceMetric;
  label: string;
  relSigma: number;
  absSigma: number;
  calGroup: string;
  groupCorrelation: number;
  adjustLimitRel: number;
  certificate: string;
  validFrom: number;
  validTo: number | null;
  note: string;
}

/** 支路读数：流量 m³/h、示踪/COD/氨氮浓度 mg/L */
export interface StreamReading {
  readingId: string;
  streamId: string;
  meterId: string;
  metric: BalanceMetric;
  sampledAt: number;
  dayKey: string;
  receivedAt: number;
  rawValue: number;
  qualityFlag: 'VALID' | 'SUSPECT' | 'INVALID';
  sourceFileId: string;
  sourceRow: number;
}

/** 液位记录：存量变化 ΔV = (末液位 − 初液位) × 水面面积 */
export interface LevelRecord {
  recordId: string;
  unitId: string;
  at: number;
  levelM: number;
  receivedAt: number;
  sourceFileId: string;
}

export type ProcessRecordKind = 'AERATION' | 'SLUDGE_WASTE' | 'DOSING' | 'DO';

export const PROCESS_KIND_LABELS: Record<ProcessRecordKind, string> = {
  AERATION: '曝气',
  SLUDGE_WASTE: '污泥排放',
  DOSING: '投药',
  DO: '溶解氧',
};

/** 工艺记录：去除范围只能依据这些记录形成 */
export interface ProcessRecord {
  recordId: string;
  unitId: string;
  kind: ProcessRecordKind;
  from: number;
  to: number;
  value: number;
  unit: string;
  note: string;
  sourceFileId: string;
}

/** 回流泵中途切换事件：RETURN 支路据此拆腿 */
export interface PumpSwitch {
  switchId: string;
  pumpId: string;
  at: number;
  fromStreamId: string;
  toStreamId: string;
  reason: string;
  workOrder: string;
}

/** 去除参数台账：去除范围的全部假设必须登记在此（可追溯） */
export interface RemovalParam {
  paramId: string;
  unitId: string | null;
  pollutant: Pollutant;
  param: string;
  low: number;
  high: number;
  unit: string;
  note: string;
}

export interface BalanceData {
  units: ProcessUnit[];
  streams: BoundaryStream[];
  meters: MeterSpec[];
  readings: StreamReading[];
  levels: LevelRecord[];
  processRecords: ProcessRecord[];
  pumpSwitches: PumpSwitch[];
  removalParams: RemovalParam[];
}

export function emptyBalanceData(): BalanceData {
  return {
    units: [],
    streams: [],
    meters: [],
    readings: [],
    levels: [],
    processRecords: [],
    pumpSwitches: [],
    removalParams: [],
  };
}

/* ---------------- 求解结果 ---------------- */

/** 单支路单日单指标总量（区间） */
export interface StreamTotal {
  streamId: string;
  metric: BalanceMetric;
  /** FLOW 为体积 m³；浓度指标为浓度×体积归并前的负荷 kg（示踪为 kg 计） */
  total: LoadBounds;
  /** FLOW 指标的平均浓度不适用；浓度指标给流量加权平均浓度 mg/L */
  meanConcentration: LoadBounds | null;
  seconds: number;
  readingCount: number;
  /** 缺测秒数（应有读数而没有的时段） */
  gapSeconds: number;
  sourceReadingIds: string[];
  sourceFileIds: string[];
  note: string;
}

/** 闭合等式的一侧分项（用于来源追溯） */
export interface ClosureTerm {
  label: string;
  streamId: string | null;
  sign: 1 | -1;
  amount: LoadBounds;
  basis: string;
}

export interface ClosureResult {
  /** 残差 = Σ正项 − Σ负项；区间保证不越界（路径 A） */
  residual: LoadBounds;
  /** 0 落在区间内视为在误差范围内闭合 */
  closes: boolean;
  terms: ClosureTerm[];
  note: string;
}

/** 滞后事件（进水/出水阶跃）与可达配对 */
export interface LagEvent {
  eventId: string;
  side: 'IN' | 'OUT';
  metric: BalanceMetric;
  at: number;
  /** 阶跃幅度（相对变化，正为上升） */
  magnitude: number;
  direction: 'RISE' | 'FALL';
  /** 可达时间带（仅 IN 事件）：[at+lagMin, at+lagMax] */
  reachableFrom: number | null;
  reachableTo: number | null;
  status: 'MATCHED' | 'PENDING' | 'UNMATCHED' | 'ORPHAN';
  matchedEventId: string | null;
  note: string;
}

/** 在途量：进水已升高但可达时间带尚未到达分析窗口末端的部分 */
export interface InTransit {
  metric: BalanceMetric;
  load: LoadBounds;
  events: string[];
  note: string;
}

/** 去除范围：每一项贡献都必须能追溯到工艺记录与参数台账 */
export interface RemovalContribution {
  recordId: string;
  kind: ProcessRecordKind;
  pollutant: Pollutant;
  range: LoadBounds;
  basis: string;
  paramIds: string[];
}

export interface RemovalAssessment {
  pollutant: Pollutant;
  /** 观测去除 = 进 − 出 − 存量变化（区间） */
  observed: LoadBounds;
  /** 工艺记录支持的去除范围 */
  supported: LoadBounds;
  contributions: RemovalContribution[];
  /** 不可解释残差：观测超出支持范围的部分（不得调成测量误差） */
  unexplained: LoadBounds;
  note: string;
}

/** 单条测量的协调调整（路径 B） */
export interface ReconcileAdjustment {
  meterId: string;
  metric: BalanceMetric;
  label: string;
  measured: number;
  adjusted: number;
  adjustment: number;
  adjustmentRel: number;
  sigma: number;
  /** |调整量| / 证书允许范围；>1 即超出证书边界 */
  withinCertificate: boolean;
  clamped: boolean;
  calGroup: string;
  note: string;
}

export interface ReconcileResult {
  /** 仅 FLOW/TRACER 参与；COD/氨氮永不出现 */
  metrics: BalanceMetric[];
  adjustments: ReconcileAdjustment[];
  /** 加权残差平方和（χ² 风格统计量）与自由度 */
  chi2: number;
  degreesOfFreedom: number;
  /** 协调后闭合残差（应为 0 附近）；触及证书边界后仍剩余的部分 */
  residualAfter: LoadBounds;
  irreconcilable: LoadBounds;
  covarianceBasis: string[];
  notes: string[];
}

/** 单元级水量与存量（归因定位用；出流为派生量时会明确标注） */
export interface UnitClosure {
  unitId: string;
  name: string;
  storageDeltaV: LoadBounds | null;
  levelEvidence: string;
  /** 派生出流 m³（非实测，由上游平衡推出） */
  derivedOutflow: LoadBounds | null;
  notes: string[];
}

export interface PlantBalance {
  water: ClosureResult;
  tracer: ClosureResult;
  removal: RemovalAssessment[];
  inTransit: InTransit[];
}

export interface BalanceResult {
  plantId: string;
  day: string;
  windowFrom: number;
  windowTo: number;
  streamTotals: StreamTotal[];
  plant: PlantBalance;
  units: UnitClosure[];
  lagEvents: LagEvent[];
  reconcile: ReconcileResult | null;
  /** 归因候选：规则化建议，供工艺人员复核 */
  suggestedCauses: { cause: AttributionCause; evidence: string }[];
  caveats: string[];
  computeMs: number;
}

export type AttributionCause =
  | 'STORAGE'
  | 'LAG'
  | 'BACKWASH'
  | 'METER_ERROR'
  | 'REMOVAL_SUPPORT'
  | 'OTHER';

export const ATTRIBUTION_LABELS: Record<AttributionCause, string> = {
  STORAGE: '池内存量变化',
  LAG: '取样点水力滞后',
  BACKWASH: '反冲洗水混入主线',
  METER_ERROR: '流量计与浓度仪误差叠加',
  REMOVAL_SUPPORT: '去除依据不足',
  OTHER: '其他',
};

export interface BalanceReview {
  causes: AttributionCause[];
  note: string;
  reviewedBy: string;
  reviewedAt: number;
}

/**
 * 平衡分析版本：创建后不可改写。
 * 补传流量缩窄已审核残差 → 生成新版本（supersedesId 指向前版），
 * 前版保持 REVIEWED 原状；停用支路的确认也不改写历史版本。
 */
export interface BalanceAnalysis {
  analysisId: string;
  version: number;
  plantId: string;
  day: string;
  createdAt: number;
  createdBy: string;
  status: 'OPEN' | 'REVIEWED';
  supersedesId: string | null;
  trigger: 'MANUAL' | 'LATE_DATA' | 'REGISTRY_CHANGE';
  /** 输入指纹：来源读数、文件哈希与登记台账版本 */
  sourceReadingIds: string[];
  sourceFileHashes: string[];
  registryNote: string;
  result: BalanceResult;
  review?: BalanceReview;
}

export const BALANCE_ENGINE_VERSION = '1.0.0';
