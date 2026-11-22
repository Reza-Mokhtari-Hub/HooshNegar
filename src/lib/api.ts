let inMemoryCsrfToken: string | null = null;
let onUnauthorizedCallback: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  inMemoryCsrfToken = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorizedCallback = handler;
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    skipAuthRedirect?: boolean;
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (inMemoryCsrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = inMemoryCsrfToken;
  }

  const response = await fetch(path, {
    method,
    headers,
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: text };
    }
  }

  if (!response.ok) {
    if (response.status === 401 && !options.skipAuthRedirect && onUnauthorizedCallback) {
      inMemoryCsrfToken = null;
      onUnauthorizedCallback();
    }
    throw new ApiError(
      typeof data.error === 'string' ? data.error : `خطای ارتباط با سرور (HTTP ${response.status})`,
      response.status,
      typeof data.code === 'string' ? data.code : undefined,
    );
  }

  return data as T;
}
