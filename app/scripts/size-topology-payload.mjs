#!/usr/bin/env node
/*
 * How large a topology payload is, at the candidate caps, from the 32h recordings.
 *
 *   cd app && node scripts/size-topology-payload.mjs [--record]
 *
 * Named `size-` rather than `measure-` because it never talks to a warehouse. The
 * `measure-*` census requires `refuseUnlessNamedForItsEstate` of scripts that write
 * into `runtime-baseline/`. This one only reads those recordings.
 *
 * Offline. It reads the two committed 32h recordings and writes nothing unless `--record`.
 * `--record` writes `scripts/recordings/topology-payload.json`, which 101b quotes.
 *
 * 32h counted edges. 101b has to decide a cap, and a cap decided from "7.0 MiB at 169 bytes"
 * is an estimate with a stated basis, not a reading of the shape this row is about to ship.
 * This script serialises the model 101b declares and measures the bytes.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const recordings = join(here, 'recordings');
const baseline = join(here, '..', 'server', 'collect', 'sql', 'runtime-baseline');

/** Relations 101b draws. The three 32h probes that are not here are decided, not forgotten. */
export const DRAWN = [
  'table-to-table',
  'job-to-table',
  'pipeline-to-table',
  'job-to-cluster',
  'job-to-warehouse',
  'warehouse-to-table',
  'job-to-job',
];

/** 32h read these and 101b declines them. */
export const DECLINED = {
  'pipeline-to-cluster': 'one cluster per update — an event log, not a relation',
  'cluster-to-table': 'zero edges on both estates; the join does not carry cluster',
  'bill-derived-pairs': "32i's rule declines an edge drawn from a bill",
};

const CAPS = [250, 500, 1000, 2000, 5000, 10000];

/**
 * @param {string} name
 * @returns {{ profile: string, lookbackDays: number, probes: readonly { id: string, source: string, from: string, to: string, reading: { edges: number, from_ends: number, to_ends: number } }[] }}
 */
function loadEstate(name) {
  return JSON.parse(readFileSync(join(baseline, `${name}-topology-sources.json`), 'utf8'));
}

function sampleEdge(relation, sourceKind, targetKind, joinedBy, index) {
  return {
    id: `${relation}:${index}`,
    source: `${sourceKind}:${index}`,
    target: `${targetKind}:${index + 1}`,
    relation,
    joinedBy,
    lastSeen: '2026-08-16',
  };
}

function sampleNode(kind, index) {
  return {
    id: `${kind}:${index}`,
    kind,
    label: `${kind}-${index}`,
  };
}

function bytesOf(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function drawnProbes(estate) {
  return estate.probes.filter((probe) => DRAWN.includes(probe.id));
}

function declinedProbes(estate) {
  return estate.probes
    .filter((probe) => probe.id in DECLINED)
    .map((probe) => ({
      id: probe.id,
      edges: probe.reading.edges,
      why: DECLINED[probe.id],
    }));
}

function estateReading(estate) {
  const drawn = drawnProbes(estate);
  const edges = drawn.reduce((sum, probe) => sum + probe.reading.edges, 0);
  const byRelation = Object.fromEntries(
    drawn.map((probe) => [
      probe.id,
      {
        edges: probe.reading.edges,
        from_ends: probe.reading.from_ends,
        to_ends: probe.reading.to_ends,
        source: probe.source,
      },
    ]),
  );
  const largest = drawn.reduce(
    (max, probe) => (probe.reading.edges > max.edges ? { id: probe.id, edges: probe.reading.edges } : max),
    { id: '', edges: 0 },
  );
  return {
    profile: estate.profile,
    lookbackDays: estate.lookbackDays,
    drawnEdges: edges,
    largestRelation: largest,
    byRelation,
    declined: declinedProbes(estate),
  };
}

function payloadAt(drawn, cap) {
  const taken = [];
  let remaining = cap;
  for (const probe of drawn) {
    const n = Math.min(probe.reading.edges, remaining);
    for (let i = 0; i < n; i += 1) {
      taken.push(sampleEdge(probe.id, probe.from, probe.to, probe.source, i));
    }
    remaining -= n;
    if (remaining === 0) break;
  }
  const nodeIds = new Map();
  for (const edge of taken) {
    nodeIds.set(edge.source, edge.source.split(':')[0]);
    nodeIds.set(edge.target, edge.target.split(':')[0]);
  }
  const nodes = [...nodeIds.entries()].map(([, kind], index) => sampleNode(kind, index));
  const body = {
    nodes,
    edges: taken,
    cap,
    truncated: drawn.reduce((sum, probe) => sum + probe.reading.edges, 0) > cap,
  };
  return {
    edges: taken.length,
    nodes: nodes.length,
    bytes: bytesOf(body),
    bytesPerEdge: taken.length === 0 ? 0 : bytesOf(body) / taken.length,
  };
}

function allCaps(estate) {
  const drawn = drawnProbes(estate);
  const uncapped = payloadAt(drawn, Number.POSITIVE_INFINITY);
  const at = Object.fromEntries(CAPS.map((cap) => [String(cap), payloadAt(drawn, cap)]));
  return { uncapped, at };
}

function reportOf() {
  const fieldeng = loadEstate('large-estate');
  const labs = loadEstate('labs');
  return {
    what: 'Serialised topology payload size at the candidate caps, from the 32h recordings.',
    takenAt: new Date().toISOString(),
    shape:
      'Each edge is id, source, target, relation, joinedBy, lastSeen. Each node is id, kind, label. The body also carries cap and truncated.',
    fieldeng: { ...estateReading(fieldeng), payload: allCaps(fieldeng) },
    labs: { ...estateReading(labs), payload: allCaps(labs) },
  };
}

const invoked = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1];

if (invoked) {
  const report = reportOf();
  if (process.argv.includes('--record')) {
    writeFileSync(join(recordings, 'topology-payload.json'), `${JSON.stringify(report, null, 2)}\n`);
  }

  const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
  const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  const size = (bytes) => (bytes >= 1024 * 1024 ? mib(bytes) : kib(bytes));

  process.stdout.write(
    `fieldeng drawn ${report.fieldeng.drawnEdges} → uncapped ${size(report.fieldeng.payload.uncapped.bytes)}\n` +
      `labs drawn ${report.labs.drawnEdges} → uncapped ${size(report.labs.payload.uncapped.bytes)}\n` +
      CAPS.map((cap) => {
        const reading = report.fieldeng.payload.at[String(cap)];
        return `  cap ${cap}: ${reading.edges} edges, ${reading.nodes} nodes, ${size(reading.bytes)}`;
      }).join('\n') +
      '\n',
  );
}
