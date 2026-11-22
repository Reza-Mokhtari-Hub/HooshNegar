import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Sparkles, Coins } from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { DICTIONARIES, formatNumber, type Locale } from '../../i18n';
import {
  BILLING_INTERVALS,
  PLAN_TIERS,
  type BillingInterval,
  type PlanTier,
} from '../../shared/validation';
import type { ModelRecord } from './ModelsSection';
import type { ProviderRecord } from './ProvidersSection';
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

export interface PlanRecord {
  id: string;
  name: string;
  slug: string;
  tier: PlanTier;
  description: string;
  priceAmount: number;
  currency: 'XTR' | 'IRR' | 'IRT' | 'USD' | 'EUR';
  starsPrice: number;
  billingInterval: BillingInterval;
  isRecurringStars: boolean;
  durationDays: number;
  allowedProviderIds: string[];
  availableModelIds: string[];
  dailyRequestLimit: number;
  monthlyRequestLimit: number;
  dailyTextLimit: number;
  textGenerationLimit: number;
  dailyImageLimit: number;
  imageGenerationLimit: number;
  audioGenerationLimit: number;
  dailyVideoLimit: number;
  videoGenerationLimit: number;
  maxFileSizeMb: number;
  maxContextLength: number;
  maxConcurrentTasks: number;
  creditAllocation: number;
  priorityQueue: boolean;
  features: string[];
  restrictions: string[];
  isEnabled: boolean;
  sortOrder: number;
}

export interface CreditPackageRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  creditsAmount: number;
  bonusCredits: number;
  starsPrice: number;
  isActive: boolean;
  sortOrder: number;
}

const INITIAL_PLAN_FORM = {
  name: '',
  slug: '',
  tier: 'pro' as PlanTier,
  description: '',
  priceAmount: 0,
  currency: 'XTR' as 'XTR' | 'IRR' | 'IRT' | 'USD' | 'EUR',
  starsPrice: 250,
  billingInterval: 'monthly' as BillingInterval,
  isRecurringStars: false,
  durationDays: 30,
  allowedProviderIds: [] as string[],
  availableModelIds: [] as string[],
  dailyRequestLimit: 100,
  monthlyRequestLimit: 2500,
  dailyTextLimit: 100,
  textGenerationLimit: 2000,
  dailyImageLimit: 15,
  imageGenerationLimit: 100,
  audioGenerationLimit: 30,
  dailyVideoLimit: 3,
  videoGenerationLimit: 15,
  maxFileSizeMb: 25,
  maxContextLength: 32000,
  maxConcurrentTasks: 3,
  creditAllocation: 500,
  priorityQueue: false,
  featuresText: '',
  restrictionsText: '',
  isEnabled: true,
  sortOrder: 0,
};

const INITIAL_PKG_FORM = {
  name: '',
  slug: '',
  description: '',
  creditsAmount: 500,
  bonusCredits: 50,
  starsPrice: 150,
  isActive: true,
  sortOrder: 0,
};

const INTERVAL_LABELS: Record<BillingInterval, { fa: string; en: string }> = {
  one_time: { fa: 'یک‌باره', en: 'One-time' },
  weekly: { fa: 'هفتگی', en: 'Weekly' },
  monthly: { fa: 'ماهانه', en: 'Monthly' },
  quarterly: { fa: 'فصلی', en: 'Quarterly' },
  yearly: { fa: 'سالانه', en: 'Yearly' },
  lifetime: { fa: 'مادام‌العمر', en: 'Lifetime' },
};

export function PlansSection({ locale }: { locale: Locale }) {
  const t = DICTIONARIES[locale];
  const [tab, setTab] = useState<'plans' | 'packages'>('plans');
  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [packages, setPackages] = useState<CreditPackageRecord[]>([]);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PlanRecord | null>(null);
  const [form, setForm] = useState(INITIAL_PLAN_FORM);
  const [saving, setSaving] = useState(false);

  const [pkgOpen, setPkgOpen] = useState(false);
  const [editingPkg, setEditingPkg] = useState<CreditPackageRecord | null>(null);
  const [pkgForm, setPkgForm] = useState(INITIAL_PKG_FORM);
  const [savingPkg, setSavingPkg] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [plansRes, pkgsRes, modelsRes, providersRes] = await Promise.all([
        apiRequest<{ plans: PlanRecord[] }>('/api/plans'),
        apiRequest<{ packages: CreditPackageRecord[] }>('/api/credit-packages'),
        apiRequest<{ models: ModelRecord[] }>('/api/models'),
        apiRequest<{ providers: ProviderRecord[] }>('/api/providers'),
      ]);
      setPlans(plansRes.plans);
      setPackages(pkgsRes.packages);
      setModels(modelsRes.models);
      setProviders(providersRes.providers);
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در دریافت پلن‌ها' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreatePlan = () => {
    setEditing(null);
    setForm(INITIAL_PLAN_FORM);
    setFormOpen(true);
  };

  const openEditPlan = (p: PlanRecord) => {
    setEditing(p);
    setForm({
      name: p.name,
      slug: p.slug,
      tier: p.tier,
      description: p.description ?? '',
      priceAmount: p.priceAmount,
      currency: p.currency,
      starsPrice: p.starsPrice ?? 0,
      billingInterval: p.billingInterval ?? 'monthly',
      isRecurringStars: Boolean(p.isRecurringStars),
      durationDays: p.durationDays,
      allowedProviderIds: p.allowedProviderIds ?? [],
      availableModelIds: p.availableModelIds ?? [],
      dailyRequestLimit: p.dailyRequestLimit,
      monthlyRequestLimit: p.monthlyRequestLimit,
      dailyTextLimit: p.dailyTextLimit ?? 50,
      textGenerationLimit: p.textGenerationLimit,
      dailyImageLimit: p.dailyImageLimit ?? 10,
      imageGenerationLimit: p.imageGenerationLimit,
      audioGenerationLimit: p.audioGenerationLimit,
      dailyVideoLimit: p.dailyVideoLimit ?? 2,
      videoGenerationLimit: p.videoGenerationLimit,
      maxFileSizeMb: p.maxFileSizeMb,
      maxContextLength: p.maxContextLength ?? 16000,
      maxConcurrentTasks: p.maxConcurrentTasks,
      creditAllocation: p.creditAllocation,
      priorityQueue: Boolean(p.priorityQueue),
      featuresText: (p.features ?? []).join('\n'),
      restrictionsText: (p.restrictions ?? []).join('\n'),
      isEnabled: p.isEnabled,
      sortOrder: p.sortOrder,
    });
    setFormOpen(true);
  };

  const handleSavePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const payload = {
        name: form.name.trim(),
        slug: form.slug.trim().toLowerCase(),
        tier: form.tier,
        description: form.description.trim(),
        priceAmount: Number(form.priceAmount),
        currency: form.currency,
        starsPrice: Number(form.starsPrice),
        billingInterval: form.billingInterval,
        isRecurringStars: form.isRecurringStars,
        durationDays: Number(form.durationDays),
        allowedProviderIds: form.allowedProviderIds,
        availableModelIds: form.availableModelIds,
        dailyRequestLimit: Number(form.dailyRequestLimit),
        monthlyRequestLimit: Number(form.monthlyRequestLimit),
        dailyTextLimit: Number(form.dailyTextLimit),
        textGenerationLimit: Number(form.textGenerationLimit),
        dailyImageLimit: Number(form.dailyImageLimit),
        imageGenerationLimit: Number(form.imageGenerationLimit),
        audioGenerationLimit: Number(form.audioGenerationLimit),
        dailyVideoLimit: Number(form.dailyVideoLimit),
        videoGenerationLimit: Number(form.videoGenerationLimit),
        maxFileSizeMb: Number(form.maxFileSizeMb),
        maxContextLength: Number(form.maxContextLength),
        maxConcurrentTasks: Number(form.maxConcurrentTasks),
        creditAllocation: Number(form.creditAllocation),
        priorityQueue: form.priorityQueue,
        features: form.featuresText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        restrictions: form.restrictionsText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        isEnabled: form.isEnabled,
        sortOrder: Number(form.sortOrder),
      };

      if (editing) {
        await apiRequest(`/api/plans/${editing.id}`, { method: 'PATCH', body: payload });
        setFeedback({ tone: 'success', text: locale === 'fa' ? 'پلن اشتراک بروزرسانی شد.' : 'Plan updated.' });
      } else {
        await apiRequest('/api/plans', { method: 'POST', body: payload });
        setFeedback({ tone: 'success', text: locale === 'fa' ? 'پلن اشتراک جدید ایجاد شد.' : 'Plan created.' });
      }
      setFormOpen(false);
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ذخیره پلن' });
    } finally {
      setSaving(false);
    }
  };

  const handleDeletePlan = async (p: PlanRecord) => {
    try {
      await apiRequest(`/api/plans/${p.id}`, { method: 'DELETE' });
      setFeedback({ tone: 'success', text: locale === 'fa' ? `پلن «${p.name}» حذف شد.` : `Plan "${p.name}" deleted.` });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در حذف پلن' });
    }
  };

  const openCreatePkg = () => {
    setEditingPkg(null);
    setPkgForm(INITIAL_PKG_FORM);
    setPkgOpen(true);
  };

  const openEditPkg = (pkg: CreditPackageRecord) => {
    setEditingPkg(pkg);
    setPkgForm({
      name: pkg.name,
      slug: pkg.slug,
      description: pkg.description ?? '',
      creditsAmount: pkg.creditsAmount,
      bonusCredits: pkg.bonusCredits,
      starsPrice: pkg.starsPrice,
      isActive: pkg.isActive,
      sortOrder: pkg.sortOrder,
    });
    setPkgOpen(true);
  };

  const handleSavePkg = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPkg(true);
    setFeedback(null);
    try {
      const payload = {
        ...pkgForm,
        name: pkgForm.name.trim(),
        slug: pkgForm.slug.trim().toLowerCase(),
        description: pkgForm.description.trim(),
        creditsAmount: Number(pkgForm.creditsAmount),
        bonusCredits: Number(pkgForm.bonusCredits),
        starsPrice: Number(pkgForm.starsPrice),
        sortOrder: Number(pkgForm.sortOrder),
      };
      if (editingPkg) {
        await apiRequest(`/api/credit-packages/${editingPkg.id}`, { method: 'PATCH', body: payload });
        setFeedback({ tone: 'success', text: locale === 'fa' ? 'بسته اعتبار بروزرسانی شد.' : 'Credit package updated.' });
      } else {
        await apiRequest('/api/credit-packages', { method: 'POST', body: payload });
        setFeedback({ tone: 'success', text: locale === 'fa' ? 'بسته اعتبار جدید ایجاد شد.' : 'Credit package created.' });
      }
      setPkgOpen(false);
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در ذخیره بسته اعتبار' });
    } finally {
      setSavingPkg(false);
    }
  };

  const handleDeletePkg = async (pkg: CreditPackageRecord) => {
    try {
      await apiRequest(`/api/credit-packages/${pkg.id}`, { method: 'DELETE' });
      setFeedback({ tone: 'success', text: locale === 'fa' ? `بسته «${pkg.name}» حذف شد.` : `Package "${pkg.name}" deleted.` });
      await load();
    } catch (err) {
      setFeedback({ tone: 'danger', text: err instanceof Error ? err.message : 'خطا در حذف بسته اعتبار' });
    }
  };

  const toggleId = (field: 'availableModelIds' | 'allowedProviderIds', id: string) => {
    setForm((prev) => ({
      ...prev,
      [field]: prev[field].includes(id)
        ? prev[field].filter((item) => item !== id)
        : [...prev[field], id],
    }));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">{t.nav.plans}</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {locale === 'fa'
              ? 'پیکربندی نامحدود پلن‌های اشتراک و بسته‌های شارژ اعتبار با پرداخت اختصاصی تلگرام استارز (XTR)، سهمیه‌های روزانه/ماهانه و دسترسی مدل‌ها.'
              : 'Configure unlimited subscription tiers and top-up credit packs settled via official Telegram Stars (XTR), with granular quotas and model allowlists.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === 'plans' ? (
            <Button onClick={openCreatePlan}>
              <Plus className="w-4 h-4" />
              <span>{locale === 'fa' ? 'ایجاد پلن اشتراک' : 'Create Plan'}</span>
            </Button>
          ) : (
            <Button onClick={openCreatePkg}>
              <Plus className="w-4 h-4" />
              <span>{locale === 'fa' ? 'ایجاد بسته اعتبار (XTR)' : 'Create Credit Pack'}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setTab('plans')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            tab === 'plans'
              ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>{locale === 'fa' ? `پلن‌های اشتراک (${formatNumber(plans.length, locale)})` : `Subscription Plans (${plans.length})`}</span>
        </button>
        <button
          type="button"
          onClick={() => setTab('packages')}
          className={`flex items-center gap-2 px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
            tab === 'packages'
              ? 'border-blue-700 text-blue-700 dark:border-blue-400 dark:text-blue-400'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-200'
          }`}
        >
          <Coins className="w-3.5 h-3.5" />
          <span>{locale === 'fa' ? `بسته‌های اعتبار استارز (${formatNumber(packages.length, locale)})` : `Stars Credit Packs (${packages.length})`}</span>
        </button>
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

      {tab === 'plans' ? (
        <Surface className="overflow-hidden">
          {loading ? (
            <TableSkeleton rows={4} cols={6} />
          ) : plans.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'هنوز پلن اشتراکی تعریف نشده است' : 'No subscription plans configured'}
              description={
                locale === 'fa'
                  ? 'پلن‌های رایگان، پایه، حرفه‌ای، ویژه، سازمانی یا سفارشی را با قیمت تلگرام استارز (XTR) و سهمیه دقیق بسازید.'
                  : 'Create Free, Basic, Pro, Premium, Enterprise, or Custom subscription plans priced in Telegram Stars (XTR).'
              }
              action={
                <Button onClick={openCreatePlan}>
                  <Plus className="w-4 h-4" />
                  <span>{locale === 'fa' ? 'ایجاد اولین پلن' : 'Create First Plan'}</span>
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'پلن و سطح' : 'Plan & Tier'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'قیمت تلگرام استارز / دوره' : 'Stars Price & Cycle'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'سهمیه روزانه / ماهانه' : 'Daily / Monthly Limits'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اعتبار و دسترسی‌ها' : 'Credits & Access'}</th>
                    <th className="py-3 px-4 text-start">{t.common.status}</th>
                    <th className="py-3 px-4 text-end">{t.common.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  {plans.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {p.name}
                          {p.priorityQueue && (
                            <span className="ms-2 text-[11px] font-medium text-blue-700 dark:text-blue-400">
                              · {locale === 'fa' ? 'صف اولویت' : 'Priority'}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {t.planTiers[p.tier]} · <span dir="ltr" className="font-mono inline-block">{p.slug}</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 tabular-nums text-slate-800 dark:text-slate-200">
                        <div className="font-semibold">
                          {p.starsPrice > 0
                            ? `${formatNumber(p.starsPrice, locale)} ⭐️ XTR`
                            : locale === 'fa'
                              ? 'رایگان (۰ استارز)'
                              : 'Free (0 XTR)'}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {formatNumber(p.durationDays, locale)} {locale === 'fa' ? 'روز' : 'days'} ·{' '}
                          {INTERVAL_LABELS[p.billingInterval ?? 'monthly'][locale]}
                          {p.isRecurringStars && (
                            <span className="ms-1 text-blue-700 dark:text-blue-400 font-medium">
                              ({locale === 'fa' ? 'تمدید خودکار' : 'Auto-renew'})
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 tabular-nums text-slate-700 dark:text-slate-300">
                        <div>
                          {formatNumber(p.dailyRequestLimit, locale)} / {formatNumber(p.monthlyRequestLimit, locale)}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {locale === 'fa'
                            ? `متن ${formatNumber(p.dailyTextLimit, locale)}/روز · تصویر ${formatNumber(p.dailyImageLimit, locale)}/روز · ویدیو ${formatNumber(p.dailyVideoLimit, locale)}/روز`
                            : `Txt ${p.dailyTextLimit}/d · Img ${p.dailyImageLimit}/d · Vid ${p.dailyVideoLimit}/d`}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-slate-700 dark:text-slate-300 tabular-nums">
                        <div className="font-medium">
                          {formatNumber(p.creditAllocation, locale)} {locale === 'fa' ? 'اعتبار ماهانه' : 'monthly credits'}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {locale === 'fa'
                            ? `فایل ${formatNumber(p.maxFileSizeMb, locale)}MB · زمینه ${formatNumber(p.maxContextLength, locale)} · مدل: ${p.availableModelIds.length === 0 ? 'همه' : formatNumber(p.availableModelIds.length, locale)}`
                            : `File ${p.maxFileSizeMb}MB · Ctx ${p.maxContextLength} · Models: ${p.availableModelIds.length === 0 ? 'All' : p.availableModelIds.length}`}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <StatusText tone={p.isEnabled ? 'success' : 'neutral'}>
                          {p.isEnabled ? t.common.enabled : t.common.disabled}
                        </StatusText>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openEditPlan(p)}
                            aria-label={`${t.common.edit} ${p.name}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeletePlan(p)}
                            aria-label={`${t.common.delete} ${p.name}`}
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
      ) : (
        <Surface className="overflow-hidden">
          {loading ? (
            <TableSkeleton rows={3} cols={5} />
          ) : packages.length === 0 ? (
            <EmptyState
              title={locale === 'fa' ? 'بسته شارژ اعتباری تعریف نشده است' : 'No credit packages configured'}
              description={
                locale === 'fa'
                  ? 'بسته‌های شارژ اعتبار قابل خرید با تلگرام استارز (XTR) را ایجاد کنید تا کاربران در ربات موجودی خود را افزایش دهند.'
                  : 'Create one-time top-up credit packs purchasable via Telegram Stars (XTR) inside the bot.'
              }
              action={
                <Button onClick={openCreatePkg}>
                  <Plus className="w-4 h-4" />
                  <span>{locale === 'fa' ? 'ایجاد اولین بسته اعتبار' : 'Create Credit Package'}</span>
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'نام بسته' : 'Package'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'اعتبار پایه + هدیه' : 'Base + Bonus Credits'}</th>
                    <th className="py-3 px-4 text-start">{locale === 'fa' ? 'قیمت تلگرام استارز' : 'Telegram Stars Price'}</th>
                    <th className="py-3 px-4 text-start">{t.common.status}</th>
                    <th className="py-3 px-4 text-end">{t.common.actions}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                  {packages.map((pkg) => (
                    <tr key={pkg.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">{pkg.name}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          <span dir="ltr" className="font-mono inline-block">{pkg.slug}</span>
                          {pkg.description ? ` · ${pkg.description}` : ''}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 tabular-nums">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {formatNumber(pkg.creditsAmount + pkg.bonusCredits, locale)}{' '}
                          {locale === 'fa' ? 'اعتبار کل' : 'total credits'}
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {formatNumber(pkg.creditsAmount, locale)} + {formatNumber(pkg.bonusCredits, locale)}{' '}
                          {locale === 'fa' ? 'هدیه' : 'bonus'}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                        {formatNumber(pkg.starsPrice, locale)} ⭐️ XTR
                      </td>
                      <td className="py-3.5 px-4">
                        <StatusText tone={pkg.isActive ? 'success' : 'neutral'}>
                          {pkg.isActive ? t.common.active : t.common.inactive}
                        </StatusText>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEditPkg(pkg)} aria-label={t.common.edit}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeletePkg(pkg)}
                            aria-label={t.common.delete}
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
      )}

      {/* Subscription Plan Create/Edit Modal */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        maxWidth="max-w-3xl"
        title={
          editing
            ? locale === 'fa'
              ? `ویرایش پلن: ${editing.name}`
              : `Edit Plan: ${editing.name}`
            : locale === 'fa'
              ? 'ایجاد پلن اشتراک جدید'
              : 'Create Subscription Plan'
        }
      >
        <form onSubmit={handleSavePlan} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <FieldLabel htmlFor="plan-name" required>{locale === 'fa' ? 'نام پلن' : 'Plan Name'}</FieldLabel>
              <Input
                id="plan-name"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={locale === 'fa' ? 'پلن حرفه‌ای ماهانه' : 'Pro Monthly'}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-slug" required>{locale === 'fa' ? 'اسلاگ یکتا (انگلیسی)' : 'Slug'}</FieldLabel>
              <Input
                id="plan-slug"
                dir="ltr"
                required
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                placeholder="pro-monthly"
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-tier" required>{locale === 'fa' ? 'سطح پلن' : 'Tier'}</FieldLabel>
              <Select
                id="plan-tier"
                value={form.tier}
                onChange={(e) => setForm({ ...form, tier: e.target.value as PlanTier })}
              >
                {PLAN_TIERS.map((tier) => (
                  <option key={tier} value={tier}>
                    {t.planTiers[tier]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <FieldLabel htmlFor="plan-desc">{locale === 'fa' ? 'توضیحات پلن' : 'Description'}</FieldLabel>
            <Textarea
              id="plan-desc"
              rows={2}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>

          {/* Telegram Stars Pricing & Billing */}
          <div className="p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40 space-y-3">
            <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
              {locale === 'fa' ? 'قیمت‌گذاری تلگرام استارز (XTR) و دوره صورتحساب' : 'Telegram Stars (XTR) Pricing & Billing Cycle'}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <FieldLabel htmlFor="plan-stars">{locale === 'fa' ? 'قیمت استارز (XTR)' : 'Stars Price (XTR)'}</FieldLabel>
                <Input
                  id="plan-stars"
                  type="number"
                  min={0}
                  max={100000}
                  value={form.starsPrice}
                  onChange={(e) =>
                    setForm({ ...form, starsPrice: Number(e.target.value), priceAmount: Number(e.target.value) })
                  }
                />
              </div>
              <div>
                <FieldLabel htmlFor="plan-interval">{locale === 'fa' ? 'دوره صورتحساب' : 'Billing Interval'}</FieldLabel>
                <Select
                  id="plan-interval"
                  value={form.billingInterval}
                  onChange={(e) => setForm({ ...form, billingInterval: e.target.value as BillingInterval })}
                >
                  {BILLING_INTERVALS.map((iv) => (
                    <option key={iv} value={iv}>
                      {INTERVAL_LABELS[iv][locale]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <FieldLabel htmlFor="plan-duration">{locale === 'fa' ? 'مدت اشتراک (روز)' : 'Duration (Days)'}</FieldLabel>
                <Input
                  id="plan-duration"
                  type="number"
                  min={1}
                  value={form.durationDays}
                  onChange={(e) => setForm({ ...form, durationDays: Number(e.target.value) })}
                />
              </div>
              <div>
                <FieldLabel htmlFor="plan-credits">{locale === 'fa' ? 'اعتبار ماهانه شامل‌شده' : 'Included Credits'}</FieldLabel>
                <Input
                  id="plan-credits"
                  type="number"
                  min={0}
                  value={form.creditAllocation}
                  onChange={(e) => setForm({ ...form, creditAllocation: Number(e.target.value) })}
                />
              </div>
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={form.isRecurringStars}
                onChange={(e) =>
                  setForm({
                    ...form,
                    isRecurringStars: e.target.checked,
                    durationDays: e.target.checked ? 30 : form.durationDays,
                  })
                }
                className="w-4 h-4 mt-0.5 rounded border-slate-300 text-blue-700"
              />
              <span>
                {locale === 'fa'
                  ? 'فعال‌سازی تمدید خودکار ماهانه تلگرام استارز (طبق قوانین Bot API: دقیقاً ۳۰ روز / ۲۵۹۲۰۰۰ ثانیه و بین ۱ تا ۲۵۰۰ استارز)'
                  : 'Enable native Telegram Stars recurring subscription (Bot API rules: exactly 30 days / 2,592,000s and 1–2,500 XTR)'}
              </span>
            </label>
          </div>

          {/* Daily & Monthly Limits */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <FieldLabel htmlFor="plan-daily">{locale === 'fa' ? 'سقف کل روزانه' : 'Daily Req Limit'}</FieldLabel>
              <Input
                id="plan-daily"
                type="number"
                min={0}
                value={form.dailyRequestLimit}
                onChange={(e) => setForm({ ...form, dailyRequestLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-monthly">{locale === 'fa' ? 'سقف کل ماهانه' : 'Monthly Req Limit'}</FieldLabel>
              <Input
                id="plan-monthly"
                type="number"
                min={0}
                value={form.monthlyRequestLimit}
                onChange={(e) => setForm({ ...form, monthlyRequestLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-d-text">{locale === 'fa' ? 'متن روزانه' : 'Daily Text'}</FieldLabel>
              <Input
                id="plan-d-text"
                type="number"
                min={0}
                value={form.dailyTextLimit}
                onChange={(e) => setForm({ ...form, dailyTextLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-m-text">{locale === 'fa' ? 'متن ماهانه' : 'Monthly Text'}</FieldLabel>
              <Input
                id="plan-m-text"
                type="number"
                min={0}
                value={form.textGenerationLimit}
                onChange={(e) => setForm({ ...form, textGenerationLimit: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <FieldLabel htmlFor="plan-d-img">{locale === 'fa' ? 'تصویر روزانه' : 'Daily Img'}</FieldLabel>
              <Input
                id="plan-d-img"
                type="number"
                min={0}
                value={form.dailyImageLimit}
                onChange={(e) => setForm({ ...form, dailyImageLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-m-img">{locale === 'fa' ? 'تصویر ماهانه' : 'Monthly Img'}</FieldLabel>
              <Input
                id="plan-m-img"
                type="number"
                min={0}
                value={form.imageGenerationLimit}
                onChange={(e) => setForm({ ...form, imageGenerationLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-d-vid">{locale === 'fa' ? 'ویدیو روزانه' : 'Daily Vid'}</FieldLabel>
              <Input
                id="plan-d-vid"
                type="number"
                min={0}
                value={form.dailyVideoLimit}
                onChange={(e) => setForm({ ...form, dailyVideoLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-m-vid">{locale === 'fa' ? 'ویدیو ماهانه' : 'Monthly Vid'}</FieldLabel>
              <Input
                id="plan-m-vid"
                type="number"
                min={0}
                value={form.videoGenerationLimit}
                onChange={(e) => setForm({ ...form, videoGenerationLimit: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-audio">{locale === 'fa' ? 'سقف صوت' : 'Audio Limit'}</FieldLabel>
              <Input
                id="plan-audio"
                type="number"
                min={0}
                value={form.audioGenerationLimit}
                onChange={(e) => setForm({ ...form, audioGenerationLimit: Number(e.target.value) })}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <FieldLabel htmlFor="plan-file">{locale === 'fa' ? 'حداکثر حجم آپلود (MB)' : 'Max Upload (MB)'}</FieldLabel>
              <Input
                id="plan-file"
                type="number"
                min={1}
                value={form.maxFileSizeMb}
                onChange={(e) => setForm({ ...form, maxFileSizeMb: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-ctx">{locale === 'fa' ? 'حداکثر طول زمینه (Context)' : 'Max Context Length'}</FieldLabel>
              <Input
                id="plan-ctx"
                type="number"
                min={1000}
                value={form.maxContextLength}
                onChange={(e) => setForm({ ...form, maxContextLength: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-concurrent">{locale === 'fa' ? 'حداکثر تسک همزمان' : 'Max Concurrent Jobs'}</FieldLabel>
              <Input
                id="plan-concurrent"
                type="number"
                min={1}
                value={form.maxConcurrentTasks}
                onChange={(e) => setForm({ ...form, maxConcurrentTasks: Number(e.target.value) })}
              />
            </div>
          </div>

          {/* Allowed Providers & Models */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel>
                {locale === 'fa' ? 'ارائه‌دهندگان مجاز (خالی = همه)' : 'Allowed Providers (empty = all)'}
              </FieldLabel>
              <div className="space-y-1.5 p-3 rounded-lg border border-slate-200 dark:border-slate-800 max-h-32 overflow-y-auto">
                {providers.length === 0 ? (
                  <div className="text-[11px] text-slate-400">{locale === 'fa' ? 'ارائه‌دهنده‌ای ثبت نشده' : 'No providers'}</div>
                ) : (
                  providers.map((pr) => (
                    <label key={pr.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.allowedProviderIds.includes(pr.id)}
                        onChange={() => toggleId('allowedProviderIds', pr.id)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-700"
                      />
                      <span className="truncate">{pr.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
            <div>
              <FieldLabel>
                {locale === 'fa' ? 'مدل‌های مجاز (خالی = همه)' : 'Allowed Models (empty = all)'}
              </FieldLabel>
              <div className="space-y-1.5 p-3 rounded-lg border border-slate-200 dark:border-slate-800 max-h-32 overflow-y-auto">
                {models.length === 0 ? (
                  <div className="text-[11px] text-slate-400">{locale === 'fa' ? 'مدلی ثبت نشده' : 'No models'}</div>
                ) : (
                  models.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.availableModelIds.includes(m.id)}
                        onChange={() => toggleId('availableModelIds', m.id)}
                        className="w-4 h-4 rounded border-slate-300 text-blue-700"
                      />
                      <span className="truncate">{m.name}</span>
                    </label>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="plan-features">
                {locale === 'fa' ? 'ویژگی‌های پلن (هر خط یک مورد)' : 'Features (one per line)'}
              </FieldLabel>
              <Textarea
                id="plan-features"
                rows={3}
                value={form.featuresText}
                onChange={(e) => setForm({ ...form, featuresText: e.target.value })}
                placeholder={locale === 'fa' ? 'دسترسی به مدل‌های پرچم‌دار\nپشتیبانی اولویت‌دار' : 'Flagship model access\nPriority support'}
              />
            </div>
            <div>
              <FieldLabel htmlFor="plan-restrictions">
                {locale === 'fa' ? 'محدودیت‌ها (هر خط یک مورد)' : 'Restrictions (one per line)'}
              </FieldLabel>
              <Textarea
                id="plan-restrictions"
                rows={3}
                value={form.restrictionsText}
                onChange={(e) => setForm({ ...form, restrictionsText: e.target.value })}
                placeholder={locale === 'fa' ? 'بدون تولید ویدیو\nحداکثر حجم فایل ۱۰ مگابایت' : 'No video generation\n10MB max upload'}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.priorityQueue}
                onChange={(e) => setForm({ ...form, priorityQueue: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-blue-700"
              />
              <span>{locale === 'fa' ? 'دسترسی به صف پردازش اولویت‌دار (Priority Queue)' : 'Priority Queue Access'}</span>
            </label>
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.isEnabled}
                onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })}
                className="w-4 h-4 rounded border-slate-300 text-blue-700"
              />
              <span>{locale === 'fa' ? 'پلن فعال و قابل خرید باشد' : 'Plan active'}</span>
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

      {/* Credit Package Create/Edit Modal */}
      <Modal
        open={pkgOpen}
        onClose={() => setPkgOpen(false)}
        maxWidth="max-w-lg"
        title={
          editingPkg
            ? locale === 'fa'
              ? `ویرایش بسته: ${editingPkg.name}`
              : `Edit Package: ${editingPkg.name}`
            : locale === 'fa'
              ? 'ایجاد بسته اعتبار جدید (تلگرام استارز XTR)'
              : 'Create Credit Package (Telegram Stars XTR)'
        }
      >
        <form onSubmit={handleSavePkg} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <FieldLabel htmlFor="pkg-name" required>{locale === 'fa' ? 'نام بسته' : 'Package Name'}</FieldLabel>
              <Input
                id="pkg-name"
                required
                value={pkgForm.name}
                onChange={(e) => setPkgForm({ ...pkgForm, name: e.target.value })}
                placeholder={locale === 'fa' ? 'بسته ۵۰۰ اعتبار' : '500 Credits Pack'}
              />
            </div>
            <div>
              <FieldLabel htmlFor="pkg-slug" required>{locale === 'fa' ? 'اسلاگ یکتا' : 'Slug'}</FieldLabel>
              <Input
                id="pkg-slug"
                dir="ltr"
                required
                value={pkgForm.slug}
                onChange={(e) => setPkgForm({ ...pkgForm, slug: e.target.value.toLowerCase() })}
                placeholder="credits-500"
              />
            </div>
          </div>
          <div>
            <FieldLabel htmlFor="pkg-desc">{locale === 'fa' ? 'توضیحات' : 'Description'}</FieldLabel>
            <Input
              id="pkg-desc"
              value={pkgForm.description}
              onChange={(e) => setPkgForm({ ...pkgForm, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <FieldLabel htmlFor="pkg-credits" required>{locale === 'fa' ? 'اعتبار پایه' : 'Base Credits'}</FieldLabel>
              <Input
                id="pkg-credits"
                type="number"
                min={1}
                required
                value={pkgForm.creditsAmount}
                onChange={(e) => setPkgForm({ ...pkgForm, creditsAmount: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="pkg-bonus">{locale === 'fa' ? 'اعتبار هدیه' : 'Bonus Credits'}</FieldLabel>
              <Input
                id="pkg-bonus"
                type="number"
                min={0}
                value={pkgForm.bonusCredits}
                onChange={(e) => setPkgForm({ ...pkgForm, bonusCredits: Number(e.target.value) })}
              />
            </div>
            <div>
              <FieldLabel htmlFor="pkg-stars" required>{locale === 'fa' ? 'قیمت استارز (XTR)' : 'Stars (XTR)'}</FieldLabel>
              <Input
                id="pkg-stars"
                type="number"
                min={1}
                required
                value={pkgForm.starsPrice}
                onChange={(e) => setPkgForm({ ...pkgForm, starsPrice: Number(e.target.value) })}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={pkgForm.isActive}
              onChange={(e) => setPkgForm({ ...pkgForm, isActive: e.target.checked })}
              className="w-4 h-4 rounded border-slate-300 text-blue-700"
            />
            <span>{locale === 'fa' ? 'بسته فعال و قابل خرید در ربات باشد' : 'Package active in Telegram bot'}</span>
          </label>
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
            <Button variant="outline" onClick={() => setPkgOpen(false)}>{t.common.cancel}</Button>
            <Button type="submit" disabled={savingPkg}>{savingPkg ? t.common.saving : t.common.save}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
