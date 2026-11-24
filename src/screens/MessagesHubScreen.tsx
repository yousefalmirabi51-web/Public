import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCheck,
  CheckCircle2,
  ChevronLeft,
  Clock,
  FileText,
  Hash,
  Layers,
  MessageSquare,
  Package,
  Send,
  ShieldAlert,
  UserCheck,
  Volume2,
} from 'lucide-react';
import { apiRequest } from '../api/client';
import {
  ACTIVE_OPERATIONAL_DEPARTMENTS,
  DEPARTMENT_LABELS,
  INQUIRY_CANNED_STATUSES,
  STATUS_LABELS,
  TICKET_KIND_LABELS,
  URGENCY_LABELS,
  type DepartmentCode,
  type DepartmentMessageRecord,
  type InquiryStatusCode,
  type StationAudioSetting,
  type TicketDetail,
  type TicketSummary,
  type UrgencyLevel,
  type UserProfile,
  type VoiceReaderSetting,
} from '../types/domain';
import { replayAlertAudio, resolveVoiceReaderSettingForNotification } from '../utils/audioAlerts';
import { formatAdenDateTime, formatDurationAr } from '../utils/time';

type HubTab = 'messages' | 'inquiries' | 'backlog';

interface MessagesHubScreenProps {
  user: UserProfile;
  refreshTick: number;
  stationAudioSetting?: StationAudioSetting | null;
  voiceReaderSettings?: VoiceReaderSetting[];
  authToken?: string | null;
  onSelectTicket: (ticketId: number) => void;
  onChanged: () => void;
}

const CANNED_OPTIONS = Object.entries(INQUIRY_CANNED_STATUSES).map(([k, v]) => ({
  code: Number(k) as InquiryStatusCode,
  label: v,
}));

export const MessagesHubScreen: React.FC<MessagesHubScreenProps> = ({
  user,
  refreshTick,
  stationAudioSetting,
  voiceReaderSettings = [],
  authToken,
  onSelectTicket,
  onChanged,
}) => {
  const defaultTab: HubTab =
    user.role_code === 'assembly' ? 'backlog' : user.role_code === 'hall_supervisor' ? 'inquiries' : 'messages';
  const [activeTab, setActiveTab] = useState<HubTab>(defaultTab);
  const [messages, setMessages] = useState<DepartmentMessageRecord[]>([]);
  const [backlogTickets, setBacklogTickets] = useState<TicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter / search inside hub
  const [searchQuery, setSearchQuery] = useState('');

  // Tab 1: General 6-direction direct messaging form
  const validRecipients = useMemo(
    () => ACTIVE_OPERATIONAL_DEPARTMENTS.filter((d) => d !== user.department_code),
    [user.department_code]
  );
  const [msgSenderDept, setMsgSenderDept] = useState<DepartmentCode>(
    ACTIVE_OPERATIONAL_DEPARTMENTS.includes(user.department_code) ? user.department_code : 'hall'
  );
  const [msgRecipientDept, setMsgRecipientDept] = useState<DepartmentCode>(validRecipients[0] || 'production');
  const [msgTracking, setMsgTracking] = useState('');
  const [msgInvoice, setMsgInvoice] = useState('');
  const [msgBody, setMsgBody] = useState('');
  const [msgNotes, setMsgNotes] = useState('');

  // Tab 2: Hall -> Assembly Direct Inquiry Form
  const [inqInvoice, setInqInvoice] = useState('');
  const [inqTracking, setInqTracking] = useState('');
  const [inqItem, setInqItem] = useState('');
  const [inqQty, setInqQty] = useState('1');
  const [inqUrgency, setInqUrgency] = useState<UrgencyLevel>('normal');
  const [inqBody, setInqBody] = useState('');
  const [inqNotes, setInqNotes] = useState('');

  // Tab 2: Assembly structured canned reply state per inquiry
  const [replyOpenId, setReplyOpenId] = useState<number | null>(null);
  const [replyCannedCode, setReplyCannedCode] = useState<InquiryStatusCode>(1);
  const [replyCustomText, setReplyCustomText] = useState('');
  const [replyExtraNote, setReplyExtraNote] = useState('');

  // Tab 3: Assembly -> Hall Backlog Report Form
  const [blCount, setBlCount] = useState('3');
  const [blInvoices, setBlInvoices] = useState('');
  const [blItems, setBlItems] = useState('طلبات مكتملة جاهزة للتسليم في الصالة');
  const [blWaitDuration, setBlWaitDuration] = useState('10 دقائق');
  const [blReason, setBlReason] = useState('تراكم الطلبات المكتملة داخل قسم التجميع');
  const [blUrgency, setBlUrgency] = useState<UrgencyLevel>('urgent');
  const [blNotes, setBlNotes] = useState('');

  const loadHubData = async () => {
    try {
      const [msgRes, backlogRes] = await Promise.all([
        apiRequest<{ messages: DepartmentMessageRecord[] }>('/api/messages'),
        apiRequest<{ tickets: TicketSummary[] }>('/api/tickets?scope=all&reason=assembly_backlog'),
      ]);
      setMessages(msgRes.messages);
      setBacklogTickets(backlogRes.tickets.filter((t) => t.ticket_kind === 'backlog' || t.reason_code === 'assembly_backlog'));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل المراسلات والبلاغات');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadHubData();
  }, [refreshTick]);

  const filteredMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(
      (m) =>
        m.tracking_number.toLowerCase().includes(q) ||
        m.invoice_number.toLowerCase().includes(q) ||
        m.message_body.toLowerCase().includes(q) ||
        m.sender_name.toLowerCase().includes(q)
    );
  }, [messages, searchQuery]);

  const inquiryMessages = useMemo(
    () => filteredMessages.filter((m) => m.message_type === 'inquiry' || m.message_type === 'inquiry_reply'),
    [filteredMessages]
  );

  const canSendDirectMsg = user.permissions.includes('reply_ticket') || user.role_code === 'admin';
  const canSendInquiry = user.role_code === 'hall_supervisor' || user.role_code === 'admin';
  const canReplyCanned = user.role_code === 'assembly' || user.role_code === 'admin';
  const canSendBacklog = user.role_code === 'assembly' || user.role_code === 'admin';

  const handleSendDirectMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    const effectiveSender = user.role_code === 'admin' ? msgSenderDept : user.department_code;
    if (msgRecipientDept === effectiveSender) {
      setError('يجب اختيار قسم مستلم مختلف عن القسم المرسل');
      return;
    }
    if (!msgBody.trim()) {
      setError('يرجى كتابة نص الرسالة');
      return;
    }

    setBusy(true);
    try {
      const res = await apiRequest<{ message: DepartmentMessageRecord }>('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          sender_department: user.role_code === 'admin' ? msgSenderDept : undefined,
          recipient_department: msgRecipientDept,
          tracking_number: msgTracking.trim() || undefined,
          invoice_number: msgInvoice.trim() || undefined,
          message_type: 'general',
          message_body: msgBody.trim(),
          notes: msgNotes.trim() || undefined,
        }),
      });
      setMsgBody('');
      setMsgNotes('');
      setFeedback(
        `تم إرسال الرسالة برقم المتابعة ${res.message.tracking_number} وتوجيه التنبيه الصوتي إلى ${DEPARTMENT_LABELS[msgRecipientDept]} فقط`
      );
      await loadHubData();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إرسال الرسالة');
    } finally {
      setBusy(false);
    }
  };

  const handleSendInquiry = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    if (!inqInvoice.trim() && !inqTracking.trim()) {
      setError('يرجى إدخال رقم الفاتورة أو رقم المتابعة');
      return;
    }
    if (!inqBody.trim()) {
      setError('يرجى كتابة نص الاستفسار الموجّه لقسم التجميع');
      return;
    }

    setBusy(true);
    try {
      const res = await apiRequest<{ ticket: TicketDetail; message: DepartmentMessageRecord }>('/api/inquiries', {
        method: 'POST',
        body: JSON.stringify({
          invoice_number: inqInvoice.trim(),
          tracking_number: inqTracking.trim() || undefined,
          item_name: inqItem.trim() || 'استفسار طلب',
          quantity: Math.max(1, Number(inqQty) || 1),
          urgency_level: inqUrgency,
          message: inqBody.trim(),
          notes: inqNotes.trim() || undefined,
        }),
      });
      setInqInvoice('');
      setInqTracking('');
      setInqItem('');
      setInqQty('1');
      setInqBody('');
      setInqNotes('');
      setFeedback(
        `تم إرسال الاستفسار المباشر برقم المتابعة ${res.ticket.ticket_number} وإصدار التنبيه الصوتي في قسم التجميع`
      );
      await loadHubData();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إرسال الاستفسار');
    } finally {
      setBusy(false);
    }
  };

  const handleSendCannedReply = async (parentMsg: DepartmentMessageRecord) => {
    setError(null);
    setFeedback(null);
    if (replyCannedCode === 6 && !replyCustomText.trim() && !replyExtraNote.trim()) {
      setError('يرجى كتابة نص الرد عند اختيار (رد كتابي)');
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest<{ message: DepartmentMessageRecord }>('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          ticket_id: parentMsg.ticket_id,
          tracking_number: parentMsg.tracking_number,
          invoice_number: parentMsg.invoice_number,
          sender_department: user.role_code === 'admin' ? 'assembly' : undefined,
          recipient_department: 'hall',
          message_type: 'inquiry_reply',
          canned_status_code: replyCannedCode,
          parent_message_id: parentMsg.id,
          message_body: replyCustomText.trim() || INQUIRY_CANNED_STATUSES[replyCannedCode],
          notes: replyExtraNote.trim() || undefined,
        }),
      });
      setReplyOpenId(null);
      setReplyCustomText('');
      setReplyExtraNote('');
      setFeedback(
        `تم إرسال رد التجميع (${res.message.canned_status_label || res.message.message_body}) برقم ${res.message.tracking_number} إلى الصالة`
      );
      await loadHubData();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إرسال الرد');
    } finally {
      setBusy(false);
    }
  };

  const handleCreateBacklogReport = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFeedback(null);
    if (!blInvoices.trim()) {
      setError('يرجى إدخال أرقام الفواتير المتراكمة في التجميع');
      return;
    }
    setBusy(true);
    try {
      const res = await apiRequest<{ ticket: TicketDetail }>('/api/backlog-reports', {
        method: 'POST',
        body: JSON.stringify({
          stacked_orders_count: Math.max(1, Number(blCount) || 1),
          invoice_numbers: blInvoices.trim(),
          items_summary: blItems.trim(),
          wait_duration_note: blWaitDuration.trim(),
          backlog_reason: blReason.trim(),
          urgency_level: blUrgency,
          notes: blNotes.trim(),
        }),
      });
      setBlInvoices('');
      setBlNotes('');
      setFeedback(
        `تم تسجيل بلاغ التراكم برقم المتابعة ${res.ticket.ticket_number} وإشعار الصالة بالتنبيه الصوتي الكامل`
      );
      await loadHubData();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر إرسال بلاغ التراكم');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmMessageReceipt = async (msgId: number) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/messages/${msgId}/receive`, { method: 'POST', body: JSON.stringify({}) });
      setFeedback('تم توثيق تأكيد الاستلام بنجاح وإشعار القسم المرسل');
      await loadHubData();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تأكيد الاستلام');
    } finally {
      setBusy(false);
    }
  };

  const handleMarkMessageRead = async (msgId: number) => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/messages/${msgId}/read`, { method: 'POST', body: JSON.stringify({}) });
      await loadHubData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر توثيق القراءة');
    } finally {
      setBusy(false);
    }
  };

  const handleReplayMessageAudio = (m: DepartmentMessageRecord) => {
    const text = `متابعة رقم ${m.tracking_number}، فاتورة رقم ${m.invoice_number}، من ${DEPARTMENT_LABELS[m.sender_department]} إلى ${DEPARTMENT_LABELS[m.recipient_department]}: ${m.message_body}${m.notes ? `. ملاحظات: ${m.notes}` : ''}`;
    const voiceReaderSetting = resolveVoiceReaderSettingForNotification(
      voiceReaderSettings,
      user.department_code,
      { event_type: m.message_type, target_department: m.recipient_department }
    );
    void replayAlertAudio({ text, stationSetting: stationAudioSetting, voiceReaderSetting, authToken });
  };

  const renderMessageCard = (m: DepartmentMessageRecord) => {
    const canConfirmReceipt =
      !m.received_at && (user.role_code === 'admin' || m.recipient_department === user.department_code);
    const canMarkRead =
      !m.read_at && (user.role_code === 'admin' || m.recipient_department === user.department_code);
    const isInquiry = m.message_type === 'inquiry';

    return (
      <div
        key={m.id}
        className={`rounded-2xl border bg-white p-4 space-y-2.5 ${
          !m.received_at && m.recipient_department === user.department_code
            ? 'border-[#EF1923]'
            : 'border-[#595859]/20'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2 font-bold">
            <span className="font-mono-num text-[#EF1923]">{m.tracking_number}</span>
            <span>·</span>
            <span className="font-mono-num text-[#595859]">فاتورة {m.invoice_number}</span>
            <span>·</span>
            <span className="text-[#F8941A]">
              {DEPARTMENT_LABELS[m.sender_department]} ← {DEPARTMENT_LABELS[m.recipient_department]}
            </span>
          </div>
          <span className="font-mono-num text-[#595859]/75">{formatAdenDateTime(m.sent_at)}</span>
        </div>

        <div className="text-sm font-bold text-[#595859]">
          {m.canned_status_label && (
            <span className="inline-block ml-2 rounded-lg bg-[#F8941A]/15 px-2 py-0.5 text-xs text-[#EF1923]">
              حالة #{m.canned_status_code}: {m.canned_status_label}
            </span>
          )}
          <span>{m.message_body}</span>
        </div>

        {m.notes && <div className="text-xs text-[#595859]/80">ملاحظات: {m.notes}</div>}

        {/* Independent Sent / Received / Read states */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#595859]/10 text-xs">
          <div className="flex flex-wrap items-center gap-3 text-[#595859]/85">
            <span>المرسل: <strong>{m.sender_name}</strong></span>
            <span>·</span>
            <span className="font-bold text-[#595859]">تم الإرسال</span>
            <span>·</span>
            <span className={m.received_at ? 'font-bold text-[#F8941A]' : 'text-[#EF1923] font-bold'}>
              {m.received_at
                ? `تم الاستلام (${m.received_by_name || ''} · ${formatAdenDateTime(m.received_at)})`
                : 'بانتظار تأكيد الاستلام'}
            </span>
            <span>·</span>
            <span className="text-[#595859]/75">
              {m.read_at ? `تمت القراءة (${formatAdenDateTime(m.read_at)})` : 'غير مقروءة بعد'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleReplayMessageAudio(m)}
              className="min-h-[34px] inline-flex items-center gap-1 rounded-xl border border-[#595859]/25 px-2.5 text-xs font-bold text-[#595859] hover:border-[#EF1923]"
            >
              <Volume2 className="w-3.5 h-3.5 text-[#F8941A]" />
              <span>سماع التنبيه</span>
            </button>

            {canConfirmReceipt && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmMessageReceipt(m.id)}
                className="min-h-[34px] inline-flex items-center gap-1 rounded-xl bg-[#EF1923] px-3 text-xs font-bold text-white disabled:opacity-50"
              >
                <UserCheck className="w-3.5 h-3.5" />
                <span>{isInquiry ? 'تأكيد استلام الاستفسار' : 'تأكيد الاستلام'}</span>
              </button>
            )}

            {canMarkRead && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleMarkMessageRead(m.id)}
                className="min-h-[34px] inline-flex items-center gap-1 rounded-xl border border-[#595859]/30 px-2.5 text-xs font-bold text-[#595859]"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                <span>توثيق القراءة</span>
              </button>
            )}

            {isInquiry && canReplyCanned && (
              <button
                type="button"
                onClick={() => {
                  setReplyOpenId(replyOpenId === m.id ? null : m.id);
                  setReplyCannedCode(1);
                  setReplyCustomText('');
                  setReplyExtraNote('');
                }}
                className="min-h-[34px] inline-flex items-center gap-1 rounded-xl bg-[#F8941A] px-3 text-xs font-bold text-white"
              >
                <Send className="w-3.5 h-3.5" />
                <span>رد التجميع السريع (1–6)</span>
              </button>
            )}

            {m.ticket_id && (
              <button
                type="button"
                onClick={() => onSelectTicket(m.ticket_id!)}
                className="min-h-[34px] inline-flex items-center gap-1 rounded-xl border border-[#EF1923] px-2.5 text-xs font-bold text-[#EF1923]"
              >
                <span>فتح البلاغ</span>
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Structured Canned Reply Picker for Assembly */}
        {replyOpenId === m.id && canReplyCanned && (
          <div className="pt-3 mt-2 border-t border-[#595859]/15 space-y-2.5 bg-[#595859]/[0.02] rounded-2xl p-3">
            <div className="text-xs font-bold text-[#595859]">اختر حالة الرد المنظمة لإرسالها إلى الصالة:</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {CANNED_OPTIONS.map((opt) => (
                <button
                  key={opt.code}
                  type="button"
                  onClick={() => setReplyCannedCode(opt.code)}
                  className={`min-h-[40px] rounded-xl border px-3 text-right text-xs font-bold transition-colors ${
                    replyCannedCode === opt.code
                      ? 'border-[#EF1923] bg-[#EF1923] text-white'
                      : 'border-[#595859]/25 bg-white text-[#595859] hover:border-[#EF1923]'
                  }`}
                >
                  {opt.code}. {opt.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                value={replyCustomText}
                onChange={(e) => setReplyCustomText(e.target.value)}
                placeholder={replyCannedCode === 6 ? 'اكتب الرد الكتابي المطلوب *...' : 'تفاصيل إضافية للرد (اختياري)...'}
                className="h-[42px] rounded-xl border border-[#595859]/25 bg-white px-3 text-xs text-[#595859]"
              />
              <input
                type="text"
                value={replyExtraNote}
                onChange={(e) => setReplyExtraNote(e.target.value)}
                placeholder="ملاحظة للصالة (اختياري)..."
                className="h-[42px] rounded-xl border border-[#595859]/25 bg-white px-3 text-xs text-[#595859]"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSendCannedReply(m)}
                className="min-h-[40px] rounded-xl bg-[#EF1923] px-4 text-xs font-bold text-white disabled:opacity-50"
              >
                إرسال الرد والتنبيه الصوتي للصالة
              </button>
              <button
                type="button"
                onClick={() => setReplyOpenId(null)}
                className="min-h-[40px] rounded-xl border border-[#595859]/25 bg-white px-3 text-xs font-bold text-[#595859]"
              >
                إلغاء
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-extrabold text-[#595859]">مركز المراسلات والاستفسارات وبلاغات التراكم</h2>
          <p className="text-sm text-[#595859]/80">
            تواصل ثنائي الاتجاه في المسارات التشغيلية الستة، استفسارات الصالة المباشرة، وبلاغات تراكم الطلبات في التجميع
          </p>
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="بحث برقم المتابعة (TRK-) أو الفاتورة..."
          className="h-[42px] min-w-[240px] rounded-2xl border border-[#595859]/25 bg-white px-3.5 text-xs font-semibold text-[#595859]"
        />
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setActiveTab('messages')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-2xl border px-4 text-xs font-bold transition-colors ${
            activeTab === 'messages'
              ? 'border-[#EF1923] bg-[#EF1923] text-white'
              : 'border-[#595859]/25 bg-white text-[#595859] hover:border-[#EF1923]'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          <span>المراسلات بين الأقسام (6 اتجاهات)</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('inquiries')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-2xl border px-4 text-xs font-bold transition-colors ${
            activeTab === 'inquiries'
              ? 'border-[#EF1923] bg-[#EF1923] text-white'
              : 'border-[#595859]/25 bg-white text-[#595859] hover:border-[#EF1923]'
          }`}
        >
          <FileText className="w-4 h-4" />
          <span>استفسارات الصالة ← التجميع ({inquiryMessages.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('backlog')}
          className={`min-h-[44px] inline-flex items-center gap-2 rounded-2xl border px-4 text-xs font-bold transition-colors ${
            activeTab === 'backlog'
              ? 'border-[#F8941A] bg-[#F8941A] text-white'
              : 'border-[#595859]/25 bg-white text-[#595859] hover:border-[#F8941A]'
          }`}
        >
          <Layers className="w-4 h-4" />
          <span>بلاغات تراكم الطلبات ({backlogTickets.length})</span>
        </button>
      </div>

      {feedback && (
        <div className="rounded-2xl border border-[#595859] bg-[#595859]/5 px-4 py-3 text-sm font-bold text-[#595859] flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[#EF1923] shrink-0" />
          <span>{feedback}</span>
        </div>
      )}

      {error && (
        <div className="rounded-2xl border border-[#EF1923] bg-[#EF1923]/5 px-4 py-3 text-sm font-bold text-[#EF1923] flex items-center gap-2">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* TAB 1: Direct 6-Direction Messaging */}
      {activeTab === 'messages' && (
        <div className="space-y-5">
          {canSendDirectMsg && (
            <form
              onSubmit={handleSendDirectMessage}
              className="rounded-3xl border border-[#595859]/20 bg-white p-5 space-y-4"
            >
              <h3 className="text-base font-extrabold text-[#595859]">إرسال رسالة مباشرة بين الأقسام (عزل تام عن القسم الثالث)</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {user.role_code === 'admin' && (
                  <select
                    value={msgSenderDept}
                    onChange={(e) => setMsgSenderDept(e.target.value as DepartmentCode)}
                    aria-label="القسم المرسل"
                    className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs font-bold text-[#595859]"
                  >
                    {ACTIVE_OPERATIONAL_DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>
                        من: {DEPARTMENT_LABELS[d]}
                      </option>
                    ))}
                  </select>
                )}

                <select
                  value={msgRecipientDept}
                  onChange={(e) => setMsgRecipientDept(e.target.value as DepartmentCode)}
                  aria-label="القسم المستلم"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs font-bold text-[#595859]"
                >
                  {(user.role_code === 'admin'
                    ? ACTIVE_OPERATIONAL_DEPARTMENTS.filter((d) => d !== msgSenderDept)
                    : validRecipients
                  ).map((d) => (
                    <option key={d} value={d}>
                      إلى: {DEPARTMENT_LABELS[d]}
                    </option>
                  ))}
                </select>

                <input
                  type="text"
                  value={msgTracking}
                  onChange={(e) => setMsgTracking(e.target.value)}
                  placeholder="رقم المتابعة TRK-... (اختياري)"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs font-mono-num text-[#595859]"
                />

                <input
                  type="text"
                  value={msgInvoice}
                  onChange={(e) => setMsgInvoice(e.target.value)}
                  placeholder="رقم الفاتورة (اختياري)"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs font-mono-num text-[#595859]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="text"
                  value={msgBody}
                  onChange={(e) => setMsgBody(e.target.value)}
                  placeholder="اكتب نص الرسالة التشغيلية..."
                  required
                  className="sm:col-span-2 h-[48px] rounded-2xl border border-[#595859]/25 bg-white px-4 text-sm text-[#595859]"
                />
                <input
                  type="text"
                  value={msgNotes}
                  onChange={(e) => setMsgNotes(e.target.value)}
                  placeholder="ملاحظات إضافية (اختياري)"
                  className="h-[48px] rounded-2xl border border-[#595859]/25 bg-white px-4 text-sm text-[#595859]"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="min-h-[46px] inline-flex items-center gap-2 rounded-2xl bg-[#EF1923] px-5 text-sm font-bold text-white disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                <span>{busy ? 'جاري الإرسال...' : 'إرسال الرسالة مع تنبيه صوتي للقسم المستلم'}</span>
              </button>
            </form>
          )}

          <div className="space-y-3">
            <h3 className="text-base font-bold text-[#595859] px-1">
              سجل الرسائل ضمن نطاق قسمك ({filteredMessages.length})
            </h3>
            {loading ? (
              <div className="h-32 rounded-2xl border border-[#595859]/15 bg-[#595859]/5 animate-pulse" />
            ) : filteredMessages.length === 0 ? (
              <div className="rounded-2xl border border-[#595859]/18 bg-white p-8 text-center text-sm font-bold text-[#595859]/70">
                لا توجد مراسلات مباشرة مسجلة ضمن نطاق صلاحياتك حالياً
              </div>
            ) : (
              filteredMessages.map(renderMessageCard)
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Hall -> Assembly Inquiries & Canned Replies */}
      {activeTab === 'inquiries' && (
        <div className="space-y-5">
          {canSendInquiry && (
            <form onSubmit={handleSendInquiry} className="rounded-3xl border border-[#595859]/20 bg-white p-5 space-y-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-[#EF1923]" />
                <h3 className="text-base font-extrabold text-[#595859]">إرسال استفسار مباشر من الصالة إلى قسم التجميع</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <input
                  type="text"
                  value={inqInvoice}
                  onChange={(e) => setInqInvoice(e.target.value)}
                  placeholder="رقم الفاتورة *"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs font-mono-num text-[#595859]"
                />
                <input
                  type="text"
                  value={inqTracking}
                  onChange={(e) => setInqTracking(e.target.value)}
                  placeholder="رقم المتابعة TRK-... (أو آلي)"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs font-mono-num text-[#595859]"
                />
                <input
                  type="text"
                  value={inqItem}
                  onChange={(e) => setInqItem(e.target.value)}
                  placeholder="الصنف المستفسر عنه"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs text-[#595859]"
                />
                <input
                  type="number"
                  min={1}
                  value={inqQty}
                  onChange={(e) => setInqQty(e.target.value)}
                  placeholder="الكمية"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs font-mono-num text-[#595859]"
                />
                <select
                  value={inqUrgency}
                  onChange={(e) => setInqUrgency(e.target.value as UrgencyLevel)}
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs font-bold text-[#595859]"
                >
                  <option value="normal">{URGENCY_LABELS.normal}</option>
                  <option value="urgent">{URGENCY_LABELS.urgent}</option>
                  <option value="critical">{URGENCY_LABELS.critical}</option>
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="text"
                  value={inqBody}
                  onChange={(e) => setInqBody(e.target.value)}
                  placeholder="نص الاستفسار الموجّه لقسم التجميع (مثال: هل الطلب جاهز للتسليم؟)..."
                  required
                  className="sm:col-span-2 h-[48px] rounded-2xl border border-[#595859]/25 bg-white px-4 text-sm text-[#595859]"
                />
                <input
                  type="text"
                  value={inqNotes}
                  onChange={(e) => setInqNotes(e.target.value)}
                  placeholder="ملاحظات إضافية (اختياري)"
                  className="h-[48px] rounded-2xl border border-[#595859]/25 bg-white px-4 text-sm text-[#595859]"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="min-h-[46px] inline-flex items-center gap-2 rounded-2xl bg-[#EF1923] px-5 text-sm font-bold text-white disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                <span>إرسال الاستفسار المباشر إلى التجميع</span>
              </button>
            </form>
          )}

          <div className="space-y-3">
            <h3 className="text-base font-bold text-[#595859] px-1">
              سجل الاستفسارات المباشرة والردود المنظمة ({inquiryMessages.length})
            </h3>
            {inquiryMessages.length === 0 ? (
              <div className="rounded-2xl border border-[#595859]/18 bg-white p-8 text-center text-sm font-bold text-[#595859]/70">
                لا توجد استفسارات مسجلة بعد
              </div>
            ) : (
              inquiryMessages.map(renderMessageCard)
            )}
          </div>
        </div>
      )}

      {/* TAB 3: Assembly -> Hall Backlog Reports */}
      {activeTab === 'backlog' && (
        <div className="space-y-5">
          {canSendBacklog && (
            <form onSubmit={handleCreateBacklogReport} className="rounded-3xl border border-[#F8941A]/50 bg-white p-5 space-y-4">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-[#F8941A]" />
                <h3 className="text-base font-extrabold text-[#595859]">إنشاء بلاغ تراكم الطلبات (من قسم التجميع إلى الصالة)</h3>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#595859] mb-1">عدد الطلبات المتراكمة *</label>
                  <input
                    type="number"
                    min={1}
                    value={blCount}
                    onChange={(e) => setBlCount(e.target.value)}
                    className="w-full h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-sm font-mono-num text-[#595859]"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-bold text-[#595859] mb-1">أرقام الفواتير المتراكمة *</label>
                  <input
                    type="text"
                    value={blInvoices}
                    onChange={(e) => setBlInvoices(e.target.value)}
                    placeholder="مثال: 1301, 1302, 1303"
                    required
                    className="w-full h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-sm font-mono-num text-[#595859]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#595859] mb-1">مستوى الاستعجال</label>
                  <select
                    value={blUrgency}
                    onChange={(e) => setBlUrgency(e.target.value as UrgencyLevel)}
                    className="w-full h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-sm font-bold text-[#595859]"
                  >
                    <option value="normal">{URGENCY_LABELS.normal}</option>
                    <option value="urgent">{URGENCY_LABELS.urgent}</option>
                    <option value="critical">{URGENCY_LABELS.critical}</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <input
                  type="text"
                  value={blItems}
                  onChange={(e) => setBlItems(e.target.value)}
                  placeholder="الأصناف المتراكمة"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs text-[#595859]"
                />
                <input
                  type="text"
                  value={blWaitDuration}
                  onChange={(e) => setBlWaitDuration(e.target.value)}
                  placeholder="مدة الانتظار (مثال: 15 دقيقة)"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs text-[#595859]"
                />
                <input
                  type="text"
                  value={blReason}
                  onChange={(e) => setBlReason(e.target.value)}
                  placeholder="سبب التراكم"
                  className="h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-3 text-xs text-[#595859]"
                />
              </div>

              <input
                type="text"
                value={blNotes}
                onChange={(e) => setBlNotes(e.target.value)}
                placeholder="ملاحظات إضافية لإدارة الصالة (اختياري)..."
                className="w-full h-[46px] rounded-2xl border border-[#595859]/25 bg-white px-4 text-xs text-[#595859]"
              />

              <button
                type="submit"
                disabled={busy}
                className="min-h-[48px] inline-flex items-center gap-2 rounded-2xl bg-[#F8941A] px-6 text-sm font-bold text-white disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                <span>إرسال بلاغ التراكم إلى الصالة مع تنبيه صوتي</span>
              </button>
            </form>
          )}

          <div className="space-y-3">
            <h3 className="text-base font-bold text-[#595859] px-1">
              بلاغات التراكم المسجلة ({backlogTickets.length})
            </h3>
            {backlogTickets.length === 0 ? (
              <div className="rounded-2xl border border-[#595859]/18 bg-white p-8 text-center text-sm font-bold text-[#595859]/70">
                لا توجد بلاغات تراكم طلبات حالياً
              </div>
            ) : (
              backlogTickets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelectTicket(t.id)}
                  className="w-full text-right rounded-2xl border border-[#595859]/20 bg-white p-4 hover:border-[#F8941A] transition-colors flex flex-wrap items-center justify-between gap-3"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
                      <span className="font-mono-num text-[#EF1923]">{t.ticket_number}</span>
                      <span>·</span>
                      <span className="text-[#F8941A]">{TICKET_KIND_LABELS[t.ticket_kind]}</span>
                      <span>·</span>
                      <span className="text-[#EF1923]">{URGENCY_LABELS[t.urgency_level]}</span>
                      <span>·</span>
                      <span className="font-mono-num text-[#595859]">
                        عدد الطلبات: {t.backlog_orders_count} ({t.backlog_invoices.join('، ') || t.invoice_number})
                      </span>
                    </div>
                    <div className="text-sm font-bold text-[#595859]">{t.problem_description}</div>
                    <div className="text-xs text-[#595859]/75 font-mono-num flex flex-wrap items-center gap-2">
                      <span className="text-[#EF1923] font-bold">{STATUS_LABELS[t.status]}</span>
                      <span>·</span>
                      <span>{formatDurationAr(t.stall_minutes)}</span>
                      <span>·</span>
                      <span>{formatAdenDateTime(t.created_at)}</span>
                    </div>
                  </div>
                  <ChevronLeft className="w-5 h-5 text-[#595859]/60 shrink-0" />
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
