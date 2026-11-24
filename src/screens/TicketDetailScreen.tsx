import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  ArrowLeftRight,
  CheckCircle2,
  Clock,
  Eye,
  FilePlus2,
  History,
  Lock,
  MessageSquare,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Send,
  UserCheck,
  WifiOff,
} from 'lucide-react';
import {
  apiRequest,
  enqueueOfflineAction,
  generateClientRequestId,
  isNetworkError,
} from '../api/client';
import {
  ACTIVE_OPERATIONAL_DEPARTMENTS,
  DEPARTMENT_LABELS,
  REASON_LABELS,
  STATUS_LABELS,
  type DepartmentCode,
  type TicketDetail,
  type UserProfile,
} from '../types/domain';
import { formatAdenDateTime, formatDurationAr } from '../utils/time';

interface TicketDetailScreenProps {
  user: UserProfile;
  ticketId: number;
  scope?: 'all' | 'assembly_support';
  refreshTick: number;
  onBack: () => void;
  onChanged: () => void;
  onOfflineQueued?: () => void;
  onCreateSupportChild?: (invoiceNumber: string, itemName: string, parentTicketId: number) => void;
}

export const TicketDetailScreen: React.FC<TicketDetailScreenProps> = ({
  user,
  ticketId,
  scope = 'all',
  refreshTick,
  onBack,
  onChanged,
  onOfflineQueued,
  onCreateSupportChild,
}) => {
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [offlineActionMsg, setOfflineActionMsg] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [replyText, setReplyText] = useState('');
  const [replyRecipient, setReplyRecipient] = useState<DepartmentCode>('production');
  const [actionNote, setActionNote] = useState('');
  const [transferDept, setTransferDept] = useState<DepartmentCode>('assembly');
  const [transferReason, setTransferReason] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [reopenReason, setReopenReason] = useState('');

  const [showTransferBox, setShowTransferBox] = useState(false);
  const [showReturnBox, setShowReturnBox] = useState(false);
  const [showReopenBox, setShowReopenBox] = useState(false);

  const getTransferOptions = (currentTarget: DepartmentCode): DepartmentCode[] =>
    ACTIVE_OPERATIONAL_DEPARTMENTS.filter((d) => d !== currentTarget);

  const getReplyRecipientOptions = (): DepartmentCode[] =>
    ACTIVE_OPERATIONAL_DEPARTMENTS.filter((d) => d !== user.department_code);

  const inferDefaultReplyTarget = (detail: TicketDetail): DepartmentCode => {
    const valid = getReplyRecipientOptions();
    if (
      user.department_code === detail.target_department &&
      detail.sender_department !== user.department_code &&
      valid.includes(detail.sender_department)
    ) {
      return detail.sender_department;
    }
    if (valid.includes(detail.target_department)) {
      return detail.target_department;
    }
    return valid[0] || 'assembly';
  };

  const loadDetail = async () => {
    try {
      const detailRes = await apiRequest<{ ticket: TicketDetail }>(`/api/tickets/${ticketId}?scope=${scope}`);
      setTicket(detailRes.ticket);
      const validTargets = getTransferOptions(detailRes.ticket.target_department);
      setTransferDept((prev) => (validTargets.includes(prev) ? prev : validTargets[0] || 'assembly'));
      const validReplyTargets = getReplyRecipientOptions();
      setReplyRecipient((prev) =>
        validReplyTargets.includes(prev) ? prev : inferDefaultReplyTarget(detailRes.ticket)
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل تفاصيل البلاغ');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    void loadDetail();
  }, [ticketId, scope, refreshTick]);

  const runAction = async (
    path: string,
    body: Record<string, unknown>,
    successText: string,
    actionLabelAr = successText
  ): Promise<boolean> => {
    setBusy(true);
    setActionErr(null);
    setActionMsg(null);
    setOfflineActionMsg(null);
    const clientRequestId = generateClientRequestId('act');
    const payloadWithId = { ...body, client_request_id: clientRequestId };
    try {
      const res = await apiRequest<{ ticket: TicketDetail }>(path, {
        method: 'POST',
        body: JSON.stringify(payloadWithId),
      });
      setTicket(res.ticket);
      const validTargets = getTransferOptions(res.ticket.target_department);
      setTransferDept((prev) => (validTargets.includes(prev) ? prev : validTargets[0] || 'assembly'));
      setActionMsg(successText);
      onChanged();
      return true;
    } catch (err) {
      if (isNetworkError(err)) {
        enqueueOfflineAction({
          client_request_id: clientRequestId,
          path,
          method: 'POST',
          body: payloadWithId,
          label_ar: actionLabelAr,
        });
        onOfflineQueued?.();
        setOfflineActionMsg(
          'انقطع الاتصال بالخادم — تم حفظ الإجراء محلياً في قائمة الانتظار برقم فريد ولن يُعتمد في النظام حتى يعود الاتصال ويؤكده الخادم.'
        );
        return false;
      }
      setActionErr(err instanceof Error ? err.message : 'تعذر تنفيذ الإجراء');
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loading && !ticket) {
    return <div className="h-64 app-card animate-pulse" />;
  }

  if (error || !ticket) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="min-h-[44px] inline-flex items-center gap-2 app-btn-outline px-4 text-sm"
        >
          <ArrowRight className="w-4 h-4" />
          <span>العودة</span>
        </button>
        <div className="app-card-urgent p-6 text-center text-sm font-bold text-[var(--brand-red)]">
          {error || 'البلاغ غير موجود'}
        </div>
      </div>
    );
  }

  const canReceive =
    ticket.status !== 'closed' &&
    !ticket.received_at &&
    (user.permissions.includes('receive_ticket') || user.role_code === 'admin');

  const canProcess =
    ticket.status !== 'closed' &&
    (user.permissions.includes('process_ticket') || user.role_code === 'admin');

  const canConfirmArrival =
    ticket.status !== 'closed' &&
    (user.role_code === 'assembly' || user.role_code === 'admin');

  const canSendToHall =
    ticket.status !== 'closed' &&
    ticket.status !== 'ready_for_hall' &&
    (user.role_code === 'assembly' || user.role_code === 'admin');

  const canHallConfirm =
    ticket.status !== 'closed' &&
    !ticket.hall_received_at &&
    (user.role_code === 'hall_supervisor' || user.role_code === 'admin') &&
    (ticket.status === 'ready_for_hall' || ticket.target_department === 'hall');

  const canTransfer =
    ticket.status !== 'closed' &&
    (user.permissions.includes('transfer_ticket') || user.role_code === 'admin');

  const canReopen =
    ticket.status === 'closed' &&
    (user.permissions.includes('reopen_ticket') || user.role_code === 'admin');

  const isSupportView = scope === 'assembly_support' && user.role_code === 'hall_supervisor';

  const lifecycleStages = [
    { key: 'sent', label: '1. تم الإرسال', done: true, time: ticket.created_at },
    {
      key: 'delivered',
      label: '2. وصل للقسم',
      done: Boolean(ticket.delivered_to_dept_at),
      time: ticket.delivered_to_dept_at || null,
    },
    {
      key: 'read',
      label: '3. تمت القراءة',
      done: Boolean(ticket.first_read_at),
      time: ticket.first_read_at || null,
    },
    {
      key: 'received',
      label: '4. تأكيد الاستلام',
      done: Boolean(ticket.received_at),
      time: ticket.received_at || null,
    },
    {
      key: 'processing',
      label: '5. جارٍ المعالجة',
      done: Boolean(ticket.processing_started_at) || ['in_progress', 'action_taken_awaiting_confirm', 'arrived_assembly', 'ready_for_hall', 'closed'].includes(ticket.status),
      time: ticket.processing_started_at || null,
    },
    {
      key: 'action_taken',
      label: '6. تم الإجراء',
      done: Boolean(ticket.action_taken_at || ticket.prepared_at),
      time: ticket.action_taken_at || ticket.prepared_at || null,
    },
    {
      key: 'awaiting_confirm',
      label: '7. بانتظار/تم التحقق',
      done: Boolean(ticket.arrival_confirmed_at || ticket.hall_received_at || ticket.status === 'closed'),
      time: ticket.hall_received_at || ticket.arrival_confirmed_at || null,
    },
    {
      key: 'closed',
      label: '8. مغلق',
      done: ticket.status === 'closed',
      time: ticket.closed_at || null,
    },
  ];

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      {/* Header Back Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="min-h-[44px] inline-flex items-center gap-2 app-btn-outline px-4 text-sm"
        >
          <ArrowRight className="w-4 h-4" />
          <span>العودة للقائمة</span>
        </button>

        <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
          <span className="font-mono-num text-[var(--brand-charcoal)]">{ticket.ticket_number}</span>
          <span>·</span>
          <span className="font-mono-num text-[var(--brand-red)]">فاتورة {ticket.invoice_number}</span>
          <span>·</span>
          <span className={ticket.status === 'closed' ? 'text-[var(--brand-charcoal)]' : 'text-[var(--brand-red)]'}>
            {STATUS_LABELS[ticket.status]}
          </span>
        </div>
      </div>

      {actionMsg && (
        <div className="app-card px-4 py-3 text-sm font-bold text-[var(--brand-charcoal)] flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[var(--brand-red)] shrink-0" />
          <span>{actionMsg}</span>
        </div>
      )}

      {offlineActionMsg && (
        <div className="rounded-2xl border border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 px-4 py-3 text-sm font-bold text-[var(--brand-charcoal)] flex items-center gap-2">
          <WifiOff className="w-5 h-5 text-[var(--brand-orange)] shrink-0" />
          <span>{offlineActionMsg}</span>
        </div>
      )}

      {actionErr && (
        <div className="app-card-urgent px-4 py-3 text-sm font-bold text-[var(--brand-red)] flex items-center gap-2">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{actionErr}</span>
        </div>
      )}

      {/* Overdue Unreceived Alert Banner */}
      {ticket.is_overdue_unreceived && ticket.status !== 'closed' && (
        <div className="app-banner-urgent p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-6 h-6 text-white shrink-0" />
            <div>
              <div className="text-sm font-extrabold text-white">
                تنبيه: هذا البلاغ لم يُؤكد استلامه بعد رغم مرور مدة التذكير ({formatDurationAr(ticket.stall_minutes)})!
              </div>
              <div className="text-xs text-white/90 font-mono-num mt-0.5">
                عدد التذكيرات التلقائية المرسلة للقسم المستلم: {ticket.unreceived_reminder_count ?? 0}
                {ticket.last_reminder_at ? ` · آخر تذكير: ${formatAdenDateTime(ticket.last_reminder_at)}` : ''}
              </div>
            </div>
          </div>
          {canReceive && (
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(`/api/tickets/${ticket.id}/receive`, {}, 'تم تأكيد استلام البلاغ بنجاح', 'تأكيد استلام البلاغ')}
              className="min-h-[40px] rounded-2xl bg-white px-4 text-xs font-extrabold text-[var(--brand-red)]"
            >
              تأكيد استلام البلاغ الآن
            </button>
          )}
        </div>
      )}

      {/* 8-Stage Delivery, Read, Receipt & Resolution Tracker */}
      <section className="app-card p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-extrabold text-[var(--brand-charcoal)]">
            سلسلة التتبع الموثقة (وصول ← قراءة ← تأكيد استلام ← معالجة ← إغلاق)
          </h3>
          <span className="text-xs font-semibold text-[var(--brand-charcoal)]/75">
            وصول البلاغ إلى الجهاز لا يعني قراءته أو تأكيد استلامه
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 text-[11px]">
          {lifecycleStages.map((st) => (
            <div
              key={st.key}
              className={`rounded-xl border p-2.5 space-y-1 ${
                st.done
                  ? 'border-[var(--brand-red)] bg-[var(--brand-red)]/5 text-[var(--brand-charcoal)]'
                  : 'border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] text-[var(--brand-charcoal)]/65'
              }`}
            >
              <div className={`font-extrabold ${st.done ? 'text-[var(--brand-red)]' : ''}`}>{st.label}</div>
              <div className="font-mono-num text-[10px]">
                {st.time ? formatAdenDateTime(st.time) : st.done ? 'مكتمل' : 'بانتظار'}
              </div>
            </div>
          ))}
        </div>

        {/* Clear Sender Visibility Bar for Delivery / Read / Receipt */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1 text-xs">
          <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2">
            <div className="text-[var(--brand-charcoal)]/70">حالة الوصول للقسم المستلم</div>
            <div className="font-bold text-[var(--brand-charcoal)] mt-0.5">
              {ticket.delivered_to_dept_at
                ? `وصل في ${formatAdenDateTime(ticket.delivered_to_dept_at)}`
                : 'بانتظار اتصال جهاز القسم المستلم'}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2">
            <div className="text-[var(--brand-charcoal)]/70">حالة القراءة والاطلاع</div>
            <div className="font-bold text-[var(--brand-charcoal)] mt-0.5">
              {ticket.first_read_at
                ? `قرأه: ${ticket.first_read_by_name || 'موظف القسم'} (${formatAdenDateTime(ticket.first_read_at)})`
                : 'لم يُفتح لقراءة التفاصيل بعد'}
            </div>
          </div>
          <div className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2">
            <div className="text-[var(--brand-charcoal)]/70">تأكيد الاستلام الرسمي</div>
            <div className={`font-bold mt-0.5 ${ticket.received_at ? 'text-[var(--brand-charcoal)]' : 'text-[var(--brand-red)]'}`}>
              {ticket.received_at
                ? `استلمه: ${ticket.received_by_name} (${formatAdenDateTime(ticket.received_at)})`
                : 'لم يتم الضغط على تأكيد الاستلام بعد'}
            </div>
          </div>
        </div>
      </section>

      {/* Main Ticket Summary Card */}
      <div className="app-card p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--brand-gray-light)] pb-4">
          <div>
            <h2 className="text-xl font-extrabold text-[var(--brand-charcoal)]">
              {ticket.item_name} <span className="text-sm font-mono-num text-[var(--brand-orange)]">×{ticket.quantity}</span>
            </h2>
            <p className="mt-1 text-sm font-semibold text-[var(--brand-red)]">{REASON_LABELS[ticket.reason_code]}</p>
            <p className="mt-2 text-sm text-[var(--brand-charcoal)] leading-relaxed">{ticket.problem_description}</p>
          </div>
          <div className="text-left space-y-1 text-xs font-mono-num">
            <div className="font-bold text-[var(--brand-red)] flex items-center gap-1.5">
              <Clock className="w-4 h-4" />
              <span>مدة التعثر: {formatDurationAr(ticket.stall_minutes)}</span>
            </div>
            {ticket.escalation_level > 0 && (
              <div className="font-bold text-[var(--brand-orange)]">مستوى التصعيد: {ticket.escalation_level}</div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <div className="text-[var(--brand-charcoal)]/70">المرسل</div>
            <div className="font-bold text-[var(--brand-charcoal)] mt-0.5">{ticket.created_by_name}</div>
            <div className="text-[var(--brand-charcoal)]/75">{DEPARTMENT_LABELS[ticket.sender_department]}</div>
          </div>
          <div>
            <div className="text-[var(--brand-charcoal)]/70">القسم المعني حالياً</div>
            <div className="font-bold text-[var(--brand-red)] mt-0.5">{DEPARTMENT_LABELS[ticket.target_department]}</div>
            {ticket.created_via_support && <div className="text-[var(--brand-orange)] font-semibold">أُنشئ عبر مساندة التجميع</div>}
          </div>
          <div>
            <div className="text-[var(--brand-charcoal)]/70">وقت الإنشاء</div>
            <div className="font-bold font-mono-num text-[var(--brand-charcoal)] mt-0.5">{formatAdenDateTime(ticket.created_at)}</div>
          </div>
          <div>
            <div className="text-[var(--brand-charcoal)]/70">الاستلام والتأكيد</div>
            <div className="font-bold text-[var(--brand-charcoal)] mt-0.5">
              {ticket.received_by_name ? `استلمه: ${ticket.received_by_name}` : 'لم يُستلم بعد'}
            </div>
            <div className="text-[var(--brand-charcoal)]/75">
              {ticket.arrival_confirmed ? 'تم تأكيد وصول الصنف بالتجميع' : 'بانتظار تأكيد الوصول الفعلي'}
            </div>
          </div>
        </div>

        {/* Historical Waiter Archive Reference (read-only) */}
        {ticket.assigned_waiter_name && (
          <div className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-4 py-3 text-xs flex flex-wrap items-center justify-between gap-2">
            <span>
              سجل تاريخي سابق (مباشر ملغى): <strong className="text-[var(--brand-charcoal)]">{ticket.assigned_waiter_name}</strong>
            </span>
            <span className="font-mono-num">
              استلام سابق: {ticket.waiter_received_at ? formatAdenDateTime(ticket.waiter_received_at) : '—'}
              {' · '}
              توصيل سابق: {ticket.waiter_delivered_at ? formatAdenDateTime(ticket.waiter_delivered_at) : '—'}
            </span>
          </div>
        )}
      </div>

      {/* Operational Actions Panel */}
      <div className="app-card p-5 space-y-4">
        <h3 className="text-base font-bold text-[var(--brand-charcoal)]">إجراءات المعالجة والتحقق</h3>

        {/* Support child ticket creation button for Hall Supervisor in support mode */}
        {isSupportView && onCreateSupportChild && ticket.status !== 'closed' && (
          <div className="rounded-2xl border border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-semibold text-[var(--brand-charcoal)]">
              بصفتك مسانداً للتجميع يمكنك إنشاء بلاغ اختياري للإنتاج مرتبط بهذه الفاتورة، مع بقاء التجميع مسؤولاً عن التأكيد.
            </div>
            <button
              type="button"
              onClick={() => onCreateSupportChild(ticket.invoice_number, ticket.item_name, ticket.id)}
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-secondary px-4 text-xs whitespace-nowrap"
            >
              <FilePlus2 className="w-4 h-4" />
              <span>إنشاء بلاغ مساندة للإنتاج</span>
            </button>
          </div>
        )}

        {/* Action note field for processing */}
        {canProcess && (
          <div className="space-y-2">
            <input
              type="text"
              value={actionNote}
              onChange={(e) => setActionNote(e.target.value)}
              placeholder="اكتب الإجراء المتخذ أو حالة جاهزية الطلب (مثال: تم تجهيز الوجبة وخرجت للتجميع)..."
              className="w-full h-[48px] app-input px-4 text-sm"
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2.5">
          {canReceive && (
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction(`/api/tickets/${ticket.id}/receive`, {}, 'تم تأكيد استلام البلاغ بنجاح')}
              className="min-h-[44px] inline-flex items-center gap-2 rounded-2xl bg-[var(--brand-charcoal)] px-4 py-2 text-sm font-bold text-white hover:opacity-95 disabled:opacity-50"
            >
              <UserCheck className="w-4 h-4" />
              <span>تأكيد استلام البلاغ</span>
            </button>
          )}

          {canProcess && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  runAction(
                    `/api/tickets/${ticket.id}/process`,
                    {
                      action_type: 'in_progress',
                      action_note: actionNote.trim() || 'بدأ القسم المختص في معالجة الطلب',
                    },
                    'تم تحديث الحالة إلى قيد المعالجة'
                  )
                }
                className="min-h-[44px] inline-flex items-center gap-2 app-btn-outline px-4 py-2 text-sm"
              >
                <RefreshCw className="w-4 h-4" />
                <span>بدء المعالجة</span>
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  runAction(
                    `/api/tickets/${ticket.id}/process`,
                    {
                      action_type: 'mark_dispatched',
                      action_note: actionNote.trim() || 'تم تنفيذ الإجراء وتأكيد الجاهزية وبانتظار التجميع',
                    },
                    'تم تنفيذ الإجراء وإرسال التنبيه إلى القسم المعني'
                  )
                }
                className="min-h-[44px] inline-flex items-center gap-2 app-btn-secondary px-4 py-2 text-sm disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                <span>تم تنفيذ الإجراء / خروج الصنف (بانتظار التأكيد)</span>
              </button>
            </>
          )}

          {canConfirmArrival && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  runAction(
                    `/api/tickets/${ticket.id}/confirm-arrival`,
                    { mark_order_complete: false },
                    'تم تأكيد وصول الصنف فعلياً إلى قسم التجميع'
                  )
                }
                className="min-h-[44px] inline-flex items-center gap-2 rounded-2xl bg-[var(--brand-charcoal)] px-4 py-2 text-sm font-bold text-white hover:opacity-95"
              >
                <PackageCheck className="w-4 h-4" />
                <span>تأكيد وصول الصنف للتجميع</span>
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  runAction(
                    `/api/tickets/${ticket.id}/confirm-arrival`,
                    { mark_order_complete: true },
                    'تم تأكيد وصول الصنف واعتماد اكتمال الطلب'
                  )
                }
                className="min-h-[44px] inline-flex items-center gap-2 rounded-2xl border border-[var(--brand-red)] bg-white px-4 py-2 text-sm font-bold text-[var(--brand-red)] hover:bg-[var(--brand-red)] hover:text-white transition-colors"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>اعتماد اكتمال الطلب</span>
              </button>

              <button
                type="button"
                onClick={() => setShowReturnBox((v) => !v)}
                className="min-h-[44px] inline-flex items-center gap-2 rounded-2xl border border-[var(--brand-orange)] bg-white px-4 py-2 text-sm font-bold text-[var(--brand-orange)]"
              >
                <RotateCcw className="w-4 h-4" />
                <span>إعادة للإنتاج لعدم الحل</span>
              </button>
            </>
          )}

          {canSendToHall && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                runAction(
                  `/api/tickets/${ticket.id}/send-to-hall`,
                  { note: actionNote.trim() || undefined },
                  'تم إرسال إشعار جاهزية الطلب إلى الصالة'
                )
              }
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-secondary px-4 py-2 text-sm disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              <span>الطلب جاهز – إرسال إلى الصالة</span>
            </button>
          )}

          {canHallConfirm && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                runAction(
                  `/api/tickets/${ticket.id}/hall-confirm`,
                  { note: actionNote.trim() || undefined },
                  'تم تأكيد استلام الطلب النهائي في الصالة'
                )
              }
              className="min-h-[44px] inline-flex items-center gap-2 rounded-2xl bg-[var(--brand-charcoal)] px-4 py-2 text-sm font-bold text-white hover:opacity-95 disabled:opacity-50"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>تأكيد استلام الطلب النهائي في الصالة</span>
            </button>
          )}

          {canTransfer && (
            <button
              type="button"
              onClick={() => {
                const validTargets = getTransferOptions(ticket.target_department);
                setTransferDept((prev) => (validTargets.includes(prev) ? prev : validTargets[0] || 'assembly'));
                setActionErr(null);
                setShowTransferBox((v) => !v);
              }}
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-outline px-4 py-2 text-sm"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span>تحويل لقسم آخر</span>
            </button>
          )}

          {ticket.status !== 'closed' && (
            <button
              type="button"
              disabled={busy || !ticket.can_close}
              onClick={() =>
                runAction(`/api/tickets/${ticket.id}/close`, {}, 'تم التحقق الفعلي وإغلاق البلاغ')
              }
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-primary px-5 py-2 text-sm disabled:opacity-45"
            >
              <Lock className="w-4 h-4" />
              <span>إغلاق البلاغ</span>
            </button>
          )}

          {canReopen && (
            <button
              type="button"
              onClick={() => setShowReopenBox((v) => !v)}
              className="min-h-[44px] inline-flex items-center gap-2 app-btn-secondary px-4 py-2 text-sm"
            >
              <RefreshCw className="w-4 h-4" />
              <span>إعادة فتح البلاغ</span>
            </button>
          )}
        </div>

        {/* Closure Gate Explanation */}
        {ticket.status !== 'closed' && !ticket.can_close && ticket.close_block_reason && (
          <div className="rounded-2xl border border-[var(--brand-orange)] bg-[var(--brand-orange)]/10 px-4 py-3 text-xs font-semibold text-[var(--brand-charcoal)] flex items-center gap-2">
            <Lock className="w-4 h-4 text-[var(--brand-orange)] shrink-0" />
            <span>شرط الإغلاق غير مكتمل: {ticket.close_block_reason}</span>
          </div>
        )}

        {/* Return to Production Box */}
        {showReturnBox && (
          <div className="pt-3 border-t border-[var(--brand-gray-light)] flex flex-wrap gap-2">
            <input
              type="text"
              value={returnReason}
              onChange={(e) => setReturnReason(e.target.value)}
              placeholder="سبب إعادة البلاغ للإنتاج..."
              className="flex-1 min-w-[220px] h-[44px] app-input px-3 text-sm"
            />
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!returnReason.trim()) {
                  setActionErr('يرجى كتابة سبب إعادة البلاغ للإنتاج');
                  return;
                }
                const ok = await runAction(
                  `/api/tickets/${ticket.id}/return`,
                  { reason: returnReason.trim() },
                  'تمت إعادة البلاغ إلى قسم الإنتاج'
                );
                if (ok) {
                  setReturnReason('');
                  setShowReturnBox(false);
                }
              }}
              className="min-h-[44px] app-btn-secondary px-4 text-sm disabled:opacity-50"
            >
              تأكيد الإعادة
            </button>
          </div>
        )}

        {/* Transfer Box */}
        {showTransferBox && (
          <div className="pt-3 border-t border-[var(--brand-gray-light)] space-y-2.5">
            <div className="text-xs font-semibold text-[var(--brand-charcoal)]/80">
              التحويل من <strong className="text-[var(--brand-red)]">{DEPARTMENT_LABELS[ticket.target_department]}</strong> إلى القسم المعني:
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={transferDept}
                onChange={(e) => setTransferDept(e.target.value as DepartmentCode)}
                className="h-[44px] app-input px-3 text-sm font-semibold"
              >
                {getTransferOptions(ticket.target_department).map((dept) => (
                  <option key={dept} value={dept}>
                    {DEPARTMENT_LABELS[dept]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={transferReason}
                onChange={(e) => setTransferReason(e.target.value)}
                placeholder="اكتب سبب التحويل بوضوح (مطلوب)..."
                className="flex-1 min-w-[200px] h-[44px] app-input px-3 text-sm"
              />
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const trimmed = transferReason.trim();
                  if (!trimmed) {
                    setActionErr('يرجى كتابة سبب التحويل قبل التنفيذ');
                    return;
                  }
                  if (transferDept === ticket.target_department) {
                    setActionErr('يرجى اختيار قسم مختلف عن القسم الحالي');
                    return;
                  }
                  const ok = await runAction(
                    `/api/tickets/${ticket.id}/transfer`,
                    { to_department: transferDept, reason: trimmed },
                    `تم تحويل البلاغ إلى ${DEPARTMENT_LABELS[transferDept]} بنجاح`
                  );
                  if (ok) {
                    setTransferReason('');
                    setShowTransferBox(false);
                  }
                }}
                className="min-h-[44px] app-btn-primary px-5 text-sm disabled:opacity-50"
              >
                {busy ? 'جاري التحويل...' : 'تنفيذ التحويل'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setShowTransferBox(false);
                  setActionErr(null);
                }}
                className="min-h-[44px] app-btn-outline px-4 text-sm"
              >
                إلغاء
              </button>
            </div>
          </div>
        )}

        {/* Reopen Box */}
        {showReopenBox && (
          <div className="pt-3 border-t border-[var(--brand-gray-light)] flex flex-wrap gap-2">
            <input
              type="text"
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="سبب إعادة فتح البلاغ..."
              className="flex-1 min-w-[220px] h-[44px] app-input px-3 text-sm"
            />
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!reopenReason.trim()) {
                  setActionErr('يرجى كتابة سبب إعادة فتح البلاغ');
                  return;
                }
                const ok = await runAction(
                  `/api/tickets/${ticket.id}/reopen`,
                  { reason: reopenReason.trim() },
                  'تمت إعادة فتح البلاغ'
                );
                if (ok) {
                  setReopenReason('');
                  setShowReopenBox(false);
                }
              }}
              className="min-h-[44px] app-btn-primary px-4 text-sm disabled:opacity-50"
            >
              تأكيد إعادة الفتح
            </button>
          </div>
        )}
      </div>

      {/* Replies Section with Explicit Station Targeting */}
      <div className="app-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-[var(--brand-red)]" />
          <h3 className="text-base font-bold text-[var(--brand-charcoal)]">الردود والمراسلات المباشرة (موجهة للقسم المستلم فقط)</h3>
        </div>

        <div className="space-y-2.5">
          {ticket.replies.length === 0 ? (
            <p className="text-xs text-[var(--brand-charcoal)]/70">لا توجد ردود مسجلة ضمن نطاق صلاحياتك بعد.</p>
          ) : (
            ticket.replies.map((r) => (
              <div key={r.id} className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-bold text-[var(--brand-charcoal)]">
                    {r.author_name} · <span className="text-[var(--brand-red)]">{r.author_department}</span>
                    {r.recipient_department && (
                      <span className="text-[var(--brand-orange)]">
                        {' '}
                        ← {DEPARTMENT_LABELS[r.recipient_department]}
                      </span>
                    )}
                  </span>
                  <span className="font-mono-num text-[var(--brand-charcoal)]/70">{formatAdenDateTime(r.created_at)}</span>
                </div>
                <p className="text-sm text-[var(--brand-charcoal)]">{r.message}</p>
              </div>
            ))
          )}
        </div>

        {(user.permissions.includes('reply_ticket') || user.role_code === 'admin') && (
          <div className="flex flex-wrap gap-2">
            <select
              value={replyRecipient}
              onChange={(e) => setReplyRecipient(e.target.value as DepartmentCode)}
              aria-label="الجهة المستلمة للرسالة"
              className="h-[48px] app-input px-3 text-sm font-semibold"
            >
              {getReplyRecipientOptions().map((dept) => (
                <option key={dept} value={dept}>
                  إلى: {DEPARTMENT_LABELS[dept]}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="اكتب رسالة أو رداً يُرسل بالتنبيه الصوتي إلى القسم المختار فقط..."
              className="flex-1 min-w-[200px] h-[48px] app-input px-4 text-sm"
            />
            <button
              type="button"
              disabled={busy || !replyText.trim()}
              onClick={() => {
                void runAction(
                  `/api/tickets/${ticket.id}/reply`,
                  { message: replyText.trim(), recipient_department: replyRecipient },
                  `تم إرسال الرسالة والتنبيه الصوتي إلى ${DEPARTMENT_LABELS[replyRecipient]}`
                );
                setReplyText('');
              }}
              className="min-h-[48px] app-btn-primary px-5 text-sm disabled:opacity-50"
            >
              إرسال الرد
            </button>
          </div>
        )}
      </div>

      {/* Read & Receipt Audit Section */}
      {ticket.reads && ticket.reads.length > 0 && (
        <div className="app-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Eye className="w-5 h-5 text-[var(--brand-orange)]" />
              <h3 className="text-base font-bold text-[var(--brand-charcoal)]">سجل القراءة والاطلاع على البلاغ</h3>
            </div>
            <span className="text-xs font-mono-num text-[var(--brand-charcoal)]/75">
              {ticket.reads.length} موظف
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {ticket.reads.map((rd) => (
              <div
                key={rd.id}
                className="rounded-xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] px-3 py-2 flex items-center justify-between gap-2"
              >
                <div>
                  <strong className="text-[var(--brand-charcoal)]">{rd.user_name}</strong>
                  <span className="text-[var(--brand-charcoal)]/70"> · {rd.department_name_ar}</span>
                </div>
                <span className="font-mono-num text-[11px] text-[var(--brand-charcoal)]/75">
                  {formatAdenDateTime(rd.read_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Immutable Chronological Audit Timeline */}
      <div className="app-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-[var(--brand-orange)]" />
            <h3 className="text-base font-bold text-[var(--brand-charcoal)]">سجل الأحداث الزمني الكامل (غير قابل للحذف)</h3>
          </div>
          <span className="text-xs font-mono-num text-[var(--brand-charcoal)]/75">{ticket.events.length} حدث</span>
        </div>

        <div className="space-y-2.5">
          {ticket.events.map((ev) => (
            <div key={ev.id} className="rounded-2xl border border-[var(--brand-gray-light)] bg-[var(--brand-surface-neutral)] p-3.5 flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-white border border-[var(--brand-gray-light)] text-[var(--brand-red)] flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold font-mono-num">
                {ev.id}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-bold text-[var(--brand-charcoal)]">
                    {ev.actor_name} · <span className="text-[var(--brand-charcoal)]/75">{ev.actor_department}</span>
                  </span>
                  <span className="font-mono-num text-[var(--brand-charcoal)]/70">{formatAdenDateTime(ev.created_at)}</span>
                </div>
                {ev.note && <p className="text-sm text-[var(--brand-charcoal)]">{ev.note}</p>}
                {(ev.from_status || ev.to_status) && (
                  <div className="text-[11px] text-[var(--brand-charcoal)]/75">
                    الحالة:{' '}
                    {ev.from_status ? STATUS_LABELS[ev.from_status as keyof typeof STATUS_LABELS] || ev.from_status : '—'}
                    {' ← '}
                    <strong className="text-[var(--brand-red)]">
                      {ev.to_status ? STATUS_LABELS[ev.to_status as keyof typeof STATUS_LABELS] || ev.to_status : '—'}
                    </strong>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
