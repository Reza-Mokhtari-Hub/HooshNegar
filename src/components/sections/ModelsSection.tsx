import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Search, RefreshCw, Sparkles, ShieldCheck } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatNumber, type Locale } from '../../i18n';
import {
  CAPABILITY_TYPES,
  MODEL_CATEGORIES,
  PLAN_TIERS,
  type CapabilityType,
  type ModelCategory,
  type PlanTier,
} from '../../shared/validation';
import type { ProviderRecord } from './ProvidersSection';
import { ModelHealthPrunerModal } from './ModelHealthPrunerModal';
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

export interface ModelRecord {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  modelIdentifier: string;
  category: ModelCategory;
  description: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  creditCost: number;
  minCreditCost?: number;
  providerCostPerOpUsd?: number;
  allowedPlanTiers?: PlanTier[];
  estimatedRevenuePerOpUsd?: number;
  estimatedProfitPerOpUsd?: number;
  priority: number;
  isDefault: boolean;
  isActive: boolean;
  maxInputSize: number;
  maxOutputSize: number;
  fallbackProviderId?: string | null;
  fallbackModelIdentifier?: string | null;
  modelParameters: Record<string, unknown>;
  capabilities: CapabilityType[];
  createdAt: string;
  updatedAt: string;
}

interface DiscoveredModelItem {
  name: string;
  modelIdentifier: string;
  category: ModelCategory;
  capabilities: CapabilityType[];
  description: string;
  maxInputSize: number;
  maxOutputSize: number;
  creditCost: number;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  modelParameters: Record<string, unknown>;
}

const DEFAULT_CAPS_BY_CATEGORY: Record<ModelCategory, CapabilityType[]> = {
  llm: ['text_generation', 'chat'],
  multimodal: ['text_generation', 'chat', 'vision', 'document_analysis'],
  image: ['image_generation', 'image_editing', 'image_variation'],
  audio: ['speech_generation', 'audio_transcription'],
  video: ['video_generation'],
  embedding: ['embeddings'],
  document: ['document_analysis', 'vision', 'chat'],
};

export function ModelsSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [capFilter, setCapFilter] = useState<string>('all');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [prunerOpen, setPrunerOpen] = useState(false);
  const [editing, setEditing] = useState<ModelRecord | null>(null);
  const [providerId, setProviderId] = useState('');
  const [name, setName] = useState('');
  const [modelIdentifier, setModelIdentifier] = useState('');
  const [category, setCategory] = useState<ModelCategory>('llm');
  const [description, setDescription] = useState('');
  const [capabilities, setCapabilities] = useState<CapabilityType[]>(['text_generation', 'chat']);
  const [inputPrice, setInputPrice] = useState(0);
  const [outputPrice, setOutputPrice] = useState(0);
  const [creditCost, setCreditCost] = useState(1);
  const [minCreditCost, setMinCreditCost] = useState(0);
  const [providerCostPerOpUsd, setProviderCostPerOpUsd] = useState(0);
  const [allowedPlanTiers, setAllowedPlanTiers] = useState<PlanTier[]>([]);
  const [priority, setPriority] = useState(100);
  const [maxInputSize, setMaxInputSize] = useState(128000);
  const [maxOutputSize, setMaxOutputSize] = useState(8192);
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [fallbackProviderId, setFallbackProviderId] = useState('');
  const [fallbackModelIdentifier, setFallbackModelIdentifier] = useState('');
  const [paramsJson, setParamsJson] = useState('{}');
  const [saving, setSaving] = useState(false);

  // Discovery picker inside Add Model modal
  const [discovering, setDiscovering] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModelItem[]>([]);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [modelsRes, providersRes] = await Promise.all([
        apiRequest<{ models: ModelRecord[] }>('/api/models'),
        apiRequest<{ providers: ProviderRecord[] }>('/api/providers'),
      ]);
      setModels(modelsRes.models);
      setProviders(providersRes.providers);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در بارگذاری مدل‌ها' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const openCreate = () => {
    setEditing(null);
    setProviderId(providers[0]?.id ?? '');
    setName('');
    setModelIdentifier('');
    setCategory('llm');
    setDescription('');
    setCapabilities(DEFAULT_CAPS_BY_CATEGORY.llm);
    setInputPrice(0);
    setOutputPrice(0);
    setCreditCost(1);
    setMinCreditCost(0);
    setProviderCostPerOpUsd(0);
    setAllowedPlanTiers([]);
    setPriority(100);
    setMaxInputSize(128000);
    setMaxOutputSize(8192);
    setIsDefault(false);
    setIsActive(true);
    setFallbackProviderId('');
    setFallbackModelIdentifier('');
    setParamsJson('{}');
    setDiscoveredModels([]);
    setDiscoverNote(null);
    setFormOpen(true);
  };

  const openEdit = (m: ModelRecord) => {
    setEditing(m);
    setProviderId(m.providerId);
    setName(m.name);
    setModelIdentifier(m.modelIdentifier);
    setCategory(m.category);
    setDescription(m.description);
    setCapabilities(m.capabilities);
    setInputPrice(m.inputPricePerMillion);
    setOutputPrice(m.outputPricePerMillion);
    setCreditCost(m.creditCost);
    setMinCreditCost(m.minCreditCost ?? 0);
    setProviderCostPerOpUsd(m.providerCostPerOpUsd ?? 0);
    setAllowedPlanTiers(m.allowedPlanTiers ?? []);
    setPriority(m.priority);
    setMaxInputSize(m.maxInputSize);
    setMaxOutputSize(m.maxOutputSize);
    setIsDefault(m.isDefault);
    setIsActive(m.isActive);
    setFallbackProviderId(m.fallbackProviderId ?? '');
    setFallbackModelIdentifier(m.fallbackModelIdentifier ?? '');
    setParamsJson(JSON.stringify(m.modelParameters ?? {}, null, 2));
    setDiscoveredModels([]);
    setDiscoverNote(null);
    setFormOpen(true);
  };

  const handleDiscoverFromProvider = async () => {
    if (!providerId) return;
    setDiscovering(true);
    setDiscoverNote(null);
    try {
      const res = await apiRequest<{
        ok: boolean;
        discoveredModels: DiscoveredModelItem[];
        message: string;
      }>(`/api/providers/${providerId}/sync-models`, {
        method: 'POST',
        body: { discoverOnly: true },
      });
      setDiscoveredModels(res.discoveredModels ?? []);
      setDiscoverNote(res.message);
    } catch (err) {
      setDiscoverNote(err instanceof Error ? err.message : 'خطا در دریافت لیست مدل‌ها');
    } finally {
      setDiscovering(false);
    }
  };

  const handleSyncAllFromProvider = async () => {
    if (!providerId) return;
    setSyncingAll(true);
    setDiscoverNote(null);
    try {
      const res = await apiRequest<{
        ok: boolean;
        createdCount: number;
        message: string;
      }>(`/api/providers/${providerId}/sync-models`, {
        method: 'POST',
        body: { activateAll: true },
      });
      setFeedback({ tone: 'success', text: res.message });
      setFormOpen(false);
      await loadData();
    } catch (err) {
      setDiscoverNote(err instanceof Error ? err.message : 'خطا در همگام‌سازی همه مدل‌ها');
    } finally {
      setSyncingAll(false);
    }
  };

  const applyDiscoveredSpec = (spec: DiscoveredModelItem) => {
    setName(spec.name);
    setModelIdentifier(spec.modelIdentifier);
    setCategory(spec.category);
    setCapabilities(spec.capabilities);
    setDescription(spec.description ?? '');
    setMaxInputSize(spec.maxInputSize);
    setMaxOutputSize(spec.maxOutputSize);
    setCreditCost(spec.creditCost);
    setParamsJson(JSON.stringify(spec.modelParameters ?? {}, null, 2));
  };

  const toggleCapability = (cap: CapabilityType) => {
    setCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((item) => item !== cap) : [...prev, cap],
    );
  };

  const togglePlanTier = (tier: PlanTier) => {
    setAllowedPlanTiers((prev) =>
      prev.includes(tier) ? prev.filter((item) => item !== tier) : [...prev, tier],
    );
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (capabilities.length === 0) {
      setFeedback({
        tone: 'danger',
        text: locale === 'fa' ? 'حداقل یک قابلیت برای مدل انتخاب کنید.' : 'Select at least one capability.',
      });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      let modelParameters: Record<string, unknown> = {};
      if (paramsJson.trim()) {
        const parsed = JSON.parse(paramsJson) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('پارامترهای مدل باید یک آبجکت JSON معتبر باشد.');
        }
        modelParameters = parsed as Record<string, unknown>;
      }

      const payload = {
        providerId,
        name: name.trim(),
        modelIdentifier: modelIdentifier.trim(),
        category,
        description: description.trim(),
        capabilities,
        inputPricePerMillion: Number(inputPrice),
        outputPricePerMillion: Number(outputPrice),
        creditCost: Number(creditCost),
        minCreditCost: Number(minCreditCost),
        providerCostPerOpUsd: Number(providerCostPerOpUsd),
        allowedPlanTiers,
        priority: Number(priority),
        maxInputSize: Number(maxInputSize),
        maxOutputSize: Number(maxOutputSize),
        isDefault,
        isActive,
        fallbackProviderId: fallbackProviderId || null,
        fallbackModelIdentifier: fallbackModelIdentifier.trim() || null,
        modelParameters,
      };

      if (editing) {
        await apiRequest(`/api/models/${editing.id}`, { method: 'PATCH', body: payload });
        setFeedback({ tone: 'success', text: locale === 'fa' ? 'مدل هوش مصنوعی بروزرسانی شد.' : 'Model updated.' });
      } else {
        await apiRequest('/api/models', { method: 'POST', body: payload });
        setFeedback({ tone: 'success', text: locale === 'fa' ? 'مدل هوش مصنوعی با قابلیت‌ها ثبت شد.' : 'Model created.' });
      }
      setFormOpen(false);
      await loadData();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ذخیره مدل' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (m: ModelRecord) => {
    try {
      await apiRequest(`/api/models/${m.id}`, { method: 'PATCH', body: { isActive: !m.isActive } });
      await loadData();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در تغییر وضعیت' });
    }
  };

  const handleDelete = async (m: ModelRecord) => {
    try {
      await apiRequest(`/api/models/${m.id}`, { method: 'DELETE' });
      setFeedback({ tone: 'success', text: locale === 'fa' ? `مدل «${m.name}» حذف شد.` : `Model "${m.name}" deleted.` });
      await loadData();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در حذف مدل' });
    }
  };

  const filtered = models.filter((m) => {
    const matchSearch =
      !search.trim() ||
      m.name.toLowerCase().includes(search.toLowerCase()) ||
      m.modelIdentifier.toLowerCase().includes(search.toLowerCase()) ||
      m.providerName.toLowerCase().includes(search.toLowerCase());
    const matchCap = capFilter === 'all' || m.capabilities.includes(capFilter as CapabilityType);
    return matchSearch && matchCap;
  });

  const modelCountsByProvider = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of models) {
      counts[m.providerId] = (counts[m.providerId] ?? 0) + 1;
    }
    return counts;
  }, [models]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.models}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'تعریف مدل‌ها با معماری مبتنی بر قابلیت (متن، گفتگو، بینایی، تصویر، صوت، ویدیو، اسناد) و تعرفه اعتبار.'
              : 'Capability-based model registry supporting text, vision, image, audio, video, embeddings, and documents.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setPrunerOpen(true)}
            disabled={models.length === 0}
          >
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <span>
              {locale === 'fa' ? 'پالایش هوشمند مدل‌های سالم' : 'Smart Health Pruner'}
            </span>
          </Button>
          <Button onClick={openCreate} disabled={providers.length === 0}>
            <Plus className="w-4 h-4" />
            <span>{locale === 'fa' ? 'افزودن مدل جدید' : 'Add AI Model'}</span>
          </Button>
        </div>
      </div>

      {providers.length === 0 && !loading && (
        <div className="p-4 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 text-xs text-amber-900 dark:text-amber-200">
          {locale === 'fa'
            ? 'برای ثبت مدل جدید، ابتدا حداقل یک ارائه‌دهنده هوش مصنوعی در بخش «ارائه‌دهندگان هوش مصنوعی» تعریف کنید.'
            : 'Configure at least one AI provider in the AI Providers section before registering models.'}
        </div>
      )}

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

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute top-3 start-3 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={locale === 'fa' ? 'جستجوی نام یا شناسه مدل...' : 'Search model name or ID...'}
            className="ps-9"
          />
        </div>

        <div className="w-full sm:w-64">
          <Select
            aria-label={locale === 'fa' ? 'فیلتر بر اساس قابلیت' : 'Filter by capability'}
            value={capFilter}
            onChange={(e) => setCapFilter(e.target.value)}
          >
            <option value="all">
              {locale === 'fa' ? 'همه قابلیت‌ها (۱۱ قابلیت)' : 'All Capabilities (11)'}
            </option>
            {CAPABILITY_TYPES.map((cap) => (
              <option key={cap} value={cap}>
                {t.capabilities[cap]}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <Surface className="overflow-hidden">
        {loading ? (
          <TableSkeleton rows={4} cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={locale === 'fa' ? 'مدلی یافت نشد' : 'No AI models registered'}
            description={
              locale === 'fa'
                ? 'مدل‌های هر ارائه‌دهنده را همراه با قابلیت‌های دقیق، هزینه اعتبار و محدودیت ورودی/خروجی ثبت کنید.'
                : 'Register models per provider with explicit capabilities, credit costs, and context limits.'
            }
            action={
              providers.length > 0 ? (
                <Button onClick={openCreate}>
                  <Plus className="w-4 h-4" />
                  <span>{locale === 'fa' ? 'ثبت اولین مدل' : 'Register First Model'}</span>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'مدل و شناسه' : 'Model & Identifier'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'ارائه‌دهنده / دسته' : 'Provider / Category'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'قابلیت‌های پشتیبانی‌شده' : 'Capabilities'}</th>
                  <th className="py-3 px-4 text-start">{locale === 'fa' ? 'تعرفه و اعتبار' : 'Pricing & Credits'}</th>
                  <th className="py-3 px-4 text-start">{t.common.status}</th>
                  <th className="py-3 px-4 text-end">{t.common.actions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {filtered.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40 transition-colors">
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {m.name}
                        {m.isDefault && (
                          <span className="ms-2 text-[11px] font-medium text-blue-700 dark:text-blue-400">
                            · {locale === 'fa' ? 'پیش‌فرض' : 'Default'}
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        <span dir="ltr" className="inline-block">
                          {m.modelIdentifier}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="text-slate-800 dark:text-slate-200">{m.providerName}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                        {t.modelCategories[m.category]}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 max-w-xs">
                      <div className="text-slate-700 dark:text-slate-300 leading-relaxed">
                        {m.capabilities.map((cap) => t.capabilities[cap]).join(' · ')}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 tabular-nums text-slate-700 dark:text-slate-300">
                      <div className={`font-medium ${locale === 'en' ? 'font-mono' : ''}`}>
                        {formatNumber(Math.max(m.creditCost, m.minCreditCost ?? 0), locale)}{' '}
                        {locale === 'fa' ? 'اعتبار' : 'credits'}
                        {(m.minCreditCost ?? 0) > 0 && (
                          <span className="text-[10px] text-slate-500 ms-1">
                            (min {formatNumber(m.minCreditCost ?? 0, locale)})
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 mt-0.5">
                        <span dir="ltr" className="inline-block">
                          ${m.inputPricePerMillion} / ${m.outputPricePerMillion} (1M)
                        </span>
                      </div>
                      {m.estimatedProfitPerOpUsd !== undefined && (
                        <div
                          className={`text-[10px] font-mono mt-0.5 ${
                            m.estimatedProfitPerOpUsd >= 0
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-700 dark:text-red-400'
                          }`}
                        >
                          <span dir="ltr" className="inline-block">
                            {locale === 'fa' ? 'سود برآوردی/عملیات: ' : 'Est. profit/op: '}$
                            {m.estimatedProfitPerOpUsd.toFixed(4)}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4">
                      <button
                        type="button"
                        onClick={() => handleToggleActive(m)}
                        className="cursor-pointer hover:underline underline-offset-4"
                      >
                        <StatusText tone={m.isActive ? 'success' : 'neutral'}>
                          {m.isActive ? t.common.active : t.common.inactive}
                        </StatusText>
                      </button>
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(m)}
                          aria-label={`${t.common.edit} ${m.name}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(m)}
                          aria-label={`${t.common.delete} ${m.name}`}
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

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={
          editing
            ? locale === 'fa'
              ? `ویرایش مدل: ${editing.name}`
              : `Edit Model: ${editing.name}`
            : locale === 'fa'
              ? 'ثبت مدل جدید هوش مصنوعی'
              : 'Register AI Model'
        }
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="model-provider" required>
                {locale === 'fa' ? 'ارائه‌دهنده مرتبط' : 'Associated Provider'}
              </FieldLabel>
              <Select
                id="model-provider"
                required
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setDiscoveredModels([]);
                  setDiscoverNote(null);
                }}
              >
                <option value="">{locale === 'fa' ? 'انتخاب ارائه‌دهنده...' : 'Select provider...'}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {t.providerTypes[p.providerType]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="model-category" required>
                {locale === 'fa' ? 'دسته‌بندی مدل' : 'Model Category'}
              </FieldLabel>
              <Select
                id="model-category"
                value={category}
                onChange={(e) => {
                  const nextCat = e.target.value as ModelCategory;
                  setCategory(nextCat);
                  if (!editing) {
                    setCapabilities(DEFAULT_CAPS_BY_CATEGORY[nextCat] ?? ['text_generation', 'chat']);
                  }
                }}
              >
                {MODEL_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {t.modelCategories[cat]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {!editing && providerId && (
            <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                  {locale === 'fa'
                    ? 'شناسایی خودکار مدل‌ها از ارائه‌دهنده'
                    : 'Auto-discover models from provider'}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDiscoverFromProvider}
                    disabled={discovering || syncingAll}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${discovering ? 'animate-spin' : ''}`} />
                    <span>
                      {discovering
                        ? locale === 'fa'
                          ? 'در حال دریافت...'
                          : 'Discovering...'
                        : locale === 'fa'
                          ? 'دریافت لیست مدل‌ها'
                          : 'Fetch Models'}
                    </span>
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleSyncAllFromProvider}
                    disabled={syncingAll || discovering}
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    <span>
                      {syncingAll
                        ? locale === 'fa'
                          ? 'در حال ثبت...'
                          : 'Syncing...'
                        : locale === 'fa'
                          ? 'افزودن خودکار همه'
                          : 'Sync All Automatically'}
                    </span>
                  </Button>
                </div>
              </div>

              {discoverNote && (
                <div className="text-[11px] text-slate-600 dark:text-slate-400">{discoverNote}</div>
              )}

              {discoveredModels.length > 0 && (
                <div className="max-h-40 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg bg-white dark:bg-slate-900">
                  {discoveredModels.map((item) => (
                    <button
                      key={item.modelIdentifier}
                      type="button"
                      onClick={() => applyDiscoveredSpec(item)}
                      className="w-full px-3 py-2 text-start flex items-center justify-between gap-2 hover:bg-blue-50/70 dark:hover:bg-blue-950/30 transition-colors cursor-pointer text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100 truncate">{item.name}</div>
                        <div dir="ltr" className="font-mono text-[11px] text-slate-500 truncate">
                          {item.modelIdentifier}
                        </div>
                      </div>
                      <span className="text-[11px] text-blue-700 dark:text-blue-400 shrink-0">
                        {t.modelCategories[item.category]}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="model-name" required>
                {locale === 'fa' ? 'نام نمایشی مدل' : 'Display Name'}
              </FieldLabel>
              <Input
                id="model-name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="GPT-4o / Gemini 2.5 Pro"
              />
            </div>
            <div>
              <FieldLabel htmlFor="model-identifier" required>
                {locale === 'fa' ? 'شناسه فنی مدل (Model ID)' : 'Model Identifier'}
              </FieldLabel>
              <Input
                id="model-identifier"
                dir="ltr"
                required
                value={modelIdentifier}
                onChange={(e) => setModelIdentifier(e.target.value)}
                placeholder="gpt-4o-2024-11-20"
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="model-desc">{locale === 'fa' ? 'توضیحات مدل' : 'Description'}</FieldLabel>
            <Textarea
              id="model-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div>
            <FieldLabel required>
              {locale === 'fa' ? 'قابلیت‌های پشتیبانی‌شده (چندانتخابی)' : 'Supported Capabilities'}
            </FieldLabel>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
              {CAPABILITY_TYPES.map((cap) => {
                const checked = capabilities.includes(cap);
                return (
                  <label
                    key={cap}
                    className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer py-1"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleCapability(cap)}
                      className="w-4 h-4 rounded border-slate-300 text-blue-700"
                    />
                    <span>{t.capabilities[cap]}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <FieldLabel htmlFor="model-in-price">{locale === 'fa' ? 'قیمت ورودی ($ / 1M)' : 'Input Price ($/1M)'}</FieldLabel>
              <Input
                id="model-in-price"
                type="number"
                step="0.0001"
                min={0}
                value={inputPrice}
                onChange={(e) => setInputPrice(Number(e.target.value))}
              />
            </div>
            <div>
              <FieldLabel htmlFor="model-out-price">{locale === 'fa' ? 'قیمت خروجی ($ / 1M)' : 'Output Price ($/1M)'}</FieldLabel>
              <Input
                id="model-out-price"
                type="number"
                step="0.0001"
                min={0}
                value={outputPrice}
                onChange={(e) => setOutputPrice(Number(e.target.value))}
              />
            </div>
            <div>
              <FieldLabel htmlFor="model-credit">{locale === 'fa' ? 'هزینه اعتبار (Credit)' : 'Credit Cost'}</FieldLabel>
              <Input
                id="model-credit"
                type="number"
                step="0.1"
                min={0}
                value={creditCost}
                onChange={(e) => setCreditCost(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="model-min-credit">
                {locale === 'fa' ? 'کف حداقل هزینه اعتبار (محافظ سود)' : 'Min Credit Cost Floor'}
              </FieldLabel>
              <Input
                id="model-min-credit"
                type="number"
                step="0.1"
                min={0}
                value={minCreditCost}
                onChange={(e) => setMinCreditCost(Number(e.target.value))}
              />
            </div>
            <div>
              <FieldLabel htmlFor="model-op-cost">
                {locale === 'fa' ? 'هزینه برآوردی هر عملیات ($ USD)' : 'Est. Provider Cost / Op ($ USD)'}
              </FieldLabel>
              <Input
                id="model-op-cost"
                type="number"
                step="0.0001"
                min={0}
                value={providerCostPerOpUsd}
                onChange={(e) => setProviderCostPerOpUsd(Number(e.target.value))}
              />
            </div>
          </div>

          <div>
            <FieldLabel>
              {locale === 'fa' ? 'سطوح اشتراک مجاز برای این مدل (خالی = همه پلن‌ها)' : 'Allowed Plan Tiers (empty = all)'}
            </FieldLabel>
            <div className="flex flex-wrap gap-3 p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/50">
              {PLAN_TIERS.map((tier) => (
                <label key={tier} className="flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allowedPlanTiers.includes(tier)}
                    onChange={() => togglePlanTier(tier)}
                    className="w-4 h-4 rounded border-slate-300 text-blue-700"
                  />
                  <span>{t.planTiers[tier]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <FieldLabel htmlFor="model-max-in">{locale === 'fa' ? 'حداکثر اندازه ورودی' : 'Max Input Size'}</FieldLabel>
              <Input
                id="model-max-in"
                type="number"
                min={1}
                value={maxInputSize}
                onChange={(e) => setMaxInputSize(Number(e.target.value))}
              />
            </div>
            <div>
              <FieldLabel htmlFor="model-max-out">{locale === 'fa' ? 'حداکثر اندازه خروجی' : 'Max Output Size'}</FieldLabel>
              <Input
                id="model-max-out"
                type="number"
                min={1}
                value={maxOutputSize}
                onChange={(e) => setMaxOutputSize(Number(e.target.value))}
              />
            </div>
            <div>
              <FieldLabel htmlFor="model-priority">{locale === 'fa' ? 'اولویت نمایش' : 'Priority'}</FieldLabel>
              <Input
                id="model-priority"
                type="number"
                min={0}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div>
              <FieldLabel htmlFor="model-fallback-provider">
                {locale === 'fa' ? 'ارائه‌دهنده پشتیبان (Failover اختیاری)' : 'Fallback Provider (Optional)'}
              </FieldLabel>
              <Select
                id="model-fallback-provider"
                value={fallbackProviderId}
                onChange={(e) => setFallbackProviderId(e.target.value)}
              >
                <option value="">{locale === 'fa' ? 'بدون پشتیبان' : 'No fallback'}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({t.providerTypes[p.providerType]})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor="model-fallback-id">
                {locale === 'fa' ? 'شناسه مدل پشتیبان (Fallback Model ID)' : 'Fallback Model ID'}
              </FieldLabel>
              <Input
                id="model-fallback-id"
                dir="ltr"
                value={fallbackModelIdentifier}
                onChange={(e) => setFallbackModelIdentifier(e.target.value)}
                placeholder="gemini-2.5-flash"
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="model-params">
              {locale === 'fa' ? 'پارامترهای اختصاصی مدل (JSON اختیاری)' : 'Model-Specific Parameters (JSON)'}
            </FieldLabel>
            <Textarea
              id="model-params"
              dir="ltr"
              rows={2}
              className="font-mono text-xs"
              value={paramsJson}
              onChange={(e) => setParamsJson(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-700"
              />
              <span>{locale === 'fa' ? 'مدل پیش‌فرض در این دسته‌بندی' : 'Default model for category'}</span>
            </label>

            <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-700"
              />
              <span>{locale === 'fa' ? 'وضعیت فعال' : 'Active'}</span>
            </label>
          </div>

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

      <ModelHealthPrunerModal
        open={prunerOpen}
        onClose={() => setPrunerOpen(false)}
        locale={locale}
        providers={providers}
        modelCountsByProvider={modelCountsByProvider}
        onCompleted={loadData}
      />
    </div>
  );
}
