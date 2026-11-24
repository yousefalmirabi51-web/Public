import React, { useEffect, useState } from 'react';
import {
  CheckCircle2,
  FilePlus2,
  Filter,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { apiRequest } from '../api/client';
import { TicketListItem } from '../components/TicketListItem';
import {
  DEPARTMENT_LABELS,
  REASON_LABELS,
  STATUS_LABELS,
  type TicketSummary,
  type UserProfile,
} from '../types/domain';

interface TicketListScreenProps {
  user: UserProfile;
  scope: 'inbox' | 'open' | 'delayed' | 'all' | 'assembly_support';
  title: string;
  subtitle: string;
  refreshTick: number;
  onSelectTicket: (ticketId: number) => void;
  onCreateNew?: () => void;
  onCreateSupportTicket?: () => void;
}

export const TicketListScreen: React.FC<TicketListScreenProps> = ({
  user,
  scope,
  title,
  subtitle,
  refreshTick,
  onSelectTicket,
  onCreateNew,
  onCreateSupportTicket,
}) => {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [reasonFilter, setReasonFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [minStall, setMinStall] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams({ scope });
    if (search.trim()) params.set('search', search.trim());
    if (statusFilter) params.set('status', statusFilter);
    if (deptFilter) params.set('department', deptFilter);
    if (reasonFilter) params.set('reason', reasonFilter);
    if (dateFrom) params.set('date_from', dateFrom);
    if (minStall) params.set('min_stall_minutes', minStall);

    apiRequest<{ tickets: TicketSummary[] }>(`/api/tickets?${params.toString()}`)
      .then((res) => {
        if (active) {
          setTickets(res.tickets);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'تعذر تحميل البلاغات');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [scope, search, statusFilter, deptFilter, reasonFilter, dateFrom, minStall, refreshTick]);

  const canCreate = user.permissions.includes('create_ticket') || user.role_code === 'admin';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">{title}</h2>
          <p className="text-sm text-[var(--brand-charcoal)]/80">{subtitle}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {scope === 'assembly_support' && onCreateSupportTicket && (
            <button
              type="button"
              onClick={onCreateSupportTicket}
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-secondary px-4 py-2 text-sm whitespace-nowrap"
            >
              <FilePlus2 className="w-4 h-4" />
              <span>إنشاء بلاغ مساندة للإنتاج</span>
            </button>
          )}
          {scope !== 'assembly_support' && canCreate && onCreateNew && (
            <button
              type="button"
              onClick={onCreateNew}
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-primary px-4 py-2 text-sm whitespace-nowrap"
            >
              <FilePlus2 className="w-4 h-4" />
              <span>بلاغ جديد</span>
            </button>
          )}
        </div>
      </div>

      {scope === 'assembly_support' && (
        <div className="rounded-2xl border border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 px-4 py-3 text-xs font-semibold text-[var(--brand-charcoal)] flex items-center gap-2.5">
          <ShieldAlert className="w-5 h-5 text-[var(--brand-orange)] shrink-0" />
          <span>
            وضع مساندة قسم التجميع (اختياري ومنفصل عن صندوق الصالة الرئيسي): يمكنك المتابعة وإنشاء بلاغ مساندة للإنتاج، وتظل مسؤولية تأكيد الوصول واكتمال الطلب وإغلاق البلاغ بيد قسم التجميع.
          </span>
        </div>
      )}

      {/* Search & Filter Bar */}
      <div className="app-card p-3 space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center app-input h-[48px] px-3">
            <Search className="w-4 h-4 text-[var(--brand-charcoal)]/70 shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث برقم البلاغ، رقم الفاتورة، الصنف، القسم، السبب، المرسل..."
              className="w-full h-full bg-transparent px-2.5 text-sm text-[var(--brand-charcoal)] placeholder:text-[var(--brand-charcoal)]/55 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={`min-h-[48px] px-4 rounded-2xl border text-sm font-bold flex items-center gap-2 transition-colors whitespace-nowrap ${
              showFilters
                ? 'border-[var(--brand-red)] bg-[var(--brand-red)] text-white'
                : 'border-[var(--brand-gray-light)] bg-white text-[var(--brand-charcoal)] hover:border-[var(--brand-red)]'
            }`}
          >
            <Filter className="w-4 h-4" />
            <span>تصفية</span>
          </button>
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 pt-2 border-t border-[var(--brand-gray-light)]">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-[44px] app-input px-3 text-xs font-semibold"
            >
              <option value="">كل الحالات</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>

            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="h-[44px] app-input px-3 text-xs font-semibold"
            >
              <option value="">كل الأقسام</option>
              {Object.entries(DEPARTMENT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>

            <select
              value={reasonFilter}
              onChange={(e) => setReasonFilter(e.target.value)}
              className="h-[44px] app-input px-3 text-xs font-semibold"
            >
              <option value="">كل أسباب التعثر</option>
              {Object.entries(REASON_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>

            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              aria-label="من تاريخ"
              className="h-[44px] app-input px-3 text-xs font-semibold"
            />

            <select
              value={minStall}
              onChange={(e) => setMinStall(e.target.value)}
              className="h-[44px] app-input px-3 text-xs font-semibold"
            >
              <option value="">كل مدد التعثر</option>
              <option value="5">أكثر من 5 دقائق</option>
              <option value="10">أكثر من 10 دقائق</option>
              <option value="20">أكثر من 20 دقيقة</option>
            </select>
          </div>
        )}
      </div>

      {/* Results List */}
      {error ? (
        <div className="app-card-urgent p-6 text-center text-sm font-semibold text-[var(--brand-red)]">
          {error}
        </div>
      ) : loading ? (
        <div className="space-y-2.5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 app-card animate-pulse" />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <div className="app-card p-10 text-center">
          <CheckCircle2 className="w-10 h-10 text-[var(--brand-charcoal)]/45 mx-auto" />
          <p className="mt-2 text-base font-bold text-[var(--brand-charcoal)]">لا توجد بلاغات مطابقة في هذه القائمة</p>
          <p className="mt-1 text-xs text-[var(--brand-charcoal)]/75">جرّب تعديل كلمات البحث أو الفلاتر</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="text-xs font-semibold text-[var(--brand-charcoal)]/75 px-1 font-mono-num">
            النتائج: {tickets.length} بلاغ
          </div>
          {tickets.map((t) => (
            <TicketListItem key={t.id} ticket={t} onSelect={onSelectTicket} />
          ))}
        </div>
      )}
    </div>
  );
};
