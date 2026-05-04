import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useAuthStore, useConfigStore, useUsageServiceStore } from '@/stores';
import { apiKeyUsageApi, usageServiceApi, type UsagePayload } from '@/services/api';
import {
  normalizeRecentRequestUsageEntry,
  sumRecentRequests,
  type ApiKeyUsageResponse,
} from '@/utils/recentRequests';
import styles from './RequestMonitoringPage.module.scss';

type StatusFilter = 'all' | 'success' | 'failed';
type DataSource = 'usage-service' | 'api-key-usage';

type PersistedRequestSnapshot = {
  id: string;
  timestamp: number;
  provider: string;
  baseUrl: string;
  apiKeyLabel: string;
  success: number;
  failed: number;
  recentSuccess: number;
  recentFailed: number;
};

type RequestMonitorRow = {
  id: string;
  timestamp: number;
  provider: string;
  target: string;
  apiKeyLabel: string;
  model: string;
  endpoint: string;
  source: string;
  authIndex: string;
  latencyMs?: number;
  totalTokens: number;
  success: number;
  failed: number;
  recentSuccess: number;
  recentFailed: number;
  total: number;
  successRate: number;
  deltaSuccess: number;
  deltaFailed: number;
};

type ProviderSummaryRow = {
  provider: string;
  entries: number;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  deltaSuccess: number;
  deltaFailed: number;
  totalTokens: number;
  avgLatencyMs?: number;
};

const STORAGE_KEY = 'requestMonitoring.snapshots.v1';
const MAX_SNAPSHOTS = 2000;
const AUTO_REFRESH_MS = 10000;

const formatNumber = (value: number) => new Intl.NumberFormat().format(value);
const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;
const formatLatency = (value?: number) => (typeof value === 'number' ? `${formatNumber(value)} ms` : '-');
const normalizeProvider = (value: string) => value.trim() || 'unknown';

const maskSecret = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '-';
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***`;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
};

const splitCompositeKey = (compositeKey: string) => {
  const separatorIndex = compositeKey.indexOf('|');
  if (separatorIndex === -1) {
    return { baseUrl: compositeKey.trim() || '-', apiKeyLabel: '-' };
  }

  const baseUrl = compositeKey.slice(0, separatorIndex).trim() || '-';
  const apiKey = compositeKey.slice(separatorIndex + 1).trim();
  return { baseUrl, apiKeyLabel: maskSecret(apiKey) };
};

const getSnapshotId = (provider: string, baseUrl: string, apiKeyLabel: string) =>
  `${provider.toLowerCase()}|${baseUrl}|${apiKeyLabel}`;

const buildLatestSnapshotMap = (snapshots: PersistedRequestSnapshot[]) => {
  const latest = new Map<string, PersistedRequestSnapshot>();

  snapshots.forEach((snapshot) => {
    const existing = latest.get(snapshot.id);
    if (!existing || snapshot.timestamp > existing.timestamp) {
      latest.set(snapshot.id, snapshot);
    }
  });

  return latest;
};

const toSnapshotRow = (
  snapshot: PersistedRequestSnapshot,
  previous?: PersistedRequestSnapshot
): RequestMonitorRow => {
  const total = snapshot.success + snapshot.failed;
  return {
    id: snapshot.id,
    timestamp: snapshot.timestamp,
    provider: snapshot.provider,
    target: snapshot.baseUrl,
    apiKeyLabel: snapshot.apiKeyLabel,
    model: '-',
    endpoint: snapshot.baseUrl,
    source: snapshot.apiKeyLabel,
    authIndex: '-',
    totalTokens: 0,
    success: snapshot.success,
    failed: snapshot.failed,
    recentSuccess: snapshot.recentSuccess,
    recentFailed: snapshot.recentFailed,
    total,
    successRate: total > 0 ? snapshot.success / total : 1,
    deltaSuccess: previous ? Math.max(snapshot.success - previous.success, 0) : 0,
    deltaFailed: previous ? Math.max(snapshot.failed - previous.failed, 0) : 0,
  };
};

const buildRowsFromSnapshots = (snapshots: PersistedRequestSnapshot[]) =>
  Array.from(buildLatestSnapshotMap(snapshots).values())
    .map((snapshot) => toSnapshotRow(snapshot))
    .sort((left, right) => right.total - left.total || left.provider.localeCompare(right.provider));

const pruneSnapshots = (snapshots: PersistedRequestSnapshot[]) =>
  snapshots
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-MAX_SNAPSHOTS);

const flattenApiKeyUsagePayload = (
  payload: ApiKeyUsageResponse,
  previousById: Map<string, PersistedRequestSnapshot>
) => {
  const timestamp = Date.now();
  const rows: RequestMonitorRow[] = [];
  const snapshots: PersistedRequestSnapshot[] = [];

  Object.entries(payload || {}).forEach(([providerName, entries]) => {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return;

    const provider = normalizeProvider(providerName);
    Object.entries(entries).forEach(([compositeKey, entry]) => {
      const usage = normalizeRecentRequestUsageEntry(entry);
      const recent = sumRecentRequests(usage.recentRequests);
      const { baseUrl, apiKeyLabel } = splitCompositeKey(compositeKey);
      const id = getSnapshotId(provider, baseUrl, apiKeyLabel);
      const snapshot: PersistedRequestSnapshot = {
        id,
        timestamp,
        provider,
        baseUrl,
        apiKeyLabel,
        success: usage.success,
        failed: usage.failed,
        recentSuccess: recent.success,
        recentFailed: recent.failure,
      };

      snapshots.push(snapshot);
      rows.push(toSnapshotRow(snapshot, previousById.get(id)));
    });
  });

  return {
    rows: rows.sort((left, right) => right.total - left.total || left.provider.localeCompare(right.provider)),
    snapshots,
  };
};

const parseTime = (value?: string) => {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const flattenUsageServicePayload = (payload: UsagePayload): RequestMonitorRow[] => {
  const rows: RequestMonitorRow[] = [];

  Object.entries(payload.apis || {}).forEach(([endpoint, apiAggregate]) => {
    Object.entries(apiAggregate?.models || {}).forEach(([model, modelAggregate]) => {
      (modelAggregate?.details || []).forEach((detail, index) => {
        const timestamp = parseTime(detail.timestamp);
        const failed = detail.failed ? 1 : 0;
        const success = detail.failed ? 0 : 1;
        const tokens = detail.tokens || {};
        const provider = normalizeProvider(detail.provider || '-');
        const source = detail.source || '-';
        const authIndex = detail.auth_index || '-';
        const requestId = detail.request_id || `${endpoint}|${model}|${timestamp}|${source}|${index}`;

        rows.push({
          id: requestId,
          timestamp,
          provider,
          target: endpoint || '-',
          apiKeyLabel: source,
          model: model || '-',
          endpoint: endpoint || '-',
          source,
          authIndex,
          latencyMs: detail.latency_ms,
          totalTokens: tokens.total_tokens || 0,
          success,
          failed,
          recentSuccess: success,
          recentFailed: failed,
          total: 1,
          successRate: detail.failed ? 0 : 1,
          deltaSuccess: 0,
          deltaFailed: 0,
        });
      });
    });
  });

  return rows.sort((left, right) => right.timestamp - left.timestamp);
};

const buildProviderRows = (rows: RequestMonitorRow[]): ProviderSummaryRow[] => {
  const map = new Map<string, ProviderSummaryRow & { latencySum: number; latencyCount: number }>();

  rows.forEach((row) => {
    const existing = map.get(row.provider) ?? {
      provider: row.provider,
      entries: 0,
      total: 0,
      success: 0,
      failed: 0,
      successRate: 1,
      deltaSuccess: 0,
      deltaFailed: 0,
      totalTokens: 0,
      latencySum: 0,
      latencyCount: 0,
    };

    existing.entries += 1;
    existing.success += row.success;
    existing.failed += row.failed;
    existing.total += row.total;
    existing.deltaSuccess += row.deltaSuccess;
    existing.deltaFailed += row.deltaFailed;
    existing.totalTokens += row.totalTokens;
    if (typeof row.latencyMs === 'number') {
      existing.latencySum += row.latencyMs;
      existing.latencyCount += 1;
    }
    existing.successRate = existing.total > 0 ? existing.success / existing.total : 1;
    existing.avgLatencyMs = existing.latencyCount > 0 ? Math.round(existing.latencySum / existing.latencyCount) : undefined;
    map.set(row.provider, existing);
  });

  return Array.from(map.values()).sort(
    (left, right) => right.total - left.total || left.provider.localeCompare(right.provider)
  );
};

const getStatusClassName = (successRate: number, failed: number) => {
  if (failed === 0) return styles.statusGood;
  if (successRate >= 0.9) return styles.statusWarn;
  return styles.statusBad;
};

export function RequestMonitoringPage() {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const usageServiceEnabled = useUsageServiceStore((state) => state.enabled);
  const usageServiceBase = useUsageServiceStore((state) => state.serviceBase);
  const usageServiceQueue = useUsageServiceStore((state) => state.queue);
  const usageServicePopSide = useUsageServiceStore((state) => state.popSide);
  const setUsageServiceEnabled = useUsageServiceStore((state) => state.setEnabled);
  const setUsageServiceBase = useUsageServiceStore((state) => state.setServiceBase);
  const setUsageServiceQueue = useUsageServiceStore((state) => state.setQueue);
  const setUsageServicePopSide = useUsageServiceStore((state) => state.setPopSide);
  const [snapshots, setSnapshots] = useLocalStorage<PersistedRequestSnapshot[]>(STORAGE_KEY, []);
  const [rows, setRows] = useState<RequestMonitorRow[]>(() => buildRowsFromSnapshots(snapshots));
  const [loading, setLoading] = useState(false);
  const [setupLoading, setSetupLoading] = useState(false);
  const [error, setError] = useState('');
  const [dataSource, setDataSource] = useState<DataSource>('api-key-usage');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(() => {
    const latest = snapshots.reduce((max, snapshot) => Math.max(max, snapshot.timestamp), 0);
    return latest > 0 ? new Date(latest) : null;
  });
  const [autoRefresh, setAutoRefresh] = useLocalStorage('requestMonitoring.autoRefresh', true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const snapshotsRef = useRef(snapshots);

  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  useEffect(() => {
    if (connectionStatus !== 'connected' || config) return;
    void fetchConfig(undefined, false);
  }, [config, connectionStatus, fetchConfig]);

  const loadUsage = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');

    try {
      if (usageServiceEnabled && usageServiceBase) {
        try {
          const usage = await usageServiceApi.getUsage(usageServiceBase, managementKey);
          setRows(flattenUsageServicePayload(usage));
          setDataSource('usage-service');
          setLastRefreshedAt(new Date());
          return;
        } catch (usageServiceError) {
          setError(
            `${t('request_monitoring.usage_service_fallback', {
              defaultValue: 'usage-service 读取失败，已回退到聚合用量接口',
            })}: ${usageServiceError instanceof Error ? usageServiceError.message : String(usageServiceError)}`
          );
        }
      }

      const previousById = buildLatestSnapshotMap(snapshotsRef.current);
      const payload = await apiKeyUsageApi.getUsage();
      const next = flattenApiKeyUsagePayload(payload, previousById);
      const nextSnapshots = pruneSnapshots([...snapshotsRef.current, ...next.snapshots]);

      snapshotsRef.current = nextSnapshots;
      setSnapshots(nextSnapshots);
      setRows(next.rows);
      setDataSource('api-key-usage');
      setLastRefreshedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [connectionStatus, managementKey, setSnapshots, t, usageServiceBase, usageServiceEnabled]);

  const setupUsageService = useCallback(async () => {
    if (connectionStatus !== 'connected') return;
    setSetupLoading(true);
    setError('');
    try {
      await usageServiceApi.setup(usageServiceBase, {
        cpaBaseUrl: apiBase,
        managementKey,
        queue: usageServiceQueue,
        popSide: usageServicePopSide,
      });
      setUsageServiceEnabled(true);
      const usage = await usageServiceApi.getUsage(usageServiceBase, managementKey);
      setRows(flattenUsageServicePayload(usage));
      setDataSource('usage-service');
      setLastRefreshedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupLoading(false);
    }
  }, [apiBase, connectionStatus, managementKey, setUsageServiceEnabled, usageServiceBase, usageServicePopSide, usageServiceQueue]);

  useHeaderRefresh(loadUsage);

  useEffect(() => {
    if (connectionStatus === 'connected') {
      void loadUsage();
    }
  }, [connectionStatus, loadUsage]);

  useEffect(() => {
    if (!autoRefresh || connectionStatus !== 'connected') return;
    const id = window.setInterval(() => {
      void loadUsage();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [autoRefresh, connectionStatus, loadUsage]);

  const filteredRows = useMemo(() => {
    const query = deferredSearchQuery.trim().toLowerCase();

    return rows.filter((row) => {
      if (statusFilter === 'success' && row.failed > 0) return false;
      if (statusFilter === 'failed' && row.failed === 0) return false;
      if (!query) return true;

      return [row.provider, row.target, row.apiKeyLabel, row.model, row.endpoint, row.authIndex]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [deferredSearchQuery, rows, statusFilter]);

  const providerRows = useMemo(() => buildProviderRows(filteredRows), [filteredRows]);

  const summary = useMemo(() => {
    const success = filteredRows.reduce((sum, row) => sum + row.success, 0);
    const failed = filteredRows.reduce((sum, row) => sum + row.failed, 0);
    const recentSuccess = filteredRows.reduce((sum, row) => sum + row.recentSuccess, 0);
    const recentFailed = filteredRows.reduce((sum, row) => sum + row.recentFailed, 0);
    const deltaSuccess = filteredRows.reduce((sum, row) => sum + row.deltaSuccess, 0);
    const deltaFailed = filteredRows.reduce((sum, row) => sum + row.deltaFailed, 0);
    const totalTokens = filteredRows.reduce((sum, row) => sum + row.totalTokens, 0);
    const total = success + failed;

    return {
      total,
      success,
      failed,
      successRate: total > 0 ? success / total : 1,
      recentTotal: recentSuccess + recentFailed,
      deltaTotal: deltaSuccess + deltaFailed,
      deltaFailed,
      totalTokens,
    };
  }, [filteredRows]);

  const persistedHistory = useMemo(
    () => snapshots.slice().sort((left, right) => right.timestamp - left.timestamp).slice(0, 80),
    [snapshots]
  );

  const clearPersistedData = useCallback(() => {
    snapshotsRef.current = [];
    setSnapshots([]);
    if (dataSource === 'api-key-usage') setRows([]);
    setLastRefreshedAt(null);
  }, [dataSource, setSnapshots]);

  const renderStatusBadge = (successRate: number, failed: number) => (
    <span className={`${styles.statusBadge} ${getStatusClassName(successRate, failed)}`}>
      {failed > 0
        ? t('request_monitoring.status_failed', { defaultValue: '有失败' })
        : t('request_monitoring.status_success', { defaultValue: '正常' })}
    </span>
  );

  const usageStatsEnabled = config?.usageStatisticsEnabled;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <h1 className={styles.pageTitle}>
            {t('request_monitoring.title', { defaultValue: '请求监控' })}
          </h1>
          <p className={styles.subtitle}>
            {t('request_monitoring.subtitle', {
              defaultValue:
                '优先读取 usage-service 持久化的单次请求事件；不可用时回退到现有 API Key 聚合用量快照。',
            })}
          </p>
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={loadUsage} loading={loading} disabled={connectionStatus !== 'connected'}>
            {t('common.refresh')}
          </Button>
          <Button variant="danger" onClick={clearPersistedData} disabled={snapshots.length === 0 && rows.length === 0}>
            {t('request_monitoring.clear_data', { defaultValue: '清空本地快照' })}
          </Button>
        </div>
      </div>

      {usageStatsEnabled === false ? (
        <div className={styles.errorBox}>
          {t('request_monitoring.usage_statistics_disabled', {
            defaultValue:
              'CPA 配置中的 usage-statistics-enabled 未启用，usage-service 无法从 RESP 队列收到单次请求事件。',
          })}
        </div>
      ) : null}

      <Card className={styles.toolbar}>
        <div className={styles.filterRow}>
          <ToggleSwitch
            checked={usageServiceEnabled}
            onChange={setUsageServiceEnabled}
            disabled={connectionStatus !== 'connected'}
            label={t('request_monitoring.use_usage_service', { defaultValue: '使用 usage-service' })}
          />
          <Input
            value={usageServiceBase}
            onChange={(event) => setUsageServiceBase(event.target.value)}
            placeholder="http://localhost:18317"
            className={styles.searchInput}
            disabled={!usageServiceEnabled || connectionStatus !== 'connected'}
          />
          <Input
            value={usageServiceQueue}
            onChange={(event) => setUsageServiceQueue(event.target.value)}
            placeholder="usage"
            disabled={!usageServiceEnabled || connectionStatus !== 'connected'}
          />
          <div className={styles.segmented}>
            {(['right', 'left'] as const).map((side) => (
              <button
                key={side}
                type="button"
                className={`${styles.segmentButton} ${usageServicePopSide === side ? styles.segmentButtonActive : ''}`}
                onClick={() => setUsageServicePopSide(side)}
                disabled={!usageServiceEnabled || connectionStatus !== 'connected'}
              >
                {side === 'right' ? 'RPOP' : 'LPOP'}
              </button>
            ))}
          </div>
          <Button
            variant="secondary"
            onClick={setupUsageService}
            loading={setupLoading}
            disabled={!usageServiceEnabled || connectionStatus !== 'connected'}
          >
            {t('request_monitoring.setup_usage_service', { defaultValue: '配置采集服务' })}
          </Button>
        </div>
      </Card>

      <section className={styles.summaryGrid}>
        <Card className={styles.summaryCard}>
          <span className={styles.summaryLabel}>{t('request_monitoring.total_requests', { defaultValue: '总请求' })}</span>
          <strong className={styles.summaryValue}>{formatNumber(summary.total)}</strong>
          <span className={styles.summaryMeta}>{`${filteredRows.length} ${t('request_monitoring.entries', { defaultValue: '条记录' })}`}</span>
        </Card>
        <Card className={styles.summaryCard}>
          <span className={styles.summaryLabel}>{t('request_monitoring.success_rate', { defaultValue: '成功率' })}</span>
          <strong className={styles.summaryValue}>{formatPercent(summary.successRate)}</strong>
          <span className={styles.summaryMeta}>{`${formatNumber(summary.success)} / ${formatNumber(summary.failed)}`}</span>
        </Card>
        <Card className={styles.summaryCard}>
          <span className={styles.summaryLabel}>{t('request_monitoring.total_tokens', { defaultValue: 'Token 总量' })}</span>
          <strong className={styles.summaryValue}>{formatNumber(summary.totalTokens)}</strong>
          <span className={styles.summaryMeta}>{dataSource === 'usage-service' ? 'usage-service' : '/api-key-usage'}</span>
        </Card>
        <Card className={styles.summaryCard}>
          <span className={styles.summaryLabel}>{t('request_monitoring.new_since_last', { defaultValue: '本次新增' })}</span>
          <strong className={styles.summaryValue}>{formatNumber(dataSource === 'usage-service' ? summary.recentTotal : summary.deltaTotal)}</strong>
          <span className={styles.summaryMeta}>{`${t('request_monitoring.failed_delta', { defaultValue: '失败新增' })}: ${formatNumber(dataSource === 'usage-service' ? summary.failed : summary.deltaFailed)}`}</span>
        </Card>
      </section>

      <Card className={styles.toolbar}>
        <div className={styles.filterRow}>
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('request_monitoring.search_placeholder', { defaultValue: '搜索提供商、端点、模型、来源或 Auth Index' })}
            className={styles.searchInput}
          />
          <div className={styles.segmented}>
            {(['all', 'success', 'failed'] as StatusFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                className={`${styles.segmentButton} ${statusFilter === filter ? styles.segmentButtonActive : ''}`}
                onClick={() => setStatusFilter(filter)}
              >
                {filter === 'all'
                  ? t('request_monitoring.filter_all', { defaultValue: '全部' })
                  : filter === 'success'
                    ? t('request_monitoring.filter_success', { defaultValue: '仅正常' })
                    : t('request_monitoring.filter_failed', { defaultValue: '有失败' })}
              </button>
            ))}
          </div>
          <ToggleSwitch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            disabled={connectionStatus !== 'connected'}
            label={t('request_monitoring.auto_refresh', { defaultValue: '10 秒自动刷新' })}
          />
        </div>
        <div className={styles.metaRow}>
          <span className={styles.metaPill}>
            {`${t('request_monitoring.connection', { defaultValue: '连接' })}: ${connectionStatus}`}
          </span>
          <span className={styles.metaPill}>
            {`${t('request_monitoring.data_source', { defaultValue: '数据源' })}: ${dataSource}`}
          </span>
          <span className={styles.metaPill}>
            {`${t('request_monitoring.last_refresh', { defaultValue: '上次刷新' })}: ${lastRefreshedAt ? lastRefreshedAt.toLocaleString(i18n.language) : '--'}`}
          </span>
          <span className={styles.metaPill}>
            {`${t('request_monitoring.persisted_snapshots', { defaultValue: '本地快照' })}: ${formatNumber(snapshots.length)}`}
          </span>
        </div>
        {error ? <div className={styles.errorBox}>{error}</div> : null}
      </Card>

      <Card title={t('request_monitoring.provider_overview', { defaultValue: '提供商概览' })}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('request_monitoring.provider', { defaultValue: '提供商' })}</th>
                <th>{t('request_monitoring.entries', { defaultValue: '记录' })}</th>
                <th>{t('request_monitoring.total_requests', { defaultValue: '总请求' })}</th>
                <th>{t('request_monitoring.success', { defaultValue: '成功' })}</th>
                <th>{t('request_monitoring.failed', { defaultValue: '失败' })}</th>
                <th>{t('request_monitoring.success_rate', { defaultValue: '成功率' })}</th>
                <th>{t('request_monitoring.total_tokens', { defaultValue: 'Token' })}</th>
                <th>{t('request_monitoring.avg_latency', { defaultValue: '平均延迟' })}</th>
                <th>{t('request_monitoring.status', { defaultValue: '状态' })}</th>
              </tr>
            </thead>
            <tbody>
              {providerRows.map((row) => (
                <tr key={row.provider}>
                  <td className={styles.monoCell}>{row.provider}</td>
                  <td>{formatNumber(row.entries)}</td>
                  <td>{formatNumber(row.total)}</td>
                  <td className={styles.deltaGood}>{formatNumber(row.success)}</td>
                  <td className={row.failed > 0 ? styles.deltaBad : undefined}>{formatNumber(row.failed)}</td>
                  <td>{formatPercent(row.successRate)}</td>
                  <td>{formatNumber(row.totalTokens)}</td>
                  <td>{formatLatency(row.avgLatencyMs)}</td>
                  <td>{renderStatusBadge(row.successRate, row.failed)}</td>
                </tr>
              ))}
              {providerRows.length === 0 ? (
                <tr>
                  <td colSpan={9}>
                    <div className={styles.emptyState}>
                      {t('request_monitoring.no_data', { defaultValue: '暂无请求监控数据' })}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={t('request_monitoring.request_details', { defaultValue: '请求明细' })}>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('request_monitoring.time', { defaultValue: '时间' })}</th>
                <th>{t('request_monitoring.target', { defaultValue: '端点' })}</th>
                <th>{t('request_monitoring.model', { defaultValue: '模型' })}</th>
                <th>{t('request_monitoring.source', { defaultValue: '来源' })}</th>
                <th>{t('request_monitoring.auth_index', { defaultValue: 'Auth Index' })}</th>
                <th>{t('request_monitoring.tokens', { defaultValue: 'Token' })}</th>
                <th>{t('request_monitoring.latency', { defaultValue: '延迟' })}</th>
                <th>{t('request_monitoring.status', { defaultValue: '状态' })}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={`${row.id}-${row.timestamp}`}>
                  <td>{new Date(row.timestamp).toLocaleString(i18n.language)}</td>
                  <td>
                    <div className={styles.primaryCell}>
                      <span className={styles.monoCell}>{row.provider}</span>
                      <small className={styles.monoCell}>{row.endpoint}</small>
                    </div>
                  </td>
                  <td className={styles.monoCell}>{row.model}</td>
                  <td className={styles.monoCell}>{row.source}</td>
                  <td className={styles.monoCell}>{row.authIndex}</td>
                  <td>{formatNumber(row.totalTokens)}</td>
                  <td>{formatLatency(row.latencyMs)}</td>
                  <td>{renderStatusBadge(row.successRate, row.failed)}</td>
                </tr>
              ))}
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={8}>
                    <div className={styles.emptyState}>
                      {t('request_monitoring.no_data', { defaultValue: '暂无请求监控数据' })}
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {dataSource === 'api-key-usage' ? (
        <Card title={t('request_monitoring.persisted_history', { defaultValue: '本地快照历史' })}>
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{t('request_monitoring.time', { defaultValue: '时间' })}</th>
                  <th>{t('request_monitoring.provider', { defaultValue: '提供商' })}</th>
                  <th>{t('request_monitoring.target', { defaultValue: '目标' })}</th>
                  <th>{t('request_monitoring.total_requests', { defaultValue: '总请求' })}</th>
                  <th>{t('request_monitoring.success', { defaultValue: '成功' })}</th>
                  <th>{t('request_monitoring.failed', { defaultValue: '失败' })}</th>
                  <th>{t('request_monitoring.recent_requests', { defaultValue: '近期请求' })}</th>
                </tr>
              </thead>
              <tbody>
                {persistedHistory.map((snapshot, index) => (
                  <tr key={`${snapshot.id}-${snapshot.timestamp}-${index}`}>
                    <td>{new Date(snapshot.timestamp).toLocaleString(i18n.language)}</td>
                    <td className={styles.monoCell}>{snapshot.provider}</td>
                    <td>
                      <div className={styles.primaryCell}>
                        <span className={styles.monoCell}>{snapshot.baseUrl}</span>
                        <small className={styles.monoCell}>{snapshot.apiKeyLabel}</small>
                      </div>
                    </td>
                    <td>{formatNumber(snapshot.success + snapshot.failed)}</td>
                    <td className={styles.deltaGood}>{formatNumber(snapshot.success)}</td>
                    <td className={snapshot.failed > 0 ? styles.deltaBad : undefined}>{formatNumber(snapshot.failed)}</td>
                    <td>{`${formatNumber(snapshot.recentSuccess)} / ${formatNumber(snapshot.recentFailed)}`}</td>
                  </tr>
                ))}
                {persistedHistory.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className={styles.emptyState}>
                        {t('request_monitoring.no_persisted_data', { defaultValue: '暂无本地快照' })}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
