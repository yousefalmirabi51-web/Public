import React from 'react';
import { BrandLogo } from './BrandLogo';

export const SplashScreen: React.FC = () => {
  return (
    <div className="min-h-screen w-full bg-[var(--brand-surface-neutral)] flex flex-col items-center justify-center px-6 text-center">
      <div className="app-card p-8 flex flex-col items-center max-w-sm w-full">
        <BrandLogo size="xl" />
        <h1 className="mt-4 text-xl font-bold text-[var(--brand-red)]">التشغيل الذكي</h1>
        <p className="mt-1 text-base font-semibold text-[var(--brand-charcoal)]">مطعم المذاق اليمني</p>
        <div className="mt-6 w-36 h-1.5 rounded-full bg-[var(--brand-gray-light)] overflow-hidden">
          <div className="h-full w-1/2 bg-[var(--brand-red)] rounded-full animate-pulse" />
        </div>
        <p className="mt-3 text-xs text-[var(--brand-charcoal)]/80">جاري تجهيز محطة التشغيل...</p>
      </div>
    </div>
  );
};
