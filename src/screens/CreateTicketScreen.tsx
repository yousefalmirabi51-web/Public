import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  Clock,
  FileText,
  Hash,
  Layers,
  Send,
  User,
  Utensils,
  WifiOff,
} from 'lucide-react';
import {
  apiRequest,
  enqueueOfflineTicket,
  generateClientRequestId,
  isNetworkError,
} from '../api/client';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import {
  DEFAULT_TARGET_DEPT_BY_REASON,
  DEPARTMENT_LABELS,
  REASON_LABELS,
  type DepartmentCode,
  type ReasonCode,
  type TicketDetail,
  type UserProfile,
} from '../types/domain';
import { formatAdenDateTime } from '../utils/time';

interface CreateTicketScreenProps {
  user: UserProfile;
  viaSupport?: boolean;
  prefillInvoice?: string;
  prefillItem?: string;
  parentTicketId?: number | null;
  onCreated: (ticket: TicketDetail) => void;
  onOfflineQueued: () => void;
  onCancel?: () => void;
}

const REASON_OPTIONS = Object.entries(REASON_LABELS) as [ReasonCode, string][];

export const CreateTicketScreen: React.FC<CreateTicketScreenProps> = ({
  user,
  viaSupport = false,
  prefillInvoice = '',
  prefillItem = '',
  parentTicketId = null,
  onCreated,
  onOfflineQueued,
  onCancel,
}) => {
  const isOnline = useOnlineStatus();
  const [invoiceNumber, setInvoiceNumber] = useState(prefillInvoice);
  const [itemName, setItemName] = useState(prefillItem);
  const [quantity, setQuantity] = useState('1');
  const [reasonCode, setReasonCode] = useState<ReasonCode>('production_delay');
  const [targetDepartment, setTargetDepartment] = useState<DepartmentCode>('production');
  const [problemDescription, setProblemDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offlineSavedMsg, setOfflineSavedMsg] = useState<string | null>(null);

  const nowPreview = useMemo(() => formatAdenDateTime(new Date().toISOString()), []);

  const handleReasonChange = (nextReason: ReasonCode) => {
    setReasonCode(nextReason);
    if (viaSupport) {
      setTargetDepartment('production');
    } else {
      setTargetDepartment(DEFAULT_TARGET_DEPT_BY_REASON[nextReason]);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOfflineSavedMsg(null);

    if (!invoiceNumber.trim()) {
      setError('يرجى إدخال رقم الفاتورة الصادر من نظام الكاشير');
      return;
    }
    if (!itemName.trim()) {
      setError('يرجى إدخال اسم الصنف المتعثر');
      return;
    }
    if (reasonCode === 'other' && problemDescription.trim().length < 4) {
      setError('عند اختيار (سبب آخر) يجب كتابة التوضيح الإلزامي للمشكلة');
      return;
    }

    const clientRequestId = generateClientRequestId('tkt');

    const payload = {
      client_request_id: clientRequestId,
      invoice_number: invoiceNumber.trim(),
      item_name: itemName.trim(),
      quantity: Math.max(1, Number(quantity) || 1),
      reason_code: reasonCode,
      problem_description: problemDescription.trim(),
      target_department: viaSupport ? ('production' as DepartmentCode) : targetDepartment,
      created_via_support: viaSupport,
      parent_ticket_id: parentTicketId,
    };

    if (!isOnline) {
      enqueueOfflineTicket(payload);
      onOfflineQueued();
      setOfflineSavedMsg(
        'انقطع الاتصال بالخادم — تم حفظ البلاغ في قائمة الانتظار المؤقتة ولن يُعتبر مُرسلاً حتى يعود الاتصال ويؤكد الخادم حفظه.'
      );
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiRequest<{ ticket: TicketDetail }>('/api/tickets', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onCreated(res.ticket);
    } catch (err) {
      // Check if network-level failure (TypeError: Failed to fetch / 502-504)
      if (isNetworkError(err)) {
        enqueueOfflineTicket(payload);
        onOfflineQueued();
        setOfflineSavedMsg(
          'تعذر الوصول للخادم حالياً — تم حفظ البلاغ مؤقتاً برقم طلب فريد لمنع التكرار، وسيُرحّل تلقائياً فور عودة الاتصال.'
        );
      } else {
        setError(err instanceof Error ? err.message : 'تعذر ترحيل البلاغ');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">
            {viaSupport ? 'إنشاء بلاغ مساندة إلى الإنتاج' : 'إنشاء بلاغ تعثر طلب'}
          </h2>
          <p className="text-sm text-[var(--brand-charcoal)]/80">
            {viaSupport
              ? 'بلاغ اختياري من مسؤول الصالة لمساندة التجميع — يصل إلى الإنتاج ويظهر للتجميع مع حفظ كامل التاريخ'
              : 'يمكن تسجيل عدة بلاغات مستقلة لنفس رقم الفاتورة عند تعثر أكثر من صنف'}
          </p>
        </div>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="min-h-[42px] app-btn-outline px-4 text-sm"
          >
            إلغاء
          </button>
        )}
      </div>

      <form
        onSubmit={handleSubmit}
        className="app-card p-5 sm:p-7 space-y-4"
      >
        {/* Auto-generated Ticket Meta Summary */}
        <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
              <Hash className="w-4 h-4" />
            </span>
            <div>
              <div className="text-[var(--brand-charcoal)]/70">رقم البلاغ</div>
              <div className="font-bold text-[var(--brand-charcoal)]">يُنشأ آلياً عند الحفظ في الخادم</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-[var(--brand-orange)] text-white flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4" />
            </span>
            <div>
              <div className="text-[var(--brand-charcoal)]/70">تاريخ ووقت الإنشاء (عدن)</div>
              <div className="font-bold font-mono-num text-[var(--brand-charcoal)]">{nowPreview}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
              <User className="w-4 h-4" />
            </span>
            <div>
              <div className="text-[var(--brand-charcoal)]/70">الموظف المرسل</div>
              <div className="font-bold text-[var(--brand-charcoal)]">{user.full_name}</div>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
              <Building2 className="w-4 h-4" />
            </span>
            <div>
              <div className="text-[var(--brand-charcoal)]/70">القسم المرسل</div>
              <div className="font-bold text-[var(--brand-charcoal)]">{user.department_name_ar}</div>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2.5 rounded-2xl border border-[var(--brand-red)] bg-[var(--brand-red)]/5 px-4 py-3 text-sm font-medium text-[var(--brand-red)]">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {offlineSavedMsg && (
          <div className="flex items-center gap-2.5 rounded-2xl border border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 px-4 py-3 text-sm font-medium text-[var(--brand-charcoal)]">
            <WifiOff className="w-5 h-5 text-[var(--brand-orange)] shrink-0" />
            <span>{offlineSavedMsg}</span>
          </div>
        )}

        {/* Invoice Number */}
        <div className="space-y-1.5">
          <label className="block text-sm font-bold text-[var(--brand-charcoal)] px-1">رقم الفاتورة *</label>
          <div className="flex items-center app-input h-[54px] px-3">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
              <Hash className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="مثال: 1250"
              required
              className="w-full h-full bg-transparent px-3 text-sm font-semibold font-mono-num text-[var(--brand-charcoal)] placeholder:text-[var(--brand-charcoal)]/50 focus:outline-none"
            />
          </div>
        </div>

        {/* Item & Quantity */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2 space-y-1.5">
            <label className="block text-sm font-bold text-[var(--brand-charcoal)] px-1">الصنف المتعثر *</label>
            <div className="flex items-center app-input h-[54px] px-3">
              <div className="w-9 h-9 rounded-full bg-[var(--brand-orange)] text-white flex items-center justify-center shrink-0">
                <Utensils className="w-4 h-4" />
              </div>
              <input
                type="text"
                value={itemName}
                onChange={(e) => setItemName(e.target.value)}
                placeholder="مثال: ربع بروستد / واحد رز"
                required
                className="w-full h-full bg-transparent px-3 text-sm font-semibold text-[var(--brand-charcoal)] placeholder:text-[var(--brand-charcoal)]/50 focus:outline-none"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-bold text-[var(--brand-charcoal)] px-1">الكمية</label>
            <div className="flex items-center app-input h-[54px] px-3">
              <div className="w-9 h-9 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
                <Layers className="w-4 h-4" />
              </div>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className="w-full h-full bg-transparent px-3 text-sm font-semibold font-mono-num text-[var(--brand-charcoal)] focus:outline-none"
              />
            </div>
          </div>
        </div>

        {/* Reason */}
        <div className="space-y-1.5">
          <label className="block text-sm font-bold text-[var(--brand-charcoal)] px-1">سبب التعثر *</label>
          <div className="flex items-center app-input h-[54px] px-3">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-red)] text-white flex items-center justify-center shrink-0">
              <AlertCircle className="w-4 h-4" />
            </div>
            <select
              value={reasonCode}
              onChange={(e) => handleReasonChange(e.target.value as ReasonCode)}
              className="w-full h-full bg-transparent px-3 text-sm font-semibold text-[var(--brand-charcoal)] focus:outline-none"
            >
              {REASON_OPTIONS.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Target Department */}
        <div className="space-y-1.5">
          <label className="block text-sm font-bold text-[var(--brand-charcoal)] px-1">القسم المعني بالمعالجة</label>
          <div className="flex items-center app-input h-[54px] px-3">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-charcoal)] text-white flex items-center justify-center shrink-0">
              <Building2 className="w-4 h-4" />
            </div>
            <select
              value={targetDepartment}
              disabled={viaSupport}
              onChange={(e) => setTargetDepartment(e.target.value as DepartmentCode)}
              className="w-full h-full bg-transparent px-3 text-sm font-semibold text-[var(--brand-charcoal)] focus:outline-none disabled:opacity-75"
            >
              <option value="production">{DEPARTMENT_LABELS.production}</option>
              <option value="assembly">{DEPARTMENT_LABELS.assembly}</option>
              <option value="hall">{DEPARTMENT_LABELS.hall}</option>
            </select>
          </div>
        </div>

        {/* Problem Description */}
        <div className="space-y-1.5">
          <label className="block text-sm font-bold text-[var(--brand-charcoal)] px-1">
            وصف المشكلة {reasonCode === 'other' ? '* (إلزامي)' : '(اختياري)'}
          </label>
          <div className="flex items-start app-input p-3">
            <div className="w-9 h-9 rounded-full bg-[var(--brand-orange)] text-white flex items-center justify-center shrink-0 mt-0.5">
              <FileText className="w-4 h-4" />
            </div>
            <textarea
              rows={3}
              value={problemDescription}
              onChange={(e) => setProblemDescription(e.target.value)}
              required={reasonCode === 'other'}
              placeholder={
                reasonCode === 'other'
                  ? 'يرجى كتابة توضيح دقيق لسبب التعثر...'
                  : 'أضف أي تفاصيل تساعد القسم المختص على المعالجة السريعة...'
              }
              className="w-full bg-transparent px-3 py-1.5 text-sm font-medium text-[var(--brand-charcoal)] placeholder:text-[var(--brand-charcoal)]/50 focus:outline-none resize-none"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="w-full min-h-[54px] app-btn-primary font-extrabold text-base flex items-center justify-center gap-2.5 active:scale-[0.99] disabled:opacity-60"
        >
          <Send className="w-5 h-5" />
          <span>{submitting ? 'جاري الترحيل والحفظ...' : 'ترحيل الطلب'}</span>
        </button>

        {!isOnline && (
          <p className="text-center text-xs font-semibold text-[var(--brand-orange)]">
            تنبيه: أنت غير متصل حالياً. عند الضغط على ترحيل الطلب سيتم حفظه محلياً وإرساله فور عودة الشبكة.
          </p>
        )}
      </form>
    </div>
  );
};
