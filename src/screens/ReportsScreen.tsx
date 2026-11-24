import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  Download,
  FileSpreadsheet,
  Printer,
  RefreshCw,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { apiRequest } from '../api/client';
import {
  DEPARTMENT_LABELS,
  REASON_LABELS,
  STATUS_LABELS,
  type ResponsibleAssignment,
  type TicketSummary,
  type UserProfile,
} from '../types/domain';
import { formatAdenDateTime } from '../utils/time';

interface ReportsData {
  summary: {
    total: number;
    open: number;
    closed: number;
    delayed: number;
    reopened: number;
    awaiting_confirm: number;
    escalated: number;
    avg_response_minutes: number;
    avg_processing_minutes: number;
  };
  by_department: Array<{ label: string; count: number }>;
  by_reason: Array<{ label: string; count: number }>;
  by_employee: Array<{ label: string; count: number }>;
  top_delayed_items: Array<{ item_name: string; count: number; total_stall_minutes: number; avg_stall_minutes: number }>;
  repeated_invoices: Array<{ invoice_number: string; count: number }>;
  tickets: TicketSummary[];
  responsibles?: ResponsibleAssignment[];
  stall_threshold_minutes?: number;
}

interface ReportsScreenProps {
  user: UserProfile;
  refreshTick: number;
  onSelectTicket: (ticketId: number) => void;
}

export const ReportsScreen: React.FC<ReportsScreenProps> = ({ user, refreshTick, onSelectTicket }) => {
  const [data, setData] = useState<ReportsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [reasonFilter, setReasonFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const params = new URLSearchParams();
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (deptFilter) params.set('department', deptFilter);
    if (reasonFilter) params.set('reason', reasonFilter);
    if (statusFilter) params.set('status', statusFilter);

    apiRequest<ReportsData>(`/api/reports?${params.toString()}`)
      .then((res) => {
        if (active) {
          setData(res);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'تعذر تحميل التقارير');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [dateFrom, dateTo, deptFilter, reasonFilter, statusFilter, refreshTick]);

  const canExport = user.permissions.includes('export_reports') || user.role_code === 'admin';

  const handleExportExcel = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();

    const summaryRows = [
      { المؤشر: 'إجمالي البلاغات', القيمة: data.summary.total },
      { المؤشر: 'البلاغات المفتوحة', القيمة: data.summary.open },
      { المؤشر: 'البلاغات المغلقة', القيمة: data.summary.closed },
      { المؤشر: 'البلاغات المتأخرة', القيمة: data.summary.delayed },
      { المؤشر: 'بلاغات بانتظار التأكيد', القيمة: data.summary.awaiting_confirm },
      { المؤشر: 'البلاغات المعاد فتحها', القيمة: data.summary.reopened },
      { المؤشر: 'البلاغات المصعدة', القيمة: data.summary.escalated },
      { المؤشر: 'متوسط زمن الاستجابة (دقيقة)', القيمة: data.summary.avg_response_minutes },
      { المؤشر: 'متوسط زمن المعالجة (دقيقة)', القيمة: data.summary.avg_processing_minutes },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'ملخص التشغيل');

    const ticketRows = data.tickets.map((t) => ({
      'رقم البلاغ': t.ticket_number,
      'رقم الفاتورة': t.invoice_number,
      الصنف: t.item_name,
      الكمية: t.quantity,
      'سبب التعثر': REASON_LABELS[t.reason_code],
      الحالة: STATUS_LABELS[t.status],
      'القسم المرسل': DEPARTMENT_LABELS[t.sender_department],
      'القسم المعني': DEPARTMENT_LABELS[t.target_department],
      المنشئ: t.created_by_name,
      'مدة التعثر (دقيقة)': t.stall_minutes,
      'مستوى التصعيد': t.escalation_level,
      'وقت الإنشاء (عدن)': formatAdenDateTime(t.created_at),
      'وقت الإغلاق (عدن)': formatAdenDateTime(t.closed_at),
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ticketRows), 'تفاصيل البلاغات');

    const itemsSheet = data.top_delayed_items.map((i) => ({
      الصنف: i.item_name,
      'عدد البلاغات': i.count,
      'إجمالي دقائق التعثر': i.total_stall_minutes,
      'متوسط دقائق التعثر': i.avg_stall_minutes,
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemsSheet), 'الأصناف المتأخرة');

    XLSX.writeFile(wb, `تقرير_المذاق_اليمني_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const handlePrintPdf = () => {
    window.print();
  };

  if (error) {
    return (
      <div className="app-card-urgent p-6 text-center text-sm font-bold text-[var(--brand-red)]">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">تقارير التشغيل وتحليل التعثر</h2>
          <p className="text-sm text-[var(--brand-charcoal)]/80">
            تغطي التقارير جميع المؤشرات الـ 12 وفق صلاحياتك مع التصفية والتصدير
          </p>
        </div>
        {canExport && data && (
          <div className="flex flex-wrap items-center gap-2 no-print">
            <button
              type="button"
              onClick={handleExportExcel}
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-primary px-4 text-sm"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span>تصدير Excel</span>
            </button>
            <button
              type="button"
              onClick={handlePrintPdf}
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-outline px-4 text-sm"
            >
              <Printer className="w-4 h-4" />
              <span>حفظ / طباعة PDF</span>
            </button>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="app-card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 no-print">
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          aria-label="من تاريخ"
          className="h-[44px] app-input px-3 text-xs font-semibold"
        />
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          aria-label="إلى تاريخ"
          className="h-[44px] app-input px-3 text-xs font-semibold"
        />
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
          <option value="">كل الأسباب</option>
          {Object.entries(REASON_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
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
      </div>

      {loading || !data ? (
        <div className="h-64 app-card animate-pulse" />
      ) : (
        <div className="space-y-5">
          {/* Responsibles & Active Threshold */}
          {data.responsibles && data.responsibles.length > 0 && (
            <div className="app-card p-4 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-extrabold text-[var(--brand-charcoal)]">المسؤولون المعتمدون في التقرير</span>
                {typeof data.stall_threshold_minutes === 'number' && (
                  <span className="font-mono-num font-bold text-[var(--brand-red)]">
                    معيار تعثر الطلب: {data.stall_threshold_minutes} دقائق
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {data.responsibles.map((resp) => (
                  <div
                    key={resp.role_key}
                    className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 text-xs"
                  >
                    <div className="font-bold text-[var(--brand-red)] truncate">{resp.role_title_ar}</div>
                    <div className="font-extrabold text-[var(--brand-charcoal)] truncate mt-0.5">
                      {resp.assigned_person_name}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Summary KPI Grid (Reports 3,4,5,6,8,9,12) */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {[
              { label: 'المفتوحة', val: data.summary.open, color: 'text-[var(--brand-red)]' },
              { label: 'المغلقة', val: data.summary.closed, color: 'text-[var(--brand-charcoal)]' },
              { label: 'المتأخرة', val: data.summary.delayed, color: 'text-[var(--brand-red)]', urgent: data.summary.delayed > 0 },
              { label: 'بانتظار التأكيد', val: data.summary.awaiting_confirm, color: 'text-[var(--brand-orange)]' },
              { label: 'المعاد فتحها', val: data.summary.reopened, color: 'text-[var(--brand-orange)]' },
              { label: 'المصعدة', val: data.summary.escalated, color: 'text-[var(--brand-red)]' },
              { label: 'متوسط الاستجابة', val: `${data.summary.avg_response_minutes} د`, color: 'text-[var(--brand-charcoal)]' },
              { label: 'متوسط المعالجة', val: `${data.summary.avg_processing_minutes} د`, color: 'text-[var(--brand-charcoal)]' },
              { label: 'فواتير متكررة التعثر', val: data.repeated_invoices.length, color: 'text-[var(--brand-orange)]' },
              { label: 'إجمالي البلاغات', val: data.summary.total, color: 'text-[var(--brand-charcoal)]' },
            ].map((item) => (
              <div key={item.label} className={`${item.urgent ? 'app-card-urgent' : 'app-card'} p-4`}>
                <div className="text-xs text-[var(--brand-charcoal)]/75 font-bold">{item.label}</div>
                <div className={`mt-1.5 text-2xl font-extrabold font-mono-num ${item.color}`}>{item.val}</div>
              </div>
            ))}
          </div>

          {/* Breakdowns (Reports 1, 2, 7, 10, 11) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="app-card p-5 space-y-3">
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">1. البلاغات حسب القسم</h3>
              <div className="space-y-2">
                {data.by_department.map((row) => (
                  <div key={row.label} className="rounded-2xl border border-[var(--brand-gray-light)] px-4 py-3 flex items-center justify-between text-sm">
                    <span className="font-semibold text-[var(--brand-charcoal)]">{row.label}</span>
                    <span className="font-mono-num font-extrabold text-[var(--brand-red)]">{row.count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="app-card p-5 space-y-3">
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">2. البلاغات حسب السبب</h3>
              <div className="space-y-2">
                {data.by_reason.map((row) => (
                  <div key={row.label} className="rounded-2xl border border-[var(--brand-gray-light)] px-4 py-3 flex items-center justify-between text-sm">
                    <span className="font-semibold text-[var(--brand-charcoal)]">{row.label}</span>
                    <span className="font-mono-num font-extrabold text-[var(--brand-orange)]">{row.count}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="app-card p-5 space-y-3">
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">7. أكثر الأصناف تأخراً</h3>
              <div className="space-y-2">
                {data.top_delayed_items.slice(0, 8).map((row) => (
                  <div key={row.item_name} className="rounded-2xl border border-[var(--brand-gray-light)] px-4 py-3 flex items-center justify-between text-sm">
                    <div>
                      <div className="font-bold text-[var(--brand-charcoal)]">{row.item_name}</div>
                      <div className="text-xs text-[var(--brand-charcoal)]/75 font-mono-num">
                        {row.count} بلاغ · متوسط {row.avg_stall_minutes} دقيقة
                      </div>
                    </div>
                    <span className="font-mono-num font-extrabold text-[var(--brand-red)]">{row.total_stall_minutes} د</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="app-card p-5 space-y-3">
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">10 & 11. البلاغات المتكررة وحسب الموظف</h3>
              <div className="space-y-2">
                {data.repeated_invoices.map((inv) => (
                  <div key={inv.invoice_number} className="rounded-2xl border border-[var(--brand-orange)]/45 bg-[var(--brand-orange)]/5 px-4 py-3 flex items-center justify-between text-sm">
                    <span className="font-semibold text-[var(--brand-charcoal)]">فاتورة متكررة التعثر #{inv.invoice_number}</span>
                    <span className="font-mono-num font-extrabold text-[var(--brand-orange)]">{inv.count} بلاغات</span>
                  </div>
                ))}
                {data.by_employee.map((emp) => (
                  <div key={emp.label} className="rounded-2xl border border-[var(--brand-gray-light)] px-4 py-3 flex items-center justify-between text-sm">
                    <span className="font-semibold text-[var(--brand-charcoal)]">الموظف: {emp.label}</span>
                    <span className="font-mono-num font-extrabold text-[var(--brand-charcoal)]">{emp.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Printable / Detailed Vertical List */}
          <div className="app-card p-5 space-y-3">
            <h3 className="text-base font-bold text-[var(--brand-charcoal)]">سجل البلاغات المشمولة في التقرير ({data.tickets.length})</h3>
            <div className="space-y-2">
              {data.tickets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelectTicket(t.id)}
                  className="w-full text-right app-card-interactive px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <div className="font-bold text-[var(--brand-charcoal)]">
                    <span className="font-mono-num text-[var(--brand-red)]">{t.ticket_number}</span> · فاتورة{' '}
                    <span className="font-mono-num">{t.invoice_number}</span> · {t.item_name}
                  </div>
                  <div className="text-[var(--brand-charcoal)]/80 font-mono-num">
                    {STATUS_LABELS[t.status]} · {t.stall_minutes} دقيقة · {formatAdenDateTime(t.created_at)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
