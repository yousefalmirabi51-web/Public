import React, { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, User, UserCheck, AlertCircle, ChevronLeft } from 'lucide-react';
import { BrandLogo } from './BrandLogo';
import { apiRequest, setAuthToken } from '../api/client';
import type { UserProfile } from '../types/domain';
import { unlockStationAudio } from '../utils/audioAlerts';

interface LoginScreenProps {
  onLoginSuccess: (user: UserProfile, token: string) => void;
}

const DEMO_ACCOUNTS = [
  { label: 'مسؤول التجميع والتسليم', sub: 'أحمد المقطري', username: 'assembly', pass: 'Pass@123' },
  { label: 'مسؤول الإنتاج', sub: 'محمد الصنعاني', username: 'production', pass: 'Pass@123' },
  { label: 'مسؤول الصالة', sub: 'سالم الحضرمي', username: 'hall', pass: 'Pass@123' },
  { label: 'مدير النظام', sub: 'م. فيصل الخولاني', username: 'admin', pass: 'Admin@123' },
];

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!username.trim()) {
      setError('يرجى إدخال اسم المستخدم');
      return;
    }
    if (!password) {
      setError('يرجى إدخال كلمة المرور');
      return;
    }

    setLoading(true);
    try {
      await unlockStationAudio();
      const res = await apiRequest<{ token: string; user: UserProfile }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          password,
          full_name: displayName.trim() || undefined,
          email: email.trim() || undefined,
        }),
      });
      setAuthToken(res.token);
      onLoginSuccess(res.user, res.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسجيل الدخول، يرجى التحقق من البيانات');
    } finally {
      setLoading(false);
    }
  };

  const quickFill = (acc: (typeof DEMO_ACCOUNTS)[number]) => {
    setDisplayName(acc.sub);
    setUsername(acc.username);
    setEmail(`${acc.username}@almazaq.ye`);
    setPassword(acc.pass);
    setError(null);
  };

  return (
    <div className="min-h-screen w-full bg-[var(--brand-surface-neutral)] flex flex-col items-center justify-center px-4 py-8">
      <div className="w-full max-w-md flex flex-col items-center">
        {/* Top Centered Logo & App Name */}
        <BrandLogo size="xl" />
        <h1 className="mt-3 text-2xl font-extrabold text-[var(--brand-red)] text-center">
          التشغيل الذكي
        </h1>
        <p className="mt-1 text-base font-bold text-[var(--brand-charcoal)] text-center">
          مطعم المذاق اليمني
        </p>
        <p className="mt-1 text-xs text-[var(--brand-charcoal)]/80 text-center">
          نظام متابعة الطلبات المتعثرة والتنبيه والتصعيد الفوري
        </p>

        {/* Unified White Rounded Login Card */}
        <form
          onSubmit={handleSubmit}
          className="mt-6 w-full app-card p-5 sm:p-7 space-y-4"
        >
          <div className="text-center pb-1">
            <h2 className="text-lg font-bold text-[var(--brand-charcoal)]">تسجيل الدخول للمحطة</h2>
          </div>

          {error && (
            <div className="flex items-center gap-2.5 rounded-2xl border border-[var(--brand-red)] bg-[var(--brand-red)]/5 px-4 py-3 text-sm font-medium text-[var(--brand-red)]">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Field 1: الاسم (اختياري) */}
          <div className="relative flex items-center app-input h-[54px] px-3">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
              <UserCheck className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="الاسم (اختياري)"
              aria-label="الاسم"
              className="w-full h-full bg-transparent px-3 text-sm font-medium text-[var(--brand-charcoal)] placeholder:text-[var(--brand-charcoal)]/60 focus:outline-none"
            />
          </div>

          {/* Field 2: اسم المستخدم (إلزامي) */}
          <div className="relative flex items-center app-input h-[54px] px-3">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
              <User className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="اسم المستخدم *"
              aria-label="اسم المستخدم"
              autoComplete="username"
              required
              className="w-full h-full bg-transparent px-3 text-sm font-medium text-[var(--brand-charcoal)] placeholder:text-[var(--brand-charcoal)]/60 focus:outline-none"
            />
          </div>

          {/* Field 3: البريد الإلكتروني (اختياري) */}
          <div className="relative flex items-center app-input h-[54px] px-3">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-orange)] text-white flex items-center justify-center shrink-0">
              <Mail className="w-4 h-4" />
            </div>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="البريد الإلكتروني (اختياري)"
              aria-label="البريد الإلكتروني"
              autoComplete="email"
              className="w-full h-full bg-transparent px-3 text-sm font-medium text-[var(--brand-charcoal)] placeholder:text-[var(--brand-charcoal)]/60 focus:outline-none"
            />
          </div>

          {/* Field 4: كلمة المرور + زر إظهار/إخفاء */}
          <div className="relative flex items-center app-input h-[54px] px-3">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
              <Lock className="w-4 h-4" />
            </div>
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="كلمة المرور *"
              aria-label="كلمة المرور"
              autoComplete="current-password"
              required
              className="w-full h-full bg-transparent px-3 text-sm font-medium text-[var(--brand-charcoal)] placeholder:text-[var(--brand-charcoal)]/60 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              aria-label={showPassword ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
              className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl text-[var(--brand-charcoal)] hover:bg-[var(--brand-charcoal)]/10 transition-colors"
            >
              {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full min-h-[52px] app-btn-primary text-base active:scale-[0.99] disabled:opacity-60"
          >
            {loading ? 'جاري التحقق والدخول...' : 'تسجيل الدخول'}
          </button>
        </form>

        {/* Vertical Quick Access List for Testing Stations */}
        <div className="mt-6 w-full app-card p-4">
          <p className="text-xs font-bold text-[var(--brand-charcoal)] mb-3 px-1">
            تعبئة سريعة لحسابات المحطات والأقسام
          </p>
          <div className="space-y-2">
            {DEMO_ACCOUNTS.map((acc) => (
              <button
                key={acc.username}
                type="button"
                onClick={() => quickFill(acc)}
                className="w-full min-h-[48px] flex items-center justify-between gap-3 app-card-interactive px-3.5 py-2 text-right"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-8 h-8 rounded-full bg-[var(--brand-surface-neutral)] border border-[var(--brand-gray-light)] text-[var(--brand-red)] flex items-center justify-center shrink-0 text-xs font-bold">
                    {acc.username.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-[var(--brand-charcoal)] truncate">{acc.label}</div>
                    <div className="text-xs text-[var(--brand-charcoal)]/75 truncate">
                      {acc.sub} · {acc.username}
                    </div>
                  </div>
                </div>
                <ChevronLeft className="w-4 h-4 text-[var(--brand-charcoal)]/60 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
