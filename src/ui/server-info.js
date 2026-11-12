(function (root) {
  'use strict';
  const number = value => {
    if (value === undefined || value === null || String(value).trim() === '') return undefined;
    const result = Number(value);
    return Number.isFinite(result) && result >= 0 ? result : undefined;
  };
  const percent = (used, total) => total > 0 && used !== undefined ? Math.min(100, Math.max(0, used / total * 100)) : undefined;

  function networkCounters(source, platform) {
    const interfaces = new Map();
    const add = (name, received, sent) => {
      if (!name || /^lo\d*$/.test(name) || /[\s\x00-\x1f\x7f]/.test(name) ||
          !/^\d+$/.test(received || '') || !/^\d+$/.test(sent || '')) return;
      const rx = BigInt(received), tx = BigInt(sent);
      if (rx > 18446744073709551615n || tx > 18446744073709551615n) return;
      interfaces.set(name, { received: rx, sent: tx });
    };
    const lines = source.split('\n');
    if (platform === 'Linux') {
      for (const line of lines) {
        const match = /^\s*(\S+):\s*(\d+(?:\s+\d+){15})\s*$/.exec(line);
        if (!match) continue;
        const counters = match[2].split(/\s+/);
        add(match[1], counters[0], counters[8]);
      }
    } else if (platform === 'Darwin') {
      const header = lines.shift()?.trim().split(/\s+/) || [];
      const [name, network, received, sent] = ['Name', 'Network', 'Ibytes', 'Obytes'].map(key => header.indexOf(key));
      if ([name, network, received, sent].some(index => index < 0)) return interfaces;
      for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        // Only link rows carry interface totals; address rows repeat those counters.
        if (!/^<Link#\d+>$/.test(fields[network] || '')) continue;
        // Point-to-point interfaces have an empty Address cell. Numeric columns
        // still align with the end of the header, even when that cell is absent.
        add((fields[name] || '').replace(/\*$/, ''), fields.at(received - header.length), fields.at(sent - header.length));
      }
    }
    return interfaces;
  }

  function networkSample(before, after, seconds) {
    const rate = (current, previous) => previous !== undefined && current >= previous && seconds > 0
      ? Number(current - previous) / seconds : undefined;
    return [...after].map(([name, counters]) => ({ name,
      received: Number(counters.received), sent: Number(counters.sent),
      downloadRate: rate(counters.received, before.get(name)?.received),
      uploadRate: rate(counters.sent, before.get(name)?.sent) }));
  }

  function formatNetworkBytes(value, perSecond = false) {
    if (!Number.isFinite(value) || value < 0) return '暂不可用';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
    const unit = value > 0 ? Math.max(0, Math.min(units.length - 1, Math.floor(Math.log2(value) / 10))) : 0;
    return `${(value / 1024 ** unit).toFixed(unit || (perSecond && value > 0 && value < 10) ? 1 : 0)} ${units[unit]}${perSecond ? '/s' : ''}`;
  }

  function diskIoCounters(source, platform) {
    const devices = new Map();
    const counter = value => {
      if (!/^\d+$/.test(value || '')) return undefined;
      const result = BigInt(value);
      return result <= 18446744073709551615n ? result : undefined;
    };
    const add = (name, identity, read, written, unit, readOps, writeOps, busyMs, timing = {}) => {
      const rx = counter(read), tx = counter(written);
      if (!/^[\w.!+-]+$/.test(name || '') || !identity || rx === undefined || tx === undefined) return;
      devices.set(name, { identity, read: rx * unit, written: tx * unit,
        readOps: counter(readOps), writeOps: counter(writeOps), busyMs: counter(busyMs),
        readTime: counter(timing.read), writeTime: counter(timing.write), weightedMs: counter(timing.weighted),
        timeDivisor: timing.divisor || 1 });
    };
    if (platform === 'Linux') {
      for (const line of source.split('\n')) {
        const fields = line.trim().split(/\s+/);
        if (![4, 7, 10].includes(fields.length) || !/^\d+:\d+:(?:\d+|-)$/.test(fields[1] || '')) continue;
        add(...fields.slice(0, 4), 512n, fields[4], fields[5], fields[6],
          { read: fields[7], write: fields[8], weighted: fields[9] });
      }
    } else if (platform === 'Darwin') {
      // Each root driver owns one set of counters. Ignore partition descendants.
      for (const driver of source.split(/(?=^\+-o )/m)) {
        const identity = /^\+-o .*<class \S+, id (0x[\da-f]+),/i.exec(driver)?.[1];
        const name = /"BSD Name"\s*=\s*"(disk\d+)"/.exec(driver)?.[1];
        const stats = /"Statistics"\s*=\s*\{([^}\n]*)\}/.exec(driver)?.[1] || '';
        const stat = (kind, direction) => new RegExp(`"${kind} \\(${direction}\\)"\\s*=\\s*(\\d+)(?=\\s*(?:,|$))`).exec(stats)?.[1];
        add(name, identity, stat('Bytes', 'Read'), stat('Bytes', 'Write'), 1n,
          stat('Operations', 'Read'), stat('Operations', 'Write'), undefined,
          { read: stat('Total Time', 'Read'), write: stat('Total Time', 'Write'), divisor: 1e6 });
      }
    }
    return devices;
  }

  function diskIoSample(before, after, seconds) {
    return [...after].map(([name, counters]) => {
      const previous = before.get(name);
      const delta = key => previous?.identity === counters.identity && counters[key] !== undefined && previous[key] !== undefined &&
        counters[key] >= previous[key] && seconds > 0
        ? counters[key] - previous[key] : undefined;
      const rate = key => { const value = delta(key); return value !== undefined ? Number(value) / seconds : undefined; };
      const latency = (time, operations) => {
        const count = delta(operations), duration = delta(time);
        return count !== undefined && count > 0n && duration !== undefined
          ? Number(duration) / Number(count) / counters.timeDivisor : undefined;
      };
      const readIops = rate('readOps'), writeIops = rate('writeOps'), busyPerSecond = rate('busyMs');
      const weightedPerSecond = rate('weightedMs');
      return { name, identity: counters.identity, readRate: rate('read'), writeRate: rate('written'),
        iops: readIops !== undefined && writeIops !== undefined ? readIops + writeIops : undefined,
        utilization: busyPerSecond !== undefined ? Math.min(100, busyPerSecond / 10) : undefined,
        readLatency: latency('readTime', 'readOps'), writeLatency: latency('writeTime', 'writeOps'),
        queueLength: weightedPerSecond !== undefined ? weightedPerSecond / 1000 : undefined };
    });
  }

  const historyWindow = 5 * 60 * 1000;
  const historyLimit = 121;
  const validRate = value => Number.isFinite(value) && value >= 0;
  const validPercent = value => validRate(value) && value <= 100;

  function appendHistory(history = [], values, at, paused = false) {
    if (!Number.isFinite(at) || at < 0) return history;
    const backwards = history.length && at < history.at(-1).at;
    const samples = backwards ? [] : history.filter(sample => sample.at >= at - historyWindow);
    const previous = samples.at(-1);
    const discontinuity = paused || !previous || at - previous.at > 7500;
    const sample = { at, breakBefore: discontinuity, values };
    // Manual refreshes share a five-second bucket, unless collection was paused.
    if (previous && !discontinuity && Math.floor(previous.at / 5000) === Math.floor(at / 5000)) {
      sample.breakBefore = previous.breakBefore;
      samples[samples.length - 1] = sample;
    } else samples.push(sample);
    return samples.slice(-historyLimit);
  }

  function appendNetworkHistory(history, network, at, paused = false) {
    return appendHistory(history, Object.fromEntries(network.map(entry => [entry.name, {
      downloadRate: validRate(entry.downloadRate) ? entry.downloadRate : undefined,
      uploadRate: validRate(entry.uploadRate) ? entry.uploadRate : undefined
    }])), at, paused);
  }

  function appendResourceHistory(history, data, at, paused = false) {
    const entry = value => ({ percent: validPercent(value) ? value : undefined });
    return appendHistory(history, { cpu: entry(data.cpuPercent), memory: entry(data.memory?.percent) }, at, paused);
  }

  function appendDiskHistory(history, devices, at, paused = false) {
    return appendHistory(history, Object.fromEntries(devices.map(entry => [entry.name, {
      identity: entry.identity,
      readRate: validRate(entry.readRate) ? entry.readRate : undefined,
      writeRate: validRate(entry.writeRate) ? entry.writeRate : undefined,
      iops: validRate(entry.iops) ? entry.iops : undefined,
      utilization: validPercent(entry.utilization) ? entry.utilization : undefined,
      readLatency: validRate(entry.readLatency) ? entry.readLatency : undefined,
      writeLatency: validRate(entry.writeLatency) ? entry.writeLatency : undefined,
      queueLength: validRate(entry.queueLength) ? entry.queueLength : undefined
    }])), at, paused);
  }

  function historySeries(samples, name, key, valid = validRate) {
    const segments = [];
    let segment = [], previousAt, previousIdentity;
    const finish = () => { if (segment.length) segments.push(segment); segment = []; };
    for (const sample of samples) {
      const entry = sample.values[name];
      const value = entry?.[key];
      if (sample.breakBefore || entry?.identity !== previousIdentity ||
          (previousAt !== undefined && sample.at - previousAt > 7500) || !valid(value)) finish();
      if (valid(value)) segment.push({ at: sample.at, value });
      previousAt = sample.at;
      previousIdentity = entry?.identity;
    }
    finish();
    return segments;
  }

  function peak(segments) {
    const values = segments.flat().map(point => point.value);
    return values.length ? Math.max(...values) : undefined;
  }

  function resourceChartModel(history = [], metric, now = Date.now()) {
    const start = now - historyWindow;
    const samples = history.filter(sample => sample.at >= start && sample.at <= now);
    const series = historySeries(samples, metric, 'percent', validPercent);
    return { start, end: now, series, peak: peak(series), maximum: 100,
      count: samples.filter(sample => validPercent(sample.values[metric]?.percent)).length };
  }

  function networkChartModel(history = [], name, now = Date.now()) {
    const model = speedChartModel(history, name, 'downloadRate', 'uploadRate', now);
    return { ...model, download: model.first, upload: model.second,
      downloadPeak: model.firstPeak, uploadPeak: model.secondPeak };
  }

  function diskChartModel(history = [], name, now = Date.now()) {
    const model = speedChartModel(history, name, 'readRate', 'writeRate', now);
    return { ...model, read: model.first, write: model.second, readPeak: model.firstPeak, writePeak: model.secondPeak };
  }

  function diskLatencyChartModel(history = [], name, now = Date.now()) {
    const model = speedChartModel(history, name, 'readLatency', 'writeLatency', now, { minimum: .001, binary: false });
    return { ...model, read: model.first, write: model.second, readPeak: model.firstPeak, writePeak: model.secondPeak };
  }

  function diskMetricChartModel(history = [], name, metric, now = Date.now()) {
    const start = now - historyWindow;
    const samples = history.filter(sample => sample.at >= start && sample.at <= now);
    const valid = metric === 'utilization' ? validPercent : validRate;
    const series = historySeries(samples, name, metric, valid);
    const maximum = Math.max(metric === 'queueLength' ? .001 : 1, peak(series) || 0);
    return { start, end: now, series, peak: peak(series),
      maximum: metric === 'utilization' ? 100 : chartMaximum(maximum),
      count: samples.filter(sample => valid(sample.values[name]?.[metric])).length };
  }

  function chartMaximum(maximum, unit = 1) {
    const magnitude = 10 ** Math.floor(Math.log10(maximum / unit));
    const step = [1, 2, 5, 10].find(value => value >= maximum / unit / magnitude) || 10;
    const result = step * magnitude * unit;
    return Number.isFinite(result) ? result : maximum;
  }

  function speedChartModel(history, name, firstKey, secondKey, now, { minimum = 1, binary = true } = {}) {
    const start = now - historyWindow;
    const samples = history.filter(sample => sample.at >= start && sample.at <= now);
    const download = historySeries(samples, name, firstKey), upload = historySeries(samples, name, secondKey);
    const downloadPeak = peak(download), uploadPeak = peak(upload);
    const maximum = Math.max(minimum, downloadPeak || 0, uploadPeak || 0);
    const unit = binary ? 1024 ** Math.max(0, Math.min(6, Math.floor(Math.log2(maximum) / 10))) : 1;
    return { start, end: now, first: download, second: upload, firstPeak: downloadPeak, secondPeak: uploadPeak,
      maximum: chartMaximum(maximum, unit),
      count: samples.filter(sample => validRate(sample.values[name]?.[firstKey]) || validRate(sample.values[name]?.[secondKey])).length };
  }

  function parse(source) {
    const sections = {};
    let key;
    for (const line of String(source).replace(/\r/g, '').split('\n')) {
      const marker = /^__TERMLUME_INFO__(\w+)$/.exec(line);
      if (marker) { key = marker[1]; sections[key] = ''; }
      else if (key) sections[key] += `${line}\n`;
    }
    const text = key => (sections[key] || '').trim();
    if (text('version') !== '1' || text('end') !== 'ok' || !text('platform')) {
      throw new Error('服务器返回的信息不完整，请刷新重试。');
    }
    const platform = text('platform');
    const fields = {};
    for (const line of text('memory').split('\n')) {
      const match = /^(\w+):\s+(\d+)\s+kB$/.exec(line.trim());
      if (match) fields[match[1]] = Number(match[2]) * 1024;
    }
    const total = fields.MemTotal ?? number(text('memoryTotal'));
    let available = fields.MemAvailable;
    if (available === undefined && fields.MemFree !== undefined) {
      available = fields.MemFree + (fields.Buffers || 0) + (fields.Cached || 0) + (fields.SReclaimable || 0) - (fields.Shmem || 0);
    }
    if (platform === 'Darwin') {
      const pages = text('memoryPages');
      const pageSize = number(/page size of (\d+) bytes/.exec(pages)?.[1]);
      const free = number(/Pages free:\s+(\d+)/.exec(pages)?.[1]);
      const inactive = number(/Pages inactive:\s+(\d+)/.exec(pages)?.[1]);
      if (pageSize && free !== undefined && inactive !== undefined) available = (free + inactive) * pageSize;
    }
    if (available !== undefined && total > 0) available = Math.max(0, Math.min(total, available));
    const used = total > 0 && available !== undefined ? total - available : undefined;
    const ticks = key => {
      const match = /^cpu\s+([\d\s]+)$/.exec(text(key));
      if (!match) return undefined;
      const values = match[1].trim().split(/\s+/).map(Number).slice(0, 8); // guest ticks are already in user/nice.
      if (values.length < 4) return undefined;
      return { total: values.reduce((a, b) => a + b, 0), idle: values[3] + (values[4] || 0) };
    };
    const before = ticks('cpuBefore'), after = ticks('cpuAfter');
    const delta = before && after ? after.total - before.total : 0;
    const idle = before && after ? after.idle - before.idle : -1;
    const cpuPercent = delta > 0 && idle >= 0 && idle <= delta ? percent(delta - idle, delta) : undefined;
    let uptime = number(text('uptime').split(/\s+/)[0]);
    if (platform === 'Darwin') {
      const boot = number(/sec\s*=\s*(\d+)/.exec(text('bootTime'))?.[1]);
      const epoch = number(text('epoch'));
      if (boot !== undefined && epoch >= boot) uptime = epoch - boot;
    }
    const disks = [];
    for (const line of text('disks').split('\n')) {
      const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
      if (!match || /^(tmpfs|devtmpfs|udev|devfs)$/.test(match[1]) || Number(match[2]) === 0) continue;
      const [, device, blocks, occupied, free, capacity, mount] = match;
      disks.push({ device, mount, total: Number(blocks) * 1024, used: Number(occupied) * 1024,
        available: Number(free) * 1024, percent: Math.min(100, Number(capacity)) });
    }
    let os = text('os');
    if (platform === 'Linux') os = os.replace(/^PRETTY_NAME=/, '').replace(/^(["'])(.*)\1$/, '$2').replace(/\\([\\"$`])/g, '$1');
    if (platform === 'Darwin' && os) os = `macOS ${os}`;
    const networkBeforeTime = number(text('networkBeforeTime').split(/\s+/)[0]);
    const networkAfterTime = number(text('networkAfterTime').split(/\s+/)[0]);
    const networkSeconds = networkBeforeTime !== undefined && networkAfterTime !== undefined
      ? networkAfterTime - networkBeforeTime : undefined;
    const network = networkSample(networkCounters(text('networkBefore'), platform),
      networkCounters(text('networkAfter'), platform), networkSeconds);
    const preferred = text('networkDefault').split(/\s+/);
    network.sort((a, b) => {
      const rank = name => preferred.includes(name) ? preferred.indexOf(name) : preferred.length;
      return rank(a.name) - rank(b.name);
    });
    const diskBeforeTime = number(text('diskIoBeforeTime').split(/\s+/)[0]);
    const diskAfterTime = number(text('diskIoAfterTime').split(/\s+/)[0]);
    const diskIo = diskIoSample(diskIoCounters(text('diskIoBefore'), platform), diskIoCounters(text('diskIoAfter'), platform),
      diskBeforeTime !== undefined && diskAfterTime !== undefined ? diskAfterTime - diskBeforeTime : undefined);
    return { platform, hostname: text('hostname'), kernel: text('kernel'), architecture: text('architecture'),
      os: os || platform, cpuModel: text('cpuModel'), cpuCount: number(text('cpuCount')), cpuPercent,
      memory: { total, used, available, percent: percent(used, total) },
      swap: { total: fields.SwapTotal, used: fields.SwapTotal !== undefined && fields.SwapFree !== undefined ? Math.max(0, fields.SwapTotal - fields.SwapFree) : undefined },
      uptime, load: (text('load').match(/\d+(?:\.\d+)?/g) || []).slice(0, 3).join(' / '), disks, network, diskIo };
  }
  const api = { parse, formatNetworkBytes, appendNetworkHistory, networkChartModel, appendResourceHistory, resourceChartModel,
    appendDiskHistory, diskChartModel, diskMetricChartModel, diskLatencyChartModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.serverInfo = api;
})(typeof window !== 'undefined' ? window : globalThis);
