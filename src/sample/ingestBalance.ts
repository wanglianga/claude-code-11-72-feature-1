/**
 * 工艺段平衡分析接入层：CSV → 平衡台账实体
 *
 * 与排口读数解析（ingest.ts）并列但独立：平衡子系统的支路读数按
 * stream_id + meter_id 归属，不确定度库（meter_specs）提供精度、
 * 共用校准组与可接受调整范围；所有时间均为对齐时间轴（Asia/Shanghai）。
 */

import { parseCsv, parseIso, parseIsoOrNull } from './csv';
import { dayKeyFromMs } from '../domain/time';
import type { FileKind } from '../domain/types';
import type {
  BalanceMetric,
  BoundaryStream,
  LevelRecord,
  MeterSpec,
  ProcessRecord,
  ProcessUnit,
  PumpSwitch,
  RemovalParam,
  StreamKind,
  StreamReading,
} from '../domain/balance/types';
import type { Pollutant } from '../domain/types';

function num(value: string, field: string, errors: string[], row: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    errors.push(`第 ${row} 行 ${field} 不是有效数字：${value}`);
    return 0;
  }
  return n;
}

function iso(value: string, field: string, errors: string[], row: number): number {
  try {
    return parseIso(value);
  } catch (e) {
    errors.push(`第 ${row} 行 ${field} 无法解析：${(e as Error).message}`);
    return 0;
  }
}

export function parseProcessUnits(text: string): { units: ProcessUnit[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const units: ProcessUnit[] = rows.map((row, i) => ({
    unitId: row.unit_id,
    plantId: row.plant_id,
    name: row.name,
    kind: row.kind ?? '',
    surfaceAreaM2: num(row.surface_area_m2, 'surface_area_m2', errors, i + 2),
    lagMinMinutes: num(row.lag_min_minutes, 'lag_min_minutes', errors, i + 2),
    lagMaxMinutes: num(row.lag_max_minutes, 'lag_max_minutes', errors, i + 2),
    note: row.note ?? '',
  }));
  return { units, errors };
}

const STREAM_KINDS: StreamKind[] = ['IN', 'OUT', 'RETURN', 'SLUDGE', 'BACKWASH'];

export function parseBoundaryStreams(text: string): { streams: BoundaryStream[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const streams: BoundaryStream[] = rows.map((row, i) => {
    const kind = (row.kind || 'IN') as StreamKind;
    if (!STREAM_KINDS.includes(kind)) errors.push(`第 ${i + 2} 行未知支路类型 ${row.kind}`);
    let effectiveTo: number | null = null;
    try {
      effectiveTo = parseIsoOrNull(row.effective_to);
    } catch (e) {
      errors.push(`第 ${i + 2} 行 effective_to 无法解析：${(e as Error).message}`);
    }
    return {
      streamId: row.stream_id,
      plantId: row.plant_id,
      unitId: row.unit_id,
      kind,
      flowMeterId: row.flow_meter_id || null,
      internal: row.internal === 'true' || row.internal === '1',
      effectiveFrom: iso(row.effective_from, 'effective_from', errors, i + 2),
      effectiveTo,
      registeredAt: iso(row.registered_at, 'registered_at', errors, i + 2),
      gapFlowLowM3h: Number(row.gap_flow_low_m3h || 0),
      gapFlowHighM3h: Number(row.gap_flow_high_m3h || 0),
      gapConcLowMgL: {
        TRACER: Number(row.gap_conc_tracer_low_mg_l || 0),
        COD: Number(row.gap_conc_cod_low_mg_l || 0),
        NH3N: Number(row.gap_conc_nh3n_low_mg_l || 0),
      },
      gapConcHighMgL: {
        TRACER: Number(row.gap_conc_tracer_high_mg_l || 0),
        COD: Number(row.gap_conc_cod_high_mg_l || 0),
        NH3N: Number(row.gap_conc_nh3n_high_mg_l || 0),
      },
      note: row.note ?? '',
    };
  });
  return { streams, errors };
}

const BALANCE_METRICS: BalanceMetric[] = ['FLOW', 'TRACER', 'COD', 'NH3N'];

export function parseMeterSpecs(text: string): { meters: MeterSpec[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const meters: MeterSpec[] = rows.map((row, i) => {
    const metric = (row.metric || 'FLOW') as BalanceMetric;
    if (!BALANCE_METRICS.includes(metric)) errors.push(`第 ${i + 2} 行未知指标 ${row.metric}`);
    let validTo: number | null = null;
    try {
      validTo = parseIsoOrNull(row.valid_to);
    } catch (e) {
      errors.push(`第 ${i + 2} 行 valid_to 无法解析：${(e as Error).message}`);
    }
    return {
      meterId: row.meter_id,
      metric,
      label: row.label ?? row.meter_id,
      relSigma: num(row.rel_sigma, 'rel_sigma', errors, i + 2),
      absSigma: num(row.abs_sigma, 'abs_sigma', errors, i + 2),
      calGroup: row.cal_group ?? '',
      groupCorrelation: num(row.group_correlation, 'group_correlation', errors, i + 2),
      adjustLimitRel: num(row.adjust_limit_rel, 'adjust_limit_rel', errors, i + 2),
      certificate: row.certificate ?? '',
      validFrom: iso(row.valid_from, 'valid_from', errors, i + 2),
      validTo,
      note: row.note ?? '',
    };
  });
  return { meters, errors };
}

export interface ParsedStreamReadings {
  readings: StreamReading[];
  errors: string[];
  rejected: number;
}

/** 支路读数解析：meter_id 必须在不确定度库登记，stream_id 必须在边界登记中 */
export function parseStreamReadings(
  text: string,
  file: { fileId: string; kind: FileKind; receivedAt: number },
  meters: MeterSpec[],
  streams: BoundaryStream[],
  options: { lateMode?: boolean } = {},
): ParsedStreamReadings {
  const { rows, headers } = parseCsv(text);
  const errors: string[] = [];
  const readings: StreamReading[] = [];
  let rejected = 0;
  const required = ['reading_id', 'stream_id', 'meter_id', 'metric', 'sampled_at', 'raw_value'];
  for (const h of required) {
    if (!headers.includes(h)) {
      return { readings: [], errors: [`文件缺少必需列 ${h}`], rejected: rows.length };
    }
  }
  const meterById = new Map(meters.map((m) => [m.meterId, m]));
  const streamById = new Map(streams.map((s) => [s.streamId, s]));
  rows.forEach((row, idx) => {
    const line = idx + 2;
    const meter = meterById.get(row.meter_id);
    if (!meter) {
      rejected += 1;
      errors.push(`第 ${line} 行计量仪表 ${row.meter_id} 未在不确定度库登记，拒绝入库`);
      return;
    }
    if (!streamById.get(row.stream_id)) {
      rejected += 1;
      errors.push(`第 ${line} 行支路 ${row.stream_id} 未在边界登记中，拒绝入库`);
      return;
    }
    const metric = (row.metric || meter.metric) as BalanceMetric;
    if (!BALANCE_METRICS.includes(metric)) {
      rejected += 1;
      errors.push(`第 ${line} 行未知指标 ${row.metric}`);
      return;
    }
    if (metric !== meter.metric) {
      rejected += 1;
      errors.push(`第 ${line} 行指标 ${metric} 与仪表 ${row.meter_id} 登记指标 ${meter.metric} 不一致`);
      return;
    }
    let sampledAt = 0;
    try {
      sampledAt = parseIso(row.sampled_at);
    } catch (e) {
      rejected += 1;
      errors.push(`第 ${line} 行 sampled_at：${(e as Error).message}`);
      return;
    }
    const rawValue = Number(row.raw_value);
    if (!Number.isFinite(rawValue)) {
      rejected += 1;
      errors.push(`第 ${line} 行 raw_value 不是有效数字`);
      return;
    }
    const flag = (row.quality_flag || 'VALID').toUpperCase();
    const receivedAt = options.lateMode || !row.received_at ? file.receivedAt : parseIso(row.received_at);
    readings.push({
      readingId: row.reading_id || `auto-${file.fileId}-${line}`,
      streamId: row.stream_id,
      meterId: row.meter_id,
      metric,
      sampledAt,
      dayKey: dayKeyFromMs(sampledAt),
      receivedAt,
      rawValue,
      qualityFlag: flag === 'SUSPECT' ? 'SUSPECT' : flag === 'INVALID' ? 'INVALID' : 'VALID',
      sourceFileId: file.fileId,
      sourceRow: line,
    });
  });
  return { readings, errors, rejected };
}

export function parseLevelLog(text: string, fileId: string, receivedAt: number): { levels: LevelRecord[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const levels: LevelRecord[] = rows.map((row, i) => ({
    recordId: row.record_id || `lv-${fileId}-${i + 2}`,
    unitId: row.unit_id,
    at: iso(row.at, 'at', errors, i + 2),
    levelM: num(row.level_m, 'level_m', errors, i + 2),
    receivedAt: row.received_at ? iso(row.received_at, 'received_at', errors, i + 2) : receivedAt,
    sourceFileId: fileId,
  }));
  return { levels, errors };
}

const PROCESS_KINDS = ['AERATION', 'SLUDGE_WASTE', 'DOSING', 'DO'] as const;

export function parseProcessLog(text: string, fileId: string): { records: ProcessRecord[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const records: ProcessRecord[] = rows.map((row, i) => {
    const kind = (row.kind || 'AERATION') as ProcessRecord['kind'];
    if (!PROCESS_KINDS.includes(kind)) errors.push(`第 ${i + 2} 行未知工艺记录类型 ${row.kind}`);
    return {
      recordId: row.record_id || `pr-${fileId}-${i + 2}`,
      unitId: row.unit_id,
      kind,
      from: iso(row.from, 'from', errors, i + 2),
      to: iso(row.to, 'to', errors, i + 2),
      value: num(row.value, 'value', errors, i + 2),
      unit: row.unit ?? '',
      note: row.note ?? '',
      sourceFileId: fileId,
    };
  });
  return { records, errors };
}

export function parseRemovalParams(text: string): { params: RemovalParam[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const params: RemovalParam[] = rows.map((row, i) => ({
    paramId: row.param_id,
    unitId: row.unit_id || null,
    pollutant: (row.pollutant || 'COD') as Pollutant,
    param: row.param,
    low: num(row.low, 'low', errors, i + 2),
    high: num(row.high, 'high', errors, i + 2),
    unit: row.unit ?? '',
    note: row.note ?? '',
  }));
  return { params, errors };
}

export function parsePumpSwitches(text: string): { switches: PumpSwitch[]; errors: string[] } {
  const { rows } = parseCsv(text);
  const errors: string[] = [];
  const switches: PumpSwitch[] = rows.map((row, i) => ({
    switchId: row.switch_id,
    pumpId: row.pump_id,
    at: iso(row.at, 'at', errors, i + 2),
    fromStreamId: row.from_stream_id,
    toStreamId: row.to_stream_id,
    reason: row.reason ?? '',
    workOrder: row.work_order ?? '',
  }));
  return { switches, errors };
}

/** 合并平衡台账（按主键去重，读数按 receivedAt 新者胜） */
export function mergeBalanceData(
  base: BalanceDataLike,
  patch: Partial<BalanceDataLike>,
): BalanceDataLike {
  const mergeBy = <T>(a: T[], b: T[], key: (x: T) => string): T[] => {
    const map = new Map(a.map((x) => [key(x), x]));
    for (const item of b) map.set(key(item), item);
    return [...map.values()];
  };
  const readings = new Map<string, StreamReading>();
  for (const r of [...(base.readings ?? []), ...(patch.readings ?? [])]) {
    const existing = readings.get(r.readingId);
    if (!existing || r.receivedAt >= existing.receivedAt) readings.set(r.readingId, r);
  }
  return {
    units: mergeBy(base.units ?? [], patch.units ?? [], (u) => u.unitId),
    streams: mergeBy(base.streams ?? [], patch.streams ?? [], (s) => s.streamId),
    meters: mergeBy(base.meters ?? [], patch.meters ?? [], (m) => m.meterId),
    readings: [...readings.values()],
    levels: mergeBy(base.levels ?? [], patch.levels ?? [], (l) => l.recordId),
    processRecords: mergeBy(base.processRecords ?? [], patch.processRecords ?? [], (p) => p.recordId),
    pumpSwitches: mergeBy(base.pumpSwitches ?? [], patch.pumpSwitches ?? [], (p) => p.switchId),
    removalParams: mergeBy(base.removalParams ?? [], patch.removalParams ?? [], (p) => p.paramId),
  };
}

interface BalanceDataLike {
  units: ProcessUnit[];
  streams: BoundaryStream[];
  meters: MeterSpec[];
  readings: StreamReading[];
  levels: LevelRecord[];
  processRecords: ProcessRecord[];
  pumpSwitches: PumpSwitch[];
  removalParams: RemovalParam[];
}
