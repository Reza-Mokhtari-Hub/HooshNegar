import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import {
  notificationLogs,
  notificationTemplates,
  telegramAccounts,
  users,
} from '../../db/schema.ts';
import { getConfiguredTelegramApi } from '../telegram/jobRunner.ts';
import { redactSecrets } from '../security/crypto.ts';

export type NotificationTemplateKey =
  | 'payment_success'
  | 'subscription_activated'
  | 'subscription_expired'
  | 'renewal_upcoming'
  | 'renewal_failed'
  | 'low_credits'
  | 'referral_success'
  | 'promo_reward'
  | 'ai_completed'
  | 'ai_failed';

type TelegramMessageSender = (chatId: number, text: string) => Promise<void>;
let customSenderForTests: TelegramMessageSender | null = null;

export function setNotificationSenderForTests(sender: TelegramMessageSender | null): void {
  customSenderForTests = sender;
}

export function renderNotificationTemplate(
  template: string,
  variables: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = variables[key];
    return val === undefined || val === null ? '' : String(val);
  });
}

export async function sendUserNotification(params: {
  userId: string;
  templateKey: NotificationTemplateKey;
  dedupKey: string;
  variables: Record<string, string | number>;
  overrideText?: string;
}): Promise<{ status: 'sent' | 'skipped' | 'duplicate' | 'failed'; logId?: string }> {
  const db = getDb();

  // Check deduplication first
  const [existing] = await db
    .select({ id: notificationLogs.id })
    .from(notificationLogs)
    .where(eq(notificationLogs.dedupKey, params.dedupKey))
    .limit(1);

  if (existing) {
    return { status: 'duplicate', logId: existing.id };
  }

  // Load user & telegram account
  const [userRow] = await db
    .select({ id: users.id, locale: users.locale })
    .from(users)
    .where(eq(users.id, params.userId))
    .limit(1);

  if (!userRow) {
    return { status: 'skipped' };
  }

  const [tgAcc] = await db
    .select({
      telegramChatId: telegramAccounts.telegramChatId,
      telegramUserId: telegramAccounts.telegramUserId,
      isBlockedByUser: telegramAccounts.isBlockedByUser,
      languageCode: telegramAccounts.languageCode,
    })
    .from(telegramAccounts)
    .where(eq(telegramAccounts.userId, params.userId))
    .limit(1);

  const [tpl] = await db
    .select()
    .from(notificationTemplates)
    .where(eq(notificationTemplates.templateKey, params.templateKey))
    .limit(1);

  if (tpl && !tpl.isEnabled && !params.overrideText) {
    return { status: 'skipped' };
  }

  const lang = tgAcc?.languageCode === 'en' || userRow.locale === 'en' ? 'en' : 'fa';
  const rawBody =
    params.overrideText ??
    (tpl ? (lang === 'en' && tpl.bodyEn ? tpl.bodyEn : tpl.bodyFa) : '');

  if (!rawBody.trim()) {
    return { status: 'skipped' };
  }

  const messageText = renderNotificationTemplate(rawBody, params.variables);
  const chatId = tgAcc?.telegramChatId ?? tgAcc?.telegramUserId ?? null;

  const [inserted] = await db
    .insert(notificationLogs)
    .values({
      userId: params.userId,
      telegramChatId: chatId,
      templateKey: params.templateKey,
      dedupKey: params.dedupKey,
      channel: 'telegram',
      messageText,
      status: 'queued',
    })
    .onConflictDoNothing()
    .returning({ id: notificationLogs.id });

  if (!inserted) {
    return { status: 'duplicate' };
  }

  if (!chatId || tgAcc?.isBlockedByUser) {
    await db
      .update(notificationLogs)
      .set({
        status: 'skipped',
        errorMessage: tgAcc?.isBlockedByUser ? 'User blocked bot' : 'No Telegram chat ID',
      })
      .where(eq(notificationLogs.id, inserted.id));
    return { status: 'skipped', logId: inserted.id };
  }

  try {
    if (customSenderForTests) {
      await customSenderForTests(chatId, messageText);
    } else {
      const tg = await getConfiguredTelegramApi();
      if (!tg) {
        await db
          .update(notificationLogs)
          .set({
            status: 'skipped',
            errorMessage: 'Telegram bot token not configured',
          })
          .where(eq(notificationLogs.id, inserted.id));
        return { status: 'skipped', logId: inserted.id };
      }
      await tg.api.sendMessage(chatId, messageText);
    }

    await db
      .update(notificationLogs)
      .set({
        status: 'sent',
        sentAt: new Date(),
      })
      .where(eq(notificationLogs.id, inserted.id));

    return { status: 'sent', logId: inserted.id };
  } catch (err) {
    const safeErr = redactSecrets(err instanceof Error ? err.message : 'Notification delivery failed');
    await db
      .update(notificationLogs)
      .set({
        status: 'failed',
        errorMessage: safeErr.slice(0, 400),
      })
      .where(eq(notificationLogs.id, inserted.id));
    return { status: 'failed', logId: inserted.id };
  }
}

export async function sendDirectTelegramMessage(chatId: number, text: string): Promise<boolean> {
  try {
    if (customSenderForTests) {
      await customSenderForTests(chatId, text);
      return true;
    }
    const tg = await getConfiguredTelegramApi();
    if (!tg) return false;
    await tg.api.sendMessage(chatId, text);
    return true;
  } catch {
    return false;
  }
}
