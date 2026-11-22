#!/usr/bin/env tsx
/**
 * 生成可回放的虚构资料：public/sample/*.csv + manifest.json
 *
 * 数据设计（2026-11-18，Asia/Shanghai）：
 *  - 三个厂站、四个点位，上报频率 10s / 60s / 300s，浓度与流量时钟各有偏移
 *  - CC-E01：04:00 浓度探头整机更换（点位编号复用，按实例衔接）
 *            09:15:00–09:15:40 高浓度冲击（COD 边界 50→140→145→132→50，恰 40 秒超限）
 *            13:00:00 校准中途生效（切开片段，两侧系数不同）
 *            01:00–01:08 冲洗（排除）、20:00–20:04 旁路（排除）
 *            02:00–02:03 三分钟缺测；迟到补录文件在申报后到达（16:40）
 *  - CC-E02：12:00 浓度探头更换；15:00–15:03 冲洗
 *  - HX-OUT：07:00–07:30 流量故障；10:00 校准
 *  - ZB-01：16:00–16:20 缺测；04:00–04:30 旁路
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeCsv, isoLocal } from '../src/sample/csv';
import type {
  Binding,
  Calibration,
  Instrument,
  OutfallPoint,
  Plant,
  Pollutant,
  Reading,
  SampleManifest,
  StatePeriod,
} from '../src/domain/types';
import type {
  BoundaryStream,
  LevelRecord,
  MeterSpec,
  ProcessRecord,
  ProcessUnit,
  PumpSwitch,
  RemovalParam,
  StreamReading,
} from '../src/domain/balance/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '../public/sample');

const DAY = '2026-11-18';
const SHANGHAI = 8 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 10, 18) - SHANGHAI; // 2026-11-18T00:00+08:00
const HOUR = 3_600_000;
const SEC = 1000;
const MIN = 60_000;

function at(h: number, m = 0, s = 0, ms = 0): number {
  return D0 + h * HOUR + m * MIN + s * SEC + ms;
}

const plants: Plant[] = [
  {
    plantId: 'P1',
    name: '澄川水务第一净水厂',
    shortName: '一厂',
    timezone: 'Asia/Shanghai',
    dischargeStandard: { COD: 50, NH3N: 5 },
  },
  {
    plantId: 'P2',
    name: '澄川水务河西分厂',
    shortName: '河西厂',
    timezone: 'Asia/Shanghai',
    dischargeStandard: { COD: 50, NH3N: 5 },
  },
  {
    plantId: 'P3',
    name: '澄川水务北滩厂',
    shortName: '北滩厂',
    timezone: 'Asia/Shanghai',
    dischargeStandard: { COD: 60, NH3N: 8 },
  },
];

const points: OutfallPoint[] = [
  {
    pointCode: 'CC-E01',
    plantId: 'P1',
    name: '一厂总排口',
    reused: true,
    designFlowM3h: 450,
    note: '点位编号沿用，2026-11-18 04:00 更换 COD 探头、12:00 更换 CC-E02 探头，按设备实例衔接。',
  },
  {
    pointCode: 'CC-E02',
    plantId: 'P1',
    name: '一厂二期排口',
    reused: true,
    designFlowM3h: 320,
    note: '分钟级上报；12:00 更换 COD 探头；15:00 冲洗 3 分钟。',
  },
  {
    pointCode: 'HX-OUT',
    plantId: 'P2',
    name: '河西厂总排口',
    reused: false,
    designFlowM3h: 280,
    note: '分钟级上报；07:00–07:30 流量计故障；10:00 浓度校准。',
  },
  {
    pointCode: 'ZB-01',
    plantId: 'P3',
    name: '北滩厂排口',
    reused: false,
    designFlowM3h: 520,
    note: '五分钟级上报；16:00–16:20 缺测；04:00–04:30 旁路。',
  },
];

const instruments: Instrument[] = [
  {
    instrumentId: 'C-CO1',
    pointCode: 'CC-E01',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2100',
    serial: 'A1901',
    scale: 0.97,
    offset: 0.4,
    valueUncertainty: 0.03,
    nominalIntervalSeconds: 10,
    installedAt: at(0) - 400 * 24 * HOUR,
    removedAt: at(4),
    clockOffsetMs: -7200,
    clockOffsetUncertaintyMs: 400,
    note: '旧探头，设备时钟快 7.2 秒；04:00 整机更换。',
  },
  {
    instrumentId: 'C-CO2',
    pointCode: 'CC-E01',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2200',
    serial: 'B2107',
    scale: 1.0,
    offset: 0,
    valueUncertainty: 0.025,
    nominalIntervalSeconds: 10,
    installedAt: at(4),
    removedAt: null,
    clockOffsetMs: 2500,
    clockOffsetUncertaintyMs: 250,
    note: '新探头，设备时钟慢 2.5 秒；13:00 校准生效。',
  },
  {
    instrumentId: 'N-NH1',
    pointCode: 'CC-E01',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'NH3N',
    model: 'NH3-N Analyzer 80',
    serial: 'N5521',
    scale: 1.02,
    offset: -0.05,
    valueUncertainty: 0.035,
    nominalIntervalSeconds: 10,
    installedAt: at(0) - 300 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -1500,
    clockOffsetUncertaintyMs: 300,
    note: '设备时钟快 1.5 秒。',
  },
  {
    instrumentId: 'F-FL1',
    pointCode: 'CC-E01',
    plantId: 'P1',
    kind: 'FLOW',
    metric: 'FLOW',
    model: 'Ultrasonic Flow U8',
    serial: 'F7710',
    scale: 1.01,
    offset: -1.2,
    valueUncertainty: 0.02,
    nominalIntervalSeconds: 10,
    installedAt: at(0) - 500 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 3200,
    clockOffsetUncertaintyMs: 500,
    note: '设备时钟慢 3.2 秒；20:00–20:04 旁路。',
  },
  {
    instrumentId: 'C-CO3',
    pointCode: 'CC-E02',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2100',
    serial: 'A2033',
    scale: 0.99,
    offset: 0.2,
    valueUncertainty: 0.03,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 200 * 24 * HOUR,
    removedAt: at(12),
    clockOffsetMs: 4000,
    clockOffsetUncertaintyMs: 600,
    note: '旧探头，时钟慢 4 秒；12:00 更换。',
  },
  {
    instrumentId: 'C-CO4',
    pointCode: 'CC-E02',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2300',
    serial: 'C3301',
    scale: 1.03,
    offset: -0.5,
    valueUncertainty: 0.02,
    nominalIntervalSeconds: 60,
    installedAt: at(12),
    removedAt: null,
    clockOffsetMs: -6000,
    clockOffsetUncertaintyMs: 600,
    note: '新探头，时钟快 6 秒。',
  },
  {
    instrumentId: 'N-NH2',
    pointCode: 'CC-E02',
    plantId: 'P1',
    kind: 'CONCENTRATION',
    metric: 'NH3N',
    model: 'NH3-N Analyzer 80',
    serial: 'N5610',
    scale: 0.98,
    offset: 0.1,
    valueUncertainty: 0.04,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 300 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 1800,
    clockOffsetUncertaintyMs: 400,
    note: '时钟慢 1.8 秒。',
  },
  {
    instrumentId: 'F-FL2',
    pointCode: 'CC-E02',
    plantId: 'P1',
    kind: 'FLOW',
    metric: 'FLOW',
    model: 'Ultrasonic Flow U8',
    serial: 'F7822',
    scale: 1.0,
    offset: 0.8,
    valueUncertainty: 0.02,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 500 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -2200,
    clockOffsetUncertaintyMs: 500,
    note: '时钟快 2.2 秒。',
  },
  {
    instrumentId: 'C-CO5',
    pointCode: 'HX-OUT',
    plantId: 'P2',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2200',
    serial: 'B2288',
    scale: 1.01,
    offset: -0.3,
    valueUncertainty: 0.03,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 150 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 5000,
    clockOffsetUncertaintyMs: 700,
    note: '时钟慢 5 秒；10:00 校准。',
  },
  {
    instrumentId: 'N-NH3',
    pointCode: 'HX-OUT',
    plantId: 'P2',
    kind: 'CONCENTRATION',
    metric: 'NH3N',
    model: 'NH3-N Analyzer 80',
    serial: 'N5802',
    scale: 1.0,
    offset: 0,
    valueUncertainty: 0.035,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 300 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -2500,
    clockOffsetUncertaintyMs: 400,
    note: '时钟快 2.5 秒。',
  },
  {
    instrumentId: 'F-FL3',
    pointCode: 'HX-OUT',
    plantId: 'P2',
    kind: 'FLOW',
    metric: 'FLOW',
    model: 'Doppler Flow D2',
    serial: 'F8033',
    scale: 0.995,
    offset: 1.5,
    valueUncertainty: 0.025,
    nominalIntervalSeconds: 60,
    installedAt: at(0) - 500 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 1200,
    clockOffsetUncertaintyMs: 500,
    note: '07:00–07:30 故障。',
  },
  {
    instrumentId: 'C-CO6',
    pointCode: 'ZB-01',
    plantId: 'P3',
    kind: 'CONCENTRATION',
    metric: 'COD',
    model: 'UV-CodMeter 2100',
    serial: 'A2455',
    scale: 1.0,
    offset: 0,
    valueUncertainty: 0.04,
    nominalIntervalSeconds: 300,
    installedAt: at(0) - 600 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -8000,
    clockOffsetUncertaintyMs: 1000,
    note: '五分钟级上报；16:00–16:20 缺测；04:00–04:30 旁路。',
  },
  {
    instrumentId: 'N-NH4',
    pointCode: 'ZB-01',
    plantId: 'P3',
    kind: 'CONCENTRATION',
    metric: 'NH3N',
    model: 'NH3-N Analyzer 70',
    serial: 'N5901',
    scale: 1.0,
    offset: 0,
    valueUncertainty: 0.045,
    nominalIntervalSeconds: 300,
    installedAt: at(0) - 600 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: 6000,
    clockOffsetUncertaintyMs: 1000,
    note: '时钟慢 6 秒。',
  },
  {
    instrumentId: 'F-FL4',
    pointCode: 'ZB-01',
    plantId: 'P3',
    kind: 'FLOW',
    metric: 'FLOW',
    model: 'Ultrasonic Flow U10',
    serial: 'F8410',
    scale: 1.02,
    offset: -2.0,
    valueUncertainty: 0.03,
    nominalIntervalSeconds: 300,
    installedAt: at(0) - 700 * 24 * HOUR,
    removedAt: null,
    clockOffsetMs: -3500,
    clockOffsetUncertaintyMs: 800,
    note: '时钟快 3.5 秒。',
  },
];

const bindings: Binding[] = [
  { bindingId: 'B-CO1', pointCode: 'CC-E01', instrumentId: 'C-CO1', metric: 'COD', from: instruments[0].installedAt, to: at(4) },
  { bindingId: 'B-CO2', pointCode: 'CC-E01', instrumentId: 'C-CO2', metric: 'COD', from: at(4), to: null },
  { bindingId: 'B-NH1', pointCode: 'CC-E01', instrumentId: 'N-NH1', metric: 'NH3N', from: instruments[2].installedAt, to: null },
  { bindingId: 'B-FL1', pointCode: 'CC-E01', instrumentId: 'F-FL1', metric: 'FLOW', from: instruments[3].installedAt, to: null },
  { bindingId: 'B-CO3', pointCode: 'CC-E02', instrumentId: 'C-CO3', metric: 'COD', from: instruments[4].installedAt, to: at(12) },
  { bindingId: 'B-CO4', pointCode: 'CC-E02', instrumentId: 'C-CO4', metric: 'COD', from: at(12), to: null },
  { bindingId: 'B-NH2', pointCode: 'CC-E02', instrumentId: 'N-NH2', metric: 'NH3N', from: instruments[6].installedAt, to: null },
  { bindingId: 'B-FL2', pointCode: 'CC-E02', instrumentId: 'F-FL2', metric: 'FLOW', from: instruments[7].installedAt, to: null },
  { bindingId: 'B-CO5', pointCode: 'HX-OUT', instrumentId: 'C-CO5', metric: 'COD', from: instruments[8].installedAt, to: null },
  { bindingId: 'B-NH3', pointCode: 'HX-OUT', instrumentId: 'N-NH3', metric: 'NH3N', from: instruments[9].installedAt, to: null },
  { bindingId: 'B-FL3', pointCode: 'HX-OUT', instrumentId: 'F-FL3', metric: 'FLOW', from: instruments[10].installedAt, to: null },
  { bindingId: 'B-CO6', pointCode: 'ZB-01', instrumentId: 'C-CO6', metric: 'COD', from: instruments[11].installedAt, to: null },
  { bindingId: 'B-NH4', pointCode: 'ZB-01', instrumentId: 'N-NH4', metric: 'NH3N', from: instruments[12].installedAt, to: null },
  { bindingId: 'B-FL4', pointCode: 'ZB-01', instrumentId: 'F-FL4', metric: 'FLOW', from: instruments[13].installedAt, to: null },
];

const calibrations: Calibration[] = [
  {
    calibrationId: 'CAL-CO2-20261118',
    instrumentId: 'C-CO2',
    effectiveAt: at(13),
    scale: 1.08,
    offset: -1.2,
    coefficientUncertainty: 0.018,
    operator: '王笛',
    certificate: 'CC-2026-11-18-COD-02',
    note: '中途校准：13:00 生效，生效前后必须切开片段，两侧系数不同。',
  },
  {
    calibrationId: 'CAL-CO5-20261118',
    instrumentId: 'C-CO5',
    effectiveAt: at(10),
    scale: 0.98,
    offset: 0.6,
    coefficientUncertainty: 0.022,
    operator: '李哲',
    certificate: 'HX-2026-11-18-COD-01',
    note: '10:00 校准生效。',
  },
  {
    calibrationId: 'CAL-FL1-20261001',
    instrumentId: 'F-FL1',
    effectiveAt: at(0) - 48 * 24 * HOUR,
    scale: 1.01,
    offset: -1.2,
    coefficientUncertainty: 0.02,
    operator: '周岚',
    certificate: 'CC-2026-10-01-FLOW-01',
    note: '流量计季度率定。',
  },
  {
    calibrationId: 'CAL-NH1-20261001',
    instrumentId: 'N-NH1',
    effectiveAt: at(0) - 48 * 24 * HOUR,
    scale: 1.02,
    offset: -0.05,
    coefficientUncertainty: 0.035,
    operator: '周岚',
    certificate: 'CC-2026-10-01-NH3N-01',
    note: '氨氮季度校准。',
  },
];

const states: StatePeriod[] = [
  ...instruments.map<StatePeriod>((inst) => ({
    stateId: `ST-${inst.instrumentId}-OK-BASE`,
    instrumentId: inst.instrumentId,
    state: 'OK',
    from: at(0) - 24 * HOUR,
    to: at(0) + 48 * HOUR,
    reason: '运行正常（台账基线）',
    workOrder: 'WO-118-000',
  })),
  {
    stateId: 'ST-CCE01-FLUSH-0100',
    instrumentId: 'C-CO1',
    state: 'FLUSH',
    from: at(1),
    to: at(1, 8),
    reason: '自动冲洗程序',
    workOrder: 'WO-118-001',
  },
  {
    stateId: 'ST-CCE01-FL1-BYPASS-2000',
    instrumentId: 'F-FL1',
    state: 'BYPASS',
    from: at(20),
    to: at(20, 4),
    reason: '超越管切换，流量计旁路',
    workOrder: 'WO-118-014',
  },
  {
    stateId: 'ST-CCE02-FLUSH-1500',
    instrumentId: 'C-CO3',
    state: 'FLUSH',
    from: at(15),
    to: at(15, 3),
    reason: '探头清洗',
    workOrder: 'WO-118-009',
  },
  {
    stateId: 'ST-HX-FL3-FAULT-0700',
    instrumentId: 'F-FL3',
    state: 'FAULT',
    from: at(7),
    to: at(7, 30),
    reason: '多普勒探头信号丢失',
    workOrder: 'WO-118-005',
  },
  {
    stateId: 'ST-ZB-CO6-BYPASS-0400',
    instrumentId: 'C-CO6',
    state: 'BYPASS',
    from: at(4),
    to: at(4, 30),
    reason: '旁路超越作业',
    workOrder: 'WO-118-003',
  },
];

interface PointProfile {
  pointCode: string;
  plantId: string;
  cadenceSec: number;
  metrics: MetricProfile[];
  events: {
    gap?: [number, number];
    shock?: { from: number; to: number; pollutant: Pollutant };
  };
}

interface MetricProfile {
  metric: 'COD' | 'NH3N' | 'FLOW';
  instrumentIds: { from: number; instrumentId: string }[];
  base: number;
  amplitude: number;
  phaseHour: number;
}

const profiles: PointProfile[] = [
  {
    pointCode: 'CC-E01',
    plantId: 'P1',
    cadenceSec: 10,
    metrics: [
      { metric: 'COD', instrumentIds: [{ from: at(0), instrumentId: 'C-CO1' }, { from: at(4), instrumentId: 'C-CO2' }], base: 29, amplitude: 3.4, phaseHour: 7 },
      { metric: 'NH3N', instrumentIds: [{ from: at(0), instrumentId: 'N-NH1' }], base: 3.1, amplitude: 0.5, phaseHour: 9 },
      { metric: 'FLOW', instrumentIds: [{ from: at(0), instrumentId: 'F-FL1' }], base: 430, amplitude: 42, phaseHour: 11 },
    ],
    events: {
      gap: [at(2), at(2, 3)],
      shock: { from: at(9, 15), to: at(9, 15, 40), pollutant: 'COD' },
    },
  },
  {
    pointCode: 'CC-E02',
    plantId: 'P1',
    cadenceSec: 60,
    metrics: [
      { metric: 'COD', instrumentIds: [{ from: at(0), instrumentId: 'C-CO3' }, { from: at(12), instrumentId: 'C-CO4' }], base: 37, amplitude: 2.1, phaseHour: 8 },
      { metric: 'NH3N', instrumentIds: [{ from: at(0), instrumentId: 'N-NH2' }], base: 4.1, amplitude: 0.3, phaseHour: 10 },
      { metric: 'FLOW', instrumentIds: [{ from: at(0), instrumentId: 'F-FL2' }], base: 305, amplitude: 22, phaseHour: 12 },
    ],
    events: {},
  },
  {
    pointCode: 'HX-OUT',
    plantId: 'P2',
    cadenceSec: 60,
    metrics: [
      { metric: 'COD', instrumentIds: [{ from: at(0), instrumentId: 'C-CO5' }], base: 44, amplitude: 3.0, phaseHour: 9 },
      { metric: 'NH3N', instrumentIds: [{ from: at(0), instrumentId: 'N-NH3' }], base: 4.5, amplitude: 0.4, phaseHour: 13 },
      { metric: 'FLOW', instrumentIds: [{ from: at(0), instrumentId: 'F-FL3' }], base: 258, amplitude: 18, phaseHour: 10 },
    ],
    events: {},
  },
  {
    pointCode: 'ZB-01',
    plantId: 'P3',
    cadenceSec: 300,
    metrics: [
      { metric: 'COD', instrumentIds: [{ from: at(0), instrumentId: 'C-CO6' }], base: 41, amplitude: 4.0, phaseHour: 6 },
      { metric: 'NH3N', instrumentIds: [{ from: at(0), instrumentId: 'N-NH4' }], base: 2.7, amplitude: 0.3, phaseHour: 8 },
      { metric: 'FLOW', instrumentIds: [{ from: at(0), instrumentId: 'F-FL4' }], base: 505, amplitude: 30, phaseHour: 12 },
    ],
    events: { gap: [at(16), at(16, 20)] },
  },
];

const instrumentById = new Map(instruments.map((i) => [i.instrumentId, i]));
const calibrationByInstrument = new Map<string, Calibration[]>();
for (const c of calibrations) {
  const arr = calibrationByInstrument.get(c.instrumentId) ?? [];
  arr.push(c);
  calibrationByInstrument.set(c.instrumentId, arr);
}
for (const arr of calibrationByInstrument.values()) arr.sort((a, b) => a.effectiveAt - b.effectiveAt);

function activeCalibration(instrumentId: string, t: number): Calibration | null {
  let found: Calibration | null = null;
  for (const c of calibrationByInstrument.get(instrumentId) ?? []) {
    if (c.effectiveAt <= t) found = c;
    else break;
  }
  return found;
}

function trueValue(profile: MetricProfile, t: number, pointProfile: PointProfile): number {
  const hourOfDay = (t - D0) / HOUR;
  let value =
    profile.base +
    profile.amplitude * Math.sin((2 * Math.PI * (hourOfDay - profile.phaseHour)) / 24);
  // 冲击：边界读数等于限值，内部抬升，形成恰 40 秒超限
  const shock = pointProfile.events.shock;
  if (shock && profile.metric === shock.pollutant) {
    const offsetSec = (t - shock.from) / 1000;
    const durationSec = (shock.to - shock.from) / 1000;
    const limit = plants.find((p) => p.plantId === pointProfile.plantId)!.dischargeStandard[shock.pollutant];
    if (offsetSec === 0 || offsetSec === durationSec) value = limit;
    else if (offsetSec > 0 && offsetSec < durationSec) {
      if (shock.pollutant === 'COD') value = [140, 145, 132][Math.min(2, Math.floor(offsetSec / 10))];
      else value = [9.2, 10.5, 8.6][Math.min(2, Math.floor(offsetSec / 10))];
    }
  }
  // 旁路期间浓度计仍在取样，但状态排除；给一个可辨识值
  return Math.round(value * 1000) / 1000;
}

function instrumentFor(profile: MetricProfile, t: number): string {
  let id = profile.instrumentIds[0].instrumentId;
  for (const seg of profile.instrumentIds) if (seg.from <= t) id = seg.instrumentId;
  return id;
}

function rawOf(instrumentId: string, t: number, trueVal: number): number {
  const inst = instrumentById.get(instrumentId)!;
  const cal = activeCalibration(instrumentId, t);
  const scale = cal?.scale ?? inst.scale;
  const offset = cal?.offset ?? inst.offset;
  const raw = (trueVal - offset) / scale;
  return Math.round(raw * 100) / 100;
}

function makeReadingId(instrumentId: string, alignedAt: number): string {
  return `rd-${instrumentId}-${Math.floor(alignedAt / 1000)}`;
}

interface Generated {
  pointCode: string;
  plantId: string;
  fileName: string;
  receivedAt: number;
  readings: Reading[];
  rowCount: number;
}

const BASE_RECEIVED = at(0) + 31 * HOUR + 20 * MIN; // 2026-11-19 07:20+08 的批次接收
const LATE_RECEIVED = at(0) + 40 * HOUR + 40 * MIN; // 2026-11-19 16:40+08

function generatePoint(profile: PointProfile): Generated {
  const readings: Reading[] = [];
  let row = 0;
  const fileKey = `${profile.pointCode}_${DAY}`;
  const step = profile.cadenceSec * 1000;
  // 起点保留一个标称间隔的余量，避免负时钟偏移把首条读数推到前一日
  for (let aligned = D0 + step; aligned < D0 + 24 * HOUR; aligned += step) {
    const gap = profile.events.gap;
    if (gap && aligned >= gap[0] && aligned < gap[1]) continue;
    for (const metricProfile of profile.metrics) {
      const instrumentId = instrumentFor(metricProfile, aligned);
      const trueVal = trueValue(metricProfile, aligned, profile);
      const raw = rawOf(instrumentId, aligned, trueVal);
      const inst = instrumentById.get(instrumentId)!;
      const sampledAt = aligned - inst.clockOffsetMs;
      row += 1;
      readings.push({
        readingId: makeReadingId(instrumentId, aligned),
        pointCode: profile.pointCode,
        plantId: profile.plantId,
        instrumentId,
        metric: metricProfile.metric,
        sampledAt,
        receivedAt: BASE_RECEIVED,
        rawValue: raw,
        qualityFlag: 'VALID',
        sourceFileId: `pending:${fileKey}`,
        sourceRow: row,
        alignedAt: aligned,
        dayKey: DAY,
      });
    }
  }
  // 把某个读数的质量标记为 SUSPECT，演示不确定度膨胀
  const suspect = readings.find((r) => r.metric === 'NH3N' && r.alignedAt === at(18));
  if (suspect) suspect.qualityFlag = 'SUSPECT';
  return {
    pointCode: profile.pointCode,
    plantId: profile.plantId,
    fileName: `readings_${profile.pointCode}_${DAY}.csv`,
    receivedAt: BASE_RECEIVED + (profile.pointCode === 'CC-E01' ? 0 : 5 * MIN),
    readings,
    rowCount: row,
  };
}

function generateLate(): Reading[] {
  const readings: Reading[] = [];
  const profile = profiles[0];
  for (let aligned = at(2); aligned < at(2, 3); aligned += 10 * SEC) {
    for (const metricProfile of profile.metrics) {
      const instrumentId = instrumentFor(metricProfile, aligned);
      const trueVal = trueValue(metricProfile, aligned, profile);
      const inst = instrumentById.get(instrumentId)!;
      readings.push({
        readingId: `late-${instrumentId}-${Math.floor(aligned / 1000)}`,
        pointCode: profile.pointCode,
        plantId: profile.plantId,
        instrumentId,
        metric: metricProfile.metric,
        sampledAt: aligned - inst.clockOffsetMs,
        receivedAt: LATE_RECEIVED,
        rawValue: rawOf(instrumentId, aligned, trueVal),
        qualityFlag: 'VALID',
        sourceFileId: 'pending:late_CC-E01_2026-11-19.csv',
        sourceRow: readings.length + 1,
        alignedAt: aligned,
        dayKey: DAY,
      });
    }
  }
  return readings;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ================= 工艺段平衡分析样例（P1，2026-11-18） =================
 *
 * 故事线（全部确定性，无随机数）：
 * - 反冲洗 14:00–15:20（450 m³/h，共 600 m³）回流水在进水计量点上游汇入主线，
 *   其流量计与浓度计在基础批次中缺测（遥测中断），补传文件次日 16:40 到达；
 * - 生化池液位 08:00–12:00 上升 0.4 m（+800 m³ 存量），夜间回落，净 ΔV +100 m³；
 * - 22:30–23:30 进水升高（流量/COD/示踪同步），全厂滞后带 150–260 min，
 *   到达出水已是次日 01:00 之后 → 保持“在途”，不强行配对；
 * - 08:30–09:30 进水 COD 抬升，出水 12:00–13:30 出现滞后响应（允许配对）；
 * - 回流泵 P-R1 11:00 由 S-RET-A 切换至 S-RET-B（内部循环，从主线拆出）；
 * - 旁通支路 S-BYP 2026-11-20 起停用（2026-11-22 登记确认），不改写 11-18 平衡；
 * - 各仪表带确定性偏差（均在证书 k=2 区间内），供路径 B 协调定位。
 */

const B_RECEIVED = at(0) + 30 * HOUR + 10 * MIN; // 台账 2026-11-19 06:10+08
const B_READINGS_RECEIVED = BASE_RECEIVED; // 支路读数随基础批次
const B_LATE_RECEIVED = LATE_RECEIVED; // 补传与迟到读数同批到达

const balanceUnits: ProcessUnit[] = [
  { unitId: 'U1', plantId: 'P1', name: '初沉池', kind: 'PRIMARY_CLARIFIER', surfaceAreaM2: 800, lagMinMinutes: 20, lagMaxMinutes: 40, note: '无液位计，存量变化按 0 处理并披露。' },
  { unitId: 'U2', plantId: 'P1', name: '生化池(A²/O)', kind: 'BIOREACTOR', surfaceAreaM2: 2000, lagMinMinutes: 90, lagMaxMinutes: 150, note: '曝气与排泥记录所在单元；液位计 L-U2。' },
  { unitId: 'U3', plantId: 'P1', name: '二沉池', kind: 'SECONDARY_CLARIFIER', surfaceAreaM2: 1200, lagMinMinutes: 30, lagMaxMinutes: 50, note: '回流污泥自本单元抽出；液位计 L-U3。' },
  { unitId: 'U4', plantId: 'P1', name: '深度处理(高效沉淀+滤池)', kind: 'TERTIARY', surfaceAreaM2: 400, lagMinMinutes: 10, lagMaxMinutes: 20, note: '反冲洗水回流至厂首；投药记录所在单元。' },
];

const balanceStreams: BoundaryStream[] = [
  { streamId: 'S-IN', plantId: 'P1', unitId: 'U1', kind: 'IN', flowMeterId: 'M-QIN', internal: false, effectiveFrom: at(0) - 300 * 24 * HOUR, effectiveTo: null, registeredAt: B_RECEIVED, gapFlowLowM3h: 0, gapFlowHighM3h: 0, gapConcLowMgL: { TRACER: 0, COD: 0, NH3N: 0 }, gapConcHighMgL: { TRACER: 0, COD: 0, NH3N: 0 }, note: '总进水计量点位于反冲洗回流水汇入点下游，测量值含回流水。' },
  { streamId: 'S-OUT', plantId: 'P1', unitId: 'U4', kind: 'OUT', flowMeterId: 'M-QOUT', internal: false, effectiveFrom: at(0) - 300 * 24 * HOUR, effectiveTo: null, registeredAt: B_RECEIVED, gapFlowLowM3h: 0, gapFlowHighM3h: 0, gapConcLowMgL: { TRACER: 0, COD: 0, NH3N: 0 }, gapConcHighMgL: { TRACER: 0, COD: 0, NH3N: 0 }, note: '总出水（厂界）。' },
  { streamId: 'S-RET-A', plantId: 'P1', unitId: 'U3', kind: 'RETURN', flowMeterId: 'M-QR1', internal: true, effectiveFrom: at(0) - 300 * 24 * HOUR, effectiveTo: at(11), registeredAt: B_RECEIVED, gapFlowLowM3h: 0, gapFlowHighM3h: 0, gapConcLowMgL: { TRACER: 0, COD: 0, NH3N: 0 }, gapConcHighMgL: { TRACER: 0, COD: 0, NH3N: 0 }, note: '回流污泥至生化池前端（11:00 前）。' },
  { streamId: 'S-RET-B', plantId: 'P1', unitId: 'U3', kind: 'RETURN', flowMeterId: 'M-QR1', internal: true, effectiveFrom: at(11), effectiveTo: null, registeredAt: B_RECEIVED, gapFlowLowM3h: 0, gapFlowHighM3h: 0, gapConcLowMgL: { TRACER: 0, COD: 0, NH3N: 0 }, gapConcHighMgL: { TRACER: 0, COD: 0, NH3N: 0 }, note: '回流污泥至生化池缺氧段（11:00 起，泵切换后）。' },
  { streamId: 'S-SL1', plantId: 'P1', unitId: 'U1', kind: 'SLUDGE', flowMeterId: 'M-QS1', internal: false, effectiveFrom: at(0) - 300 * 24 * HOUR, effectiveTo: null, registeredAt: B_RECEIVED, gapFlowLowM3h: 0, gapFlowHighM3h: 0, gapConcLowMgL: { TRACER: 0, COD: 0, NH3N: 0 }, gapConcHighMgL: { TRACER: 0, COD: 0, NH3N: 0 }, note: '初沉排泥（06:00–06:30、18:00–18:30）。' },
  { streamId: 'S-SL2', plantId: 'P1', unitId: 'U3', kind: 'SLUDGE', flowMeterId: 'M-QS2', internal: false, effectiveFrom: at(0) - 300 * 24 * HOUR, effectiveTo: null, registeredAt: B_RECEIVED, gapFlowLowM3h: 0, gapFlowHighM3h: 0, gapConcLowMgL: { TRACER: 0, COD: 0, NH3N: 0 }, gapConcHighMgL: { TRACER: 0, COD: 0, NH3N: 0 }, note: '剩余污泥排放（20:00–20:40）。' },
  { streamId: 'S-BW', plantId: 'P1', unitId: 'U4', kind: 'BACKWASH', flowMeterId: 'M-QBW', internal: true, effectiveFrom: at(0) - 300 * 24 * HOUR, effectiveTo: null, registeredAt: B_RECEIVED, gapFlowLowM3h: 0, gapFlowHighM3h: 450, gapConcLowMgL: { TRACER: 150, COD: 80, NH3N: 5 }, gapConcHighMgL: { TRACER: 200, COD: 260, NH3N: 20 }, note: '反冲洗水回流至厂首（进水计量点上游）；缺测时按泵额定 0–450 m³/h、浓度 80–260 mg/L 登记估计。' },
  { streamId: 'S-BYP', plantId: 'P1', unitId: 'U1', kind: 'OUT', flowMeterId: null, internal: false, effectiveFrom: at(0) - 300 * 24 * HOUR, effectiveTo: at(0) + 2 * 24 * HOUR, registeredAt: Date.UTC(2026, 10, 22, 1, 0, 0), gapFlowLowM3h: 0, gapFlowHighM3h: 0, gapConcLowMgL: { TRACER: 0, COD: 0, NH3N: 0 }, gapConcHighMgL: { TRACER: 0, COD: 0, NH3N: 0 }, note: '应急旁通（无量计，常年零流量）；2026-11-20 起停用，2026-11-22 登记确认，不改写 11-18 平衡。' },
];

const balanceMeters: MeterSpec[] = [
  { meterId: 'M-QIN', metric: 'FLOW', label: '总进水流量计', relSigma: 0.01, absSigma: 2, calGroup: 'CG-FLOW-2026Q4', groupCorrelation: 0.5, adjustLimitRel: 0.03, certificate: 'CC-2026-10-01-FLOW-01', validFrom: at(0) - 48 * 24 * HOUR, validTo: null, note: '与 M-QOUT/M-QR1/M-QBW 同批次率定，误差相关 ρ=0.5。' },
  { meterId: 'M-QOUT', metric: 'FLOW', label: '总出水流量计', relSigma: 0.01, absSigma: 2, calGroup: 'CG-FLOW-2026Q4', groupCorrelation: 0.5, adjustLimitRel: 0.03, certificate: 'CC-2026-10-01-FLOW-02', validFrom: at(0) - 48 * 24 * HOUR, validTo: null, note: '同 CG-FLOW-2026Q4。' },
  { meterId: 'M-QR1', metric: 'FLOW', label: '回流泵流量计', relSigma: 0.015, absSigma: 1, calGroup: 'CG-FLOW-2026Q4', groupCorrelation: 0.5, adjustLimitRel: 0.04, certificate: 'CC-2026-10-01-FLOW-03', validFrom: at(0) - 48 * 24 * HOUR, validTo: null, note: '回流泵 P-R1 出线计量。' },
  { meterId: 'M-QS1', metric: 'FLOW', label: '初沉排泥流量计', relSigma: 0.025, absSigma: 0.5, calGroup: 'CG-SLUDGE-2026Q4', groupCorrelation: 0.4, adjustLimitRel: 0.06, certificate: 'CC-2026-10-02-SLD-01', validFrom: at(0) - 46 * 24 * HOUR, validTo: null, note: '间歇运行。' },
  { meterId: 'M-QS2', metric: 'FLOW', label: '剩余污泥流量计', relSigma: 0.025, absSigma: 0.5, calGroup: 'CG-SLUDGE-2026Q4', groupCorrelation: 0.4, adjustLimitRel: 0.06, certificate: 'CC-2026-10-02-SLD-02', validFrom: at(0) - 46 * 24 * HOUR, validTo: null, note: '间歇运行。' },
  { meterId: 'M-QBW', metric: 'FLOW', label: '反冲洗回流流量计', relSigma: 0.02, absSigma: 1, calGroup: 'CG-FLOW-2026Q4', groupCorrelation: 0.5, adjustLimitRel: 0.05, certificate: 'CC-2026-10-01-FLOW-04', validFrom: at(0) - 48 * 24 * HOUR, validTo: null, note: '14:00–15:20 遥测中断（基础批次缺测，补传到达）。' },
  { meterId: 'M-TIN', metric: 'TRACER', label: '进水氯离子仪', relSigma: 0.015, absSigma: 1, calGroup: 'CG-TRACER-202611', groupCorrelation: 0.5, adjustLimitRel: 0.04, certificate: 'CC-2026-11-01-TRC-01', validFrom: at(0) - 17 * 24 * HOUR, validTo: null, note: '与 M-TOUT/M-TBW 共用标准物质。' },
  { meterId: 'M-TOUT', metric: 'TRACER', label: '出水氯离子仪', relSigma: 0.015, absSigma: 1, calGroup: 'CG-TRACER-202611', groupCorrelation: 0.5, adjustLimitRel: 0.04, certificate: 'CC-2026-11-01-TRC-02', validFrom: at(0) - 17 * 24 * HOUR, validTo: null, note: '同 CG-TRACER-202611。' },
  { meterId: 'M-TBW', metric: 'TRACER', label: '反冲洗水氯离子仪', relSigma: 0.015, absSigma: 1, calGroup: 'CG-TRACER-202611', groupCorrelation: 0.5, adjustLimitRel: 0.04, certificate: 'CC-2026-11-01-TRC-03', validFrom: at(0) - 17 * 24 * HOUR, validTo: null, note: '同 CG-TRACER-202611。' },
  { meterId: 'M-CIN', metric: 'COD', label: '进水 COD 仪', relSigma: 0.02, absSigma: 2, calGroup: 'CG-COD-202611', groupCorrelation: 0.5, adjustLimitRel: 0.05, certificate: 'CC-2026-11-02-COD-01', validFrom: at(0) - 16 * 24 * HOUR, validTo: null, note: '与 M-COUT/M-CBW 共用标准液。' },
  { meterId: 'M-COUT', metric: 'COD', label: '出水 COD 仪', relSigma: 0.02, absSigma: 1, calGroup: 'CG-COD-202611', groupCorrelation: 0.5, adjustLimitRel: 0.05, certificate: 'CC-2026-11-02-COD-02', validFrom: at(0) - 16 * 24 * HOUR, validTo: null, note: '同 CG-COD-202611。' },
  { meterId: 'M-CBW', metric: 'COD', label: '反冲洗水 COD 仪', relSigma: 0.02, absSigma: 2, calGroup: 'CG-COD-202611', groupCorrelation: 0.5, adjustLimitRel: 0.05, certificate: 'CC-2026-11-02-COD-03', validFrom: at(0) - 16 * 24 * HOUR, validTo: null, note: '同 CG-COD-202611。' },
  { meterId: 'M-NIN', metric: 'NH3N', label: '进水氨氮仪', relSigma: 0.025, absSigma: 0.3, calGroup: 'CG-NH3N-202611', groupCorrelation: 0.5, adjustLimitRel: 0.06, certificate: 'CC-2026-11-03-NHN-01', validFrom: at(0) - 15 * 24 * HOUR, validTo: null, note: '与 M-NOUT/M-NBW 共用标准液。' },
  { meterId: 'M-NOUT', metric: 'NH3N', label: '出水氨氮仪', relSigma: 0.025, absSigma: 0.2, calGroup: 'CG-NH3N-202611', groupCorrelation: 0.5, adjustLimitRel: 0.06, certificate: 'CC-2026-11-03-NHN-02', validFrom: at(0) - 15 * 24 * HOUR, validTo: null, note: '同 CG-NH3N-202611。' },
  { meterId: 'M-NBW', metric: 'NH3N', label: '反冲洗水氨氮仪', relSigma: 0.025, absSigma: 0.3, calGroup: 'CG-NH3N-202611', groupCorrelation: 0.5, adjustLimitRel: 0.06, certificate: 'CC-2026-11-03-NHN-03', validFrom: at(0) - 15 * 24 * HOUR, validTo: null, note: '同 CG-NH3N-202611。' },
  { meterId: 'L-U2', metric: 'FLOW', label: '生化池液位计(→ΔV)', relSigma: 0, absSigma: 28, calGroup: 'CG-LEVEL', groupCorrelation: 0, adjustLimitRel: 0.5, certificate: 'CC-2026-10-05-LVL-01', validFrom: at(0) - 44 * 24 * HOUR, validTo: null, note: 'absSigma 已折算为体积：±0.01 m × √2 × 2000 m² ≈ 28 m³。' },
  { meterId: 'L-U3', metric: 'FLOW', label: '二沉池液位计(→ΔV)', relSigma: 0, absSigma: 17, calGroup: 'CG-LEVEL', groupCorrelation: 0, adjustLimitRel: 0.5, certificate: 'CC-2026-10-05-LVL-02', validFrom: at(0) - 44 * 24 * HOUR, validTo: null, note: 'absSigma 已折算为体积：±0.01 m × √2 × 1200 m² ≈ 17 m³。' },
];

const balanceParams: RemovalParam[] = [
  { paramId: 'RP-O2-KG-M3AIR', unitId: null, pollutant: 'COD', param: '每 m³ 空气理论供氧量', low: 0.3, high: 0.3, unit: 'kgO₂/m³', note: '0.21 × 1.429 kg/m³。' },
  { paramId: 'RP-ETA-O2', unitId: 'U2', pollutant: 'COD', param: '氧转移效率', low: 0.28, high: 0.42, unit: '-', note: '微孔曝气典型范围（台账登记）。' },
  { paramId: 'RP-NIT-FRAC', unitId: 'U2', pollutant: 'NH3N', param: '供氧分配硝化比例', low: 0.3, high: 0.42, unit: '-', note: '按进水 C/N 与历史运行登记。' },
  { paramId: 'RP-NIT-O2', unitId: null, pollutant: 'NH3N', param: '硝化需氧量', low: 4.57, high: 4.57, unit: 'kgO₂/kgN', note: '理论值。' },
  { paramId: 'RP-COD-PER-O2', unitId: 'U2', pollutant: 'COD', param: '碳氧化系数', low: 0.85, high: 1.1, unit: 'kgCOD/kgO₂', note: '含内源呼吸修正。' },
  { paramId: 'RP-SLUDGE-TSS', unitId: null, pollutant: 'COD', param: '排泥含固浓度', low: 7, high: 9, unit: 'kgTSS/m³', note: '排泥浓度化验登记范围。' },
  { paramId: 'RP-SLUDGE-CODRATIO', unitId: null, pollutant: 'COD', param: '污泥 COD/TSS 比', low: 1, high: 1.4, unit: 'kgCOD/kgTSS', note: '污泥成分化验登记范围。' },
  { paramId: 'RP-PAC-COD', unitId: 'U4', pollutant: 'COD', param: '混凝剂单位去除', low: 0.15, high: 0.35, unit: 'kgCOD/kg', note: 'PAC 投加化学沉淀去除。' },
  { paramId: 'RP-DO-MIN', unitId: 'U2', pollutant: 'COD', param: '好氧去除最低溶解氧', low: 1, high: 1, unit: 'mg/L', note: '低于此值好氧去除折减。' },
];

const balanceSwitches: PumpSwitch[] = [
  { switchId: 'SW-001', pumpId: 'P-R1', at: at(11), fromStreamId: 'S-RET-A', toStreamId: 'S-RET-B', reason: '缺氧段碳源分配优化，回流点切换', workOrder: 'WO-118-021' },
];

/** 仪表确定性偏差（均在证书 k=2 区间内），供路径 B 协调定位 */
const METER_BIAS: Record<string, number> = {
  'M-QIN': 1.015, 'M-QOUT': 0.99, 'M-QR1': 0.985, 'M-QS1': 1.0, 'M-QS2': 0.98, 'M-QBW': 1.02,
  'M-TIN': 1.005, 'M-TOUT': 0.995, 'M-TBW': 1.0,
  'M-CIN': 1.02, 'M-COUT': 0.98, 'M-CBW': 1.015,
  'M-NIN': 1.0, 'M-NOUT': 1.03, 'M-NBW': 1.0,
};

function bump(h: number, start: number, dur: number): number {
  return h >= start && h <= start + dur ? Math.sin((Math.PI * (h - start)) / dur) : 0;
}

function qExt(h: number): number {
  return 430 + 70 * Math.sin((2 * Math.PI * (h - 9)) / 24) + 70 * bump(h, 22.5, 1);
}
function qBw(h: number): number {
  return h >= 14 && h < 14 + 4 / 3 ? 450 : 0;
}
function qSl1(h: number): number {
  return (h >= 6 && h < 6.5) || (h >= 18 && h < 18.5) ? 60 : 0;
}
function qSl2(h: number): number {
  return h >= 20 && h < 20 + 2 / 3 ? 45 : 0;
}
function dv2dt(h: number): number {
  if (h >= 8 && h < 12) return 200;
  if (h >= 12 && h < 20) return -87.5;
  if (h >= 22.5 && h <= 23.5) return 70 * bump(h, 22.5, 1); // 夜间冲击水全部滞留池内
  return 0;
}
function dv3dt(h: number): number {
  return 0.02 * Math.cos((2 * Math.PI * h) / 24) * ((2 * Math.PI) / 24) * 1200;
}
function qOut(h: number): number {
  return qExt(h) - qSl1(h) - qSl2(h) - dv2dt(h) - dv3dt(h);
}
function qRet(h: number): number {
  return 180 + 20 * Math.sin((2 * Math.PI * (h - 6)) / 24);
}
function cCodExt(h: number): number {
  return 310 + 60 * Math.sin((2 * Math.PI * (h - 8)) / 24) + 90 * bump(h, 8.5, 1) + 220 * bump(h, 22.5, 1);
}
function cCodBw(h: number): number {
  return qBw(h) > 0 ? 160 + 30 * Math.sin((2 * Math.PI * (h - 14)) / 1.33) : 25;
}
function cTrExt(h: number): number {
  return 180 + 25 * Math.sin((2 * Math.PI * (h - 7)) / 24) + 80 * bump(h, 22.5, 1);
}
function cTrBw(h: number): number {
  return qBw(h) > 0 ? 175 : 150;
}
function cNhExt(h: number): number {
  return 30 + 4 * Math.sin((2 * Math.PI * (h - 8)) / 24);
}
function cNhBw(h: number): number {
  return qBw(h) > 0 ? 12 : 3;
}
/** 进水混合浓度：外部进水与反冲洗回流水在计量点上游混合 */
function mixed(h: number, cExt: number, cBw: number): number {
  const qe = qExt(h);
  const qb = qBw(h);
  if (qb <= 0) return cExt;
  return (qe * cExt + qb * cBw) / (qe + qb);
}
function cTrOut(h: number): number {
  const hs = Math.max(0, h - 3.5);
  return 0.998 * mixed(hs, cTrExt(hs), cTrBw(hs));
}
function cCodOut(h: number): number {
  return 26 + 4 * Math.sin((2 * Math.PI * (h - 14)) / 24) + 8 * bump(h, 12, 1.5);
}
function cNhOut(h: number): number {
  return 1.8 + 0.5 * Math.sin((2 * Math.PI * (h - 13)) / 24);
}
function levelU2(h: number): number {
  if (h < 8) return 3.1;
  if (h < 12) return 3.1 + 0.1 * (h - 8);
  if (h < 20) return 3.5 - 0.04375 * (h - 12);
  if (h < 22.5) return 3.15;
  if (h <= 23.5) return 3.15 + ((70 / Math.PI) * (1 - Math.cos(Math.PI * (h - 22.5)))) / 2000;
  return 3.172;
}
function levelU3(h: number): number {
  return 2.8 + 0.02 * Math.sin((2 * Math.PI * h) / 24);
}

interface BalanceFile {
  fileName: string;
  kind: SampleManifest['baseFiles'][number]['kind'];
  receivedAt: number;
  text: string;
  note: string;
}

function generateBalanceFiles(): { files: BalanceFile[]; lateFile: BalanceFile } {
  const files: BalanceFile[] = [];
  files.push({
    fileName: 'process_units.csv',
    kind: 'PROCESS_UNIT_REGISTER',
    receivedAt: B_RECEIVED,
    note: '工艺单元登记：水面面积与可达滞后时间带',
    text: serializeCsv(
      ['unit_id', 'plant_id', 'name', 'kind', 'surface_area_m2', 'lag_min_minutes', 'lag_max_minutes', 'note'],
      balanceUnits.map((u) => ({
        unit_id: u.unitId, plant_id: u.plantId, name: u.name, kind: u.kind,
        surface_area_m2: u.surfaceAreaM2, lag_min_minutes: u.lagMinMinutes, lag_max_minutes: u.lagMaxMinutes, note: u.note,
      })),
    ),
  });
  files.push({
    fileName: 'boundary_streams.csv',
    kind: 'BOUNDARY_STREAM_REGISTER',
    receivedAt: B_RECEIVED,
    note: '边界流登记：进出水/回流/排泥/反冲洗/旁通，含支路有效期与缺测估计',
    text: serializeCsv(
      ['stream_id', 'plant_id', 'unit_id', 'kind', 'flow_meter_id', 'internal', 'effective_from', 'effective_to', 'registered_at', 'gap_flow_low_m3h', 'gap_flow_high_m3h', 'gap_conc_tracer_low_mg_l', 'gap_conc_tracer_high_mg_l', 'gap_conc_cod_low_mg_l', 'gap_conc_cod_high_mg_l', 'gap_conc_nh3n_low_mg_l', 'gap_conc_nh3n_high_mg_l', 'note'],
      balanceStreams.map((s) => ({
        stream_id: s.streamId, plant_id: s.plantId, unit_id: s.unitId, kind: s.kind,
        flow_meter_id: s.flowMeterId ?? '', internal: s.internal ? 'true' : 'false',
        effective_from: isoLocal(s.effectiveFrom), effective_to: s.effectiveTo === null ? '' : isoLocal(s.effectiveTo),
        registered_at: isoLocal(s.registeredAt),
        gap_flow_low_m3h: s.gapFlowLowM3h, gap_flow_high_m3h: s.gapFlowHighM3h,
        gap_conc_tracer_low_mg_l: s.gapConcLowMgL.TRACER, gap_conc_tracer_high_mg_l: s.gapConcHighMgL.TRACER,
        gap_conc_cod_low_mg_l: s.gapConcLowMgL.COD, gap_conc_cod_high_mg_l: s.gapConcHighMgL.COD,
        gap_conc_nh3n_low_mg_l: s.gapConcLowMgL.NH3N, gap_conc_nh3n_high_mg_l: s.gapConcHighMgL.NH3N, note: s.note,
      })),
    ),
  });
  files.push({
    fileName: 'meter_specs.csv',
    kind: 'METER_SPEC_REGISTER',
    receivedAt: B_RECEIVED,
    note: '不确定度库：仪表精度、共用校准组、可接受调整范围',
    text: serializeCsv(
      ['meter_id', 'metric', 'label', 'rel_sigma', 'abs_sigma', 'cal_group', 'group_correlation', 'adjust_limit_rel', 'certificate', 'valid_from', 'valid_to', 'note'],
      balanceMeters.map((m) => ({
        meter_id: m.meterId, metric: m.metric, label: m.label, rel_sigma: m.relSigma, abs_sigma: m.absSigma,
        cal_group: m.calGroup, group_correlation: m.groupCorrelation, adjust_limit_rel: m.adjustLimitRel,
        certificate: m.certificate, valid_from: isoLocal(m.validFrom), valid_to: m.validTo === null ? '' : isoLocal(m.validTo), note: m.note,
      })),
    ),
  });
  files.push({
    fileName: 'removal_params.csv',
    kind: 'REMOVAL_PARAM_REGISTER',
    receivedAt: B_RECEIVED,
    note: '去除参数台账：去除范围的全部假设来源',
    text: serializeCsv(
      ['param_id', 'unit_id', 'pollutant', 'param', 'low', 'high', 'unit', 'note'],
      balanceParams.map((p) => ({
        param_id: p.paramId, unit_id: p.unitId ?? '', pollutant: p.pollutant, param: p.param,
        low: p.low, high: p.high, unit: p.unit, note: p.note,
      })),
    ),
  });
  files.push({
    fileName: 'pump_switches.csv',
    kind: 'PUMP_SWITCH_LOG',
    receivedAt: B_RECEIVED,
    note: '回流泵切换事件：RETURN 支路据此拆腿',
    text: serializeCsv(
      ['switch_id', 'pump_id', 'at', 'from_stream_id', 'to_stream_id', 'reason', 'work_order'],
      balanceSwitches.map((s) => ({
        switch_id: s.switchId, pump_id: s.pumpId, at: isoLocal(s.at),
        from_stream_id: s.fromStreamId, to_stream_id: s.toStreamId, reason: s.reason, work_order: s.workOrder,
      })),
    ),
  });

  // ---- 支路读数（5 min cadence）----
  const readings: StreamReading[] = [];
  const lateReadings: StreamReading[] = [];
  const push = (streamId: string, meterId: string, metric: StreamReading['metric'], t: number, trueValue: number, late: boolean) => {
    const bias = METER_BIAS[meterId] ?? 1;
    const value = Math.round(trueValue * bias * 100) / 100;
    const rec: StreamReading = {
      readingId: `${late ? 'sl' : 'sr'}-${meterId}-${Math.floor(t / 1000)}`,
      streamId,
      meterId,
      metric,
      sampledAt: t,
      dayKey: DAY,
      receivedAt: late ? B_LATE_RECEIVED : B_READINGS_RECEIVED,
      rawValue: value,
      qualityFlag: 'VALID',
      sourceFileId: `pending:${late ? 'late_flow_P1_2026-11-19.csv' : 'stream_readings_P1_2026-11-18.csv'}`,
      sourceRow: 0,
    };
    if (late) lateReadings.push(rec);
    else readings.push(rec);
  };
  for (let t = D0 + 5 * MIN; t < D0 + 24 * HOUR; t += 5 * MIN) {
    const h = (t - D0) / HOUR;
    const inBwGap = h >= 14 && h < 14 + 4 / 3;
    push('S-IN', 'M-QIN', 'FLOW', t, qExt(h) + qBw(h), false);
    push('S-OUT', 'M-QOUT', 'FLOW', t, qOut(h), false);
    push(h < 11 ? 'S-RET-A' : 'S-RET-B', 'M-QR1', 'FLOW', t, qRet(h), false);
    push('S-SL1', 'M-QS1', 'FLOW', t, qSl1(h), false);
    push('S-SL2', 'M-QS2', 'FLOW', t, qSl2(h), false);
    push('S-BW', 'M-QBW', 'FLOW', t, qBw(h), inBwGap);
    push('S-IN', 'M-TIN', 'TRACER', t, mixed(h, cTrExt(h), cTrBw(h)), false);
    push('S-OUT', 'M-TOUT', 'TRACER', t, cTrOut(h), false);
    push('S-BW', 'M-TBW', 'TRACER', t, cTrBw(h), inBwGap);
    push('S-IN', 'M-CIN', 'COD', t, mixed(h, cCodExt(h), cCodBw(h)), false);
    push('S-OUT', 'M-COUT', 'COD', t, cCodOut(h), false);
    push('S-BW', 'M-CBW', 'COD', t, cCodBw(h), inBwGap);
    push('S-IN', 'M-NIN', 'NH3N', t, mixed(h, cNhExt(h), cNhBw(h)), false);
    push('S-OUT', 'M-NOUT', 'NH3N', t, cNhOut(h), false);
    push('S-BW', 'M-NBW', 'NH3N', t, cNhBw(h), inBwGap);
  }
  readings.forEach((r, i) => { r.sourceRow = i + 2; });
  lateReadings.forEach((r, i) => { r.sourceRow = i + 2; });
  const readingHeaders = ['reading_id', 'stream_id', 'meter_id', 'metric', 'sampled_at', 'received_at', 'raw_value', 'quality_flag'];
  const toRows = (list: StreamReading[]) =>
    list.map((r) => ({
      reading_id: r.readingId, stream_id: r.streamId, meter_id: r.meterId, metric: r.metric,
      sampled_at: isoLocal(r.sampledAt, true), received_at: isoLocal(r.receivedAt),
      raw_value: r.rawValue, quality_flag: r.qualityFlag,
    }));
  files.push({
    fileName: 'stream_readings_P1_2026-11-18.csv',
    kind: 'STREAM_READINGS',
    receivedAt: B_READINGS_RECEIVED,
    note: `P1 边界支路读数（${readings.length} 行；反冲洗 14:00–15:20 遥测中断）`,
    text: serializeCsv(readingHeaders, toRows(readings)),
  });
  const lateFile: BalanceFile = {
    fileName: 'late_flow_P1_2026-11-19.csv',
    kind: 'LATE_FLOW_BATCH',
    receivedAt: B_LATE_RECEIVED,
    note: `补传流量：反冲洗支路 14:00–15:20 缺测段（${lateReadings.length} 行），分析出具后到达`,
    text: serializeCsv(readingHeaders, toRows(lateReadings)),
  };

  // ---- 液位记录（15 min）----
  const levels: LevelRecord[] = [];
  for (let t = D0; t <= D0 + 24 * HOUR; t += 15 * MIN) {
    const h = (t - D0) / HOUR;
    levels.push(
      { recordId: `lv-U2-${Math.floor(t / 1000)}`, unitId: 'U2', at: t, levelM: Math.round(levelU2(h) * 1000) / 1000, receivedAt: B_READINGS_RECEIVED, sourceFileId: 'pending:level_log_P1_2026-11-18.csv' },
      { recordId: `lv-U3-${Math.floor(t / 1000)}`, unitId: 'U3', at: t, levelM: Math.round(levelU3(h) * 1000) / 1000, receivedAt: B_READINGS_RECEIVED, sourceFileId: 'pending:level_log_P1_2026-11-18.csv' },
    );
  }
  files.push({
    fileName: 'level_log_P1_2026-11-18.csv',
    kind: 'LEVEL_LOG',
    receivedAt: B_READINGS_RECEIVED,
    note: `液位记录（${levels.length} 行）：U2 生化池午间蓄水 0.4 m`,
    text: serializeCsv(
      ['record_id', 'unit_id', 'at', 'level_m', 'received_at'],
      levels.map((l) => ({ record_id: l.recordId, unit_id: l.unitId, at: isoLocal(l.at), level_m: l.levelM, received_at: isoLocal(l.receivedAt) })),
    ),
  });

  // ---- 工艺记录 ----
  const processRecords: ProcessRecord[] = [];
  for (let h = 0; h < 24; h += 1) {
    processRecords.push(
      { recordId: `pr-aer-${h}`, unitId: 'U2', kind: 'AERATION', from: D0 + h * HOUR, to: D0 + (h + 1) * HOUR, value: 1400, unit: 'm³/h', note: '生化池鼓风机 hourly 均值', sourceFileId: 'pending:process_log_P1_2026-11-18.csv' },
      { recordId: `pr-do-${h}`, unitId: 'U2', kind: 'DO', from: D0 + h * HOUR, to: D0 + (h + 1) * HOUR, value: Math.round((2.2 + 0.3 * Math.sin((2 * Math.PI * (h - 6)) / 24)) * 100) / 100, unit: 'mg/L', note: '好氧段溶解氧 hourly 均值', sourceFileId: 'pending:process_log_P1_2026-11-18.csv' },
    );
  }
  processRecords.push(
    { recordId: 'pr-sl-1', unitId: 'U1', kind: 'SLUDGE_WASTE', from: at(6), to: at(6, 30), value: 30, unit: 'm³', note: '初沉排泥 06:00–06:30', sourceFileId: 'pending:process_log_P1_2026-11-18.csv' },
    { recordId: 'pr-sl-2', unitId: 'U3', kind: 'SLUDGE_WASTE', from: at(20), to: at(20, 40), value: 30, unit: 'm³', note: '剩余污泥排放 20:00–20:40', sourceFileId: 'pending:process_log_P1_2026-11-18.csv' },
    { recordId: 'pr-dose-1', unitId: 'U4', kind: 'DOSING', from: at(9), to: at(10), value: 150, unit: 'kg', note: 'PAC 投加（上午）', sourceFileId: 'pending:process_log_P1_2026-11-18.csv' },
    { recordId: 'pr-dose-2', unitId: 'U4', kind: 'DOSING', from: at(15), to: at(16), value: 100, unit: 'kg', note: 'PAC 投加（下午）', sourceFileId: 'pending:process_log_P1_2026-11-18.csv' },
  );
  files.push({
    fileName: 'process_log_P1_2026-11-18.csv',
    kind: 'PROCESS_LOG',
    receivedAt: B_READINGS_RECEIVED,
    note: `工艺记录（${processRecords.length} 行）：曝气/溶解氧/排泥/投药，去除范围唯一依据`,
    text: serializeCsv(
      ['record_id', 'unit_id', 'kind', 'from', 'to', 'value', 'unit', 'note'],
      processRecords.map((p) => ({
        record_id: p.recordId, unit_id: p.unitId, kind: p.kind, from: isoLocal(p.from), to: isoLocal(p.to),
        value: p.value, unit: p.unit, note: p.note,
      })),
    ),
  });
  return { files, lateFile };
}

function main(): void {
  mkdirSync(outDir, { recursive: true });
  const manifestBase: SampleManifest['baseFiles'] = [];

  const plantCsv = serializeCsv(
    ['plant_id', 'name', 'short_name', 'timezone', 'cod_limit', 'nh3n_limit'],
    plants.map((p) => ({
      plant_id: p.plantId,
      name: p.name,
      short_name: p.shortName,
      timezone: p.timezone,
      cod_limit: p.dischargeStandard.COD,
      nh3n_limit: p.dischargeStandard.NH3N,
    })),
  );
  const pointCsv = serializeCsv(
    ['point_code', 'plant_id', 'name', 'reused', 'design_flow_m3h', 'note'],
    points.map((p) => ({
      point_code: p.pointCode,
      plant_id: p.plantId,
      name: p.name,
      reused: p.reused ? 'true' : 'false',
      design_flow_m3h: p.designFlowM3h,
      note: p.note,
    })),
  );
  const instrumentCsv = serializeCsv(
    [
      'instrument_id',
      'point_code',
      'plant_id',
      'kind',
      'metric',
      'model',
      'serial',
      'scale',
      'offset',
      'value_uncertainty',
      'nominal_interval_seconds',
      'installed_at',
      'removed_at',
      'clock_offset_ms',
      'clock_offset_uncertainty_ms',
      'note',
    ],
    instruments.map((i) => ({
      instrument_id: i.instrumentId,
      point_code: i.pointCode,
      plant_id: i.plantId,
      kind: i.kind,
      metric: i.metric,
      model: i.model,
      serial: i.serial,
      scale: i.scale,
      offset: i.offset,
      value_uncertainty: i.valueUncertainty,
      nominal_interval_seconds: i.nominalIntervalSeconds,
      installed_at: isoLocal(i.installedAt),
      removed_at: i.removedAt === null ? '' : isoLocal(i.removedAt),
      clock_offset_ms: i.clockOffsetMs,
      clock_offset_uncertainty_ms: i.clockOffsetUncertaintyMs,
      note: i.note,
    })),
  );
  const bindingCsv = serializeCsv(
    ['binding_id', 'point_code', 'instrument_id', 'metric', 'from', 'to'],
    bindings.map((b) => ({
      binding_id: b.bindingId,
      point_code: b.pointCode,
      instrument_id: b.instrumentId,
      metric: b.metric,
      from: isoLocal(b.from),
      to: b.to === null ? '' : isoLocal(b.to),
    })),
  );
  const calibrationCsv = serializeCsv(
    [
      'calibration_id',
      'instrument_id',
      'effective_at',
      'scale',
      'offset',
      'coefficient_uncertainty',
      'operator',
      'certificate',
      'note',
    ],
    calibrations.map((c) => ({
      calibration_id: c.calibrationId,
      instrument_id: c.instrumentId,
      effective_at: isoLocal(c.effectiveAt),
      scale: c.scale,
      offset: c.offset,
      coefficient_uncertainty: c.coefficientUncertainty,
      operator: c.operator,
      certificate: c.certificate,
      note: c.note,
    })),
  );
  const stateCsv = serializeCsv(
    ['state_id', 'instrument_id', 'state', 'from', 'to', 'reason', 'work_order'],
    states.map((s) => ({
      state_id: s.stateId,
      instrument_id: s.instrumentId,
      state: s.state,
      from: isoLocal(s.from),
      to: s.to === null ? '' : isoLocal(s.to),
      reason: s.reason,
      work_order: s.workOrder,
    })),
  );

  const registers: { name: string; text: string; kind: SampleManifest['baseFiles'][number]['kind']; note: string }[] = [
    { name: 'plants.csv', text: plantCsv, kind: 'PLANT_REGISTER', note: '厂站与排放限值台账' },
    { name: 'points.csv', text: pointCsv, kind: 'POINT_REGISTER', note: '排口点位实体（含编号复用标记）' },
    { name: 'instruments.csv', text: instrumentCsv, kind: 'INSTRUMENT_REGISTER', note: '仪表实例台账（含时钟偏移）' },
    { name: 'bindings.csv', text: bindingCsv, kind: 'BINDING_REGISTER', note: '仪表—点位—指标绑定有效期' },
    { name: 'calibrations.csv', text: calibrationCsv, kind: 'CALIBRATION_REGISTER', note: '校准系数与生效时刻' },
    { name: 'states.csv', text: stateCsv, kind: 'STATE_LOG', note: '冲洗/校准/旁路/故障状态台账' },
  ];
  for (const reg of registers) {
    writeFileSync(resolve(outDir, reg.name), reg.text, 'utf8');
    manifestBase.push({
      fileName: reg.name,
      kind: reg.kind,
      receivedAt: isoLocal(at(0) + 30 * HOUR + 10 * MIN),
      rowCount: reg.text.trim().split('\n').length - 1,
      sha256: sha256(reg.text),
      note: reg.note,
    });
  }

  const generated = profiles.map(generatePoint);
  for (const g of generated) {
    const text = serializeCsv(
      [
        'reading_id',
        'point_code',
        'plant_id',
        'instrument_id',
        'metric',
        'sampled_at',
        'received_at',
        'raw_value',
        'quality_flag',
      ],
      g.readings.map((r) => ({
        reading_id: r.readingId,
        point_code: r.pointCode,
        plant_id: r.plantId,
        instrument_id: r.instrumentId,
        metric: r.metric,
        sampled_at: isoLocal(r.sampledAt, true),
        received_at: isoLocal(r.receivedAt),
        raw_value: r.rawValue,
        quality_flag: r.qualityFlag,
      })),
    );
    writeFileSync(resolve(outDir, g.fileName), text, 'utf8');
    manifestBase.push({
      fileName: g.fileName,
      kind: 'READINGS',
      receivedAt: isoLocal(g.receivedAt),
      rowCount: g.rowCount,
      sha256: sha256(text),
      note: `${g.pointCode} 2026-11-18 原始读数（${g.readings.length} 行，含三指标）`,
    });
  }

  const lateReadings = generateLate();
  const lateFileName = 'late_CC-E01_2026-11-19.csv';
  const lateText = serializeCsv(
    [
      'reading_id',
      'point_code',
      'plant_id',
      'instrument_id',
      'metric',
      'sampled_at',
      'received_at',
      'raw_value',
      'quality_flag',
    ],
    lateReadings.map((r) => ({
      reading_id: r.readingId,
      point_code: r.pointCode,
      plant_id: r.plantId,
      instrument_id: r.instrumentId,
      metric: r.metric,
      sampled_at: isoLocal(r.sampledAt, true),
      received_at: isoLocal(r.receivedAt),
      raw_value: r.rawValue,
      quality_flag: r.qualityFlag,
    })),
  );
  writeFileSync(resolve(outDir, lateFileName), lateText, 'utf8');

  // ---- 工艺段平衡分析资料 ----
  const balance = generateBalanceFiles();
  const manifestBalance: NonNullable<SampleManifest['balanceFiles']> = [];
  for (const f of balance.files) {
    writeFileSync(resolve(outDir, f.fileName), f.text, 'utf8');
    manifestBalance.push({
      fileName: f.fileName,
      kind: f.kind,
      receivedAt: isoLocal(f.receivedAt),
      rowCount: f.text.trim().split('\n').length - 1,
      sha256: sha256(f.text),
      note: f.note,
    });
  }
  writeFileSync(resolve(outDir, balance.lateFile.fileName), balance.lateFile.text, 'utf8');
  const manifestLateBalance: NonNullable<SampleManifest['lateBalanceFile']> = {
    fileName: balance.lateFile.fileName,
    kind: balance.lateFile.kind,
    receivedAt: isoLocal(balance.lateFile.receivedAt),
    rowCount: balance.lateFile.text.trim().split('\n').length - 1,
    sha256: sha256(balance.lateFile.text),
    note: balance.lateFile.note,
  };

  const manifest: SampleManifest = {
    name: '排口负荷离线复核样例（虚构）',
    description:
      '2026-11-18 澄川水务三个厂站、四个排口的接入资料。CC-E01 含 40 秒高浓度冲击、13:00 校准中途生效、02:00–02:03 三分钟缺测、04:00 探头更换与 20:00 旁路；迟到补录在申报后到达。',
    generatedAt: new Date(Date.UTC(2026, 10, 20, 1, 0, 0)).toISOString(),
    timezone: 'Asia/Shanghai',
    baseFiles: manifestBase,
    lateFile: {
      fileName: lateFileName,
      kind: 'LATE_BATCH',
      receivedAt: isoLocal(LATE_RECEIVED),
      rowCount: lateReadings.length,
      sha256: sha256(lateText),
      note: '迟到补录：CC-E01 02:00–02:03 缺测段的 10 秒读数，申报出具后才到达。',
    },
    balanceFiles: manifestBalance,
    lateBalanceFile: manifestLateBalance,
    balanceFocus: {
      plantId: 'P1',
      day: DAY,
      scenario: [
        '反冲洗水混入主线：14:00–15:20 回流水 600 m³ 在进水计量点上游汇入，基础批次缺测，补传后残差缩窄',
        '池内存量变化：生化池 08:00–12:00 蓄水 0.4 m（+800 m³），净 ΔV +100 m³',
        '水力滞后：22:30 进水升高的可达时间带为次日 01:00–02:50，保持在途不强行配对',
        '回流泵切换：11:00 P-R1 由 S-RET-A 切至 S-RET-B，内部循环从主线拆出',
        '仪表误差叠加：各表偏差均在证书 k=2 区间内，路径 B 在证书边界内协调定位',
        '停用支路：S-BYP 2026-11-20 起停用（2026-11-22 确认），不改写 11-18 平衡',
      ],
    },
    focus: {
      pointCode: 'CC-E01',
      day: DAY,
      declarationCutoff: isoLocal(at(0) + 31 * HOUR + 20 * MIN),
      scenario: [
        '40 秒高浓度冲击：09:15:00–09:15:40，边界读数等于限值，内部 140/145/132 mg/L',
        '校准中途生效：13:00:00，切开片段，前后系数分别为 1.00/0.00 与 1.08/-1.20',
        '三分钟缺测：02:00–02:03，负荷与覆盖率均扣除，缺口影响单独量化',
        '设备交接：04:00 COD 探头整机更换，点位编号复用按实例衔接',
        '排除时段：01:00–01:08 冲洗、20:00–20:04 旁路，均不并入排放',
        '迟到补录：16:40 到达的 02:00–02:03 读数，只能形成锁定来源范围的重算候选',
      ],
    },
  };
  writeFileSync(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const totalRows = manifestBase.filter((f) => f.kind === 'READINGS').reduce((a, f) => a + f.rowCount, 0);
  const balanceRows = manifestBalance.reduce((a, f) => a + f.rowCount, 0);
  console.log(`样例已生成：${outDir}`);
  console.log(`读数 ${totalRows} 行；迟到补录 ${lateReadings.length} 行；台账 ${registers.length} 份`);
  console.log(`平衡分析资料 ${manifestBalance.length} 份 / ${balanceRows} 行；补传流量 ${manifestLateBalance.rowCount} 行`);
}

main();
