const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { setImmediate: nextTurn } = require('node:timers/promises');
const serverInfo = require('../src/ui/server-info.js');
const { parse, formatNetworkBytes, appendNetworkHistory, networkChartModel, appendResourceHistory, resourceChartModel,
  appendDiskHistory, diskChartModel, diskMetricChartModel, diskLatencyChartModel } = serverInfo;

const snapshot = fields => Object.entries({ version: '1', platform: 'Linux', ...fields, end: 'ok' })
  .map(([key, value]) => `\n__TERMLUME_INFO__${key}\n${value}\n`).join('');

test('Linux snapshot computes CPU deltas, available memory, swap and spaced mount points', () => {
  const info = parse(snapshot({
    os: 'PRETTY_NAME="Ubuntu 24.04 LTS"', architecture: 'aarch64', cpuCount: '4',
    cpuBefore: 'cpu 100 20 30 800 50 0 0 0 10 0',
    cpuAfter: 'cpu 120 20 40 860 60 0 0 0 20 0',
    memory: 'MemTotal: 1024 kB\nMemAvailable: 640 kB\nSwapTotal: 512 kB\nSwapFree: 128 kB',
    disks: '/dev/vda1 1000 300 650 32% /srv/my app\ntmpfs 100 20 80 20% /run',
    uptime: '12345.6 54321.0'
  }));
  assert.equal(info.os, 'Ubuntu 24.04 LTS');
  assert.equal(info.cpuPercent, 30);
  assert.equal(info.memory.percent, 37.5);
  assert.equal(info.swap.used, 384 * 1024);
  assert.equal(info.disks.length, 1);
  assert.equal(info.disks[0].mount, '/srv/my app');
  assert.equal(info.disks[0].percent, 32); // df capacity accounts for reserved blocks.
  assert.equal(info.uptime, 12345.6);
});

test('missing metrics stay unknown; older Linux and Darwin memory use explicit fallbacks', () => {
  const empty = parse(snapshot({}));
  assert.equal(empty.cpuPercent, undefined);
  assert.equal(empty.memory.percent, undefined);
  assert.equal(empty.uptime, undefined);
  assert.deepEqual(empty.disks, []);
  const old = parse(snapshot({ memory: 'MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 200 kB\nSReclaimable: 40 kB\nShmem: 10 kB' }));
  assert.equal(old.memory.available, 380 * 1024);
  const mac = parse(snapshot({ platform: 'Darwin', os: '15.0', memoryTotal: '1638400',
    memoryPages: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10.\nPages inactive: 20.',
    bootTime: '{ sec = 100, usec = 0 }', epoch: '200', load: '{ 1.5 2.0 3.0 }' }));
  assert.equal(mac.memory.percent, 70);
  assert.equal(mac.uptime, 100);
  assert.equal(mac.os, 'macOS 15.0');
  assert.equal(mac.load, '1.5 / 2.0 / 3.0');
  assert.throws(() => parse(snapshot({}).replace('__TERMLUME_INFO__end', 'truncated')), /不完整/);
});

const linuxNetwork = rows => rows.map(([name, rx, tx]) =>
  ` ${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`).join('\n');

test('network rates use remote elapsed time and exact 64-bit counter differences per interface', () => {
  const info = parse(snapshot({
    networkBeforeTime: '100.00 900.0', networkAfterTime: '101.25 905.0',
    networkBefore: linuxNetwork([['lo', 100, 100], ['eth0', '9007199254740993', '1000'], ['eth0:1', 0, 0]]),
    networkAfter: linuxNetwork([['lo', 500, 500], ['eth0', '9007199254743493', '1625'], ['eth0:1', 0, 0]])
  }));
  assert.equal(info.network.length, 2);
  assert.equal(info.network[0].name, 'eth0');
  assert.equal(info.network[0].downloadRate, 2000);
  assert.equal(info.network[0].uploadRate, 500);
  assert.equal(info.network[0].sent, 1625);
  assert.equal(info.network[1].name, 'eth0:1');
  assert.equal(info.network[1].downloadRate, 0);
});

test('reset counters, new interfaces, missing timestamps and unavailable data never invent a rate', () => {
  const fields = {
    networkBeforeTime: '20', networkAfterTime: '21',
    networkBefore: linuxNetwork([['eth0', 9000, 1000]]),
    networkAfter: linuxNetwork([['eth0', 100, 2000], ['ens2', 700, 800]])
  };
  const info = parse(snapshot(fields));
  assert.equal(info.network[0].downloadRate, undefined);
  assert.equal(info.network[0].uploadRate, 1000);
  assert.equal(info.network[0].received, 100);
  assert.equal(info.network[1].downloadRate, undefined);
  for (const clock of [{ networkAfterTime: '19' }, { networkAfterTime: '20' }, { networkBeforeTime: '' }]) {
    assert.equal(parse(snapshot({ ...fields, ...clock })).network[0].uploadRate, undefined);
  }
  assert.deepEqual(parse(snapshot({})).network, []);
  assert.deepEqual(parse(snapshot({ networkAfter: 'garbled bytes' })).network, []);
  assert.deepEqual(parse(snapshot({ networkAfter: linuxNetwork([['eth0', '18446744073709551616', 0]]) })).network, []);
});

test('Darwin link rows are counted once using named byte columns, excluding address rows and loopback', () => {
  const header = 'Name Mtu Network Address Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll';
  const info = parse(snapshot({ platform: 'Darwin', networkBeforeTime: '50', networkAfterTime: '52',
    networkBefore: `${header}\nen0 1500 <Link#6> aa:bb:cc:dd:ee:ff 1 0 1000 1 0 2000 0\nutun0 1380 <Link#9> 1 0 100 1 0 200 0`,
    networkAfter: `${header}\nlo0 16384 <Link#1> lo0 1 0 500 1 0 500 0\nen0 1500 <Link#6> aa:bb:cc:dd:ee:ff 2 0 5000 2 0 4000 0\nen0 1500 192.0.2 192.0.2.1 2 - 5000 2 - 4000 -\nutun0 1380 <Link#9> 2 0 700 2 0 600 0`
  }));
  assert.equal(info.network.length, 2);
  assert.equal(info.network[0].downloadRate, 2000);
  assert.equal(info.network[0].uploadRate, 1000);
  assert.equal(info.network[0].received, 5000);
  assert.equal(info.network[1].name, 'utun0');
  assert.equal(info.network[1].downloadRate, 300);
  assert.equal(info.network[1].uploadRate, 200);
  assert.deepEqual(parse(snapshot({ platform: 'Darwin', networkAfter: 'Name Ipkts Opkts\nen0 100 200' })).network, []);
});

test('network units distinguish missing data from zero and scale rates and traffic totals', () => {
  assert.equal(formatNetworkBytes(undefined, true), '暂不可用');
  assert.equal(formatNetworkBytes(0, true), '0 B/s');
  assert.equal(formatNetworkBytes(1 / 2, true), '0.5 B/s');
  assert.equal(formatNetworkBytes(2 * 1024 ** 2, true), '2.0 MiB/s');
  assert.equal(formatNetworkBytes(1.5 * 1024 ** 4), '1.5 TiB');
});

test('default-route interfaces are shown first without dropping or aggregating virtual interfaces', () => {
  const fields = { networkDefault: 'eth0\neth1',
    networkAfter: linuxNetwork([['veth0', 100, 200], ['eth1', 500, 600], ['eth0', 300, 400], ['docker0', 700, 800]]) };
  const interfaces = parse(snapshot(fields)).network;
  assert.deepEqual(interfaces.map(entry => entry.name), ['eth0', 'eth1', 'veth0', 'docker0']);
  assert.equal(interfaces[0].received, 300);
  assert.deepEqual(parse(snapshot({ ...fields, networkDefault: 'missing' })).network.map(entry => entry.name),
    ['veth0', 'eth1', 'eth0', 'docker0']);
});

const rates = (down, up, name = 'eth0') => [{ name, downloadRate: down, uploadRate: up }];

test('Linux disk IO uses fixed 512-byte sectors, exact counter deltas and independent device identities', () => {
  const info = parse(snapshot({ diskIoBeforeTime: '100.00 900', diskIoAfterTime: '101.25 905',
    diskIoBefore: 'nvme0n1 259:0:5 9007199254740993 1000\nvda 252:0:2 10 20',
    diskIoAfter: 'nvme0n1 259:0:5 9007199254740998 1010\nvda 252:0:2 10 20' }));
  assert.equal(info.diskIo.length, 2);
  assert.deepEqual(info.diskIo[0], { name: 'nvme0n1', identity: '259:0:5', readRate: 2048, writeRate: 4096,
    iops: undefined, utilization: undefined, readLatency: undefined, writeLatency: undefined, queueLength: undefined });
  assert.equal(info.diskIo[1].readRate, 0);
  assert.equal(info.diskIo[1].writeRate, 0);
});

test('disk IO treats resets, hotplug, absent clocks and malformed counters as unavailable', () => {
  const fields = { diskIoBeforeTime: '20', diskIoAfterTime: '21',
    diskIoBefore: 'vda 252:0:2 500 1000\nvme0n1 259:0:5 10 20',
    diskIoAfter: 'vda 252:0:2 100 1100\nvme0n1 259:0:6 30 40\nvdb 252:16:- 100 200' };
  const devices = parse(snapshot(fields)).diskIo;
  assert.equal(devices[0].readRate, undefined);
  assert.equal(devices[0].writeRate, 51200);
  assert.equal(devices[1].readRate, undefined);
  assert.equal(devices[2].writeRate, undefined);
  for (const clock of [{ diskIoBeforeTime: '' }, { diskIoAfterTime: '20' }, { diskIoAfterTime: '19' }]) {
    assert.equal(parse(snapshot({ ...fields, ...clock })).diskIo[0].writeRate, undefined);
  }
  assert.deepEqual(parse(snapshot({})).diskIo, []);
  assert.deepEqual(parse(snapshot({ diskIoAfter: 'sda 8:0:- 18446744073709551616 1\nsdb 8:16:- -1 0\ngarbled' })).diskIo, []);
});

const macDisk = (id, name, read, written) => `+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id ${id}, registered>\n` +
  `  | "Statistics" = {"Bytes (Write)"=${written},"Operations (Read)"=3,"Bytes (Read)"=${read}}\n` +
  `  | "BSD Name" = "${name}"\n  | "BSD Name" = "${name}s1"\n`;

test('Darwin disk IO pairs whole disk names with driver byte counters without counting partitions', () => {
  const info = parse(snapshot({ platform: 'Darwin', diskIoBeforeTime: '50', diskIoAfterTime: '52',
    diskIoBefore: macDisk('0x1', 'disk0', '9007199254740993', 1000) + macDisk('0x2', 'disk2', 10, 20),
    diskIoAfter: macDisk('0x1', 'disk0', '9007199254741493', 2000) + macDisk('0x3', 'disk2', 30, 40) +
      macDisk('0x4', 'disk4s1', 10, 20) }));
  assert.equal(info.diskIo.length, 2);
  assert.equal(info.diskIo[0].name, 'disk0');
  assert.equal(info.diskIo[0].readRate, 250);
  assert.equal(info.diskIo[0].writeRate, 500);
  assert.equal(info.diskIo[1].writeRate, undefined);
  assert.deepEqual(parse(snapshot({ platform: 'Darwin', diskIoAfter: 'unavailable' })).diskIo, []);
});

test('Linux IOPS uses completed read/write deltas and utilization uses unweighted busy milliseconds', () => {
  const fields = { diskIoBeforeTime: '100', diskIoAfterTime: '101.25',
    diskIoBefore: 'vda 252:0:2 100 100 9007199254740993 200 10000',
    diskIoAfter: 'vda 252:0:2 101 102 9007199254741013 210 10500' };
  const device = parse(snapshot(fields)).diskIo[0];
  assert.equal(device.iops, 24);
  assert.equal(device.utilization, 40);
  assert.equal(device.readRate, 409.6);
  const capped = parse(snapshot({ ...fields, diskIoAfter: 'vda 252:0:2 101 102 9007199254741013 210 11260' })).diskIo[0];
  assert.equal(capped.utilization, 100);
  const idle = parse(snapshot({ ...fields, diskIoAfter: fields.diskIoBefore })).diskIo[0];
  assert.equal(idle.iops, 0);
  assert.equal(idle.utilization, 0);
});

test('missing, reset or replaced operation and busy counters stay unknown without dropping byte rates', () => {
  const fields = { diskIoBeforeTime: '1', diskIoAfterTime: '2',
    diskIoBefore: 'vda 252:0:2 100 100 100 200 300',
    diskIoAfter: 'vda 252:0:2 101 102 99 201 299' };
  const device = parse(snapshot(fields)).diskIo[0];
  assert.equal(device.iops, undefined);
  assert.equal(device.utilization, undefined);
  assert.equal(device.writeRate, 1024);
  for (const override of [
    { diskIoAfter: 'vda 252:0:3 101 102 110 210 400' },
    { diskIoAfter: 'vda 252:0:2 101 102 - 210 -' },
    { diskIoAfter: 'vda 252:0:2 101 102 18446744073709551616 210 18446744073709551616' },
    { diskIoAfterTime: '' }, { diskIoAfterTime: '1' }, { diskIoAfterTime: '0' }
  ]) {
    const unknown = parse(snapshot({ ...fields, ...override })).diskIo[0];
    assert.equal(unknown.iops, undefined);
    assert.equal(unknown.utilization, undefined);
  }
});

test('Darwin IOPS uses operation counts and does not mistake summed request durations for utilization', () => {
  const before = macDisk('0x1', 'disk0', 100, 200).replace('"Operations (Read)"=3',
    '"Operations (Read)"=9007199254740993,"Operations (Write)"=200,"Total Time (Read)"=1000000,"Total Time (Write)"=2000000');
  const after = macDisk('0x1', 'disk0', 200, 400).replace('"Operations (Read)"=3',
    '"Operations (Read)"=9007199254741003,"Operations (Write)"=205,"Total Time (Read)"=9000000000,"Total Time (Write)"=9000000000');
  const device = parse(snapshot({ platform: 'Darwin', diskIoBeforeTime: '1', diskIoAfterTime: '3',
    diskIoBefore: before, diskIoAfter: after })).diskIo[0];
  assert.equal(device.iops, 7.5);
  assert.equal(device.utilization, undefined);
  assert.equal(device.readRate, 50);
});

test('Linux average read/write latency uses completion deltas and queue length uses weighted milliseconds', () => {
  const fields = { diskIoBeforeTime: '100', diskIoAfterTime: '101.25',
    diskIoBefore: 'vda 252:0:2 100 100 9007199254740993 100 1000 9007199254740993 1000 10000',
    diskIoAfter: 'vda 252:0:2 101 102 9007199254741013 110 1500 9007199254741073 1025 12500' };
  const device = parse(snapshot(fields)).diskIo[0];
  assert.equal(device.readLatency, 4);
  assert.equal(device.writeLatency, 2.5);
  assert.equal(device.queueLength, 2); // More than one concurrent request is valid.
  assert.equal(device.utilization, 40);
  const fraction = parse(snapshot({ ...fields,
    diskIoAfter: 'vda 252:0:2 101 102 9007199254741013 110 1500 9007199254741073 1025 10001' })).diskIo[0];
  assert.equal(fraction.queueLength, .0008);
});

test('latency stays unknown without completions, resets and missing counters affect only their own metrics', () => {
  const fields = { diskIoBeforeTime: '1', diskIoAfterTime: '2',
    diskIoBefore: 'vda 252:0:2 100 100 10 20 100 30 40 200',
    diskIoAfter: 'vda 252:0:2 101 102 10 22 150 30 50 300' };
  let device = parse(snapshot(fields)).diskIo[0];
  assert.equal(device.readLatency, undefined);
  assert.equal(device.writeLatency, 5);
  assert.equal(device.queueLength, .1);
  device = parse(snapshot({ ...fields, diskIoAfter: 'vda 252:0:2 101 102 11 22 150 30 50 300' })).diskIo[0];
  assert.equal(device.readLatency, 0); // A completed request with zero measured ticks is distinct from no request.
  device = parse(snapshot({ ...fields, diskIoAfter: 'vda 252:0:2 101 102 11 22 150 29 50 199' })).diskIo[0];
  assert.equal(device.readLatency, undefined);
  assert.equal(device.writeLatency, 5);
  assert.equal(device.queueLength, undefined);
  assert.equal(device.writeRate, 1024);
  for (const override of [
    { diskIoAfter: 'vda 252:0:3 101 102 11 22 150 35 50 300' },
    { diskIoAfter: 'vda 252:0:2 101 102 11 22 150 - - -' },
    { diskIoAfterTime: '' }, { diskIoAfterTime: '1' }, { diskIoAfterTime: '0' }
  ]) {
    const unknown = parse(snapshot({ ...fields, ...override })).diskIo[0];
    assert.equal(unknown.readLatency, undefined);
    assert.equal(unknown.writeLatency, undefined);
    assert.equal(unknown.queueLength, undefined);
  }
});

test('Darwin request times convert nanoseconds to average milliseconds without inventing a queue length', () => {
  const before = macDisk('0x1', 'disk0', 100, 200).replace('"Operations (Read)"=3',
    '"Operations (Read)"=10,"Operations (Write)"=20,"Total Time (Read)"=100000000,"Total Time (Write)"=200000000');
  const after = macDisk('0x1', 'disk0', 200, 400).replace('"Operations (Read)"=3',
    '"Operations (Read)"=14,"Operations (Write)"=22,"Total Time (Read)"=112000000,"Total Time (Write)"=205000000');
  const device = parse(snapshot({ platform: 'Darwin', diskIoBeforeTime: '1', diskIoAfterTime: '3',
    diskIoBefore: before, diskIoAfter: after })).diskIo[0];
  assert.equal(device.readLatency, 3);
  assert.equal(device.writeLatency, 2.5);
  assert.equal(device.queueLength, undefined);
  assert.equal(device.utilization, undefined);
});

test('latency and queue charts preserve small values, independent gaps, replacement and five-minute expiry', () => {
  let history = [];
  for (const [at, readLatency, writeLatency, queueLength, identity, paused] of [
    [0, 0, .02, .01, 'a'], [5000, .04, .01, .02, 'a'], [10000, undefined, .02, undefined, 'a'],
    [15000, .03, .04, 2, 'a'], [20000, .02, .02, .5, 'b'], [25000, .02, .02, .5, 'b', true],
    [30000, -1, undefined, -1, 'b']
  ]) history = appendDiskHistory(history, [{ name: 'vda', identity, readLatency, writeLatency, queueLength }], at, paused);
  const latency = diskLatencyChartModel(history, 'vda', 30000);
  const queue = diskMetricChartModel(history, 'vda', 'queueLength', 30000);
  assert.equal(latency.maximum, .05);
  assert.equal(queue.maximum, 2);
  assert.equal(latency.read[0][0].value, 0);
  assert.deepEqual(latency.read.map(segment => segment.length), [2, 1, 1, 1]);
  assert.deepEqual(latency.write.map(segment => segment.length), [4, 1, 1]);
  assert.deepEqual(queue.series.map(segment => segment.length), [2, 1, 1, 1]);
  assert.equal(queue.count, 5);
  assert.equal(diskLatencyChartModel(history, 'vda', 330001).count, 0);
  assert.equal(diskMetricChartModel(history, 'vda', 'queueLength', 330001).count, 0);
});

test('IOPS and utilization curves share disk history but keep scales, missing values and pauses independent', () => {
  let history = [];
  for (const [at, iops, utilization, identity, paused] of [
    [0, 0, 0, 'a'], [5000, 2500, 80, 'a'], [10000, 3000, undefined, 'a'],
    [15000, 2000, 40, 'a'], [20000, 1000, 100, 'a', true], [25000, 500, 30, 'b'], [30000, -1, 101, 'b']
  ]) history = appendDiskHistory(history, [{ name: 'vda', identity, iops, utilization }], at, paused);
  const iops = diskMetricChartModel(history, 'vda', 'iops', 30000);
  const utilization = diskMetricChartModel(history, 'vda', 'utilization', 30000);
  assert.equal(iops.maximum, 5000);
  assert.equal(utilization.maximum, 100);
  assert.equal(iops.peak, 3000);
  assert.equal(iops.count, 6);
  assert.deepEqual(iops.series.map(segment => segment.length), [4, 1, 1]);
  assert.deepEqual(utilization.series.map(segment => segment.length), [2, 1, 1, 1]);
  assert.equal(utilization.series[0][0].value, 0);
  assert.equal(diskMetricChartModel(history, 'vda', 'iops', 330001).count, 0);
});

test('disk history keeps devices and directions independent, breaks on pauses and device replacement, and expires', () => {
  let history = [];
  const append = (at, readRate, writeRate, identity = '8:0:1', paused = false) => {
    history = appendDiskHistory(history, [{ name: 'sda', identity, readRate, writeRate },
      { name: 'sdb', identity: '8:16:2', readRate: 1024, writeRate: 2048 }], at, paused);
  };
  append(0, 0, 10); append(5000, 100, undefined); append(10000, 200, 50);
  append(15000, 300, 60, '8:0:1', true); append(20000, 400, 70, '8:0:3');
  const model = diskChartModel(history, 'sda', 20000);
  assert.deepEqual(model.read.map(segment => segment.length), [3, 1, 1]);
  assert.deepEqual(model.write.map(segment => segment.length), [1, 1, 1, 1]);
  assert.equal(model.read[0][0].value, 0);
  assert.equal(model.readPeak, 400);
  assert(model.maximum >= 400);
  assert.equal(diskChartModel(history, 'sdb', 20000).writePeak, 2048);
  assert.equal(diskChartModel(history, 'sda', 320001).count, 0);
  assert.equal(diskChartModel(history, 'missing', 20000).count, 0);
});

test('network history retains five minutes, coalesces manual samples and has a hard memory bound', () => {
  let history = [];
  for (let i = 0; i < 180; i++) history = appendNetworkHistory(history, rates(i, i / 2), i * 5000);
  assert.equal(history.length, 61);
  assert.equal(history.at(-1).at - history[0].at, 300000);
  const old = history;
  history = appendNetworkHistory(history, rates(900, 450), history.at(-1).at + 1000);
  assert.equal(history.length, 60);
  assert.equal(old.at(-1).values.eth0.downloadRate, 179);
  assert.equal(history.at(-1).values.eth0.downloadRate, 900);
  let rapid = [];
  for (let i = 0; i < 500; i++) rapid = appendNetworkHistory(rapid, rates(i, i), i, true);
  assert.equal(rapid.length, 121);
});

test('charts break at pauses, missing rates and delayed samples without inventing zero traffic', () => {
  let history = [];
  for (const [at, down, up, pause] of [
    [0, 100, 50], [5000, 200, 80], [10000, undefined, 90],
    [15000, 300, 100], [20000, 400, 110, true], [40000, 250, 90]
  ]) history = appendNetworkHistory(history, rates(down, up), at, pause);
  const chart = networkChartModel(history, 'eth0', 40000);
  assert.deepEqual(chart.download.map(segment => segment.length), [2, 1, 1, 1]);
  assert.deepEqual(chart.upload.map(segment => segment.length), [4, 1, 1]);
  assert.equal(chart.download.flat().some(point => point.at === 10000), false);
  assert.equal(chart.count, 6);
  assert.equal(chart.downloadPeak, 400);
  assert.equal(chart.uploadPeak, 110);
  assert(chart.maximum >= chart.downloadPeak);
});

test('charts keep interfaces independent, show known idle traffic and age out uncollected time', () => {
  const history = appendNetworkHistory([], [...rates(0, undefined), ...rates(2048, 512, 'eth1')], 10000);
  assert.equal(networkChartModel(history, 'eth0', 10000).downloadPeak, 0);
  assert.equal(networkChartModel(history, 'eth0', 10000).uploadPeak, undefined);
  assert.equal(networkChartModel(history, 'eth1', 10000).downloadPeak, 2048);
  assert.equal(networkChartModel(history, 'missing', 10000).count, 0);
  const expired = networkChartModel(history, 'eth1', 310001);
  assert.equal(expired.count, 0);
  assert.deepEqual(expired.download, []);
  assert.equal(history.length, 1);
});

test('reopening within a bucket still creates a new segment and backward clocks reset history', () => {
  let history = appendNetworkHistory([], rates(10, 20), 5100);
  history = appendNetworkHistory(history, rates(11, 21), 6100, true);
  assert.equal(networkChartModel(history, 'eth0', 6100).download.length, 2);
  history = appendNetworkHistory(history, rates(1, 2), 1000);
  assert.equal(history.length, 1);
  assert.equal(history[0].at, 1000);
  assert.equal(history[0].breakBefore, true);
});

test('CPU and memory curves use independent percentages on a fixed 0–100 scale', () => {
  let history = [];
  for (const [at, cpuPercent, memoryPercent] of [
    [0, 0, 40], [5000, 25, undefined], [10000, 100, 80], [15000, -1, 101]
  ]) history = appendResourceHistory(history, { cpuPercent, memory: { percent: memoryPercent } }, at);
  const cpu = resourceChartModel(history, 'cpu', 15000);
  const memory = resourceChartModel(history, 'memory', 15000);
  assert.equal(cpu.maximum, 100);
  assert.equal(memory.maximum, 100);
  assert.equal(cpu.count, 3);
  assert.equal(cpu.series[0][0].value, 0);
  assert.equal(cpu.peak, 100);
  assert.deepEqual(memory.series.map(segment => segment.length), [1, 1]);
  assert.equal(memory.count, 2);
  assert.equal(memory.peak, 80);
  assert.equal(history.at(-1).values.cpu.percent, undefined);
});

test('CPU and memory retain only five minutes and do not join across paused collection', () => {
  let history = [];
  for (let i = 0; i < 180; i++) history = appendResourceHistory(history,
    { cpuPercent: i % 100, memory: { percent: 40 } }, i * 5000);
  assert.equal(history.length, 61);
  assert.equal(resourceChartModel(history, 'memory', 895000).count, 61);
  history = appendResourceHistory(history, { cpuPercent: 10, memory: { percent: 50 } }, 896000, true);
  assert.equal(resourceChartModel(history, 'cpu', 896000).series.length, 2);
  assert.equal(resourceChartModel(history, 'memory', 1196001).count, 0);
  assert.equal(resourceChartModel([], 'cpu', 1000).peak, undefined);
});

function rendererFixture() {
  const renderer = fs.readFileSync(require.resolve('../src/ui/renderer.js'), 'utf8');
  const from = renderer.indexOf('async function loadServerInfo(');
  const to = renderer.indexOf('\nfunction renderServerInfo(', from);
  const tab = { id: 'first', status: 'ready', attempts: 1 };
  let finish;
  const scope = { tab, origin: () => tab, renderServerInfo() {}, message: String,
    serverInfoRefresh: undefined, serverInfoOpen: false,
    readySession: (t, a = t?.attempts) => t.status === 'ready' && t.attempts === a,
    window: { serverInfo }, api: { ssh: { serverInfo: () => new Promise(resolve => { finish = resolve; }) } } };
  vm.createContext(scope);
  vm.runInContext(renderer.slice(from, to), scope);
  return { scope, tab, finish: value => finish(value) };
}

test('late snapshots cannot replace a reconnected session and concurrent refreshes are coalesced', async () => {
  const f = rendererFixture();
  const request = f.scope.loadServerInfo(f.tab, true);
  const original = f.tab.serverInfo;
  await f.scope.loadServerInfo(f.tab, true);
  assert.equal(f.tab.serverInfo, original);
  f.tab.attempts++;
  f.tab.serverInfo = undefined;
  f.finish(snapshot({ hostname: 'old-session' }));
  await request;
  assert.equal(f.tab.serverInfo, undefined);
});

test('failed refresh keeps the previous sample and can be retried', async () => {
  const f = rendererFixture();
  f.tab.serverInfo = { data: { hostname: 'last-success' } };
  f.scope.api.ssh.serverInfo = async () => { throw new Error('timeout'); };
  await f.scope.loadServerInfo(f.tab, true);
  assert.equal(f.tab.serverInfo.data.hostname, 'last-success');
  assert.match(f.tab.serverInfo.error, /timeout/);
  assert.equal(f.tab.serverInfo.loading, false);
  f.scope.api.ssh.serverInfo = async () => snapshot({ hostname: 'new-success' });
  await f.scope.loadServerInfo(f.tab, true);
  assert.equal(f.tab.serverInfo.data.hostname, 'new-success');
  assert.equal(f.tab.serverInfo.error, '');
});

function autoRefreshFixture() {
  const renderer = fs.readFileSync(require.resolve('../src/ui/renderer.js'), 'utf8');
  const from = renderer.indexOf('function stopServerInfoRefresh(');
  const to = renderer.indexOf('\nasync function loadServerInfo(', from);
  const f = rendererFixture();
  const intervals = new Map();
  const calls = [];
  const panel = { hidden: false };
  let nextId = 0;
  Object.assign(f.scope, {
    serverInfoOpen: true, serverInfoRefresh: undefined,
    $: () => panel,
    setInterval: (callback, delay) => { const id = ++nextId; intervals.set(id, { callback, delay }); return id; },
    clearInterval: id => intervals.delete(id)
  });
  vm.runInContext(renderer.slice(from, to), f.scope);
  f.scope.api.ssh.serverInfo = async id => { calls.push(id); return snapshot({ hostname: id }); };
  const tick = async () => {
    for (const { callback } of [...intervals.values()]) callback();
    await nextTurn();
  };
  return { ...f, intervals, calls, panel, tick };
}

test('expanded server info refreshes every five seconds without resetting the timer on render', async () => {
  const f = autoRefreshFixture();
  f.scope.syncServerInfoRefresh(f.tab, true);
  const subscription = f.scope.serverInfoRefresh;
  assert.equal(f.intervals.size, 1);
  assert.equal([...f.intervals.values()][0].delay, 5000);
  await f.tick();
  assert.deepEqual(f.calls, [f.tab.id]);
  f.scope.syncServerInfoRefresh(f.tab, true);
  assert.equal(f.scope.serverInfoRefresh, subscription);
  await f.tick();
  assert.equal(f.calls.length, 2);
  f.scope.syncServerInfoRefresh(f.tab, false);
  assert.equal(f.intervals.size, 0);
  await f.tick();
  assert.equal(f.calls.length, 2);
});

test('refresh stops when hidden, disconnected or moved away from the current session', async () => {
  for (const change of [
    f => { f.scope.serverInfoOpen = false; },
    f => { f.panel.hidden = true; },
    f => { f.tab.status = 'closed'; },
    f => { f.scope.origin = () => undefined; },
    f => { f.tab.attempts++; }
  ]) {
    const f = autoRefreshFixture();
    f.scope.syncServerInfoRefresh(f.tab, true);
    change(f);
    await f.tick();
    assert.equal(f.intervals.size, 0);
    assert.deepEqual(f.calls, []);
  }
});

test('switching hosts or reconnecting replaces the timer and queued old ticks cannot affect the new timer', async () => {
  const f = autoRefreshFixture();
  f.scope.syncServerInfoRefresh(f.tab, true);
  const oldTick = [...f.intervals.values()][0].callback;
  const second = { id: 'second', status: 'ready', attempts: 1 };
  f.scope.origin = () => second;
  f.scope.syncServerInfoRefresh(second, true);
  oldTick();
  await f.tick();
  assert.equal(f.intervals.size, 1);
  assert.deepEqual(f.calls, ['second']);
  const firstTimer = f.scope.serverInfoRefresh;
  second.attempts++;
  f.scope.syncServerInfoRefresh(second, true);
  assert.notEqual(f.scope.serverInfoRefresh, firstTimer);
  assert.equal(f.intervals.size, 1);
});

test('slow polls do not overlap and polling retries after an error', async () => {
  const f = autoRefreshFixture();
  let complete;
  f.scope.api.ssh.serverInfo = id => {
    f.calls.push(id);
    return new Promise(resolve => { complete = resolve; });
  };
  f.scope.syncServerInfoRefresh(f.tab, true);
  await f.tick();
  await f.tick();
  assert.equal(f.calls.length, 1);
  complete(snapshot({}));
  await nextTurn();
  f.scope.api.ssh.serverInfo = async () => { throw new Error('temporary failure'); };
  await f.tick();
  assert.match(f.tab.serverInfo.error, /temporary failure/);
  f.scope.api.ssh.serverInfo = async id => snapshot({ hostname: id });
  await f.tick();
  assert.equal(f.tab.serverInfo.error, '');
  assert.equal(f.tab.serverInfo.data.hostname, f.tab.id);
});

test('closing or reopening a panel while a request is in flight cannot append a hidden sample', async () => {
  const f = autoRefreshFixture();
  let complete;
  f.scope.api.ssh.serverInfo = () => new Promise(resolve => { complete = resolve; });
  f.scope.syncServerInfoRefresh(f.tab, true);
  await f.tick();
  f.scope.serverInfoOpen = false;
  f.scope.syncServerInfoRefresh(f.tab, false);
  f.scope.serverInfoOpen = true;
  f.scope.syncServerInfoRefresh(f.tab, true);
  complete(snapshot({}));
  await nextTurn();
  assert.equal(f.tab.networkHistory, undefined);
  assert.equal(f.tab.resourceHistory, undefined);
  assert.equal(f.tab.diskHistory, undefined);
  f.scope.api.ssh.serverInfo = async () => snapshot({});
  await f.tick();
  assert.equal(f.tab.networkHistory.length, 1);
  assert.equal(f.tab.resourceHistory.length, 1);
  assert.equal(f.tab.resourceHistory[0].at, f.tab.networkHistory[0].at);
  assert.equal(f.tab.diskHistory[0].at, f.tab.networkHistory[0].at);
  f.scope.syncServerInfoRefresh(f.tab, false);
  assert.equal(f.tab.serverHistoryPaused, true);
  const count = f.tab.networkHistory.length;
  await f.tick();
  assert.equal(f.tab.networkHistory.length, count);
  assert.equal(f.tab.resourceHistory.length, count);
  assert.equal(f.tab.diskHistory.length, count);
});

test('one successful poll records CPU, memory, network and disk IO together, with shared failure gaps', async () => {
  const f = autoRefreshFixture();
  const source = snapshot({ cpuBefore: 'cpu 0 0 0 100', cpuAfter: 'cpu 20 0 0 180',
    memory: 'MemTotal: 1000 kB\nMemAvailable: 500 kB', diskIoBeforeTime: '1', diskIoAfterTime: '2',
    diskIoBefore: 'vda 252:0:2 100 100 10 20 100 10 20 100', diskIoAfter: 'vda 252:0:2 101 102 12 23 350 16 32 200' });
  f.scope.api.ssh.serverInfo = async () => source;
  f.scope.syncServerInfoRefresh(f.tab, true);
  await f.tick();
  assert.equal(f.tab.resourceHistory[0].values.cpu.percent, 20);
  assert.equal(f.tab.resourceHistory[0].values.memory.percent, 50);
  assert.equal(f.tab.networkHistory[0].at, f.tab.resourceHistory[0].at);
  assert.equal(f.tab.diskHistory[0].at, f.tab.resourceHistory[0].at);
  assert.equal(f.tab.diskHistory[0].values.vda.writeRate, 1024);
  assert.equal(f.tab.diskHistory[0].values.vda.iops, 5);
  assert.equal(f.tab.diskHistory[0].values.vda.utilization, 25);
  assert.equal(f.tab.diskHistory[0].values.vda.readLatency, 3);
  assert.equal(f.tab.diskHistory[0].values.vda.writeLatency, 4);
  assert.equal(f.tab.diskHistory[0].values.vda.queueLength, .1);
  f.scope.api.ssh.serverInfo = async () => { throw new Error('sample unavailable'); };
  await f.tick();
  assert.equal(f.tab.serverHistoryPaused, true);
  assert.equal(f.tab.resourceHistory.length, 1);
  assert.equal(f.tab.diskHistory.length, 1);
  f.scope.api.ssh.serverInfo = async () => source;
  await f.tick();
  assert.equal(f.tab.resourceHistory.length, 2);
  assert.equal(resourceChartModel(f.tab.resourceHistory, 'cpu').series.length, 2);
  assert.equal(resourceChartModel(f.tab.resourceHistory, 'memory').series.length, 2);
  assert.equal(diskChartModel(f.tab.diskHistory, 'vda').read.length, 2);
  assert.equal(diskMetricChartModel(f.tab.diskHistory, 'vda', 'iops').series.length, 2);
  assert.equal(diskMetricChartModel(f.tab.diskHistory, 'vda', 'utilization').series.length, 2);
  assert.equal(diskLatencyChartModel(f.tab.diskHistory, 'vda').read.length, 2);
  assert.equal(diskMetricChartModel(f.tab.diskHistory, 'vda', 'queueLength').series.length, 2);
});

test('background server snapshots do not postpone the Electron vault idle lock', () => {
  const main = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
  const handlers = new Map();
  const scope = { ipcMain: { handle: (name, action) => handlers.set(name, action) },
    verified: () => true, store: { data: {} }, lastActivity: 100, Date: { now: () => 200 } };
  vm.createContext(scope);
  vm.runInContext(main.slice(main.indexOf('function handle('), main.indexOf('\nfunction listen(')), scope);
  scope.handle('ssh:server-info', () => 'snapshot');
  assert.equal(handlers.get('ssh:server-info')({}, null), 'snapshot');
  assert.equal(scope.lastActivity, 100);
  scope.handle('hosts:list', () => []);
  handlers.get('hosts:list')({}, null);
  assert.equal(scope.lastActivity, 200);
});
