import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  Clock,
  FilePlus2,
  Filter,
  Flame,
  Handshake,
  Inbox,
  Package,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import { apiRequest } from '../api/client';
import { TicketListItem } from '../components/TicketListItem';
import {
  DEPARTMENT_LABELS,
  REASON_LABELS,
  STATUS_LABELS,
  type ResponsibleAssignment,
  type TicketSummary,
  type UserProfile,
} from '../types/domain';
import { formatAdenDateTime, formatDurationAr, getAdenTodayDateKey } from '../utils/time';

export type NavView =
  | 'dashboard'
  | 'create'
  | 'inbox'
  | 'open'
  | 'delayed'
  | 'history'
  | 'assembly_support'
  | 'reports'
  | 'notifications'
  | 'sounds'
  | 'users'
  | 'settings'
  | 'readiness';

type DateFilterMode = 'today' | 'single' | 'range' | 'all';

interface DashboardResponse {
  filter: {
    mode: DateFilterMode;
    date: string;
    date_from: string;
    date_to: string;
    aden_today: string;
  };
  counts: {
    total: number;
    open: number;
    new: number;
    unreceived: number;
    in_progress: number;
    delayed: number;
    awaiting_confirm: number;
    reopened: number;
    closed: number;
    escalated: number;
  };
  metrics: {
    avg_response_minutes: number;
    avg_resolution_minutes: number;
    total_open_stall_minutes: number;
  };
  recent_tickets: TicketSummary[];
  tickets: TicketSummary[];
  responsibles?: ResponsibleAssignment[];
  stall_threshold_minutes?: number;
}

interface DashboardScreenProps {
  user: UserProfile;
  refreshTick: number;
  onNavigate: (view: NavView) => void;
  onSelectTicket: (ticketId: number) => void;
}

export const DashboardScreen: React.FC<DashboardScreenProps> = ({
  user,
  refreshTick,
  onNavigate,
  onSelectTicket,
}) => {
  const todayAden = getAdenTodayDateKey();
  const isAdminOrOps = user.role_code === 'admin';

  const [filterMode, setFilterMode] = useState<DateFilterMode>(isAdminOrOps ? 'today' : 'all');
  const [singleDate, setSingleDate] = useState<string>(todayAden);
  const [dateFrom, setDateFrom] = useState<string>(todayAden);
  const [dateTo, setDateTo] = useState<string>(todayAden);

  const [appliedFilter, setAppliedFilter] = useState<{
    mode: DateFilterMode;
    date: string;
    dateFrom: string;
    dateTo: string;
  }>({
    mode: isAdminOrOps ? 'today' : 'all',
    date: todayAden,
    dateFrom: todayAden,
    dateTo: todayAden,
  });

  const [data, setData] = useState<DashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams();
    params.set('mode', appliedFilter.mode);
    if (appliedFilter.mode === 'single' && appliedFilter.date) {
      params.set('date', appliedFilter.date);
    }
    if (appliedFilter.mode === 'range') {
      if (appliedFilter.dateFrom) params.set('date_from', appliedFilter.dateFrom);
      if (appliedFilter.dateTo) params.set('date_to', appliedFilter.dateTo);
    }

    apiRequest<DashboardResponse>(`/api/dashboard?${params.toString()}`)
      .then((res) => {
        if (active) {
          setData(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'تعذر تحميل لوحة المتابعة');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshTick, appliedFilter]);

  const applyTodayFilter = () => {
    const t = getAdenTodayDateKey();
    setFilterMode('today');
    setSingleDate(t);
    setDateFrom(t);
    setDateTo(t);
    setAppliedFilter({ mode: 'today', date: t, dateFrom: t, dateTo: t });
  };

  const applyAllFilter = () => {
    setFilterMode('all');
    setAppliedFilter({ mode: 'all', date: singleDate, dateFrom, dateTo });
  };

  const handleApplyResults = () => {
    if (filterMode === 'single') {
      setAppliedFilter({ mode: 'single', date: singleDate || todayAden, dateFrom, dateTo });
    } else if (filterMode === 'range') {
      setAppliedFilter({ mode: 'range', date: singleDate, dateFrom, dateTo });
    } else {
      setAppliedFilter({ mode: filterMode, date: singleDate, dateFrom, dateTo });
    }
  };

  const handleResetFilters = () => {
    if (isAdminOrOps) {
      applyTodayFilter();
    } else {
      applyAllFilter();
    }
  };

  const canCreate = user.permissions.includes('create_ticket') || user.role_code === 'admin';
  const canReports = user.permissions.includes('view_reports') || user.role_code === 'admin';
  const canReadiness = user.role_code === 'admin' || user.permissions.includes('manage_settings');

  const quickActions: Array<{
    view: NavView;
    title: string;
    desc: string;
    count?: number;
    accent: 'red' | 'orange' | 'charcoal';
    icon: React.ComponentType<{ className?: string }>;
    visible: boolean;
  }> = [
    {
      view: 'inbox',
      title: 'صندوق الوارد للقسم',
      desc: 'متابعة البلاغات الموجهة إلى قسمك واستلامها',
      count: data?.counts.unreceived,
      accent: 'red',
      icon: Inbox,
      visible: true,
    },
    {
      view: 'create',
      title: 'إنشاء بلاغ تعثر جديد',
      desc: 'تسجيل صنف متأخر أو ناقص أو تكدس وترحيله للقسم المختص',
      accent: 'red',
      icon: FilePlus2,
      visible: canCreate,
    },
    {
      view: 'delayed',
      title: 'البلاغات المتأخرة والمصعدة',
      desc: 'مراقبة الطلبات التي تجاوزت مدة التعثر المحددة',
      count: data?.counts.delayed,
      accent: 'orange',
      icon: AlertTriangle,
      visible: true,
    },
    {
      view: 'assembly_support',
      title: 'مساندة قسم التجميع',
      desc: 'متابعة الأصناف المتأخرة والناقصة وإسناد التجميع اختيارياً',
      accent: 'orange',
      icon: Handshake,
      visible: user.has_assembly_support,
    },
    {
      view: 'reports',
      title: 'تقارير التشغيل والأداء',
      desc: 'تحليل أسباب التعثر ومتوسط الاستجابة والتصدير',
      accent: 'charcoal',
      icon: BarChart3,
      visible: canReports,
    },
    {
      view: 'readiness',
      title: 'لوحة جاهزية النظام والنسخ الاحتياطي',
      desc: 'فحص سلامة قاعدة البيانات، تأكيدات الاستلام، والنسخ الاحتياطية الموثقة',
      accent: 'charcoal',
      icon: ShieldCheck,
      visible: canReadiness,
    },
  ];

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 app-card animate-pulse" />
          ))}
        </div>
        <div className="h-48 app-card animate-pulse" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="app-card-urgent p-6 text-center text-sm font-bold text-[var(--brand-red)]">
        {error}
      </div>
    );
  }

  const c = data?.counts;
  const m = data?.metrics;
  const periodTickets = data?.tickets ?? [];

  const statCards: Array<{
    label: string;
    value: string | number;
    sub: string;
    color: string;
    urgent?: boolean;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    {
      label: 'إجمالي الطلبات المتعثرة',
      value: c?.total ?? 0,
      sub: 'في الفترة المحددة',
      color: 'text-[var(--brand-charcoal)]',
      icon: Package,
    },
    {
      label: 'الطلبات المفتوحة',
      value: c?.open ?? 0,
      sub: `${c?.unreceived ?? 0} بانتظار الاستلام`,
      color: 'text-[var(--brand-charcoal)]',
      icon: Clock,
    },
    {
      label: 'قيد التحضير والمعالجة',
      value: c?.in_progress ?? 0,
      sub: 'جاري التنفيذ',
      color: 'text-[var(--brand-orange)]',
      icon: Flame,
    },
    {
      label: 'الطلبات المتأخرة',
      value: c?.delayed ?? 0,
      sub: `${c?.escalated ?? 0} حالة حرجة / مصعدة`,
      color: 'text-[var(--brand-red)]',
      urgent: (c?.delayed ?? 0) > 0,
      icon: AlertTriangle,
    },
    {
      label: 'بانتظار التأكيد',
      value: c?.awaiting_confirm ?? 0,
      sub: 'في قسم التجميع',
      color: 'text-[var(--brand-orange)]',
      icon: Flame,
    },
    {
      label: 'الطلبات المغلقة',
      value: c?.closed ?? 0,
      sub: 'تم التحقق والإغلاق',
      color: 'text-[var(--brand-charcoal)]',
      icon: CheckCircle2,
    },
    {
      label: 'متوسط زمن التجهيز',
      value: `${m?.avg_resolution_minutes ?? 0} د`,
      sub: 'معدل الإنجاز الفعلي',
      color: 'text-[var(--brand-charcoal)]',
      icon: Clock,
    },
    {
      label: 'متوسط الاستجابة للتأخير',
      value: `${m?.avg_response_minutes ?? 0} د`,
      sub: `تعثر مفتوح: ${formatDurationAr(m?.total_open_stall_minutes ?? 0)}`,
      color: 'text-[var(--brand-red)]',
      icon: AlertTriangle,
    },
  ];

  const periodDescription =
    appliedFilter.mode === 'today'
      ? `اليوم (${todayAden} · بتوقيت عدن)`
      : appliedFilter.mode === 'single'
        ? `تاريخ ${appliedFilter.date}`
        : appliedFilter.mode === 'range'
          ? `من ${appliedFilter.dateFrom || 'البداية'} إلى ${appliedFilter.dateTo || 'الآن'}`
          : 'كافة التواريخ المسجلة';

  return (
    <div className="space-y-6">
      {/* Signature Urgent Alert Banner (Matches Reference Screenshot Top Red Banner) */}
      {(c?.delayed ?? 0) > 0 && (
        <div className="app-banner-urgent p-4 sm:p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-white/15 text-white flex items-center justify-center shrink-0">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base sm:text-lg font-extrabold text-white">
                يوجد <span className="font-mono-num">{c?.delayed}</span> طلبات متعثرة تتطلب تدخلاً فورياً!
              </h3>
              <p className="text-xs text-white/90 mt-0.5">
                تم تنبيه الأقسام المسؤولة ومتابعة الطلبات المتجاوزة للوقت المستهدف بتوقيت عدن.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('delayed')}
            className="min-h-[42px] rounded-2xl bg-white px-5 py-2 text-xs sm:text-sm font-extrabold text-[var(--brand-red)] shadow-sm hover:opacity-95 transition-opacity whitespace-nowrap"
          >
            عرض البلاغات المتأخرة
          </button>
        </div>
      )}

      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">
            لوحة متابعة {user.department_name_ar}
          </h2>
          <p className="text-sm text-[var(--brand-charcoal)]/80">
            مرحباً {user.full_name} · {user.role_name_ar} — التوقيت المعتمد Asia/Aden
          </p>
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={() => onNavigate('create')}
            className="min-h-[44px] inline-flex items-center gap-2 app-btn-primary px-5 py-2.5 text-sm whitespace-nowrap"
          >
            <FilePlus2 className="w-4 h-4" />
            <span>ترحيل بلاغ جديد</span>
          </button>
        )}
      </div>

      {/* Live Responsible Roster & Active Stall Threshold */}
      {data?.responsibles && data.responsibles.length > 0 && (
        <section className="app-card p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-extrabold text-[var(--brand-charcoal)]">
              المسؤولون المكلفون حالياً في التشغيل
            </span>
            {typeof data.stall_threshold_minutes === 'number' && (
              <span className="rounded-2xl border border-[var(--brand-orange)]/40 bg-[var(--brand-orange)]/10 px-3 py-1 text-[11px] font-bold text-[var(--brand-charcoal)] font-mono-num">
                مدة اعتبار الطلب متعثراً: <strong className="text-[var(--brand-red)]">{data.stall_threshold_minutes} د</strong>
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {data.responsibles.map((resp) => (
              <div
                key={resp.role_key}
                className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2"
              >
                <div className="text-[11px] font-bold text-[var(--brand-red)] truncate">{resp.role_title_ar}</div>
                <div className="text-xs font-extrabold text-[var(--brand-charcoal)] truncate mt-0.5">
                  {resp.assigned_person_name}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Time Filter Panel (Asia/Aden Stall Date Filtering) */}
      <section className="app-card p-4 sm:p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
              <Calendar className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-extrabold text-[var(--brand-charcoal)]">
                تصفية الطلبات المتعثرة حسب تاريخ التعثر الفعلي (عدن)
              </h3>
              <p className="text-[11px] text-[var(--brand-charcoal)]/75">
                النطاق المعروض حالياً:{' '}
                <strong className="text-[var(--brand-red)] font-mono-num">{periodDescription}</strong>
              </p>
            </div>
          </div>
          <span className="text-xs font-mono-num font-bold text-[var(--brand-charcoal)]">
            إجمالي النتائج: <strong className="text-[var(--brand-red)]">{c?.total ?? 0}</strong>
          </span>
        </div>

        {/* Mode Buttons */}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={applyTodayFilter}
            className={`min-h-[40px] rounded-2xl border px-4 text-xs font-bold transition-colors ${
              filterMode === 'today'
                ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
            }`}
          >
            اليوم
          </button>

          <button
            type="button"
            onClick={() => setFilterMode('single')}
            className={`min-h-[40px] rounded-2xl border px-4 text-xs font-bold transition-colors ${
              filterMode === 'single'
                ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
            }`}
          >
            اختيار التاريخ
          </button>

          <button
            type="button"
            onClick={() => setFilterMode('range')}
            className={`min-h-[40px] rounded-2xl border px-4 text-xs font-bold transition-colors ${
              filterMode === 'range'
                ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
            }`}
          >
            فترة زمنية (من / إلى)
          </button>

          <button
            type="button"
            onClick={applyAllFilter}
            className={`min-h-[40px] rounded-2xl border px-4 text-xs font-bold transition-colors ${
              filterMode === 'all'
                ? 'border-[var(--brand-charcoal)] bg-[var(--brand-charcoal)] text-white'
                : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
            }`}
          >
            كافة البلاغات
          </button>
        </div>

        {/* Date Inputs */}
        {(filterMode === 'single' || filterMode === 'range') && (
          <div className="flex flex-wrap items-end gap-3 pt-1">
            {filterMode === 'single' && (
              <div className="min-w-[180px]">
                <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">
                  اختيار التاريخ
                </label>
                <input
                  type="date"
                  value={singleDate}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSingleDate(val);
                    if (val) {
                      setAppliedFilter({ mode: 'single', date: val, dateFrom, dateTo });
                    }
                  }}
                  className="w-full h-[42px] app-input px-3 text-sm font-mono-num"
                />
              </div>
            )}

            {filterMode === 'range' && (
              <>
                <div className="min-w-[170px]">
                  <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">من تاريخ</label>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDateFrom(val);
                      setAppliedFilter({ mode: 'range', date: singleDate, dateFrom: val, dateTo });
                    }}
                    className="w-full h-[42px] app-input px-3 text-sm font-mono-num"
                  />
                </div>
                <div className="min-w-[170px]">
                  <label className="block text-xs font-bold text-[var(--brand-charcoal)] mb-1">إلى تاريخ</label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDateTo(val);
                      setAppliedFilter({ mode: 'range', date: singleDate, dateFrom, dateTo: val });
                    }}
                    className="w-full h-[42px] app-input px-3 text-sm font-mono-num"
                  />
                </div>
              </>
            )}

            <button
              type="button"
              onClick={handleApplyResults}
              className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-primary px-4 text-xs"
            >
              <Filter className="w-3.5 h-3.5" />
              <span>عرض النتائج</span>
            </button>

            <button
              type="button"
              onClick={handleResetFilters}
              className="min-h-[42px] inline-flex items-center gap-1.5 app-btn-outline px-4 text-xs"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>إعادة تعيين</span>
            </button>
          </div>
        )}
      </section>

      {/* KPI Grid (Matches Reference Screenshot White Cards with Soft Shadows) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3.5">
        {statCards.map((card) => {
          const CardIcon = card.icon;
          return (
            <div
              key={card.label}
              className={`${card.urgent ? 'app-card-urgent' : 'app-card'} p-4 flex flex-col justify-between`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className={`text-xs font-bold ${card.urgent ? 'text-[var(--brand-red)]' : card.color}`}>
                  {card.label}
                </span>
                <CardIcon className={`w-4 h-4 shrink-0 ${card.color}`} />
              </div>
              <div className={`mt-3 text-2xl font-extrabold font-mono-num ${card.color}`}>{card.value}</div>
              <span
                className={`mt-1 text-[11px] font-semibold ${
                  card.urgent ? 'text-[var(--brand-red)]' : 'text-[var(--brand-charcoal)]/75'
                }`}
              >
                {card.sub}
              </span>
            </div>
          );
        })}
      </div>

      {/* Period Detailed Stalled Orders List */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 px-1">
          <h3 className="text-base font-bold text-[var(--brand-charcoal)]">
            الطلبات المتعثرة خلال الفترة (<span className="font-mono-num">{periodTickets.length}</span>)
          </h3>
          <span className="text-xs text-[var(--brand-charcoal)]/75">
            يظهر كل بلاغ بشكل مستقل حتى لو تعددت البلاغات لنفس الفاتورة — اضغط على البلاغ لفتح كامل المراسلات
          </span>
        </div>

        {periodTickets.length > 0 ? (
          <div className="space-y-2.5">
            {periodTickets.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectTicket(t.id)}
                className="w-full app-card-interactive p-4 text-right space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
                    <span className="font-mono-num text-[var(--brand-red)]">فاتورة {t.invoice_number}</span>
                    <span>·</span>
                    <span className="font-mono-num text-[var(--brand-charcoal)]">{t.ticket_number}</span>
                    <span>·</span>
                    <span className="text-[var(--brand-charcoal)] text-sm font-extrabold">
                      {t.item_name} <span className="text-[var(--brand-orange)] font-mono-num">×{t.quantity}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-xs font-bold">
                    <span
                      className={
                        t.status === 'closed'
                          ? 'text-[var(--brand-charcoal)]'
                          : 'text-[var(--brand-red)]'
                      }
                    >
                      {STATUS_LABELS[t.status]}
                    </span>
                    <ChevronLeft className="w-4 h-4 text-[var(--brand-charcoal)]/60" />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs text-[var(--brand-charcoal)]/85">
                  <div>
                    <span className="text-[var(--brand-charcoal)]/60">القسم المسؤول: </span>
                    <strong className="text-[var(--brand-red)]">{DEPARTMENT_LABELS[t.target_department]}</strong>
                  </div>
                  <div>
                    <span className="text-[var(--brand-charcoal)]/60">سبب التعثر: </span>
                    <strong className="text-[var(--brand-charcoal)]">{REASON_LABELS[t.reason_code]}</strong>
                  </div>
                  <div className="font-mono-num">
                    <span className="text-[var(--brand-charcoal)]/60">بداية التعثر: </span>
                    <strong>{formatAdenDateTime(t.created_at)}</strong>
                  </div>
                  <div className="font-mono-num flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-[var(--brand-orange)] shrink-0" />
                    <span className="text-[var(--brand-charcoal)]/60">التأخير: </span>
                    <strong className="text-[var(--brand-red)]">{formatDurationAr(t.stall_minutes)}</strong>
                    <span className="text-[var(--brand-charcoal)]/60"> · تحديث: {formatAdenDateTime(t.updated_at)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="app-card p-8 text-center">
            <CheckCircle2 className="w-10 h-10 text-[var(--brand-charcoal)]/45 mx-auto" />
            <p className="mt-2 text-sm font-bold text-[var(--brand-charcoal)]">
              لا توجد طلبات متعثرة مطابقة للفترة المحددة
            </p>
            <p className="mt-1 text-xs text-[var(--brand-charcoal)]/75">
              يمكنك تغيير التاريخ أو الضغط على إعادة تعيين لعرض كافة النتائج
            </p>
          </div>
        )}
      </section>

      {/* Unified Vertical Navigation List */}
      <section className="space-y-2.5">
        <h3 className="text-base font-bold text-[var(--brand-charcoal)] px-1">الوصول السريع للأقسام والمهام</h3>
        <div className="space-y-2.5">
          {quickActions
            .filter((a) => a.visible)
            .map((action) => {
              const Icon = action.icon;
              const badgeColor =
                action.accent === 'red'
                  ? 'bg-[var(--brand-red)]'
                  : action.accent === 'orange'
                    ? 'bg-[var(--brand-orange)]'
                    : 'bg-[var(--brand-charcoal)]';
              return (
                <button
                  key={action.view}
                  type="button"
                  onClick={() => onNavigate(action.view)}
                  className="w-full min-h-[60px] app-card-interactive px-4 py-3 flex items-center justify-between gap-3 text-right"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div
                      className={`w-10 h-10 rounded-full ${badgeColor} text-white flex items-center justify-center shrink-0`}
                    >
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-[var(--brand-charcoal)] truncate">{action.title}</div>
                      <div className="text-xs text-[var(--brand-charcoal)]/75 truncate">{action.desc}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {typeof action.count === 'number' && action.count > 0 && (
                      <span className="font-mono-num text-sm font-extrabold text-[var(--brand-red)]">
                        {action.count}
                      </span>
                    )}
                    <ChevronLeft className="w-5 h-5 text-[var(--brand-charcoal)]/60" />
                  </div>
                </button>
              );
            })}
        </div>
      </section>

      {/* Recent Open Tickets */}
      {data && data.recent_tickets.length > 0 && (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between px-1">
            <h3 className="text-base font-bold text-[var(--brand-charcoal)]">أحدث البلاغات المفتوحة في هذه الفترة</h3>
            <button
              type="button"
              onClick={() => onNavigate('open')}
              className="text-xs font-bold text-[var(--brand-red)] hover:underline flex items-center gap-1"
            >
              <span>عرض الكل</span>
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-2.5">
            {data.recent_tickets.map((t) => (
              <TicketListItem key={t.id} ticket={t} onSelect={onSelectTicket} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
