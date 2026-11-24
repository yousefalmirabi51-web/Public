import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface PWAInstallButtonProps {
  variant?: 'sidebar' | 'card';
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({ variant = 'card' }) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) return null;

  const handleClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowGuide(true);
    }
  };

  return (
    <>
      {variant === 'sidebar' ? (
        <button
          type="button"
          onClick={handleClick}
          className="w-full min-h-[44px] flex items-center justify-between gap-2 rounded-2xl bg-white/15 hover:bg-white/25 text-white px-4 py-2.5 text-sm font-semibold transition-colors whitespace-nowrap"
        >
          <span className="flex items-center gap-2.5">
            <Download className="w-4 h-4 shrink-0" />
            <span>تثبيت التطبيق</span>
          </span>
          <Smartphone className="w-4 h-4 shrink-0 opacity-80" />
        </button>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          className="min-h-[44px] inline-flex items-center gap-2 rounded-2xl border border-[var(--brand-red)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-red)] hover:bg-[var(--brand-red)] hover:text-white transition-colors whitespace-nowrap"
        >
          <Download className="w-4 h-4 shrink-0" />
          <span>{isIOS ? 'تثبيت على iPhone / iPad' : 'تثبيت التطبيق على الجهاز'}</span>
        </button>
      )}

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md app-card p-6 text-[var(--brand-charcoal)]">
            <div className="flex items-center justify-between border-b border-[var(--brand-gray-light)] pb-3">
              <h3 className="text-lg font-bold text-[var(--brand-red)]">تثبيت التطبيق كتطبيق جوال</h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center app-btn-outline"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="mt-4 space-y-3 text-sm leading-relaxed">
              {isIOS ? (
                <>
                  <p>لتثبيت التطبيق على جهاز iPhone أو iPad:</p>
                  <p>1. اضغط على زر <strong>مشاركة (Share)</strong> في شريط متصفح Safari.</p>
                  <p>2. اختر <strong>إضافة إلى الشاشة الرئيسية (Add to Home Screen)</strong>.</p>
                </>
              ) : (
                <>
                  <p>لتثبيت التطبيق على جهاز Android أو الكمبيوتر:</p>
                  <p>1. افتح قائمة المتصفح (Chrome / Edge) من الزاوية العلوية.</p>
                  <p>2. اختر <strong>تثبيت التطبيق (Install App)</strong> أو <strong>إضافة إلى الشاشة الرئيسية</strong>.</p>
                  <p className="text-xs text-[var(--brand-charcoal)]/80">أو استخدم مشروع Capacitor Android المرفق لبناء ملف APK/AAB.</p>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-5 w-full min-h-[48px] app-btn-primary text-sm"
            >
              إغلاق
            </button>
          </div>
        </div>
      )}
    </>
  );
};
