import { Router, type Request, type Response } from 'express';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { adminSessions, adminUsers, auditLogs } from '../../db/schema.ts';
import { adminLoginSchema, adminSetupSchema } from '../../shared/validation.ts';
import { generateSessionToken, hashPassword, verifyPassword } from '../security/password.ts';
import { loginRateLimiter } from '../security/rateLimit.ts';
import { recordAuditLog } from '../security/audit.ts';
import { getEnvValidationSummary } from '../config/env.ts';
import {
  clearSessionCookie,
  getClientIp,
  requireAdminAuth,
  requireRole,
  setSessionCookie,
  type AdminRequest,
} from '../middleware/auth.ts';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_DB_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export function createAuthRouter(): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const db = getDb();
      const [countRow] = await db.select({ total: count() }).from(adminUsers);
      const total = countRow?.total ?? 0;
      const env = getEnvValidationSummary();
      res.json({
        needsSetup: total === 0,
        databaseMode: env.databaseMode,
        encryptionConfigured: env.encryptionConfigured,
        encryptionSource: env.encryptionSource,
        warnings: env.warnings,
      });
    } catch (err) {
      console.error('[auth/status]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در بررسی وضعیت احراز هویت.' });
    }
  });

  // One-time initial super_admin creation (permanently disabled once any admin exists)
  router.post('/setup', async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = adminSetupSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message ?? 'اطلاعات ورودی نامعتبر است.',
          issues: parsed.error.issues,
        });
        return;
      }

      const db = getDb();
      const [countRow] = await db.select({ total: count() }).from(adminUsers);
      if ((countRow?.total ?? 0) > 0) {
        res.status(403).json({
          error: 'راه‌اندازی اولیه قبلاً انجام شده است. لطفاً از صفحه ورود استفاده کنید.',
          code: 'SETUP_ALREADY_COMPLETED',
        });
        return;
      }

      const email = parsed.data.email.toLowerCase();
      const passwordHash = await hashPassword(parsed.data.password);
      const { rawToken, tokenHash, csrfToken } = generateSessionToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      const createdAdmin = await db.transaction(async (tx) => {
        const [admin] = await tx
          .insert(adminUsers)
          .values({
            email,
            fullName: parsed.data.fullName,
            passwordHash,
            role: 'super_admin',
            permissions: ['*'],
            status: 'active',
            lastLoginAt: new Date(),
            lastLoginIp: ip,
          })
          .returning({
            id: adminUsers.id,
            email: adminUsers.email,
            fullName: adminUsers.fullName,
            role: adminUsers.role,
            permissions: adminUsers.permissions,
          });

        if (!admin) throw new Error('Failed to insert initial admin.');

        await tx.insert(adminSessions).values({
          adminUserId: admin.id,
          tokenHash,
          csrfToken,
          ipAddress: ip,
          userAgent: ua.slice(0, 500),
          expiresAt,
        });

        return admin;
      });

      setSessionCookie(req, res, rawToken, expiresAt);

      await recordAuditLog({
        adminUserId: createdAdmin.id,
        actorEmail: createdAdmin.email,
        action: 'admin.initial_setup',
        resourceType: 'admin_user',
        resourceId: createdAdmin.id,
        severity: 'warning',
        ipAddress: ip,
        userAgent: ua,
        details: { role: 'super_admin' },
      });

      res.status(201).json({
        admin: createdAdmin,
        csrfToken,
      });
    } catch (err) {
      console.error('[auth/setup]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در ایجاد حساب مدیر ارشد اولیه.' });
    }
  });

  router.post('/login', async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const parsed = adminLoginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues[0]?.message ?? 'ایمیل یا رمز عبور نامعتبر است.',
        });
        return;
      }

      const email = parsed.data.email.toLowerCase();
      const rateKey = `login:${ip}:${email}`;
      const rateCheck = loginRateLimiter.check(rateKey);
      if (!rateCheck.allowed) {
        res.setHeader('Retry-After', String(rateCheck.retryAfterSeconds));
        res.status(429).json({
          error: `تلاش‌های ناموفق بیش از حد مجاز است. لطفاً ${Math.ceil(rateCheck.retryAfterSeconds / 60)} دقیقه دیگر تلاش کنید.`,
          code: 'LOGIN_RATE_LIMITED',
        });
        return;
      }

      const db = getDb();
      const rows = await db
        .select()
        .from(adminUsers)
        .where(eq(adminUsers.email, email))
        .limit(1);

      const admin = rows[0];
      const now = new Date();

      if (!admin) {
        loginRateLimiter.consume(rateKey);
        await recordAuditLog({
          actorEmail: email,
          action: 'admin.login_failed',
          resourceType: 'admin_session',
          severity: 'warning',
          status: 'failure',
          ipAddress: ip,
          userAgent: ua,
          details: { reason: 'unknown_account' },
        });
        res.status(401).json({ error: 'ایمیل یا رمز عبور نادرست است.' });
        return;
      }

      if (admin.status !== 'active') {
        await recordAuditLog({
          adminUserId: admin.id,
          actorEmail: admin.email,
          action: 'admin.login_blocked',
          resourceType: 'admin_session',
          severity: 'critical',
          status: 'denied',
          ipAddress: ip,
          userAgent: ua,
          details: { status: admin.status },
        });
        res.status(403).json({ error: 'حساب مدیریت غیرفعال یا مسدود شده است.' });
        return;
      }

      if (admin.lockedUntil && admin.lockedUntil > now) {
        const remainingMin = Math.ceil((admin.lockedUntil.getTime() - now.getTime()) / 60000);
        res.status(423).json({
          error: `به دلیل تلاش‌های ناموفق متعدد، حساب موقتاً به مدت ${remainingMin} دقیقه قفل شده است.`,
          code: 'ACCOUNT_LOCKED',
        });
        return;
      }

      const validPassword = await verifyPassword(parsed.data.password, admin.passwordHash);
      if (!validPassword) {
        loginRateLimiter.consume(rateKey);
        const nextAttempts = admin.failedLoginAttempts + 1;
        const lockUntil =
          nextAttempts >= MAX_DB_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null;

        await db
          .update(adminUsers)
          .set({
            failedLoginAttempts: nextAttempts,
            lockedUntil: lockUntil,
            updatedAt: now,
          })
          .where(eq(adminUsers.id, admin.id));

        await recordAuditLog({
          adminUserId: admin.id,
          actorEmail: admin.email,
          action: 'admin.login_failed',
          resourceType: 'admin_session',
          severity: lockUntil ? 'critical' : 'warning',
          status: 'failure',
          ipAddress: ip,
          userAgent: ua,
          details: { attempts: nextAttempts, locked: Boolean(lockUntil) },
        });

        res.status(401).json({ error: 'ایمیل یا رمز عبور نادرست است.' });
        return;
      }

      // Success: clear rate limit & failed attempts, create server-side session
      loginRateLimiter.reset(rateKey);
      const { rawToken, tokenHash, csrfToken } = generateSessionToken();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

      await db.transaction(async (tx) => {
        await tx
          .update(adminUsers)
          .set({
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: now,
            lastLoginIp: ip,
            updatedAt: now,
          })
          .where(eq(adminUsers.id, admin.id));

        await tx.insert(adminSessions).values({
          adminUserId: admin.id,
          tokenHash,
          csrfToken,
          ipAddress: ip,
          userAgent: ua.slice(0, 500),
          expiresAt,
        });
      });

      setSessionCookie(req, res, rawToken, expiresAt);

      await recordAuditLog({
        adminUserId: admin.id,
        actorEmail: admin.email,
        action: 'admin.login_success',
        resourceType: 'admin_session',
        severity: 'info',
        ipAddress: ip,
        userAgent: ua,
        details: { role: admin.role },
      });

      res.json({
        admin: {
          id: admin.id,
          email: admin.email,
          fullName: admin.fullName,
          role: admin.role,
          permissions: admin.permissions,
        },
        csrfToken,
      });
    } catch (err) {
      console.error('[auth/login]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در فرایند ورود.' });
    }
  });

  router.get('/me', requireAdminAuth, (req: AdminRequest, res: Response) => {
    const admin = req.admin!;
    res.json({
      admin: {
        id: admin.id,
        email: admin.email,
        fullName: admin.fullName,
        role: admin.role,
        permissions: admin.permissions,
      },
      csrfToken: admin.csrfToken,
    });
  });

  router.post('/logout', requireAdminAuth, async (req: AdminRequest, res: Response) => {
    const admin = req.admin!;
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] ?? '';
    try {
      const db = getDb();
      await db
        .update(adminSessions)
        .set({ revokedAt: new Date() })
        .where(eq(adminSessions.id, admin.sessionId));

      clearSessionCookie(req, res);

      await recordAuditLog({
        adminUserId: admin.id,
        actorEmail: admin.email,
        action: 'admin.logout',
        resourceType: 'admin_session',
        resourceId: admin.sessionId,
        severity: 'info',
        ipAddress: ip,
        userAgent: ua,
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('[auth/logout]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در خروج از نشست.' });
    }
  });

  // Security & Audit Endpoints (Protected)
  router.get('/security/overview', requireAdminAuth, async (req: AdminRequest, res: Response) => {
    try {
      const db = getDb();
      const [admins, sessions, logs] = await Promise.all([
        db
          .select({
            id: adminUsers.id,
            email: adminUsers.email,
            fullName: adminUsers.fullName,
            role: adminUsers.role,
            status: adminUsers.status,
            failedLoginAttempts: adminUsers.failedLoginAttempts,
            lockedUntil: adminUsers.lockedUntil,
            lastLoginAt: adminUsers.lastLoginAt,
            lastLoginIp: adminUsers.lastLoginIp,
            createdAt: adminUsers.createdAt,
          })
          .from(adminUsers)
          .orderBy(desc(adminUsers.createdAt)),
        db
          .select({
            id: adminSessions.id,
            adminUserId: adminSessions.adminUserId,
            adminEmail: adminUsers.email,
            adminName: adminUsers.fullName,
            ipAddress: adminSessions.ipAddress,
            userAgent: adminSessions.userAgent,
            expiresAt: adminSessions.expiresAt,
            revokedAt: adminSessions.revokedAt,
            lastSeenAt: adminSessions.lastSeenAt,
            createdAt: adminSessions.createdAt,
          })
          .from(adminSessions)
          .innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id))
          .orderBy(desc(adminSessions.createdAt))
          .limit(30),
        db
          .select()
          .from(auditLogs)
          .orderBy(desc(auditLogs.createdAt))
          .limit(100),
      ]);

      const currentSessionId = req.admin!.sessionId;

      res.json({
        admins,
        sessions: sessions.map((s) => ({
          ...s,
          isCurrent: s.id === currentSessionId,
          isActive: !s.revokedAt && new Date(s.expiresAt) > new Date(),
        })),
        auditLogs: logs,
        envSummary: getEnvValidationSummary(),
      });
    } catch (err) {
      console.error('[security/overview]', err instanceof Error ? err.message : 'unknown');
      res.status(500).json({ error: 'خطا در دریافت اطلاعات امنیتی و گزارش ممیزی.' });
    }
  });

  router.post(
    '/security/sessions/:id/revoke',
    requireAdminAuth,
    requireRole('admin'),
    async (req: AdminRequest, res: Response) => {
      const sessionId = String(req.params.id ?? '');
      const ip = getClientIp(req);
      const ua = req.headers['user-agent'] ?? '';
      try {
        const db = getDb();
        const [revoked] = await db
          .update(adminSessions)
          .set({ revokedAt: new Date() })
          .where(andSessionActive(sessionId))
          .returning({ id: adminSessions.id });

        if (!revoked) {
          res.status(404).json({ error: 'نشست فعال مورد نظر یافت نشد.' });
          return;
        }

        await recordAuditLog({
          adminUserId: req.admin!.id,
          actorEmail: req.admin!.email,
          action: 'admin.session_revoked',
          resourceType: 'admin_session',
          resourceId: sessionId,
          severity: 'warning',
          ipAddress: ip,
          userAgent: ua,
        });

        res.json({ ok: true, revokedId: sessionId });
      } catch (err) {
        console.error('[security/revoke]', err instanceof Error ? err.message : 'unknown');
        res.status(500).json({ error: 'خطا در لغو نشست.' });
      }
    },
  );

  return router;
}

function andSessionActive(id: string) {
  return and(eq(adminSessions.id, id), isNull(adminSessions.revokedAt));
}
