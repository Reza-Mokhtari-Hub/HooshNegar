import React, { useCallback, useEffect, useState } from 'react';
import { Plus, PlugZap, KeyRound, Pencil, Trash2, Search } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatDateTime, formatNumber, type Locale } from '../../i18n';
import { PROVIDER_TYPES, type ProviderType } from '../../shared/validation';
import {
  Button,
  EmptyState,
  FieldLabel,
  Input,
  Modal,
  Select,
  StatusText,
  Surface,
  TableSkeleton,
  Textarea,
} from '../ui/primitives';

export interface ProviderRecord {
  id: string;
  name: string;
  slug: string;
  providerType: ProviderType;
  baseUrl: string;
  organizationId: string | null;
  additionalHeaders: Record<string, string>;
  connectionStatus: 'untested' | 'connected' | 'degraded' | 'failed';
  lastTestMessage: string | null;
  lastTestLatencyMs: number | null;
  lastTestedAt: string | null;
  isActive: boolean;
  priority: number;
  createdAt: string;
  updatedAt: string;
  hasCredential: boolean;
  maskedApiKey: string | null;
  keyVersion: number | null;
  modelsTotal: number;
  modelsActive: number;
}

const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai_compatible: 'https://api.openai.com/v1',
  google_gemini: 'https://generativelanguage.googleapis.com',
  anthropic: 'https://api.anthropic.com',
  replicate: 'https://api.replicate.com',
  fal_ai: 'https://api.fal.ai',
  custom: 'https://api.example.com/v1',
};

export function ProvidersSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [testingId, setTestingId] = useState<string | null>(null);

  // Create / Edit modal state
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProviderRecord | null>(null);
  const [name, setName] = useState('');
  const [providerType, setProviderType] = useState<ProviderType>('openai_compatible');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URLS.openai_compatible);
  const [apiKey, setApiKey] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [headersJson, setHeadersJson] = useState('{}');
  const [priority, setPriority] = useState(100);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  // Rotate Key modal state
  const [rotateTarget, setRotateTarget] = useState<ProviderRecord | null>(null);
  const [newApiKey, setNewApiKey] = useState('');
  const [rotating, setRotating] = useState(false);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{ providers: ProviderRecord[] }>('/api/providers');
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'خطا در بارگذاری ارائه‌دهندگان');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const openCreateModal = () => {
    setEditing(null);
    setName('');
    setProviderType('openai_compatible');
    setBaseUrl(DEFAULT_BASE_URLS.openai_compatible);
    setApiKey('');
    setOrganizationId('');
    setHeadersJson('{}');
    setPriority(100);
    setIsActive(true);
    setFormOpen(true);
  };

  const openEditModal = (p: ProviderRecord) => {
    setEditing(p);
    setName(p.name);
    setProviderType(p.providerType);
    setBaseUrl(p.baseUrl);
    setApiKey('');
    setOrganizationId(p.organizationId ?? '');
    setHeadersJson(JSON.stringify(p.additionalHeaders ?? {}, null, 2));
    setPriority(p.priority);
    setIsActive(p.isActive);
    setFormOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      let parsedHeaders: Record<string, string> = {};
      if (headersJson.trim()) {
        const raw = JSON.parse(headersJson) as unknown;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error(locale === 'fa' ? 'ساختار JSON هدرهای اضافی نامعتبر است.' : 'Invalid headers JSON object.');
        }
        parsedHeaders = raw as Record<string, string>;
      }

      if (editing) {
        await apiRequest(`/api/providers/${editing.id}`, {
          method: 'PATCH',
          body: {
            name: name.trim(),
            providerType,
            baseUrl: baseUrl.trim(),
            organizationId: organizationId.trim() || null,
            additionalHeaders: parsedHeaders,
            priority: Number(priority),
            isActive,
          },
        });
        setFeedback({
          tone: 'success',
          text: locale === 'fa' ? 'اطلاعات ارائه‌دهنده با موفقیت بروزرسانی شد.' : 'Provider updated.',
        });
      } else {
        await apiRequest('/api/providers', {
          method: 'POST',
          body: {
            name: name.trim(),
            providerType,
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
            organizationId: organizationId.trim(),
            additionalHeaders: parsedHeaders,
            priority: Number(priority),
            isActive,
          },
        });
        setFeedback({
          tone: 'success',
          text:
            locale === 'fa'
              ? 'ارائه‌دهنده ایجاد شد و کلید API با AES-256-GCM رمزنگاری و ذخیره شد.'
              : 'Provider created and API key encrypted with AES-256-GCM.',
        });
      }

      setFormOpen(false);
      await loadProviders();
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'خطا در ذخیره ارائه‌دهنده',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleRotateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rotateTarget) return;
    setRotating(true);
    setFeedback(null);
    try {
      await apiRequest(`/api/providers/${rotateTarget.id}/rotate-key`, {
        method: 'POST',
        body: { apiKey: newApiKey.trim() },
      });
      setRotateTarget(null);
      setNewApiKey('');
      setFeedback({
        tone: 'success',
        text:
          locale === 'fa'
            ? 'کلید امنیتی جدید رمزنگاری شد و کلید قبلی باطل گردید.'
            : 'API key rotated securely and previous key revoked.',
      });
      await loadProviders();
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'خطا در چرخش کلید',
      });
    } finally {
      setRotating(false);
    }
  };

  const handleTestConnection = async (p: ProviderRecord) => {
    setTestingId(p.id);
    setFeedback(null);
    try {
      const res = await apiRequest<{
        result: { ok: boolean; message: string; latencyMs: number; protocol: string };
      }>(`/api/providers/${p.id}/test`, { method: 'POST' });

      setFeedback({
        tone: res.result.ok ? 'success' : 'danger',
        text: `${p.name} (${res.result.protocol} · ${res.result.latencyMs}ms): ${res.result.message}`,
      });
      await loadProviders();
    } catch (err) {
      setFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : 'خطا در تست اتصال',
      });
    } finally {
      setTestingId(null);
    }
  };

  const handleToggleActive = async (p: ProviderRecord) => {
    try {
      await apiRequest(`/api/providers/${p.id}`, {
        method: 'PATCH',
        body: { isActive: !p.isActive },
      });
      await loadProviders();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تغییر وضعیت' });
    }
  };

  const handleDelete = async (p: ProviderRecord) => {
    try {
      await apiRequest(`/api/providers/${p.id}`, { method: 'DELETE' });
      setFeedback({
        tone: 'success',
        text: locale === 'fa' ? `ارائه‌دهنده «${p.name}» حذف شد.` : `Provider "${p.name}" deleted.`,
      });
      await loadProviders();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در حذف' });
    }
  };

  const filtered = providers.filter((p) => {
    const matchesSearch =
      !search.trim() ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.baseUrl.toLowerCase().includes(search.toLowerCase());
    const matchesType = filterType === 'all' || p.providerType === filterType;
    return matchesSearch && matchesType;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.providers}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'مدیریت چندارائه‌دهنده با آداپتورهای اختصاصی پروتکل و رمزنگاری سمت سرور AES-256-GCM.'
              : 'Multi-provider protocol adapters with server-side AES-256-GCM credential encryption.'}
          </p>
        </div>
        <Button onClick={openCreateModal}>
          <Plus className="w-4 h-4" />
          <span>{locale === 'fa' ? 'افزودن ارائه‌دهنده جدید' : 'Add AI Provider'}</span>
        </Button>
      </div>

      {feedback && (
        <div
          role="status"
          className={`p-3.5 rounded-xl border text-xs ${
            feedback.tone === 'success'
              ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900 text-emerald-800 dark:text-emerald-200'
              : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900 text-red-800 dark:text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}

      {error && (
        <div className="p-3.5 rounded-xl border border-red-200 bg-red-50 text-xs text-red-700">{error}</div>
      )}

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute top-3 start-3 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={locale === 'fa' ? 'جستجو بر اساس نام یا آدرس پایه...' : 'Search by name or base URL...'}
            className="ps-9"
          />
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => setFilterType('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
              filterType === 'all'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
            }`}
          >
            {t.common.all}
          </button>
          {PROVIDER_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setFilterType(type)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                filterType === type
                  ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
              }`}
            >
              {t.providerTypes[type]}
            </button>
          ))}
        </div>
      </div>

      {/* Providers Table */}
      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'هیچ ارائه‌دهنده‌ای ثبت نشده است' : 'No AI providers configured'}
            description={
              locale === 'fa'
                ? 'ارائه‌دهندگان OpenAI، Google Gemini، Anthropic، Replicate، fal.ai یا سرویس‌های سفارشی را بدون نیاز به ویرایش کد اضافه کنید.'
                : 'Add OpenAI-compatible, Google Gemini, Anthropic, Replicate, fal.ai, or custom endpoints without code edits.'
            }
            action={
              <Button onClick={openCreateModal}>
                <Plus className="w-4 h-4" />
                <span>{locale === 'fa' ? 'ثبت اولین ارائه‌دهنده' : 'Add First Provider'}</span>
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'ارائه‌دهنده و پروتکل' : 'Provider & Protocol'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'کلید رمزنگاری‌شده' : 'Masked Credential'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'وضعیت اتصال' : 'Connection'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اولویت / مدل‌ها' : 'Priority / Models'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">{p.name}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {t.providerTypes[p.providerType]} ·{' '}
                        <span dir="ltr" className="font-mono">
                          {p.baseUrl}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-mono text-slate-700 dark:text-slate-300">
                        <span dir="ltr" className="inline-block">
                          {p.maskedApiKey ?? '—'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        <span dir="ltr" className="inline-block">
                          AES-256-GCM {p.keyVersion ? `· v${p.keyVersion}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusText
                        tone={
                          p.connectionStatus === 'connected'
                            ? 'success'
                            : p.connectionStatus === 'degraded'
                              ? 'warning'
                              : p.connectionStatus === 'failed'
                                ? 'danger'
                                : 'neutral'
                        }
                      >
                        {t.connectionStatuses[p.connectionStatus]}
                      </StatusText>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 max-w-[240px] truncate" title={p.lastTestMessage ?? ''}>
                        {p.lastTestLatencyMs !== null ? `${p.lastTestLatencyMs}ms · ` : ''}
                        {p.lastTestedAt ? formatDateTime(p.lastTestedAt, locale) : locale === 'fa' ? 'هنوز تست نشده' : 'Not tested'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 tabular-nums text-slate-700 dark:text-slate-300">
                      <div className="font-mono">
                        <span dir="ltr" className="inline-block">
                          #{p.priority}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {formatNumber(p.modelsActive, locale)}/{formatNumber(p.modelsTotal, locale)}{' '}
                        {locale === 'fa' ? 'مدل فعال' : 'models'}
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(p)}
                        className="text-xs font-medium underline-offset-4 hover:underline cursor-pointer"
                      >
                        <StatusText tone={p.isActive ? 'success' : 'neutral'}>
                          {p.isActive ? t.common.active : t.common.inactive}
                        </StatusText>
                      </button>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleTestConnection(p)}
                          disabled={testingId === p.id}
                          aria-label={`${t.common.testConnection} ${p.name}`}
                        >
                          <PlugZap className="w-3.5 h-3.5" />
                          <span>{testingId === p.id ? t.common.testing : t.common.testConnection}</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setRotateTarget(p);
                            setNewApiKey('');
                          }}
                          aria-label={`${t.common.rotateKey} ${p.name}`}
                          title={t.common.rotateKey}
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditModal(p)}
                          aria-label={`${t.common.edit} ${p.name}`}
                          title={t.common.edit}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(p)}
                          aria-label={`${t.common.delete} ${p.name}`}
                          title={t.common.delete}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/40"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Surface>

      {/* Create / Edit Provider Modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={
          editing
            ? locale === 'fa'
              ? `ویرایش ارائه‌دهنده: ${editing.name}`
              : `Edit Provider: ${editing.name}`
            : locale === 'fa'
              ? 'افزودن ارائه‌دهنده هوش مصنوعی'
              : 'Add AI Provider'
        }
        description={
          locale === 'fa'
            ? 'کلید API بلافاصله در سرور با الگوریتم AES-256-GCM رمزنگاری شده و هرگز به مرورگر بازگردانده نمی‌شود.'
            : 'API keys are encrypted server-side with AES-256-GCM and never returned to the browser.'
        }
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="prov-name" required>
                {locale === 'fa' ? 'نام ارائه‌دهنده' : 'Provider Name'}
              </FieldLabel>
              <Input
                id="prov-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={locale === 'fa' ? 'مثلاً OpenAI Production' : 'e.g. OpenAI Production'}
              />
            </div>

            <div>
              <FieldLabel htmlFor="prov-type" required>
                {locale === 'fa' ? 'نوع پروتکل (آداپتور)' : 'Provider Protocol Type'}
              </FieldLabel>
              <Select
                id="prov-type"
                value={providerType}
                onChange={(e) => {
                  const nextType = e.target.value as ProviderType;
                  setProviderType(nextType);
                  if (!editing) {
                    setBaseUrl(DEFAULT_BASE_URLS[nextType]);
                  }
                }}
              >
                {PROVIDER_TYPES.map((pt) => (
                  <option key={pt} value={pt}>
                    {t.providerTypes[pt]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="prov-url" required>
              {locale === 'fa' ? 'آدرس پایه API (Base URL)' : 'API Base URL'}
            </FieldLabel>
            <Input
              id="prov-url"
              type="url"
              dir="ltr"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>

          {!editing && (
            <div>
              <FieldLabel htmlFor="prov-key" required>
                {locale === 'fa' ? 'کلید API (ذخیره رمزنگاری‌شده AES-256-GCM)' : 'API Key (AES-256-GCM Encrypted)'}
              </FieldLabel>
              <Input
                id="prov-key"
                type="password"
                dir="ltr"
                required
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="off"
              />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="prov-org">
                {locale === 'fa' ? 'شناسه سازمان (اختیاری)' : 'Organization ID (Optional)'}
              </FieldLabel>
              <Input
                id="prov-org"
                dir="ltr"
                value={organizationId}
                onChange={(e) => setOrganizationId(e.target.value)}
                placeholder="org-..."
              />
            </div>

            <div>
              <FieldLabel htmlFor="prov-priority">
                {locale === 'fa' ? 'اولویت مسیریابی (عدد کمتر = اولویت بالاتر)' : 'Routing Priority (lower = higher)'}
              </FieldLabel>
              <Input
                id="prov-priority"
                type="number"
                min={0}
                max={10000}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="prov-headers">
              {locale === 'fa' ? 'هدرهای HTTP اضافی (JSON اختیاری)' : 'Additional HTTP Headers (JSON)'}
            </FieldLabel>
            <Textarea
              id="prov-headers"
              dir="ltr"
              rows={3}
              className="font-mono text-xs"
              value={headersJson}
              onChange={(e) => setHeadersJson(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2.5 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-blue-700"
            />
            <span>{locale === 'fa' ? 'ارائه‌دهنده در حالت فعال باشد' : 'Provider is active'}</span>
          </label>

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? t.common.saving : t.common.save}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Rotate Key Modal */}
      <Modal
        open={Boolean(rotateTarget)}
        onClose={() => setRotateTarget(null)}
        maxWidth="max-w-md"
        title={
          locale === 'fa'
            ? `چرخش کلید امنیتی: ${rotateTarget?.name ?? ''}`
            : `Rotate API Key: ${rotateTarget?.name ?? ''}`
        }
        description={
          locale === 'fa'
            ? 'کلید قبلی به صورت تراکنشی باطل شده و نسخه جدید با رمزنگاری AES-256-GCM جایگزین می‌شود.'
            : 'The current key will be atomically revoked and replaced with a new AES-256-GCM encrypted version.'
        }
      >
        <form onSubmit={handleRotateKey} className="space-y-4">
          <div>
            <FieldLabel htmlFor="rotate-key-input" required>
              {locale === 'fa' ? 'کلید API جدید' : 'New API Key'}
            </FieldLabel>
            <Input
              id="rotate-key-input"
              type="password"
              dir="ltr"
              required
              value={newApiKey}
              onChange={(e) => setNewApiKey(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
          </div>
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setRotateTarget(null)}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={rotating}>
              {rotating ? t.common.saving : t.common.rotateKey}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
