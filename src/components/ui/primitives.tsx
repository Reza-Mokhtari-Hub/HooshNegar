import React from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { X } from 'lucide-react';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
}

export function Button({
  className,
  variant = 'primary',
  size = 'md',
  type = 'button',
  ...props
}: ButtonProps) {
  const variants = {
    primary:
      'bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-500 border border-transparent',
    secondary:
      'bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white border border-transparent',
    outline:
      'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-200 dark:border-slate-700 dark:hover:bg-slate-800',
    ghost:
      'bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 border border-transparent',
    danger:
      'bg-red-600 text-white hover:bg-red-700 dark:bg-red-700 dark:hover:bg-red-600 border border-transparent',
  };

  const sizes = {
    sm: 'h-8 px-3 text-xs gap-1.5',
    md: 'h-10 px-4 text-sm gap-2',
    lg: 'h-11 px-5 text-sm gap-2',
  };

  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}

export function Surface({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Input({
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full h-10 px-3 rounded-lg text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100',
        'border border-slate-300 dark:border-slate-700 placeholder:text-slate-400 dark:placeholder:text-slate-500',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:border-blue-600 transition-colors',
        'disabled:opacity-60 disabled:bg-slate-50 dark:disabled:bg-slate-900',
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full h-10 px-3 rounded-lg text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100',
        'border border-slate-300 dark:border-slate-700',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:border-blue-600 transition-colors',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full p-3 rounded-lg text-sm bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100',
        'border border-slate-300 dark:border-slate-700 placeholder:text-slate-400 dark:placeholder:text-slate-500',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:border-blue-600 transition-colors',
        className,
      )}
      {...props}
    />
  );
}

export function FieldLabel({
  htmlFor,
  children,
  required,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5"
    >
      {children}
      {required && <span className="text-red-600 ms-1">*</span>}
    </label>
  );
}

export function StatusText({
  tone,
  children,
}: {
  tone: 'success' | 'warning' | 'danger' | 'neutral';
  children: React.ReactNode;
}) {
  const tones = {
    success: 'text-emerald-700 dark:text-emerald-400',
    warning: 'text-amber-700 dark:text-amber-400',
    danger: 'text-red-700 dark:text-red-400',
    neutral: 'text-slate-500 dark:text-slate-400',
  };
  return <span className={cn('text-xs font-medium', tones[tone])}>{children}</span>;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  maxWidth = 'max-w-2xl',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/60 backdrop-blur-[1px]"
    >
      <div
        className={cn(
          'w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xl max-h-[90vh] flex flex-col',
          maxWidth,
        )}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
            {description && (
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن پنجره"
            className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:hover:text-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-14 px-6">
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5 max-w-md leading-relaxed">
        {description}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function TableSkeleton({ rows = 4, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-slate-200 dark:divide-slate-800">
      {Array.from({ length: rows }).map((_, rIdx) => (
        <div key={rIdx} className="grid gap-4 px-5 py-3.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {Array.from({ length: cols }).map((__, cIdx) => (
            <div key={cIdx} className="h-4 rounded bg-slate-200/70 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      ))}
    </div>
  );
}
