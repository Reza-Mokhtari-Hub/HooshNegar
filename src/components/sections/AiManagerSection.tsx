import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Cpu,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../../lib/api';
import { formatNumber, type Locale } from '../../i18n';
import { Button, Select, Surface } from '../ui/primitives';

interface CopilotModelOption {
  id: string;
  name: string;
  modelIdentifier: string;
  providerName: string;
  providerType: string;
  isDefault: boolean;
}

interface CopilotAlerts {
  totalUsers: number;
  activeProviders: number;
  activeModels: number;
  inactiveModels: number;
  failedRequests24h: number;
  stuckJobs: number;
  freePlanCredits: number | null;
}

interface CopilotToolTrace {
  tool: string;
  labelFa: string;
  args: Record<string, unknown>;
  summaryFa: string;
  durationMs: number;
}

interface CopilotProposedAction {
  id: string;
  tool: string;
  titleFa: string;
  descriptionFa: string;
  risk: 'low' | 'medium' | 'high';
  args: Record<string, unknown>;
}

interface CopilotActionExecutionResult {
  actionId: string;
  tool: string;
  ok: boolean;
  summaryFa: string;
  details?: Record<string, unknown>;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  usedModelName?: string;
  toolTraces?: CopilotToolTrace[];
  proposedActions?: CopilotProposedAction[];
  executedActions?: CopilotActionExecutionResult[];
}

const QUICK_COMMANDS_FA = [
  'گزارش وضعیت امروز سامانه و خطاهای ۲۴ ساعت اخیر را بده',
  'اعتبار اولیه پلن رایگان را به ۱۰ کاهش بده',
  'مدل‌های خراب را تست و غیرفعال کن ولی مدل‌های لیمیت‌دار بمانند',
  'تسک‌های گیرکرده در صف را پاک‌سازی کن و اعتبار کاربران را برگردان',
  'یک کد هدیه ۵۰ اعتباری برای ۱۰۰ کاربر بساز',
  'کدام مدل‌ها بیشترین خطا را داده‌اند و پیشنهادت چیست؟',
];

const QUICK_COMMANDS_EN = [
  'Give me a live platform status report and recent 24h failures',
  'Reduce the Free plan initial credit allocation to 10',
  'Health-check and disable broken models while keeping rate-limited ones',
  'Recover stuck running jobs and refund reserved credits',
  'Create a 50-credit gift coupon for 100 users',
];

function renderFormattedText(text: string): React.ReactNode {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <p key={i} className={line.trim() === '' ? 'h-2' : 'leading-relaxed'}>
        {parts.map((part, j) =>
          part.startsWith('**') && part.endsWith('**') ? (
            <strong key={j} className="font-semibold text-slate-950 dark:text-white">
              {part.slice(2, -2)}
            </strong>
          ) : (
            <React.Fragment key={j}>{part}</React.Fragment>
          ),
        )}
      </p>
    );
  });
}

export function AiManagerSection({
  locale,
  adminRole,
}: {
  locale: Locale;
  adminRole: string;
}) {
  const isFa = locale === 'fa';
  const canMutate = adminRole === 'super_admin' || adminRole === 'admin';

  const [models, setModels] = useState<CopilotModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [alerts, setAlerts] = useState<CopilotAlerts | null>(null);
  const [loadingCtx, setLoadingCtx] = useState(true);

  const [autoExecute, setAutoExecute] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [actionStates, setActionStates] = useState<
    Record<string, { status: 'running' | 'done' | 'failed' | 'dismissed'; message?: string }>
  >({});
  const [expandedParams, setExpandedParams] = useState<Record<string, boolean>>({});
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const loadContext = useCallback(async () => {
    setLoadingCtx(true);
    try {
      const res = await apiRequest<{
        availableModels: CopilotModelOption[];
        recommendedModelId: string | null;
        alerts: CopilotAlerts;
      }>('/api/ai-manager/context');
      setModels(res.availableModels);
      setAlerts(res.alerts);
      setSelectedModelId((prev) => prev || res.recommendedModelId || res.availableModels[0]?.id || '');
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'خطا در بارگذاری وضعیت دستیار هوشمند');
    } finally {
      setLoadingCtx(false);
    }
  }, []);

  useEffect(() => {
    void loadContext();
  }, [loadContext]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, sending]);

  const sendMessage = async (textOverride?: string) => {
    const content = (textOverride ?? input).trim();
    if (!content || sending) return;

    setErrorText(null);
    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content,
    };

    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    if (!textOverride) setInput('');
    setSending(true);

    try {
      const historyPayload = nextTurns.slice(-12).map((t) => ({
        role: t.role,
        content: t.content,
      }));

      const res = await apiRequest<{
        replyFa: string;
        usedModelId: string | null;
        usedModelName: string;
        toolTraces: CopilotToolTrace[];
        proposedActions: CopilotProposedAction[];
        executedActions: CopilotActionExecutionResult[];
      }>('/api/ai-manager/chat', {
        method: 'POST',
        body: {
          messages: historyPayload,
          modelId: selectedModelId || undefined,
          autoExecute: canMutate ? autoExecute : false,
        },
      });

      const assistantTurn: ChatTurn = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: res.replyFa,
        usedModelName: res.usedModelName,
        toolTraces: res.toolTraces,
        proposedActions: res.proposedActions,
        executedActions: res.executedActions,
      };
      setTurns((prev) => [...prev, assistantTurn]);

      if (res.executedActions.length > 0) {
        void loadContext();
      }
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'خطا در ارتباط با دستیار هوشمند');
    } finally {
      setSending(false);
    }
  };

  const handleExecuteAction = async (action: CopilotProposedAction) => {
    setActionStates((prev) => ({ ...prev, [action.id]: { status: 'running' } }));
    try {
      const res = await apiRequest<{ result: CopilotActionExecutionResult }>(
        '/api/ai-manager/execute-action',
        {
          method: 'POST',
          body: {
            actionId: action.id,
            tool: action.tool,
            args: action.args,
          },
        },
      );
      setActionStates((prev) => ({
        ...prev,
        [action.id]: {
          status: res.result.ok ? 'done' : 'failed',
          message: res.result.summaryFa,
        },
      }));
      if (res.result.ok) {
        void loadContext();
      }
    } catch (err) {
      setActionStates((prev) => ({
        ...prev,
        [action.id]: {
          status: 'failed',
          message: err instanceof Error ? err.message : 'اجرای عملیات ناموفق بود',
        },
      }));
    }
  };

  const handleDismissAction = (actionId: string) => {
    setActionStates((prev) => ({
      ...prev,
      [actionId]: { status: 'dismissed', message: isFa ? 'رد شد' : 'Dismissed' },
    }));
  };

  const quickCommands = isFa ? QUICK_COMMANDS_FA : QUICK_COMMANDS_EN;

  return (
    <div className="space-y-5">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-700 text-white flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {isFa ? 'دستیار هوشمند مدیریت سامانه' : 'AI Site Manager Copilot'}
            </h1>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {isFa
              ? 'مدیریت هوشمند پلن‌ها، پالایش مدل‌های خراب، عیب‌یابی خطاهای زنده، مدیریت اعتبار کاربران و ساخت کوپن — متصل به دیتابیس واقعی و گزارش ممیزی.'
              : 'Live AI operations copilot for inspecting metrics, diagnosing errors, editing plans, pruning broken models, and executing audited actions.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="w-full sm:w-72">
            <Select
              aria-label={isFa ? 'انتخاب مدل هوش مصنوعی دستیار' : 'Select Copilot AI model'}
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              disabled={models.length === 0}
            >
              {models.length === 0 ? (
                <option value="">{isFa ? 'مدل چت فعالی یافت نشد' : 'No active chat model'}</option>
              ) : (
                models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.providerName}
                  </option>
                ))
              )}
            </Select>
          </div>

          {canMutate && (
            <label
              className="h-10 px-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-200 cursor-pointer select-none"
              title={
                isFa
                  ? 'در حالت امن، هر تغییر ابتدا به صورت کارت تایید نمایش داده می‌شود.'
                  : 'In safe mode, mutations show an approval card before execution.'
              }
            >
              <input
                type="checkbox"
                checked={autoExecute}
                onChange={(e) => setAutoExecute(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-slate-300 text-blue-700"
              />
              <span>{isFa ? 'اجرای خودکار (کم‌ریسک)' : 'Auto-execute (low risk)'}</span>
            </label>
          )}

          <Button variant="outline" size="sm" onClick={() => void loadContext()} disabled={loadingCtx}>
            <RefreshCw className={`w-3.5 h-3.5 ${loadingCtx ? 'animate-spin' : ''}`} />
          </Button>

          {turns.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setTurns([]);
                setActionStates({});
                setErrorText(null);
              }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{isFa ? 'گفتگوی جدید' : 'Clear'}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Live Health Strip */}
      {alerts && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Surface className="p-3.5">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {isFa ? 'مدل‌های فعال / غیرفعال' : 'Active / Inactive Models'}
            </div>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-lg font-bold text-slate-900 dark:text-slate-100">
                {formatNumber(alerts.activeModels, locale)}
              </span>
              <span className="text-xs text-slate-400">
                / {formatNumber(alerts.inactiveModels, locale)} {isFa ? 'غیرفعال' : 'off'}
              </span>
            </div>
          </Surface>

          <Surface className="p-3.5">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {isFa ? 'خطاهای ۲۴ ساعت اخیر' : 'Failed Requests (24h)'}
            </div>
            <div
              className={`mt-1 text-lg font-bold ${
                alerts.failedRequests24h > 0
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-emerald-600 dark:text-emerald-400'
              }`}
            >
              {formatNumber(alerts.failedRequests24h, locale)}
            </div>
          </Surface>

          <Surface className="p-3.5">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {isFa ? 'تسک‌های متوقف در صف' : 'Stuck Queue Jobs'}
            </div>
            <div
              className={`mt-1 text-lg font-bold ${
                alerts.stuckJobs > 0
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-slate-900 dark:text-slate-100'
              }`}
            >
              {formatNumber(alerts.stuckJobs, locale)}
            </div>
          </Surface>

          <Surface className="p-3.5">
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              {isFa ? 'اعتبار اولیه پلن رایگان' : 'Free Plan Initial Credits'}
            </div>
            <div className="mt-1 text-lg font-bold text-blue-700 dark:text-blue-400">
              {alerts.freePlanCredits !== null
                ? formatNumber(alerts.freePlanCredits, locale)
                : '—'}
            </div>
          </Surface>
        </div>
      )}

      {/* Chat Workspace */}
      <Surface className="flex flex-col min-h-[520px] max-h-[680px] overflow-hidden">
        {/* Conversation Stream */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5">
          {turns.length === 0 ? (
            <div className="py-6 space-y-6">
              <div className="text-center max-w-lg mx-auto space-y-2">
                <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-950/50 border border-blue-200 dark:border-blue-900 text-blue-700 dark:text-blue-400 flex items-center justify-center mx-auto">
                  <Bot className="w-6 h-6" />
                </div>
                <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  {isFa ? 'فرمان مدیریتی خود را به فارسی بنویسید' : 'Give an administrative command'}
                </h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  {isFa
                    ? 'دستیار ابتدا داده‌های واقعی دیتابیس را می‌خواند و سپس تحلیل دقیق و کارت‌های اجرای امن (با ثبت در گزارش ممیزی) در اختیارتان می‌گذارد.'
                    : 'The copilot inspects live database telemetry first, then provides structured analysis and audited confirmation cards.'}
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 max-w-3xl mx-auto">
                {quickCommands.map((cmd, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => void sendMessage(cmd)}
                    className="text-start p-3 rounded-xl border border-slate-200 dark:border-slate-800 hover:border-blue-400 dark:hover:border-blue-600 hover:bg-blue-50/40 dark:hover:bg-blue-950/20 transition-colors text-xs text-slate-700 dark:text-slate-200 flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span>{cmd}</span>
                    <Sparkles className="w-3.5 h-3.5 shrink-0 text-blue-600 dark:text-blue-400" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn) => (
              <div
                key={turn.id}
                className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                {turn.role === 'user' ? (
                  <div className="max-w-2xl rounded-2xl rounded-te-sm bg-blue-700 text-white px-4 py-2.5 text-sm leading-relaxed">
                    {turn.content}
                  </div>
                ) : (
                  <div className="w-full max-w-3xl space-y-3">
                    {/* Model badge + Tool Traces */}
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="inline-flex items-center gap-1 font-medium text-slate-700 dark:text-slate-300">
                        <Cpu className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                        {turn.usedModelName || 'Copilot'}
                      </span>
                      {turn.toolTraces && turn.toolTraces.length > 0 && (
                        <>
                          <span>·</span>
                          {turn.toolTraces.map((tr, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300"
                              title={tr.summaryFa}
                            >
                              <Wrench className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                              <span>{tr.labelFa}</span>
                              <span className="text-[10px] text-slate-400 font-mono">
                                ({tr.durationMs}ms)
                              </span>
                            </span>
                          ))}
                        </>
                      )}
                    </div>

                    {/* Assistant Text */}
                    <div className="rounded-2xl rounded-ts-sm border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 px-4 py-3.5 text-sm text-slate-800 dark:text-slate-200 space-y-1">
                      {renderFormattedText(turn.content)}
                    </div>

                    {/* Auto-Executed Receipts */}
                    {turn.executedActions && turn.executedActions.length > 0 && (
                      <div className="space-y-2">
                        {turn.executedActions.map((exec) => (
                          <div
                            key={exec.actionId}
                            className={`p-3 rounded-xl border text-xs flex items-start gap-2 ${
                              exec.ok
                                ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200'
                                : 'border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-red-900 dark:text-red-200'
                            }`}
                          >
                            {exec.ok ? (
                              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
                            ) : (
                              <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-600" />
                            )}
                            <div>
                              <div className="font-semibold">
                                {isFa ? 'اجرای خودکار انجام شد:' : 'Auto-executed:'}
                              </div>
                              <div className="mt-0.5">{exec.summaryFa}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Confirmable Action Cards */}
                    {turn.proposedActions && turn.proposedActions.length > 0 && (
                      <div className="space-y-2.5">
                        {turn.proposedActions.map((act) => {
                          const st = actionStates[act.id];
                          const showParams = Boolean(expandedParams[act.id]);
                          const riskStyles =
                            act.risk === 'high'
                              ? 'text-red-700 dark:text-red-400 border-red-200 dark:border-red-900/60'
                              : act.risk === 'medium'
                                ? 'text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-900/60'
                                : 'text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900/60';

                          return (
                            <div
                              key={act.id}
                              className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3.5 space-y-2.5 shadow-xs"
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="space-y-0.5">
                                  <div className="flex items-center gap-2">
                                    {act.risk === 'high' ? (
                                      <ShieldAlert className="w-4 h-4 text-red-600 shrink-0" />
                                    ) : (
                                      <ShieldCheck className="w-4 h-4 text-blue-600 shrink-0" />
                                    )}
                                    <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                      {act.titleFa}
                                    </span>
                                    <span
                                      className={`text-[10px] font-medium px-2 py-0.5 rounded border ${riskStyles}`}
                                    >
                                      {act.risk === 'high'
                                        ? isFa
                                          ? 'حساس'
                                          : 'High Risk'
                                        : act.risk === 'medium'
                                          ? isFa
                                            ? 'متوسط'
                                            : 'Medium'
                                          : isFa
                                            ? 'کم‌ریسک'
                                            : 'Low Risk'}
                                    </span>
                                  </div>
                                  <p className="text-xs text-slate-600 dark:text-slate-400">
                                    {act.descriptionFa}
                                  </p>
                                </div>

                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedParams((prev) => ({
                                      ...prev,
                                      [act.id]: !prev[act.id],
                                    }))
                                  }
                                  className="text-[11px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 inline-flex items-center gap-1 cursor-pointer"
                                >
                                  <span>{isFa ? 'جزئیات فنی' : 'Params'}</span>
                                  {showParams ? (
                                    <ChevronUp className="w-3.5 h-3.5" />
                                  ) : (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              </div>

                              {showParams && (
                                <pre
                                  dir="ltr"
                                  className="p-2.5 rounded-lg bg-slate-950 text-slate-200 text-[11px] font-mono overflow-x-auto"
                                >
                                  {JSON.stringify({ tool: act.tool, args: act.args }, null, 2)}
                                </pre>
                              )}

                              {st?.status === 'done' ? (
                                <div className="p-2.5 rounded-lg bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 text-xs text-emerald-800 dark:text-emerald-200 flex items-center gap-2">
                                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                                  <span>{st.message}</span>
                                </div>
                              ) : st?.status === 'failed' ? (
                                <div className="p-2.5 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 text-xs text-red-800 dark:text-red-200 flex items-center gap-2">
                                  <XCircle className="w-4 h-4 shrink-0 text-red-600" />
                                  <span>{st.message}</span>
                                </div>
                              ) : st?.status === 'dismissed' ? (
                                <div className="text-xs text-slate-400">
                                  {isFa ? 'این اقدام توسط مدیر لغو شد.' : 'Dismissed by admin.'}
                                </div>
                              ) : (
                                <div className="flex items-center gap-2 pt-1">
                                  <Button
                                    size="sm"
                                    disabled={st?.status === 'running'}
                                    onClick={() => void handleExecuteAction(act)}
                                  >
                                    <Play className="w-3.5 h-3.5" />
                                    <span>
                                      {st?.status === 'running'
                                        ? isFa
                                          ? 'در حال اجرا...'
                                          : 'Executing...'
                                        : isFa
                                          ? 'تایید و اجرا'
                                          : 'Approve & Execute'}
                                    </span>
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={st?.status === 'running'}
                                    onClick={() => handleDismissAction(act.id)}
                                  >
                                    {isFa ? 'رد کردن' : 'Dismiss'}
                                  </Button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}

          {sending && (
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-600" />
              <span>
                {isFa
                  ? 'در حال بررسی دیتابیس زنده و تحلیل درخواست شما...'
                  : 'Inspecting live telemetry and preparing response...'}
              </span>
            </div>
          )}
          <div ref={scrollEndRef} />
        </div>

        {errorText && (
          <div className="mx-4 mb-2 p-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
            {errorText}
          </div>
        )}

        {/* Composer */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendMessage();
          }}
          className="p-3.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-900/70 flex items-end gap-2.5"
        >
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
            }}
            placeholder={
              isFa
                ? 'مثلاً: اعتبار پلن رایگان رو ۱۰ کن، یا مدل‌های خراب رو پاک‌سازی کن، یا خطاهای امروز رو تحلیل کن...'
                : 'e.g. Set Free plan credits to 10, prune broken models, or inspect today’s errors...'
            }
            className="flex-1 resize-none rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          />
          <Button type="submit" disabled={sending || !input.trim()} className="h-11 px-4">
            <Send className="w-4 h-4" />
            <span>{isFa ? 'ارسال' : 'Send'}</span>
          </Button>
        </form>
      </Surface>
    </div>
  );
}
