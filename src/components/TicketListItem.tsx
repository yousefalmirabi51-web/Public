import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Flame,
  Package,
  RefreshCw,
  Truck,
} from 'lucide-react';
import {
  DEPARTMENT_LABELS,
  REASON_LABELS,
  STATUS_LABELS,
  type TicketSummary,
} from '../types/domain';
import { formatAdenDateTime, formatDurationAr } from '../utils/time';

interface TicketListItemProps {
  ticket: TicketSummary;
  onSelect: (ticketId: number) => void;
}

export const TicketListItem: React.FC<TicketListItemProps> = ({ ticket, onSelect }) => {
  const isEscalatedOrUrgent =
    ticket.escalation_level > 0 || (ticket.status !== 'closed' && ticket.stall_minutes >= 10);
  const isAwaitingConfirm = ticket.status === 'action_taken_awaiting_confirm';
  const isClosed = ticket.status === 'closed';

  const iconBgClass = isClosed
    ? 'bg-[#595859]'
    : isEscalatedOrUrgent
      ? 'bg-[#EF1923]'
      : isAwaitingConfirm
        ? 'bg-[#F8941A]'
        : 'bg-[#595859]';

  const StatusIcon = isClosed
    ? CheckCircle2
    : ticket.status === 'reopened'
      ? RefreshCw
      : isEscalatedOrUrgent
        ? AlertTriangle
        : ticket.reason_code === 'assembly_backlog' || ticket.reason_code === 'no_waiter_available'
          ? Truck
          : ticket.reason_code === 'production_delay'
            ? Flame
            : Package;

  const statusTextColor = isClosed
    ? 'text-[#595859]'
    : isEscalatedOrUrgent
      ? 'text-[#EF1923]'
      : isAwaitingConfirm
        ? 'text-[#F8941A]'
        : 'text-[#595859]';

  return (
    <button
      type="button"
      onClick={() => onSelect(ticket.id)}
      className={`w-full text-right app-card-interactive p-4 flex items-center justify-between gap-3 focus-visible:outline-2 focus-visible:outline-[var(--brand-red)] ${
        isEscalatedOrUrgent && !isClosed ? 'border-[var(--brand-red)]/65' : ''
      }`}
    >
      <div className="flex items-start gap-3.5 min-w-0 flex-1">
        <div className={`w-11 h-11 rounded-2xl ${iconBgClass} text-white flex items-center justify-center shrink-0 mt-0.5`}>
          <StatusIcon className="w-5 h-5" />
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-base font-bold text-[#595859] truncate">
              {ticket.item_name}
            </span>
            <span className="text-xs font-mono-num font-semibold text-[#EF1923]">
              فاتورة {ticket.invoice_number}
            </span>
            <span className="text-xs font-mono-num text-[#595859]/75">
              · {ticket.ticket_number}
            </span>
            {ticket.created_via_support && (
              <span className="text-xs font-bold text-[#F8941A]">· عبر المساندة</span>
            )}
          </div>

          <p className="text-sm text-[#595859] line-clamp-1">
            {REASON_LABELS[ticket.reason_code]} — {ticket.problem_description}
          </p>

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[#595859]/80 pt-0.5">
            <span className={`font-bold ${statusTextColor}`}>{STATUS_LABELS[ticket.status]}</span>
            <span aria-hidden="true">·</span>
            <span>من: {DEPARTMENT_LABELS[ticket.sender_department]}</span>
            <span aria-hidden="true">·</span>
            <span>إلى: {DEPARTMENT_LABELS[ticket.target_department]}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1 font-mono-num">
              <Clock className="w-3.5 h-3.5 text-[#F8941A]" />
              {formatDurationAr(ticket.stall_minutes)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono-num">{formatAdenDateTime(ticket.created_at)}</span>
            {ticket.received_by_name ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-bold text-[#595859]">استلمه: {ticket.received_by_name}</span>
              </>
            ) : ticket.first_read_by_name ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-bold text-[#F8941A]">قرأه: {ticket.first_read_by_name} (بانتظار الاستلام)</span>
              </>
            ) : ticket.delivered_to_dept_at ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-semibold text-[#595859]">وصل للقسم (لم يُفتح)</span>
              </>
            ) : null}
            {ticket.is_overdue_unreceived && !isClosed && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-extrabold text-[#EF1923]">تأخر تأكيد الاستلام</span>
              </>
            )}
            {ticket.escalation_level > 0 && !isClosed && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-bold text-[#EF1923]">تصعيد م{ticket.escalation_level}</span>
              </>
            )}
          </div>
        </div>
      </div>

      <ChevronLeft className="w-5 h-5 text-[#595859]/60 shrink-0" />
    </button>
  );
};
