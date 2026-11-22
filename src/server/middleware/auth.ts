import type { Request, Response, NextFunction } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '../../db/index.ts';
import { adminSessions, adminUsers } from '../../db/schema.ts';
import { hashSessionToken, timingSafeEqualStr } from '../security/password.ts';
import { apiRateLimiter } from '../security/rateLimit.ts';
import type { AdminRole } from '../../shared/validation.ts';

export const SESSION_COOKIE_NAME = 'hn_admin_session';

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  fullName: string;
  role: AdminRole;
  permissions: string[];
  sessionId: string;
  csrfToken: string;
}

export interface AdminRequest extends Request {
  admin?: AuthenticatedAdmin;
}

const ROLE_WEIGHT: Record<AdminRole, number> = {
  auditor: 10,
  operator: 20,
  admin: 30,
  super_admin: 40,
};

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() || req.ip || 'unknown';
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  next();
}

export function apiRateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req);
  const decision = apiRateLimiter.consume(`api:${ip}`);
  if (!decision.allowed) {
    res.setHeader('Retry-After', String(decision.retryAfterSeconds));
    res.status(429).json({
      error: 'تعداد درخواست‌های API از حد مجاز فراتر رفت. لطفاً لحظاتی صبر کنید.',
      code: 'RATE_LIMITED',
    });
    return;
  }
  next();
}

export async function requireAdminAuth(
  req: AdminRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 20) {
      res.status(401).json({ error: 'دسترسی غیرمجاز. لطفاً وارد حساب مدیریت شوید.', code: 'UNAUTHORIZED' });
      return;
    }

    const tokenHash = hashSessionToken(rawToken);
    const db = getDb();
    const now = new Date();

    const rows = await db
      .select({
        sessionId: adminSessions.id,
        csrfToken: adminSessions.csrfToken,
        expiresAt: adminSessions.expiresAt,
        adminId: adminUsers.id,
        email: adminUsers.email,
        fullName: adminUsers.fullName,
        role: adminUsers.role,
        permissions: adminUsers.permissions,
        status: adminUsers.status,
      })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminSessions.adminUserId, adminUsers.id))
      .where(
        and(
          eq(adminSessions.tokenHash, tokenHash),
          isNull(adminSessions.revokedAt),
          gt(adminSessions.expiresAt, now),
        ),
      )
      .limit(1);

    const match = rows[0];
    if (!match || match.status !== 'active') {
      res.status(401).json({ error: 'نشست شما منقضی یا لغو شده است.', code: 'SESSION_INVALID' });
      return;
    }

    // Enforce CSRF token on all state-mutating requests
    const isMutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase());
    if (isMutating) {
      const headerToken = req.headers['x-csrf-token'];
      if (typeof headerToken !== 'string' || !timingSafeEqualStr(headerToken, match.csrfToken)) {
        res.status(403).json({
          error: 'توکن امنیتی CSRF نامعتبر است. صفحه را بارگذاری مجدد کنید.',
          code: 'CSRF_INVALID',
        });
        return;
      }
    }

    req.admin = {
      id: match.adminId,
      email: match.email,
      fullName: match.fullName,
      role: match.role,
      permissions: match.permissions ?? [],
      sessionId: match.sessionId,
      csrfToken: match.csrfToken,
    };

    // Touch last_seen_at asynchronously without blocking request
    db.update(adminSessions)
      .set({ lastSeenAt: now })
      .where(eq(adminSessions.id, match.sessionId))
      .catch(() => {});

    next();
  } catch (err) {
    console.error('[auth] Session validation failed:', err instanceof Error ? err.message : 'unknown');
    res.status(500).json({ error: 'خطای داخلی در بررسی نشست امنیتی.', code: 'AUTH_ERROR' });
  }
}

export function requireRole(minRole: AdminRole) {
  return (req: AdminRequest, res: Response, next: NextFunction): void => {
    if (!req.admin) {
      res.status(401).json({ error: 'احراز هویت الزامی است.', code: 'UNAUTHORIZED' });
      return;
    }
    if (ROLE_WEIGHT[req.admin.role] < ROLE_WEIGHT[minRole]) {
      res.status(403).json({
        error: 'سطح دسترسی حساب شما برای انجام این عملیات کافی نیست.',
        code: 'FORBIDDEN',
      });
      return;
    }
    next();
  };
}

export function setSessionCookie(req: Request, res: Response, rawToken: string, expiresAt: Date): void {
  const isHttps =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production';

  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  const isHttps =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    process.env.NODE_ENV === 'production';

  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    path: '/',
  });
}
