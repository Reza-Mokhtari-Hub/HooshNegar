import { describe, expect, it } from 'vitest';
import {
  adminSetupSchema,
  modelCreateSchema,
  providerCreateSchema,
  subscriptionPlanSchema,
  telegramSettingsUpdateSchema,
} from './validation.ts';

describe('Shared Zod Validation Schemas', () => {
  it('enforces strong admin passwords during setup', () => {
    expect(
      adminSetupSchema.safeParse({
        email: 'admin@example.com',
        fullName: 'مدیر ارشد',
        password: 'weak',
      }).success,
    ).toBe(false);

    expect(
      adminSetupSchema.safeParse({
        email: 'admin@example.com',
        fullName: 'مدیر ارشد',
        password: 'StrongPassword123',
      }).success,
    ).toBe(true);
  });

  it('requires at least one capability when creating an AI model', () => {
    const validUuid = '11111111-1111-4111-8111-111111111111';
    expect(
      modelCreateSchema.safeParse({
        providerId: validUuid,
        name: 'GPT-4o',
        modelIdentifier: 'gpt-4o',
        category: 'multimodal',
        capabilities: [],
      }).success,
    ).toBe(false);

    expect(
      modelCreateSchema.safeParse({
        providerId: validUuid,
        name: 'GPT-4o',
        modelIdentifier: 'gpt-4o',
        category: 'multimodal',
        capabilities: ['text_generation', 'chat', 'vision'],
      }).success,
    ).toBe(true);
  });

  it('validates provider URL protocol and Telegram HTTPS webhook constraint', () => {
    expect(
      providerCreateSchema.safeParse({
        name: 'Gemini',
        providerType: 'google_gemini',
        baseUrl: 'javascript:alert(1)',
        apiKey: 'AIzaSy1234567890',
      }).success,
    ).toBe(false);

    expect(
      telegramSettingsUpdateSchema.safeParse({
        webhookUrl: 'http://insecure.example.com/webhook',
        welcomeMessage: 'سلام',
        errorMessages: {
          rateLimit: 'a',
          maintenance: 'b',
          providerError: 'c',
          insufficientCredits: 'd',
          unsupportedCapability: 'e',
        },
      }).success,
    ).toBe(false);
  });

  it('validates subscription plan slug and numeric bounds', () => {
    expect(
      subscriptionPlanSchema.safeParse({
        name: 'پلن حرفه‌ای',
        slug: 'pro-plan',
        tier: 'pro',
        priceAmount: 290000,
        currency: 'IRT',
        durationDays: 30,
        dailyRequestLimit: 100,
        monthlyRequestLimit: 2500,
        textGenerationLimit: 2000,
        imageGenerationLimit: 50,
        audioGenerationLimit: 20,
        videoGenerationLimit: 5,
        maxFileSizeMb: 25,
        maxConcurrentTasks: 3,
        creditAllocation: 500,
        isEnabled: true,
      }).success,
    ).toBe(true);
  });
});
