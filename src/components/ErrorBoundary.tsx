import React from 'react';
import { Button } from './ui/primitives';

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error.message || 'خطای غیرمنتظره در نمایش رابط کاربری رخ داد.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error.message, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50 dark:bg-slate-950">
          <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 text-center">
            <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              خطای اجرایی در رابط کاربری
            </h1>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-2 leading-relaxed">
              {this.state.errorMessage}
            </p>
            <div className="mt-5">
              <Button onClick={() => window.location.reload()}>بارگذاری مجدد صفحه</Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
