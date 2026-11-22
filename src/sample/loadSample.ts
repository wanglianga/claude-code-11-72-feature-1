/**
 * 样例装载：从 /sample 拉取 CSV，在浏览器内计算 SHA-256 指纹，写入 IndexedDB。
 * 迟到的补录文件单独提供导入入口（“申报后到达”），不会在首次装载时并入。
 */

import { sha256Hex } from './csv';
import { datasetCounts, mergeDataset, parseBindings, parseCalibrations, parseInstruments, parsePlants, parsePoints, parseReadings, parseStates } from './ingest';
import {
  mergeBalanceData,
  parseBoundaryStreams,
  parseLevelLog,
  parseMeterSpecs,
  parseProcessLog,
  parseProcessUnits,
  parsePumpSwitches,
  parseRemovalParams,
  parseStreamReadings,
} from './ingestBalance';
import type { Dataset, SampleManifest } from '../domain/types';
import { emptyBalanceData, type BalanceData } from '../domain/balance/types';
import { markSampleImported, putBalanceBatch, putBatch, putStreamReadingsInChunks } from '../db/db';

export interface LoadProgress {
  step: string;
  done: number;
  total: number;
}

export async function fetchSampleManifest(): Promise<SampleManifest> {
  const res = await fetch('/sample/manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`无法读取样例清单（HTTP ${res.status}）`);
  return (await res.json()) as SampleManifest;
}

async function fetchText(fileName: string): Promise<{ text: string; size: number }> {
  const res = await fetch(`/sample/${encodeURIComponent(fileName)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`无法读取 ${fileName}（HTTP ${res.status}）`);
  const text = await res.text();
  return { text, size: new TextEncoder().encode(text).byteLength };
}

export interface LoadedSample {
  dataset: Dataset;
  balance: BalanceData;
  manifest: SampleManifest;
  fingerprintMatches: { fileName: string; expected: string; actual: string; ok: boolean }[];
  warnings: string[];
}

/**
 * 装载样例基础资料（不含迟到批次与补传流量）。
 * 指纹以浏览器计算的 SHA-256 为准，与 manifest 对照，不一致时给出警告而不是静默通过。
 */
export async function loadSampleBase(
  onProgress: (p: LoadProgress) => void,
  ingestedBy = '离线分析台',
): Promise<LoadedSample> {
  const manifest = await fetchSampleManifest();
  const files = manifest.baseFiles;
  const balanceFiles = manifest.balanceFiles ?? [];
  let done = 0;
  const total = files.length + balanceFiles.length + 1;
  const warnings: string[] = [];
  const fingerprintMatches: LoadedSample['fingerprintMatches'] = [];

  let dataset: Dataset = {
    plants: [],
    points: [],
    instruments: [],
    calibrations: [],
    states: [],
    bindings: [],
    readings: [],
    files: [],
  };
  let balance: BalanceData = emptyBalanceData();

  const texts = new Map<string, { text: string; size: number; sha: string; kind: string; receivedAt: string; note: string; rowCount: number }>();
  for (const meta of [...files, ...balanceFiles]) {
    onProgress({ step: `读取 ${meta.fileName}`, done, total });
    const { text, size } = await fetchText(meta.fileName);
    const sha = await sha256Hex(text);
    texts.set(meta.fileName, { text, size, sha, kind: meta.kind, receivedAt: meta.receivedAt, note: meta.note, rowCount: meta.rowCount });
    const ok = sha === meta.sha256;
    fingerprintMatches.push({ fileName: meta.fileName, expected: meta.sha256, actual: sha, ok });
    if (!ok) warnings.push(`${meta.fileName} 指纹与清单不一致（清单 ${meta.sha256.slice(0, 12)}…，实际 ${sha.slice(0, 12)}…）`);
    done += 1;
  }

  const now = Date.now();

  // 台账先行：读数解析依赖仪表与绑定
  for (const meta of files) {
    const entry = texts.get(meta.fileName)!;
    const fileId = `file:${meta.fileName}:${entry.sha.slice(0, 16)}`;
    const baseFile = {
      fileId,
      fileName: meta.fileName,
      sha256: entry.sha,
      sizeBytes: entry.size,
      kind: meta.kind,
      receivedAt: Date.parse(meta.receivedAt),
      rowCount: meta.rowCount,
      acceptedRows: meta.rowCount,
      rejectedRows: 0,
      rejectedReasons: [] as string[],
      note: meta.note,
      ingestedAt: now,
      ingestedBy,
      sample: true,
    };
    if (meta.kind === 'PLANT_REGISTER') {
      const parsed = parsePlants(entry.text, fileId);
      dataset = mergeDataset(dataset, { plants: parsed.plants, files: [{ ...baseFile, rejectedRows: parsed.errors.length, rejectedReasons: parsed.errors }] });
    } else if (meta.kind === 'POINT_REGISTER') {
      const parsed = parsePoints(entry.text);
      dataset = mergeDataset(dataset, { points: parsed.points, files: [{ ...baseFile, rejectedRows: parsed.errors.length, rejectedReasons: parsed.errors }] });
    } else if (meta.kind === 'INSTRUMENT_REGISTER') {
      const parsed = parseInstruments(entry.text);
      dataset = mergeDataset(dataset, { instruments: parsed.instruments, files: [{ ...baseFile, rejectedRows: parsed.errors.length, rejectedReasons: parsed.errors }] });
    } else if (meta.kind === 'BINDING_REGISTER') {
      const parsed = parseBindings(entry.text);
      dataset = mergeDataset(dataset, { bindings: parsed.bindings, files: [{ ...baseFile, rejectedRows: parsed.errors.length, rejectedReasons: parsed.errors }] });
    } else if (meta.kind === 'CALIBRATION_REGISTER') {
      const parsed = parseCalibrations(entry.text);
      dataset = mergeDataset(dataset, { calibrations: parsed.calibrations, files: [{ ...baseFile, rejectedRows: parsed.errors.length, rejectedReasons: parsed.errors }] });
    } else if (meta.kind === 'STATE_LOG') {
      const parsed = parseStates(entry.text);
      dataset = mergeDataset(dataset, { states: parsed.states, files: [{ ...baseFile, rejectedRows: parsed.errors.length, rejectedReasons: parsed.errors }] });
    }
  }

  for (const meta of files.filter((f) => f.kind === 'READINGS')) {
    const entry = texts.get(meta.fileName)!;
    const fileId = `file:${meta.fileName}:${entry.sha.slice(0, 16)}`;
    const received = Date.parse(meta.receivedAt);
    const parsed = parseReadings(
      entry.text,
      { fileId, kind: meta.kind, receivedAt: received },
      dataset.instruments,
      dataset.bindings,
    );
    const acceptedRows = parsed.readings.length;
    const file = {
      fileId,
      fileName: meta.fileName,
      sha256: entry.sha,
      sizeBytes: entry.size,
      kind: meta.kind,
      receivedAt: received,
      rowCount: meta.rowCount,
      acceptedRows,
      rejectedRows: parsed.rejected,
      rejectedReasons: parsed.errors.slice(0, 20),
      note: meta.note,
      ingestedAt: now,
      ingestedBy,
      sample: true,
    };
    dataset = mergeDataset(dataset, { readings: parsed.readings, files: [file] });
    done += 1;
    onProgress({ step: `解析 ${meta.fileName}`, done, total });
  }

  // ---- 工艺段平衡分析资料 ----
  const balanceFilesParsed: Dataset['files'] = [];
  for (const meta of balanceFiles) {
    const entry = texts.get(meta.fileName)!;
    const fileId = `file:${meta.fileName}:${entry.sha.slice(0, 16)}`;
    const received = Date.parse(meta.receivedAt);
    let rejected = 0;
    const rejectedReasons: string[] = [];
    if (meta.kind === 'PROCESS_UNIT_REGISTER') {
      const p = parseProcessUnits(entry.text);
      balance = mergeBalanceData(balance, { units: p.units });
      rejectedReasons.push(...p.errors);
    } else if (meta.kind === 'BOUNDARY_STREAM_REGISTER') {
      const p = parseBoundaryStreams(entry.text);
      balance = mergeBalanceData(balance, { streams: p.streams });
      rejectedReasons.push(...p.errors);
    } else if (meta.kind === 'METER_SPEC_REGISTER') {
      const p = parseMeterSpecs(entry.text);
      balance = mergeBalanceData(balance, { meters: p.meters });
      rejectedReasons.push(...p.errors);
    } else if (meta.kind === 'REMOVAL_PARAM_REGISTER') {
      const p = parseRemovalParams(entry.text);
      balance = mergeBalanceData(balance, { removalParams: p.params });
      rejectedReasons.push(...p.errors);
    } else if (meta.kind === 'PUMP_SWITCH_LOG') {
      const p = parsePumpSwitches(entry.text);
      balance = mergeBalanceData(balance, { pumpSwitches: p.switches });
      rejectedReasons.push(...p.errors);
    } else if (meta.kind === 'LEVEL_LOG') {
      const p = parseLevelLog(entry.text, fileId, received);
      balance = mergeBalanceData(balance, { levels: p.levels });
      rejectedReasons.push(...p.errors);
    } else if (meta.kind === 'PROCESS_LOG') {
      const p = parseProcessLog(entry.text, fileId);
      balance = mergeBalanceData(balance, { processRecords: p.records });
      rejectedReasons.push(...p.errors);
    } else if (meta.kind === 'STREAM_READINGS') {
      const p = parseStreamReadings(entry.text, { fileId, kind: meta.kind, receivedAt: received }, balance.meters, balance.streams);
      balance = mergeBalanceData(balance, { readings: p.readings });
      rejected = p.rejected;
      rejectedReasons.push(...p.errors.slice(0, 20));
    }
    rejected = rejected || rejectedReasons.length;
    balanceFilesParsed.push({
      fileId,
      fileName: meta.fileName,
      sha256: entry.sha,
      sizeBytes: entry.size,
      kind: meta.kind,
      receivedAt: received,
      rowCount: meta.rowCount,
      acceptedRows: meta.rowCount - rejected,
      rejectedRows: rejected,
      rejectedReasons,
      note: meta.note,
      ingestedAt: now,
      ingestedBy,
      sample: true,
    });
    done += 1;
    onProgress({ step: `解析 ${meta.fileName}`, done, total });
  }
  dataset = mergeDataset(dataset, { files: balanceFilesParsed });

  const counts = datasetCounts(dataset);
  onProgress({ step: `写入 IndexedDB（${counts.readings + balance.readings.length} 条读数）`, done, total });
  await putBatch({
    files: dataset.files,
    plants: dataset.plants,
    points: dataset.points,
    instruments: dataset.instruments,
    calibrations: dataset.calibrations,
    states: dataset.states,
    bindings: dataset.bindings,
  });
  const { putReadingsInChunks } = await import('../db/db');
  await putReadingsInChunks(dataset.readings);
  await putBalanceBatch({
    units: balance.units,
    streams: balance.streams,
    meters: balance.meters,
    levels: balance.levels,
    processRecords: balance.processRecords,
    pumpSwitches: balance.pumpSwitches,
    removalParams: balance.removalParams,
  });
  await putStreamReadingsInChunks(balance.readings);
  await markSampleImported(true);
  onProgress({ step: '完成', done: total, total });
  return { dataset, balance, manifest, fingerprintMatches, warnings };
}

export interface LateImportResult {
  dataset: Dataset;
  readingsAdded: number;
  filesAdded: string[];
  fingerprint: { expected: string; actual: string; ok: boolean };
}

/** 导入迟到补录文件（申报后到达） */
export async function importLateBatch(base: Dataset, manifest: SampleManifest, ingestedBy = '复核员'): Promise<LateImportResult> {
  const meta = manifest.lateFile;
  const entry = await fetchText(meta.fileName);
  const sha = await sha256Hex(entry.text);
  const ok = sha === meta.sha256;
  const fileId = `file:${meta.fileName}:${sha.slice(0, 16)}`;
  const received = Date.parse(meta.receivedAt);
  const parsed = parseReadings(
    entry.text,
    { fileId, kind: meta.kind, receivedAt: received },
    base.instruments,
    base.bindings,
    { lateMode: true },
  );
  const file = {
    fileId,
    fileName: meta.fileName,
    sha256: sha,
    sizeBytes: entry.size,
    kind: meta.kind,
    receivedAt: received,
    rowCount: meta.rowCount,
    acceptedRows: parsed.readings.length,
    rejectedRows: parsed.rejected,
    rejectedReasons: parsed.errors.slice(0, 20),
    note: meta.note,
    ingestedAt: Date.now(),
    ingestedBy,
    sample: true,
  };
  const dataset = mergeDataset(base, { readings: parsed.readings, files: [file] });
  await putBatch({ files: [file] });
  const { putReadingsInChunks } = await import('../db/db');
  await putReadingsInChunks(parsed.readings);
  return {
    dataset,
    readingsAdded: parsed.readings.length,
    filesAdded: [fileId],
    fingerprint: { expected: meta.sha256, actual: sha, ok },
  };
}

export interface LateBalanceImportResult {
  balance: BalanceData;
  file: Dataset['files'][number];
  readingsAdded: number;
  fingerprint: { expected: string; actual: string; ok: boolean };
}

/** 导入补传流量（分析出具后到达；缩窄已审核残差时生成新分析版本） */
export async function importLateBalanceBatch(base: BalanceData, manifest: SampleManifest, ingestedBy = '复核员'): Promise<LateBalanceImportResult | null> {
  const meta = manifest.lateBalanceFile;
  if (!meta) return null;
  const entry = await fetchText(meta.fileName);
  const sha = await sha256Hex(entry.text);
  const ok = sha === meta.sha256;
  const fileId = `file:${meta.fileName}:${sha.slice(0, 16)}`;
  const received = Date.parse(meta.receivedAt);
  const parsed = parseStreamReadings(
    entry.text,
    { fileId, kind: meta.kind, receivedAt: received },
    base.meters,
    base.streams,
    { lateMode: true },
  );
  const file: Dataset['files'][number] = {
    fileId,
    fileName: meta.fileName,
    sha256: sha,
    sizeBytes: entry.size,
    kind: meta.kind,
    receivedAt: received,
    rowCount: meta.rowCount,
    acceptedRows: parsed.readings.length,
    rejectedRows: parsed.rejected,
    rejectedReasons: parsed.errors.slice(0, 20),
    note: meta.note,
    ingestedAt: Date.now(),
    ingestedBy,
    sample: true,
  };
  const balance = mergeBalanceData(base, { readings: parsed.readings });
  await putBatch({ files: [file] });
  await putStreamReadingsInChunks(parsed.readings);
  return {
    balance,
    file,
    readingsAdded: parsed.readings.length,
    fingerprint: { expected: meta.sha256, actual: sha, ok },
  };
}
