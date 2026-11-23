import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  adminUsers,
  aiModels,
  aiProviders,
  auditLogs,
  coupons,
  modelCapabilities,
  providerCredentials,
  subscriptionPlans,
} from '../../db/schema.ts';
import { ensurePlatformReady } from '../services/bootstrap.ts';
import { encryptSecret, maskSecret } from '../security/crypto.ts';
import {
  classifyProbeHttpResponse,
  isLikelyBrokenGradioUiHelper,
  runBatchModelHealthCheck,
} from './modelHealthService.ts';
import {
  executeAdminCopilotAction,
  extractJsonObjectFromText,
  getAdminCopilotContext,
  runAdminCopilotChat,
} from '../services/aiAdminCopilotService.ts';

const originalMockFlag = process.env.AI_MOCK_MODE;

beforeAll(async () => {
  process.env.ENCRYPTION_MASTER_KEY =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.AI_MOCK_MODE = 'true';
  await ensurePlatformReady();
});

afterEach(() => {
  process.env.AI_MOCK_MODE = originalMockFlag ?? 'true';
});

describe('Model Health Classifier & Smart Pruner (Preserves Rate-Limited Models)', () => {
  it('accurately classifies HTTP responses and NEVER marks temporary rate limits or auth errors as broken', () => {
    expect(
      classifyProbeHttpResponse({
        providerType: 'openai_compatible',
        modelIdentifier: 'llama-3.3-70b',
        httpStatus: 200,
        bodyText: '{"choices":[{"message":{"content":"hi"}}]}',
      }).status,
    ).toBe('healthy');

    // Temporary 429 RPM/RPD limit -> MUST be rate_limited (NEVER broken!)
    expect(
      classifyProbeHttpResponse({
        providerType: 'google_gemini',
        modelIdentifier: 'gemini-2.5-flash',
        httpStatus: 429,
        bodyText: JSON.stringify({
          error: {
            code: 429,
            message: 'Quota exceeded for metric: requests_per_minute, limit: 15',
          },
        }),
      }).status,
    ).toBe('rate_limited');

    // Permanent 429 limit: 0 -> broken!
    expect(
      classifyProbeHttpResponse({
        providerType: 'google_gemini',
        modelIdentifier: 'gemini-2.5-flash-image',
        httpStatus: 429,
        bodyText: JSON.stringify({
          error: {
            code: 429,
            message: 'Quota exceeded for metric: free_tier_requests, limit: 0, model: gemini-2.5-flash-image',
          },
        }),
      }).status,
    ).toBe('broken');

    // 401 Invalid key -> auth_error (preserved so an expired key never wipes 90 models)
    expect(
      classifyProbeHttpResponse({
        providerType: 'openai_compatible',
        modelIdentifier: 'gpt-4o-mini',
        httpStatus: 401,
        bodyText: '{"error":{"message":"Incorrect API key provided"}}',
      }).status,
    ).toBe('auth_error');

    // 402 on Hugging Face monthly included credits -> rate_limited (preserved)
    expect(
      classifyProbeHttpResponse({
        providerType: 'huggingface',
        modelIdentifier: 'meta-llama/Llama-3.3-70B-Instruct',
        httpStatus: 402,
        bodyText: '{"error":"You have exceeded your monthly included credits for Inference Providers."}',
      }).status,
    ).toBe('rate_limited');

    // 402 on OpenRouter paid model -> broken
    expect(
      classifyProbeHttpResponse({
        providerType: 'openai_compatible',
        modelIdentifier: 'anthropic/claude-opus-4',
        httpStatus: 402,
        bodyText: '{"error":{"message":"This request requires more credits, or fewer max_tokens."}}',
      }).status,
    ).toBe('broken');

    // 404 model not found -> broken
    expect(
      classifyProbeHttpResponse({
        providerType: 'openai_compatible',
        modelIdentifier: 'meta-llama/dead-model:free',
        httpStatus: 404,
        bodyText: '{"error":{"message":"No endpoints found for meta-llama/dead-model:free"}}',
      }).status,
    ).toBe('broken');

    // 403 billing/gated -> broken
    expect(
      classifyProbeHttpResponse({
        providerType: 'google_gemini',
        modelIdentifier: 'imagen-3.0-generate-002',
        httpStatus: 403,
        bodyText: '{"error":{"message":"Imagen API is only accessible to billed users at this time."}}',
      }).status,
    ).toBe('broken');

    // 503 overload -> transient (preserved)
    expect(
      classifyProbeHttpResponse({
        providerType: 'openai_compatible',
        modelIdentifier: 'deepseek/deepseek-r1:free',
        httpStatus: 503,
        bodyText: 'Upstream overloaded',
      }).status,
    ).toBe('transient');

    // Gradio UI helper detection
    expect(isLikelyBrokenGradioUiHelper('qwen-image::update_mode_ui')).toBe(true);
    expect(isLikelyBrokenGradioUiHelper('qwen-image::generate')).toBe(false);
  });

  it('prunes ONLY broken models while keeping healthy, rate-limited, and auth-error models intact', async () => {
    process.env.AI_MOCK_MODE = 'true';
    const db = getDb();
    const slug = `health-test-${Date.now()}`;

    const [provider] = await db
      .insert(aiProviders)
      .values({
        name: 'Bulk Test Provider',
        slug,
        providerType: 'openai_compatible',
        baseUrl: 'https://openrouter.ai/api/v1',
        isActive: true,
      })
      .returning();

    const enc = encryptSecret('sk-test-health-check-key');
    await db.insert(providerCredentials).values({
      providerId: provider!.id,
      label: 'primary',
      encryptedApiKey: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      maskedPreview: maskSecret('sk-test-health-check-key'),
      isActive: true,
    });

    const seeded = await db
      .insert(aiModels)
      .values([
        {
          providerId: provider!.id,
          name: 'Working Chat Model',
          modelIdentifier: 'org/working-chat:free',
          category: 'llm',
          isActive: true,
          priority: 1,
        },
        {
          providerId: provider!.id,
          name: 'Rate Limited Chat Model',
          modelIdentifier: 'org/rate-limit-chat:free',
          category: 'llm',
          isActive: true,
          priority: 2,
        },
        {
          providerId: provider!.id,
          name: 'Auth Issue Model',
          modelIdentifier: 'org/auth-err-model',
          category: 'llm',
          isActive: true,
          priority: 3,
        },
        {
          providerId: provider!.id,
          name: 'Dead 404 Model',
          modelIdentifier: 'org/broken-404-model',
          category: 'llm',
          isActive: true,
          priority: 4,
        },
        {
          providerId: provider!.id,
          name: 'Zero Quota Model',
          modelIdentifier: 'org/zero-quota-image',
          category: 'image',
          isActive: true,
          priority: 5,
        },
      ])
      .returning();

    await db.insert(modelCapabilities).values(
      seeded.map((m) => ({
        modelId: m.id,
        capability: m.category === 'image' ? ('image_generation' as const) : ('chat' as const),
      })),
    );

    // Step 1: Deactivate broken models (keeping healthy, rate_limited, auth_error)
    const report = await runBatchModelHealthCheck({
      providerId: provider!.id,
      onlyActive: true,
      offset: 0,
      limit: 10,
      action: 'deactivate_broken',
    });

    expect(report.totalMatching).toBe(5);
    expect(report.summary.healthy).toBe(1);
    expect(report.summary.rateLimited).toBe(1);
    expect(report.summary.authError).toBe(1);
    expect(report.summary.broken).toBe(2);
    expect(report.summary.deactivated).toBe(2);
    expect(report.summary.kept).toBe(3);

    const afterDeactivate = await db
      .select({ id: aiModels.id, modelIdentifier: aiModels.modelIdentifier, isActive: aiModels.isActive })
      .from(aiModels)
      .where(eq(aiModels.providerId, provider!.id));

    const byId = new Map(afterDeactivate.map((m) => [m.modelIdentifier, m.isActive]));
    expect(byId.get('org/working-chat:free')).toBe(true);
    expect(byId.get('org/rate-limit-chat:free')).toBe(true); // MUST stay active!
    expect(byId.get('org/auth-err-model')).toBe(true); // MUST stay active!
    expect(byId.get('org/broken-404-model')).toBe(false);
    expect(byId.get('org/zero-quota-image')).toBe(false);

    // Step 2: Delete broken models (with onlyActive=false)
    const deleteReport = await runBatchModelHealthCheck({
      providerId: provider!.id,
      onlyActive: false,
      offset: 0,
      limit: 10,
      action: 'delete_broken',
    });

    expect(deleteReport.summary.deleted).toBe(2);
    expect(deleteReport.summary.kept).toBe(3);

    const remaining = await db
      .select({ modelIdentifier: aiModels.modelIdentifier })
      .from(aiModels)
      .where(eq(aiModels.providerId, provider!.id));

    expect(remaining.map((r) => r.modelIdentifier).sort()).toEqual([
      'org/auth-err-model',
      'org/rate-limit-chat:free',
      'org/working-chat:free',
    ]);
  });
});

describe('AI Site Manager Copilot (Read Tools, Action Cards, RBAC & Audit Logs)', () => {
  it('extracts JSON safely from fenced markdown and prose', () => {
    const parsed = extractJsonObjectFromText(
      'Here is your result:\n```json\n{"type":"final","replyFa":"سلام","proposedActions":[]}\n```',
    );
    expect(parsed).toEqual({ type: 'final', replyFa: 'سلام', proposedActions: [] });
  });

  it('inspects live DB plans, proposes update_plan action, executes it with audit log, and enforces RBAC', async () => {
    process.env.AI_MOCK_MODE = 'true';
    const db = getDb();

    const ctx = await getAdminCopilotContext();
    expect(ctx.alerts).toBeTruthy();
    expect(typeof ctx.alerts.activeModels).toBe('number');

    const [createdAdmin] = await db
      .insert(adminUsers)
      .values({
        email: `copilot-admin-${Date.now()}@hooshnegar.local`,
        fullName: 'Copilot Test Super Admin',
        passwordHash: 'test-hash-not-for-login',
        role: 'super_admin',
        status: 'active',
      })
      .returning();

    const adminActor = {
      id: createdAdmin!.id,
      email: createdAdmin!.email,
      role: 'super_admin' as const,
      ipAddress: '127.0.0.1',
    };

    const chatRes = await runAdminCopilotChat({
      actor: adminActor,
      messages: [{ role: 'user', content: 'اعتبار اولیه پلن رایگان را به 10 کاهش بده' }],
      autoExecute: false,
    });

    expect(chatRes.toolTraces.length).toBeGreaterThanOrEqual(2);
    expect(chatRes.proposedActions.length).toBe(1);
    const planAction = chatRes.proposedActions[0]!;
    expect(planAction.tool).toBe('update_plan');
    expect(planAction.args.creditAllocation).toBe(10);

    // RBAC check: auditor must be blocked
    const blocked = await executeAdminCopilotAction({
      actor: { ...adminActor, role: 'auditor' },
      actionId: planAction.id,
      tool: planAction.tool,
      args: planAction.args,
    });
    expect(blocked.ok).toBe(false);

    // Execute as super_admin
    const executed = await executeAdminCopilotAction({
      actor: adminActor,
      actionId: planAction.id,
      tool: planAction.tool,
      args: planAction.args,
    });
    expect(executed.ok).toBe(true);

    // Verify DB really updated the Free plan creditAllocation to 10
    const [updatedPlan] = await db
      .select({ creditAllocation: subscriptionPlans.creditAllocation })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, String(planAction.args.planId)))
      .limit(1);
    expect(updatedPlan?.creditAllocation).toBe(10);

    // Verify audit log recorded
    const logs = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.action, 'ai_copilot.update_plan'));
    expect(logs.length).toBeGreaterThanOrEqual(1);

    // Verify create_coupon action works end-to-end
    const code = `AI${Date.now().toString().slice(-6)}`;
    const couponRes = await executeAdminCopilotAction({
      actor: adminActor,
      actionId: 'act-coupon-test',
      tool: 'create_coupon',
      args: {
        code,
        discountType: 'credits',
        discountValue: 25,
        maxRedemptions: 50,
        expiresInDays: 14,
      },
    });
    expect(couponRes.ok).toBe(true);

    const [createdCoupon] = await db
      .select({ code: coupons.code, discountValue: coupons.discountValue })
      .from(coupons)
      .where(eq(coupons.code, code))
      .limit(1);
    expect(createdCoupon?.code).toBe(code);
    expect(Number(createdCoupon?.discountValue)).toBe(25);
  });
});
