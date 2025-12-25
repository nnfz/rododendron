import { useState, useEffect, useRef } from 'react';

import { isTauri } from '../utils/isTauri';

interface TrafficStats {
  up: number;
  down: number;
}

export function useVPNStats(vpnEnabled: boolean) {

  const [uptime, setUptime] = useState({ hours: 0, minutes: 0, seconds: 0 });
  const [traffic, setTraffic] = useState<TrafficStats>({ up: 0, down: 0 });
  const [latency, setLatency] = useState<number | null>(null);

  const startTimeRef = useRef<number | null>(null);
  const uptimeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const trafficFailCountRef = useRef(0);
  const delayFailCountRef = useRef(0);
  const stopRef = useRef(false);
  const lastTrafficSampleRef = useRef<{ ts: number; up: number; down: number } | null>(null);
  const lastConnTotalsRef = useRef<{ ts: number; upTotal: number; downTotal: number } | null>(null);

  // Uptime tracker
  useEffect(() => {
    if (!vpnEnabled) {
      setUptime({ hours: 0, minutes: 0, seconds: 0 });
      setTraffic({ up: 0, down: 0 });
      setLatency(null);
      startTimeRef.current = null;
      lastTrafficSampleRef.current = null;
      lastConnTotalsRef.current = null;
      stopRef.current = false;
      if (uptimeIntervalRef.current) {
        clearInterval(uptimeIntervalRef.current);
        uptimeIntervalRef.current = null;
      }
      return;
    }

    if (!startTimeRef.current) {
      startTimeRef.current = Date.now();
    }

    uptimeIntervalRef.current = setInterval(() => {
      if (!startTimeRef.current) return;
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setUptime({
        hours: Math.floor(elapsed / 3600),
        minutes: Math.floor((elapsed % 3600) / 60),
        seconds: elapsed % 60,
      });
    }, 1000);

    return () => {
      if (uptimeIntervalRef.current) {
        clearInterval(uptimeIntervalRef.current);
        uptimeIntervalRef.current = null;
      }
    };
  }, [vpnEnabled]);

  // Fetch stats from mihomo API
  useEffect(() => {
    if (!vpnEnabled || !isTauri()) {
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }
      return;
    }

    stopRef.current = false;
    const handleBeforeUnload = () => {
      stopRef.current = true;
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    const invokeTauri = async <T,>(cmd: string, args?: Record<string, unknown>) => {
      if (stopRef.current) {
        throw new Error('invoke skipped (unmount/unload)');
      }
      const { invoke } = await import('@tauri-apps/api/core');
      return (await invoke(cmd, args)) as T;
    };

    const computeSpeedFromConnectionsTotals = async (now: number = Date.now()) => {
      if (stopRef.current) return;
      const conns = await invokeTauri<any>('mihomo_get_connections');
      const root = conns;

      // Some variants:
      // - { uploadTotal, downloadTotal, connections: [...] }
      // - { connections: { uploadTotal, downloadTotal, ... } }
      // - { connections: [...] } (no totals) => sum per-connection
      const nestedTotals =
        root?.connections && typeof root.connections === 'object' && !Array.isArray(root.connections)
          ? root.connections
          : null;

      let upTotal = Number(root?.uploadTotal ?? root?.upload_total ?? nestedTotals?.uploadTotal ?? nestedTotals?.upload_total ?? 0);
      let downTotal = Number(root?.downloadTotal ?? root?.download_total ?? nestedTotals?.downloadTotal ?? nestedTotals?.download_total ?? 0);

      if (!upTotal && !downTotal && Array.isArray(root?.connections)) {
        const list = root.connections;
        upTotal = list.reduce((acc: number, c: any) => acc + Number(c?.upload ?? c?.upload_total ?? 0), 0);
        downTotal = list.reduce((acc: number, c: any) => acc + Number(c?.download ?? c?.download_total ?? 0), 0);
      }

      const prevTotals = lastConnTotalsRef.current;
      lastConnTotalsRef.current = { ts: now, upTotal, downTotal };
      if (!prevTotals) {
        if (!stopRef.current) setTraffic({ up: 0, down: 0 });
        return;
      }
      const dt2 = Math.max(0.2, (now - prevTotals.ts) / 1000);
      const u2 = upTotal - prevTotals.upTotal;
      const d2 = downTotal - prevTotals.downTotal;
      if (u2 >= 0 && d2 >= 0) {
        if (!stopRef.current) setTraffic({ up: u2 / dt2, down: d2 / dt2 });
      } else {
        if (!stopRef.current) setTraffic({ up: 0, down: 0 });
      }
    };

    const fetchStats = async () => {
      try {
        if (stopRef.current) return;
        const now = Date.now();

        // First try to get traffic from /connections endpoint
        try {
          await computeSpeedFromConnectionsTotals(now);
          trafficFailCountRef.current = 0;
          return; // If successful, we're done
        } catch (e) {
          console.debug('Fallback to /traffic endpoint:', e);
        }

        // Fallback to /traffic endpoint if /connections fails
        try {
          const data = await invokeTauri<{ up: number; down: number }>('mihomo_get_traffic');
          const upRaw = data?.up ?? 0;
          const downRaw = data?.down ?? 0;

          const prev = lastTrafficSampleRef.current;
          lastTrafficSampleRef.current = { ts: now, up: upRaw, down: downRaw };

          if (prev) {
            const dt = Math.max(0.2, (now - prev.ts) / 1000);
            const upDelta = upRaw - prev.up;
            const downDelta = downRaw - prev.down;

            if (upDelta >= 0 && downDelta >= 0) {
              const speedUp = upDelta / dt;
              const speedDown = downDelta / dt;
              if (!stopRef.current) setTraffic({ up: speedUp, down: speedDown });
              trafficFailCountRef.current = 0;
              return;
            }
          }
        } catch (e) {
          // Let the outer catch handle logging/throttling
          throw e;
        }

        // If we get here, both /connections and /traffic endpoints failed
      } catch (e) {
        // Log first few errors, then only occasionally
        trafficFailCountRef.current += 1;
        if (trafficFailCountRef.current <= 3) {
          console.warn('Failed to get traffic data (attempt', trafficFailCountRef.current, '):', e);
        } else if (trafficFailCountRef.current % 30 === 0) {
          console.debug('Traffic data still unavailable (attempt', trafficFailCountRef.current, '):', e);
        }
        if (trafficFailCountRef.current >= 3) {
          if (!stopRef.current) setTraffic({ up: 0, down: 0 });
        }
      }
    };

    const fetchDelay = async () => {
      try {
        if (stopRef.current) return;

        const pickActiveProxyName = (root: any): string | null => {
          const table = root?.proxies && typeof root.proxies === 'object' ? root.proxies : root;
          if (!table || typeof table !== 'object') return null;

          for (const key of ['GLOBAL', 'Proxy', 'PROXY']) {
            const entry = (table as any)[key];
            if (entry && typeof entry === 'object' && typeof entry.now === 'string' && entry.now.trim()) {
              return entry.now.trim();
            }
          }

          for (const entry of Object.values(table as Record<string, any>)) {
            if (entry && typeof entry === 'object' && typeof entry.now === 'string' && entry.now.trim()) {
              return entry.now.trim();
            }
          }

          return null;
        };

        const proxies = await invokeTauri<any>('mihomo_get_proxies');
        const proxyName = pickActiveProxyName(proxies);
        if (!proxyName) {
          if (!stopRef.current) setLatency(null);
          return;
        }

        const delayResp = await invokeTauri<any>('mihomo_get_delay', { proxyName });
        const delayRaw = (delayResp && typeof delayResp === 'object')
          ? (delayResp.delay ?? delayResp.Delay ?? delayResp.ms)
          : delayResp;
        const delay = Number(delayRaw);
        if (!stopRef.current) setLatency(Number.isFinite(delay) && delay > 0 ? Math.round(delay) : null);
        delayFailCountRef.current = 0;
      } catch (e) {
        delayFailCountRef.current += 1;
        if (delayFailCountRef.current === 1) {
          console.warn('Ping not ready:', e);
        }
        if (delayFailCountRef.current >= 3) {
          if (!stopRef.current) setLatency(null);
        }
      }
    };

    // Первый запрос с небольшой задержкой для инициализации mihomo
    const initialTimeout = setTimeout(() => {
      fetchStats();
      fetchDelay();
    }, 2000);

    // Регулярные обновления
    const trafficInterval = setInterval(fetchStats, 1000);
    const delayInterval = setInterval(fetchDelay, 5000);

    statsIntervalRef.current = trafficInterval;

    return () => {
      stopRef.current = true;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      clearTimeout(initialTimeout);
      clearInterval(trafficInterval);
      clearInterval(delayInterval);
      statsIntervalRef.current = null;
    };
  }, [vpnEnabled]);

  const formatUptime = () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(uptime.hours)}:${pad(uptime.minutes)}:${pad(uptime.seconds)}`;
  };

  const formatTraffic = (bytesPerSec: number) => {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';

    const kb = bytesPerSec / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB/s`;

    const mbps = kb / 1024;
    if (mbps < 1024) return `${mbps.toFixed(2)} MB/s`;

    const gbps = mbps / 1024;
    return `${gbps.toFixed(2)} GB/s`;
  };

  return {
    uptime,
    traffic,
    latency,
    formatUptime,
    formatTraffic,
  };
}