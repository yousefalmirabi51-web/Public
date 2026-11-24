import type Database from 'better-sqlite3';
import {
  DEPARTMENT_LABELS,
  INQUIRY_CANNED_STATUSES,
  REASON_LABELS,
  STATUS_LABELS,
  URGENCY_LABELS,
  type DepartmentCode,
  type DepartmentMessageRecord,
  type DepartmentWaitMinutes,
  type EscalationSettings,
  type InquiryStatusCode,
  type MessageType,
  type NotificationItem,
  type ReasonCode,
  type ResponsibleAssignment,
  type ResponsibleRoleKey,
  type TicketDetail,
  type TicketItem,
  type TicketKind,
  type TicketReadRecord,
  type TicketStatus,
  type TicketSummary,
  type UrgencyLevel,
  type UserProfile,
} from '../src/types/domain.ts';

export type TicketScope = 'inbox' | 'open' | 'delayed' | 'all' | 'assembly_support';

const ADEN_TZ = 'Asia/Aden';

export function getAdenDateKey(isoOrDate: string | Date): string {
  const date = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ADEN_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function filterTicketsByAdenDate(
  tickets: TicketSummary[],
  opts: { mode?: string; date?: string; dateFrom?: string; dateTo?: string }
): TicketSummary[] {
  const mode = (opts.mode || '').trim();
  const singleDate = (opts.date || '').trim();
  const dateFrom = (opts.dateFrom || '').trim();
  const dateTo = (opts.dateTo || '').trim();

  if (mode === 'today') {
    const todayKey = getAdenDateKey(new Date());
    return tickets.filter((t) => getAdenDateKey(t.created_at) === todayKey);
  }
  if (mode === 'single' && singleDate) {
    return tickets.filter((t) => getAdenDateKey(t.created_at) === singleDate);
  }
  if (mode === 'range' || dateFrom || dateTo) {
    return tickets.filter((t) => {
      const k = getAdenDateKey(t.created_at);
      if (dateFrom && k < dateFrom) return false;
      if (dateTo && k > dateTo) return false;
      return true;
    });
  }
  return tickets;
}

export function computeStallMinutes(createdAtIso: string, closedAtIso: string | null): number {
  const start = new Date(createdAtIso).getTime();
  const end = closedAtIso ? new Date(closedAtIso).getTime() : Date.now();
  return Math.max(0, Math.round((end - start) / 60000));
}

function diffMins(startIso: string | null | undefined, endIso: string | null | undefined, fallbackEndMs: number): number {
  if (!startIso) return 0;
  const startMs = new Date(startIso).getTime();
  if (Number.isNaN(startMs)) return 0;
  const endMs = endIso ? new Date(endIso).getTime() : fallbackEndMs;
  if (Number.isNaN(endMs) || endMs < startMs) return 0;
  return Math.round((endMs - startMs) / 60000);
}

export function computeDepartmentWaitMinutes(params: {
  createdAt: string;
  closedAt: string | null;
  targetDepartment: DepartmentCode;
  senderDepartment: DepartmentCode;
  preparedAt: string | null;
  actionTakenAt: string | null;
  arrivalConfirmedAt: string | null;
  dispatchedToHallAt: string | null;
  hallReceivedAt: string | null;
  ticketKind: TicketKind;
}): DepartmentWaitMinutes {
  const endFallbackIso = params.closedAt;
  const nowMs = Date.now();

  let production = 0;
  let assembly = 0;
  let hall = 0;

  if (params.ticketKind === 'backlog' || (params.targetDepartment === 'hall' && !params.preparedAt && !params.dispatchedToHallAt)) {
    hall = diffMins(params.createdAt, params.hallReceivedAt || endFallbackIso, nowMs);
    if (params.senderDepartment === 'assembly' && params.actionTakenAt && !params.hallReceivedAt) {
      assembly = 0;
    }
    return { production, assembly, hall };
  }

  if (params.ticketKind === 'inquiry') {
    assembly = diffMins(params.createdAt, params.actionTakenAt || endFallbackIso, nowMs);
    return { production, assembly, hall };
  }

  const prodEndIso = params.preparedAt || params.actionTakenAt || params.arrivalConfirmedAt || endFallbackIso;
  if (params.targetDepartment === 'production' || params.preparedAt || params.senderDepartment === 'hall') {
    production = diffMins(params.createdAt, prodEndIso, nowMs);
  }

  const asmStartIso =
    params.targetDepartment === 'assembly' && !params.preparedAt
      ? params.createdAt
      : params.arrivalConfirmedAt || params.preparedAt || params.actionTakenAt;
  if (asmStartIso) {
    const asmEndIso = params.dispatchedToHallAt || endFallbackIso;
    assembly = diffMins(asmStartIso, asmEndIso, nowMs);
  }

  if (params.dispatchedToHallAt) {
    hall = diffMins(params.dispatchedToHallAt, params.hallReceivedAt || endFallbackIso, nowMs);
  }

  return { production, assembly, hall };
}

export function canUserAccessScope(user: UserProfile, scope: TicketScope): boolean {
  if (scope === 'assembly_support') {
    return user.role_code === 'admin' || user.has_assembly_support;
  }
  return true;
}

export function canUserViewTicket(user: UserProfile, ticket: TicketSummary, scope: TicketScope = 'all'): boolean {
  if (user.role_code === 'admin') return true;

  if (scope === 'assembly_support') {
    if (!user.has_assembly_support) return false;
    return (
      ['production_delay', 'dispatched_not_arrived', 'item_shortage', 'item_mismatch', 'assembly_backlog'].includes(
        ticket.reason_code
      ) ||
      ticket.created_via_support ||
      ticket.target_department === 'production' ||
      ticket.sender_department === 'assembly'
    );
  }

  switch (user.role_code) {
    case 'assembly':
      return (
        ticket.target_department === 'assembly' ||
        ticket.sender_department === 'assembly' ||
        ticket.created_via_support ||
        Boolean(ticket.transfer_departments?.includes('assembly')) ||
        [
          'production_delay',
          'dispatched_not_arrived',
          'item_shortage',
          'item_mismatch',
          'assembly_backlog',
          'no_waiter_available',
          'handover_delay',
        ].includes(ticket.reason_code)
      );

    case 'production':
      return (
        ticket.target_department === 'production' ||
        ticket.sender_department === 'production' ||
        Boolean(ticket.transfer_departments?.includes('production'))
      );

    case 'hall_supervisor':
      return (
        ticket.target_department === 'hall' ||
        (ticket.sender_department === 'hall' && !ticket.created_via_support) ||
        Boolean(ticket.transfer_departments?.includes('hall')) ||
        ['assembly_backlog', 'no_waiter_available', 'handover_delay'].includes(ticket.reason_code)
      );

    case 'waiter':
      return false;

    default:
      return false;
  }
}

export function evaluateClosureEligibility(
  user: UserProfile,
  ticket: TicketSummary,
  items: TicketItem[]
): { canClose: boolean; blockReason: string | null } {
  if (ticket.status === 'closed') {
    return { canClose: false, blockReason: 'البلاغ مغلق بالفعل' };
  }

  if (user.role_code === 'production') {
    return {
      canClose: false,
      blockReason: 'لا يحق لقسم الإنتاج إغلاق البلاغ؛ يجب تأكيد وصول الطلب في التجميع والتحقق النهائي أولاً',
    };
  }

  if (user.role_code === 'waiter') {
    return {
      canClose: false,
      blockReason: 'تم إلغاء دور المباشرين ونقل متابعة الجاهزية إلى مسؤول الصالة',
    };
  }

  const isProductionReason = ['production_delay', 'dispatched_not_arrived', 'item_shortage', 'item_mismatch'].includes(
    ticket.reason_code
  );

  // If Assembly already dispatched to Hall, final Hall receipt must be confirmed before closing
  if (ticket.dispatched_to_hall_at && !ticket.hall_received_at) {
    return {
      canClose: false,
      blockReason: 'يجب على مسؤول الصالة تأكيد استلام الطلب النهائي قبل إغلاق البلاغ',
    };
  }

  if (isProductionReason || ticket.target_department === 'production') {
    if (user.role_code === 'hall_supervisor' && ticket.sender_department !== 'hall') {
      return {
        canClose: false,
        blockReason: 'لا يحق لمسؤول الصالة إغلاق بلاغات التجميع مع الإنتاج؛ التجميع هو المخول بتأكيد الوصول والإغلاق',
      };
    }

    const allConfirmed = items.length > 0 && items.every((i) => i.arrival_confirmed);
    if (!allConfirmed && !ticket.arrival_confirmed) {
      return {
        canClose: false,
        blockReason: 'تأكيد استلام البلاغ وحده لا يكفي — يجب تأكيد وصول الطلب فعلياً في قسم التجميع أولاً',
      };
    }

    if (user.role_code === 'hall_supervisor' && ticket.dispatched_to_hall_at && !ticket.hall_received_at) {
      return {
        canClose: false,
        blockReason: 'يجب تأكيد استلام الطلب النهائي في الصالة قبل الإغلاق',
      };
    }

    return { canClose: true, blockReason: null };
  }

  if (
    ticket.reason_code === 'no_waiter_available' ||
    ticket.reason_code === 'assembly_backlog' ||
    ticket.reason_code === 'handover_delay' ||
    ticket.ticket_kind === 'backlog'
  ) {
    // Receipt alone NEVER closes a backlog/handover ticket; requires real action or hall confirmation
    if (!ticket.action_taken_at && !ticket.hall_received_at && !ticket.dispatched_to_hall_at) {
      return {
        canClose: false,
        blockReason: 'تأكيد استلام بلاغ التراكم وحده لا يكفي — يجب توثيق معالجة التراكم أو تسليم الطلب قبل الإغلاق',
      };
    }
    return { canClose: true, blockReason: null };
  }

  if (!ticket.action_taken_at && !ticket.arrival_confirmed && !ticket.hall_received_at) {
    return {
      canClose: false,
      blockReason: 'يجب تنفيذ إجراء المعالجة وتأكيد التحقق الفعلي قبل الإغلاق',
    };
  }

  return { canClose: true, blockReason: null };
}

export function fetchTicketSummaries(
  db: Database.Database,
  options?: { isTest?: boolean }
): TicketSummary[] {
  const escRow = db.prepare('SELECT first_warning_minutes FROM escalation_settings WHERE id = 1').get() as
    | { first_warning_minutes: number }
    | undefined;
  const warningThreshold = Number(escRow?.first_warning_minutes || 5);

  const whereClause =
    options?.isTest === undefined ? '' : `WHERE COALESCE(t.is_test, 0) = ${options.isTest ? 1 : 0}`;

  const rows = db.prepare(`
    SELECT
      t.*,
      cu.full_name AS created_by_name,
      wu.full_name AS assigned_waiter_name,
      fru.full_name AS first_read_by_name,
      ru.full_name AS received_by_name,
      hru.full_name AS hall_received_by_name,
      clu.full_name AS closed_by_name,
      (SELECT ti.item_name FROM ticket_items ti WHERE ti.ticket_id = t.id ORDER BY ti.id ASC LIMIT 1) AS item_name,
      (SELECT COALESCE(SUM(ti.quantity), 1) FROM ticket_items ti WHERE ti.ticket_id = t.id) AS quantity,
      (SELECT CASE WHEN COUNT(*) > 0 AND SUM(CASE WHEN ti.arrival_confirmed = 1 THEN 1 ELSE 0 END) = COUNT(*) THEN 1 ELSE 0 END FROM ticket_items ti WHERE ti.ticket_id = t.id) AS arrival_confirmed_flag,
      (SELECT MAX(ti.arrival_confirmed_at) FROM ticket_items ti WHERE ti.ticket_id = t.id) AS arrival_confirmed_at,
      (SELECT au.full_name FROM ticket_items ti JOIN users au ON au.id = ti.arrival_confirmed_by WHERE ti.ticket_id = t.id ORDER BY ti.id ASC LIMIT 1) AS arrival_confirmed_by_name,
      (SELECT CASE WHEN COUNT(*) > 0 AND SUM(CASE WHEN ti.order_completed = 1 THEN 1 ELSE 0 END) = COUNT(*) THEN 1 ELSE 0 END FROM ticket_items ti WHERE ti.ticket_id = t.id) AS order_completed_flag,
      (SELECT MAX(ti.order_completed_at) FROM ticket_items ti WHERE ti.ticket_id = t.id) AS order_completed_at,
      (SELECT GROUP_CONCAT(tt.from_department || ',' || tt.to_department) FROM ticket_transfers tt WHERE tt.ticket_id = t.id) AS transfer_departments_raw
    FROM tickets t
    JOIN users cu ON cu.id = t.created_by_user_id
    LEFT JOIN users wu ON wu.id = t.assigned_waiter_id
    LEFT JOIN users fru ON fru.id = t.first_read_by_user_id
    LEFT JOIN users ru ON ru.id = t.received_by_user_id
    LEFT JOIN users hru ON hru.id = t.hall_received_by_user_id
    LEFT JOIN users clu ON clu.id = t.closed_by_user_id
    ${whereClause}
    ORDER BY t.created_at DESC, t.id DESC
  `).all() as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const transferDepts = new Set<DepartmentCode>();
    if (r.transfer_departments_raw) {
      for (const part of String(r.transfer_departments_raw).split(',')) {
        const trimmed = part.trim() as DepartmentCode;
        if (trimmed) transferDepts.add(trimmed);
      }
    }

    let parsedBacklogInvoices: string[] = [];
    if (r.backlog_invoices) {
      try {
        const arr = JSON.parse(String(r.backlog_invoices));
        if (Array.isArray(arr)) parsedBacklogInvoices = arr.map(String);
      } catch {
        parsedBacklogInvoices = String(r.backlog_invoices)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }

    const createdAt = String(r.created_at);
    const closedAt = r.closed_at ? String(r.closed_at) : null;
    const preparedAt = r.prepared_at ? String(r.prepared_at) : null;
    const actionTakenAt = r.action_taken_at ? String(r.action_taken_at) : null;
    const arrivalConfirmedAt = r.arrival_confirmed_at ? String(r.arrival_confirmed_at) : null;
    const dispatchedToHallAt = r.dispatched_to_hall_at ? String(r.dispatched_to_hall_at) : null;
    const hallReceivedAt = r.hall_received_at ? String(r.hall_received_at) : null;
    const receivedAt = r.received_at ? String(r.received_at) : null;
    const status = r.status as TicketStatus;
    const stallMinutes = computeStallMinutes(createdAt, closedAt);
    const ticketKind = ((r.ticket_kind as TicketKind) || 'stall') as TicketKind;
    const targetDept = r.target_department as DepartmentCode;
    const senderDept = r.sender_department as DepartmentCode;

    return {
      id: Number(r.id),
      ticket_number: String(r.ticket_number),
      invoice_number: String(r.invoice_number),
      item_name: String(r.item_name || 'صنف غير محدد'),
      quantity: Number(r.quantity || 1),
      reason_code: r.reason_code as ReasonCode,
      urgency_level: ((r.urgency_level as UrgencyLevel) || 'normal') as UrgencyLevel,
      ticket_kind: ticketKind,
      problem_description: String(r.problem_description),
      target_department: targetDept,
      sender_department: senderDept,
      created_by_user_id: Number(r.created_by_user_id),
      created_by_name: String(r.created_by_name),
      assigned_waiter_id: r.assigned_waiter_id ? Number(r.assigned_waiter_id) : null,
      assigned_waiter_name: r.assigned_waiter_name ? String(r.assigned_waiter_name) : null,
      status,
      created_via_support: Number(r.created_via_support) === 1,
      parent_ticket_id: r.parent_ticket_id ? Number(r.parent_ticket_id) : null,
      escalation_level: Number(r.escalation_level || 0),
      last_escalated_at: r.last_escalated_at ? String(r.last_escalated_at) : null,
      delivered_to_dept_at: r.delivered_to_dept_at ? String(r.delivered_to_dept_at) : null,
      delivered_to_dept_via: r.delivered_to_dept_via ? String(r.delivered_to_dept_via) : null,
      first_read_at: r.first_read_at ? String(r.first_read_at) : null,
      first_read_by_name: r.first_read_by_name ? String(r.first_read_by_name) : null,
      first_read_department: r.first_read_department ? String(r.first_read_department) : null,
      received_at: receivedAt,
      received_by_name: r.received_by_name ? String(r.received_by_name) : null,
      unreceived_reminder_count: Number(r.unreceived_reminder_count || 0),
      last_reminder_at: r.last_reminder_at ? String(r.last_reminder_at) : null,
      is_overdue_unreceived: !receivedAt && status !== 'closed' && stallMinutes >= warningThreshold,
      is_test: Number(r.is_test || 0) === 1,
      processing_started_at: r.processing_started_at ? String(r.processing_started_at) : null,
      prepared_at: preparedAt,
      action_taken_at: actionTakenAt,
      arrival_confirmed: Number(r.arrival_confirmed_flag) === 1,
      arrival_confirmed_at: arrivalConfirmedAt,
      arrival_confirmed_by_name: r.arrival_confirmed_by_name ? String(r.arrival_confirmed_by_name) : null,
      order_completed: Number(r.order_completed_flag) === 1,
      order_completed_at: r.order_completed_at ? String(r.order_completed_at) : null,
      dispatched_to_hall_at: dispatchedToHallAt,
      hall_received_at: hallReceivedAt,
      hall_received_by_name: r.hall_received_by_name ? String(r.hall_received_by_name) : null,
      backlog_orders_count: Number(r.backlog_orders_count || 1),
      backlog_invoices: parsedBacklogInvoices,
      waiter_received_at: r.waiter_received_at ? String(r.waiter_received_at) : null,
      waiter_delivered_at: r.waiter_delivered_at ? String(r.waiter_delivered_at) : null,
      closed_at: closedAt,
      closed_by_name: r.closed_by_name ? String(r.closed_by_name) : null,
      reopened_count: Number(r.reopened_count || 0),
      created_at: createdAt,
      updated_at: String(r.updated_at),
      stall_minutes: stallMinutes,
      department_wait_minutes: computeDepartmentWaitMinutes({
        createdAt,
        closedAt,
        targetDepartment: targetDept,
        senderDepartment: senderDept,
        preparedAt,
        actionTakenAt,
        arrivalConfirmedAt,
        dispatchedToHallAt,
        hallReceivedAt,
        ticketKind,
      }),
      transfer_departments: Array.from(transferDepts),
    };
  });
}

export function fetchDepartmentMessages(
  db: Database.Database,
  user: UserProfile,
  filters?: { ticketId?: number; trackingNumber?: string; messageType?: MessageType | string }
): DepartmentMessageRecord[] {
  const where: string[] = ['COALESCE(dm.is_test, 0) = ?'];
  const params: unknown[] = [user.is_test_account ? 1 : 0];

  if (filters?.ticketId) {
    where.push('dm.ticket_id = ?');
    params.push(filters.ticketId);
  }
  if (filters?.trackingNumber) {
    where.push('UPPER(dm.tracking_number) = UPPER(?)');
    params.push(filters.trackingNumber.trim());
  }
  if (filters?.messageType) {
    where.push('dm.message_type = ?');
    params.push(filters.messageType);
  }

  const sql = `
    SELECT
      dm.*,
      su.full_name AS sender_name,
      ru.full_name AS received_by_name,
      rdu.full_name AS read_by_name
    FROM department_messages dm
    JOIN users su ON su.id = dm.sender_user_id
    LEFT JOIN users ru ON ru.id = dm.received_by_user_id
    LEFT JOIN users rdu ON rdu.id = dm.read_by_user_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY dm.sent_at ASC, dm.id ASC
  `;

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

  return rows
    .filter((r) => {
      if (user.role_code === 'admin') return true;
      return r.sender_department === user.department_code || r.recipient_department === user.department_code;
    })
    .map((r) => {
      const code = r.canned_status_code !== null && r.canned_status_code !== undefined
        ? (Number(r.canned_status_code) as InquiryStatusCode)
        : null;
      return {
        id: Number(r.id),
        ticket_id: r.ticket_id ? Number(r.ticket_id) : null,
        tracking_number: String(r.tracking_number),
        invoice_number: String(r.invoice_number),
        message_type: (r.message_type as MessageType) || 'general',
        canned_status_code: code,
        canned_status_label: code ? INQUIRY_CANNED_STATUSES[code] || null : null,
        sender_department: r.sender_department as DepartmentCode,
        recipient_department: r.recipient_department as DepartmentCode,
        sender_user_id: Number(r.sender_user_id),
        sender_name: String(r.sender_name),
        message_body: String(r.message_body),
        notes: r.notes ? String(r.notes) : null,
        parent_message_id: r.parent_message_id ? Number(r.parent_message_id) : null,
        sent_at: String(r.sent_at),
        sent_status: 'sent',
        received_at: r.received_at ? String(r.received_at) : null,
        received_by_name: r.received_by_name ? String(r.received_by_name) : null,
        read_at: r.read_at ? String(r.read_at) : null,
        read_by_name: r.read_by_name ? String(r.read_by_name) : null,
      };
    });
}

export function fetchTicketDetail(db: Database.Database, ticketId: number, user: UserProfile): TicketDetail | null {
  const summaries = fetchTicketSummaries(db);
  const summary = summaries.find((t) => t.id === ticketId);
  if (!summary) return null;

  const items = db.prepare(`
    SELECT
      ti.*,
      au.full_name AS arrival_confirmed_by_name,
      ou.full_name AS order_completed_by_name
    FROM ticket_items ti
    LEFT JOIN users au ON au.id = ti.arrival_confirmed_by
    LEFT JOIN users ou ON ou.id = ti.order_completed_by
    WHERE ti.ticket_id = ?
    ORDER BY ti.id ASC
  `).all(ticketId) as Array<Record<string, unknown>>;

  const mappedItems: TicketItem[] = items.map((i) => ({
    id: Number(i.id),
    ticket_id: Number(i.ticket_id),
    item_name: String(i.item_name),
    quantity: Number(i.quantity),
    expected_qty: i.expected_qty !== null ? Number(i.expected_qty) : null,
    delivered_qty: i.delivered_qty !== null ? Number(i.delivered_qty) : null,
    issue_note: i.issue_note ? String(i.issue_note) : null,
    arrival_confirmed: Number(i.arrival_confirmed) === 1,
    arrival_confirmed_by_name: i.arrival_confirmed_by_name ? String(i.arrival_confirmed_by_name) : null,
    arrival_confirmed_at: i.arrival_confirmed_at ? String(i.arrival_confirmed_at) : null,
    order_completed: Number(i.order_completed) === 1,
    order_completed_by_name: i.order_completed_by_name ? String(i.order_completed_by_name) : null,
    order_completed_at: i.order_completed_at ? String(i.order_completed_at) : null,
  }));

  const rawReplies = db.prepare(`
    SELECT tr.*, u.full_name AS author_name, d.name_ar AS author_department, d.code AS author_dept_code
    FROM ticket_replies tr
    JOIN users u ON u.id = tr.user_id
    JOIN departments d ON d.id = u.department_id
    WHERE tr.ticket_id = ?
    ORDER BY tr.created_at ASC
  `).all(ticketId) as Array<TicketDetail['replies'][number] & { author_dept_code?: DepartmentCode }>;

  const replies: TicketDetail['replies'] = rawReplies
    .map((r) => ({
      ...r,
      sender_department: (r.sender_department || r.author_dept_code || null) as DepartmentCode | null,
      recipient_department: (r.recipient_department || null) as DepartmentCode | null,
    }))
    .filter((r) => {
      if (user.role_code === 'admin') return true;
      if (!r.recipient_department) return true;
      return r.sender_department === user.department_code || r.recipient_department === user.department_code;
    });

  const messages = fetchDepartmentMessages(db, user, { ticketId });

  const actions = db.prepare(`
    SELECT ta.*, u.full_name AS actor_name
    FROM ticket_actions ta
    JOIN users u ON u.id = ta.user_id
    WHERE ta.ticket_id = ?
    ORDER BY ta.created_at ASC
  `).all(ticketId) as TicketDetail['actions'];

  const transfers = db.prepare(`
    SELECT tt.*, u.full_name AS transferred_by_name
    FROM ticket_transfers tt
    JOIN users u ON u.id = tt.transferred_by_user_id
    WHERE tt.ticket_id = ?
    ORDER BY tt.created_at ASC
  `).all(ticketId) as TicketDetail['transfers'];

  const events = db.prepare(`
    SELECT * FROM ticket_events
    WHERE ticket_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(ticketId) as TicketDetail['events'];

  const reads = db.prepare(`
    SELECT id, ticket_id, user_id, user_name, department_code, department_name_ar, read_at
    FROM ticket_reads
    WHERE ticket_id = ?
    ORDER BY read_at DESC, id DESC
  `).all(ticketId) as TicketReadRecord[];

  const closure = evaluateClosureEligibility(user, summary, mappedItems);

  return {
    ...summary,
    items: mappedItems,
    replies,
    messages,
    actions,
    transfers,
    events,
    reads,
    can_close: closure.canClose,
    close_block_reason: closure.blockReason,
  };
}

export function markTicketsDeliveredToUserDept(
  db: Database.Database,
  user: UserProfile,
  ticketIds: number[],
  via = 'dept_sync'
): TicketSummary[] {
  if (!ticketIds.length) return [];
  const isTest = user.is_test_account ? 1 : 0;
  const nowIso = new Date().toISOString();
  const newlyDeliveredIds: number[] = [];

  for (const tid of ticketIds) {
    const row = db
      .prepare(`
        SELECT id, ticket_number, status, target_department, sender_department, delivered_to_dept_at, COALESCE(is_test, 0) AS is_test
        FROM tickets
        WHERE id = ?
      `)
      .get(tid) as
      | {
          id: number;
          ticket_number: string;
          status: string;
          target_department: DepartmentCode;
          sender_department: DepartmentCode;
          delivered_to_dept_at: string | null;
          is_test: number;
        }
      | undefined;

    if (!row) continue;
    if (row.is_test !== isTest) continue;
    if (row.status === 'closed') continue;
    if (row.delivered_to_dept_at) continue;
    if (row.target_department !== user.department_code) continue;
    if (row.sender_department === user.department_code) continue;

    const upd = db
      .prepare(`
        UPDATE tickets
        SET delivered_to_dept_at = COALESCE(delivered_to_dept_at, ?),
            delivered_to_dept_via = COALESCE(delivered_to_dept_via, ?)
        WHERE id = ? AND delivered_to_dept_at IS NULL
      `)
      .run(nowIso, via, tid);

    if (upd.changes === 1) {
      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'delivered_to_dept', ?, ?, ?, ?)
      `).run(
        tid,
        user.id,
        user.full_name,
        user.department_name_ar,
        row.status,
        row.status,
        `وصل البلاغ إلى جهاز قسم ${user.department_name_ar} (${via})`,
        nowIso
      );
      newlyDeliveredIds.push(tid);
    }
  }

  if (newlyDeliveredIds.length === 0) return [];
  const idSet = new Set(newlyDeliveredIds);
  return fetchTicketSummaries(db, { isTest: Boolean(user.is_test_account) }).filter((t) => idSet.has(t.id));
}

export function recordTicketRead(
  db: Database.Database,
  ticketId: number,
  user: UserProfile
): { firstReadRecorded: boolean; readRecorded: boolean } {
  const row = db
    .prepare(`
      SELECT id, status, target_department, sender_department, first_read_at, delivered_to_dept_at, COALESCE(is_test, 0) AS is_test
      FROM tickets
      WHERE id = ?
    `)
    .get(ticketId) as
    | {
        id: number;
        status: string;
        target_department: DepartmentCode;
        sender_department: DepartmentCode;
        first_read_at: string | null;
        delivered_to_dept_at: string | null;
        is_test: number;
      }
    | undefined;

  if (!row) return { firstReadRecorded: false, readRecorded: false };
  if (row.is_test !== (user.is_test_account ? 1 : 0)) {
    return { firstReadRecorded: false, readRecorded: false };
  }

  const nowIso = new Date().toISOString();
  const twentySecondsAgo = new Date(Date.now() - 20000).toISOString();
  const recentSameUser = db
    .prepare('SELECT id FROM ticket_reads WHERE ticket_id = ? AND user_id = ? AND read_at >= ? LIMIT 1')
    .get(ticketId, user.id, twentySecondsAgo);

  let readRecorded = false;
  if (!recentSameUser) {
    db.prepare(`
      INSERT INTO ticket_reads (ticket_id, user_id, user_name, department_code, department_name_ar, read_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ticketId, user.id, user.full_name, user.department_code, user.department_name_ar, nowIso);
    readRecorded = true;
  }

  const isTargetReader =
    user.department_code === row.target_department && user.department_code !== row.sender_department;

  if (isTargetReader && !row.first_read_at) {
    const upd = db
      .prepare(`
        UPDATE tickets
        SET delivered_to_dept_at = COALESCE(delivered_to_dept_at, ?),
            delivered_to_dept_via = COALESCE(delivered_to_dept_via, 'ticket_open'),
            first_read_at = COALESCE(first_read_at, ?),
            first_read_by_user_id = COALESCE(first_read_by_user_id, ?),
            first_read_department = COALESCE(first_read_department, ?)
        WHERE id = ? AND first_read_at IS NULL
      `)
      .run(nowIso, nowIso, user.id, user.department_code, ticketId);

    if (upd.changes === 1) {
      db.prepare(`
        INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
        VALUES (?, ?, ?, ?, 'ticket_read', ?, ?, ?, ?)
      `).run(
        ticketId,
        user.id,
        user.full_name,
        user.department_name_ar,
        row.status,
        row.status,
        `تمت قراءة البلاغ والاطلاع على تفاصيله بواسطة ${user.full_name} (${user.department_name_ar})`,
        nowIso
      );
      return { firstReadRecorded: true, readRecorded: true };
    }
  }

  return { firstReadRecorded: false, readRecorded };
}

export interface DispatchNotificationOptions {
  excludeUserId?: number;
  senderDepartment?: DepartmentCode | null;
  audioTargetDepartment?: DepartmentCode | null;
  strictTargetOnly?: boolean;
  extraTargetRole?: string;
  messageUid?: string;
  spokenText?: string;
  urgencyLevel?: UrgencyLevel;
  isTest?: boolean;
}

export function getRecipientUserIdsForTicket(
  db: Database.Database,
  ticket: TicketSummary,
  excludeUserId?: number,
  extraTargetRole?: string,
  options?: Pick<DispatchNotificationOptions, 'audioTargetDepartment' | 'strictTargetOnly' | 'senderDepartment' | 'isTest'>
): number[] {
  const isTest = options?.isTest !== undefined ? (options.isTest ? 1 : 0) : ticket.is_test ? 1 : 0;
  const users = db.prepare(`
    SELECT u.id, r.code AS role_code, d.code AS dept_code
    FROM users u
    JOIN roles r ON r.id = u.role_id
    JOIN departments d ON d.id = u.department_id
    WHERE u.is_active = 1 AND r.code != 'waiter' AND COALESCE(u.is_test_account, 0) = ?
  `).all(isTest) as Array<{ id: number; role_code: string; dept_code: string }>;

  const recipients = new Set<number>();
  const audioTarget = options?.audioTargetDepartment ?? null;
  const strictTargetOnly = Boolean(options?.strictTargetOnly);

  for (const u of users) {
    if (u.id === excludeUserId) continue;

    if (extraTargetRole && u.role_code === extraTargetRole) {
      recipients.add(u.id);
    }

    if (strictTargetOnly && audioTarget) {
      if (u.dept_code === audioTarget && u.dept_code !== options?.senderDepartment) {
        recipients.add(u.id);
      }
      continue;
    }

    if (u.role_code === 'admin') {
      recipients.add(u.id);
      continue;
    }

    if (audioTarget && u.dept_code === audioTarget && u.dept_code !== options?.senderDepartment) {
      recipients.add(u.id);
      continue;
    }

    if (u.role_code === 'production' && (ticket.target_department === 'production' || ticket.sender_department === 'production')) {
      recipients.add(u.id);
    }

    if (
      u.role_code === 'assembly' &&
      (ticket.target_department === 'assembly' ||
        ticket.sender_department === 'assembly' ||
        ticket.created_via_support ||
        [
          'production_delay',
          'dispatched_not_arrived',
          'item_shortage',
          'item_mismatch',
          'assembly_backlog',
          'no_waiter_available',
          'handover_delay',
        ].includes(ticket.reason_code))
    ) {
      recipients.add(u.id);
    }

    if (
      u.role_code === 'hall_supervisor' &&
      (ticket.target_department === 'hall' ||
        ticket.sender_department === 'hall' ||
        ['assembly_backlog', 'no_waiter_available', 'handover_delay'].includes(ticket.reason_code))
    ) {
      recipients.add(u.id);
    }

    if (ticket.created_via_support && u.id === ticket.created_by_user_id && u.id !== excludeUserId) {
      recipients.add(u.id);
    }
  }

  return Array.from(recipients);
}

export function buildArabicSpokenAlert(params: {
  prefix: string;
  ticket: TicketSummary;
  extraNotes?: string;
}): string {
  const urgencyLabel = URGENCY_LABELS[params.ticket.urgency_level || 'normal'];
  const reasonLabel = REASON_LABELS[params.ticket.reason_code] || params.ticket.reason_code;
  const senderLabel = DEPARTMENT_LABELS[params.ticket.sender_department] || params.ticket.sender_department;
  const targetLabel = DEPARTMENT_LABELS[params.ticket.target_department] || params.ticket.target_department;
  const parts = [
    params.prefix,
    `من ${senderLabel} إلى ${targetLabel}`,
    `فاتورة رقم ${params.ticket.invoice_number}`,
    `رقم المتابعة ${params.ticket.ticket_number}`,
    `الصنف المتعثر ${params.ticket.item_name}`,
    `الكمية ${params.ticket.quantity}`,
    `السبب ${reasonLabel}`,
    `مستوى الاستعجال ${urgencyLabel}`,
  ];
  const note = params.extraNotes || params.ticket.problem_description;
  if (note && note.trim()) {
    parts.push(`الملاحظات: ${note.trim()}`);
  }
  return parts.join('، ');
}

export function createNotificationsForTicket(
  db: Database.Database,
  ticket: TicketSummary,
  eventType: string,
  title: string,
  body: string,
  excludeUserId?: number,
  extraTargetRole?: string,
  options?: DispatchNotificationOptions
): NotificationItem[] {
  const userIds = getRecipientUserIdsForTicket(db, ticket, excludeUserId, extraTargetRole, options);
  const audioTargetDept = options?.audioTargetDepartment ?? null;
  const senderDept = options?.senderDepartment ?? null;
  const baseUid = options?.messageUid || `${eventType}-${ticket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const spokenText = options?.spokenText || `${title}. ${body}`;
  const urgencyLevel = options?.urgencyLevel || ticket.urgency_level || 'normal';

  const userRows = db
    .prepare(`SELECT u.id, d.code AS dept_code FROM users u JOIN departments d ON d.id = u.department_id`)
    .all() as Array<{ id: number; dept_code: DepartmentCode }>;
  const deptByUser = new Map<number, DepartmentCode>(userRows.map((r) => [r.id, r.dept_code]));

  const insert = db.prepare(`
    INSERT INTO notifications (
      user_id, ticket_id, title, body, event_type,
      target_department, sender_department_code, message_uid, should_play_audio, spoken_text, urgency_level, is_test, is_read
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const created: NotificationItem[] = [];
  const nowIso = new Date().toISOString();
  const isTestInt = (options?.isTest !== undefined ? options.isTest : ticket.is_test) ? 1 : 0;

  for (const uid of userIds) {
    const recipientDept = deptByUser.get(uid) || null;
    const isReceivingAudioStation =
      (Boolean(audioTargetDept) &&
        recipientDept === audioTargetDept &&
        recipientDept !== senderDept) ||
      eventType === 'escalated' ||
      (eventType === 'unreceived_reminder' && recipientDept === ticket.target_department);

    const perUserTargetDept = isReceivingAudioStation && audioTargetDept ? audioTargetDept : recipientDept;
    const res = insert.run(
      uid,
      ticket.id,
      title,
      body,
      eventType,
      perUserTargetDept,
      senderDept,
      baseUid,
      isReceivingAudioStation ? 1 : 0,
      spokenText,
      urgencyLevel,
      isTestInt
    );
    const isEscalatedEvent = eventType === 'escalated' || eventType === 'unreceived_reminder';
    const resolvedSenderCode = isEscalatedEvent
      ? senderDept || null
      : senderDept || ticket.sender_department;
    created.push({
      id: Number(res.lastInsertRowid),
      user_id: uid,
      ticket_id: ticket.id,
      ticket_number: ticket.ticket_number,
      invoice_number: ticket.invoice_number,
      item_name: ticket.item_name,
      sender_department: isEscalatedEvent
        ? senderDept
          ? DEPARTMENT_LABELS[senderDept] || senderDept
          : 'النظام الآلي'
        : resolvedSenderCode
          ? DEPARTMENT_LABELS[resolvedSenderCode] || resolvedSenderCode
          : null,
      sender_department_code: resolvedSenderCode,
      target_department: perUserTargetDept,
      message_uid: baseUid,
      should_play_audio: isReceivingAudioStation,
      spoken_text: spokenText,
      urgency_level: urgencyLevel,
      delivered_at: null,
      read_at: null,
      reason_code: ticket.reason_code,
      title,
      body,
      event_type: eventType,
      is_read: false,
      is_test: isTestInt === 1,
      created_at: nowIso,
    });
  }
  return created;
}

export function createDirectNotificationsForDepartment(
  db: Database.Database,
  params: {
    ticketId: number | null;
    trackingNumber: string;
    invoiceNumber: string;
    itemName?: string | null;
    senderDepartment: DepartmentCode;
    recipientDepartment: DepartmentCode;
    eventType: string;
    title: string;
    body: string;
    spokenText: string;
    messageUid: string;
    urgencyLevel?: UrgencyLevel;
    excludeUserId?: number;
    isTest?: boolean;
  }
): { recipientIds: number[]; notifications: NotificationItem[] } {
  const isTestInt = params.isTest ? 1 : 0;
  const users = db
    .prepare(`
      SELECT u.id, d.code AS dept_code
      FROM users u
      JOIN roles r ON r.id = u.role_id
      JOIN departments d ON d.id = u.department_id
      WHERE u.is_active = 1 AND r.code != 'waiter' AND d.code = ? AND COALESCE(u.is_test_account, 0) = ?
    `)
    .all(params.recipientDepartment, isTestInt) as Array<{ id: number; dept_code: DepartmentCode }>;

  const insert = db.prepare(`
    INSERT INTO notifications (
      user_id, ticket_id, title, body, event_type,
      target_department, sender_department_code, message_uid, should_play_audio, spoken_text, urgency_level, is_test, is_read
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0)
  `);

  const nowIso = new Date().toISOString();
  const recipientIds: number[] = [];
  const notifications: NotificationItem[] = [];

  for (const u of users) {
    if (u.id === params.excludeUserId) continue;
    if (u.dept_code === params.senderDepartment) continue;

    const res = insert.run(
      u.id,
      params.ticketId,
      params.title,
      params.body,
      params.eventType,
      params.recipientDepartment,
      params.senderDepartment,
      params.messageUid,
      params.spokenText,
      params.urgencyLevel || 'normal',
      isTestInt
    );

    recipientIds.push(u.id);
    notifications.push({
      id: Number(res.lastInsertRowid),
      user_id: u.id,
      ticket_id: params.ticketId,
      ticket_number: params.trackingNumber,
      invoice_number: params.invoiceNumber,
      item_name: params.itemName || null,
      sender_department: DEPARTMENT_LABELS[params.senderDepartment] || params.senderDepartment,
      sender_department_code: params.senderDepartment,
      target_department: params.recipientDepartment,
      message_uid: params.messageUid,
      should_play_audio: true,
      spoken_text: params.spokenText,
      urgency_level: params.urgencyLevel || 'normal',
      delivered_at: null,
      read_at: null,
      title: params.title,
      body: params.body,
      event_type: params.eventType,
      is_read: false,
      is_test: isTestInt === 1,
      created_at: nowIso,
    });
  }

  return { recipientIds, notifications };
}

export function getResponsibleAssignments(db: Database.Database): ResponsibleAssignment[] {
  const rows = db
    .prepare(`
      SELECT role_key, role_title_ar, assigned_person_name, updated_by_user_id, updated_by_name, updated_at
      FROM responsible_assignments
      ORDER BY CASE role_key
        WHEN 'production' THEN 1
        WHEN 'assembly' THEN 2
        WHEN 'hall_supervisor' THEN 3
        WHEN 'admin' THEN 4
        ELSE 5
      END
    `)
    .all() as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    role_key: r.role_key as ResponsibleRoleKey,
    role_title_ar: String(r.role_title_ar),
    assigned_person_name: String(r.assigned_person_name),
    updated_by_user_id: r.updated_by_user_id ? Number(r.updated_by_user_id) : null,
    updated_by_name: r.updated_by_name ? String(r.updated_by_name) : null,
    updated_at: String(r.updated_at),
  }));
}

export function getResponsibleMap(db: Database.Database): Record<ResponsibleRoleKey, ResponsibleAssignment> {
  const list = getResponsibleAssignments(db);
  const map: Partial<Record<ResponsibleRoleKey, ResponsibleAssignment>> = {};
  for (const item of list) {
    map[item.role_key] = item;
  }
  const fallback = (key: ResponsibleRoleKey, title: string, name: string): ResponsibleAssignment => ({
    role_key: key,
    role_title_ar: title,
    assigned_person_name: name,
    updated_by_user_id: null,
    updated_by_name: null,
    updated_at: new Date().toISOString(),
  });
  return {
    production: map.production || fallback('production', 'مسؤول الإنتاج', 'محمد الصنعاني'),
    assembly: map.assembly || fallback('assembly', 'مسؤول التجميع والتسليم', 'أحمد المقطري'),
    hall_supervisor: map.hall_supervisor || fallback('hall_supervisor', 'مسؤول الصالة', 'سالم الحضرمي'),
    admin: map.admin || fallback('admin', 'مدير النظام', 'م. فيصل الخولاني'),
  };
}

export function getResponsibleLabelForDepartment(
  map: Record<ResponsibleRoleKey, ResponsibleAssignment>,
  dept: DepartmentCode
): string {
  if (dept === 'production') return `${map.production.role_title_ar}: ${map.production.assigned_person_name}`;
  if (dept === 'assembly') return `${map.assembly.role_title_ar}: ${map.assembly.assigned_person_name}`;
  if (dept === 'hall') return `${map.hall_supervisor.role_title_ar}: ${map.hall_supervisor.assigned_person_name}`;
  return `${map.admin.role_title_ar}: ${map.admin.assigned_person_name}`;
}

export function logUserActivity(
  db: Database.Database,
  user: UserProfile,
  action: string,
  entityType: string,
  entityId: number | null,
  details: string,
  extra?: { oldValue?: unknown; newValue?: unknown; status?: 'success' | 'failed' }
) {
  const oldStr =
    extra?.oldValue === undefined
      ? null
      : typeof extra.oldValue === 'string'
        ? extra.oldValue
        : JSON.stringify(extra.oldValue);
  const newStr =
    extra?.newValue === undefined
      ? null
      : typeof extra.newValue === 'string'
        ? extra.newValue
        : JSON.stringify(extra.newValue);

  db.prepare(`
    INSERT INTO user_activity_logs (
      user_id, username, actor_name, department_code, department_name_ar, status, is_test,
      action, entity_type, entity_id, old_value, new_value, details
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    user.id,
    user.username,
    user.full_name,
    user.department_code,
    user.department_name_ar,
    extra?.status || 'success',
    user.is_test_account ? 1 : 0,
    action,
    entityType,
    entityId,
    oldStr,
    newStr,
    details
  );
}

export function runEscalationSweep(
  db: Database.Database,
  onNotifications?: (
    notifications: NotificationItem[],
    ticket: TicketSummary,
    eventType?: 'ticket_escalated' | 'ticket_unreceived_reminder'
  ) => void
): number {
  const settings = db.prepare('SELECT * FROM escalation_settings WHERE id = 1').get() as EscalationSettings | undefined;
  if (!settings) return 0;

  const responsibleMap = getResponsibleMap(db);
  const openTickets = fetchTicketSummaries(db).filter((t) => t.status !== 'closed');
  let escalatedCount = 0;
  const nowIso = new Date().toISOString();

  for (const ticket of openTickets) {
    const elapsed = ticket.stall_minutes;

    // 1. Delayed Unacknowledged Receipt Reminder («إذا لم يتم تأكيد استلام البلاغ خلال المدة المحددة»)
    if (!ticket.received_at && elapsed >= settings.first_warning_minutes) {
      const reminderCount = Number(ticket.unreceived_reminder_count || 0);
      const lastRemMs = ticket.last_reminder_at ? new Date(ticket.last_reminder_at).getTime() : 0;
      const minsSinceRem = lastRemMs ? (Date.now() - lastRemMs) / 60000 : Infinity;

      if (reminderCount < 5 && (reminderCount === 0 || minsSinceRem >= Math.max(2, settings.repeat_interval_minutes))) {
        const nextRemCount = reminderCount + 1;
        const messageUid = `unreceived-reminder-${ticket.id}-R${nextRemCount}`;
        const alreadySent = db.prepare('SELECT id FROM notifications WHERE message_uid = ? LIMIT 1').get(messageUid);

        if (!alreadySent) {
          const remUpd = db
            .prepare(`
              UPDATE tickets
              SET unreceived_reminder_count = ?, last_reminder_at = ?, updated_at = ?
              WHERE id = ? AND received_at IS NULL AND unreceived_reminder_count = ?
            `)
            .run(nextRemCount, nowIso, nowIso, ticket.id, reminderCount);

          if (remUpd.changes === 1) {
            const adminRow = db
              .prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' LIMIT 1`)
              .get() as { id: number } | undefined;
            const actorId = adminRow ? adminRow.id : ticket.created_by_user_id;
            const targetLabel = DEPARTMENT_LABELS[ticket.target_department] || ticket.target_department;

            db.prepare(`
              INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
              VALUES (?, ?, 'النظام الآلي', 'الإدارة والتشغيل', 'unreceived_reminder', ?, ?, ?, ?)
            `).run(
              ticket.id,
              actorId,
              ticket.status,
              ticket.status,
              `تذكير رقم ${nextRemCount}: لم يتم تأكيد استلام البلاغ ${ticket.ticket_number} في ${targetLabel} رغم مرور ${elapsed} دقيقة`,
              nowIso
            );

            const remTicket = {
              ...ticket,
              unreceived_reminder_count: nextRemCount,
              last_reminder_at: nowIso,
              is_overdue_unreceived: true,
            };
            const remNotifs = createNotificationsForTicket(
              db,
              remTicket,
              'unreceived_reminder',
              `تذكير: البلاغ ${ticket.ticket_number} لم يُستلم بعد — فاتورة ${ticket.invoice_number}`,
              `موجّه إلى ${targetLabel}: الصنف ${ticket.item_name} بانتظار تأكيد الاستلام منذ ${elapsed} دقيقة`,
              undefined,
              undefined,
              {
                audioTargetDepartment: ticket.target_department,
                messageUid,
                spokenText: `تذكير عاجل، لم يتم تأكيد استلام البلاغ رقم ${ticket.ticket_number}، فاتورة رقم ${ticket.invoice_number}، الصنف ${ticket.item_name}، الموجه إلى ${targetLabel}، منذ ${elapsed} دقيقة.`,
                urgencyLevel: 'urgent',
                isTest: ticket.is_test,
              }
            );
            if (onNotifications) onNotifications(remNotifs, remTicket, 'ticket_unreceived_reminder');
          }
        }
      }
    }

    // 2. Formal Escalation Sweep
    if (
      elapsed >= settings.escalation_start_minutes &&
      ticket.escalation_level < settings.max_escalations
    ) {
      const lastEscMs = ticket.last_escalated_at ? new Date(ticket.last_escalated_at).getTime() : 0;
      const minsSinceLastEsc = lastEscMs ? (Date.now() - lastEscMs) / 60000 : Infinity;

      if (ticket.escalation_level === 0 || minsSinceLastEsc >= settings.repeat_interval_minutes) {
        const currentLevel = ticket.escalation_level;
        const nextLevel = currentLevel + 1;
        const messageUid = `escalated-${ticket.id}-L${nextLevel}`;

        // Guard against duplicate escalation alerts for the exact same ticket and level
        const alreadyNotified = db
          .prepare('SELECT id FROM notifications WHERE message_uid = ? LIMIT 1')
          .get(messageUid);
        if (alreadyNotified) continue;

        const updateRes = db
          .prepare(`
            UPDATE tickets
            SET escalation_level = ?, last_escalated_at = ?, updated_at = ?
            WHERE id = ? AND escalation_level = ?
          `)
          .run(nextLevel, nowIso, nowIso, ticket.id, currentLevel);

        if (updateRes.changes !== 1) continue;

        const adminRow = db.prepare(`SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'admin' LIMIT 1`).get() as
          | { id: number }
          | undefined;
        const actorId = adminRow ? adminRow.id : ticket.created_by_user_id;

        const deptRespLabel = getResponsibleLabelForDepartment(responsibleMap, ticket.target_department);
        const targetRespKey: ResponsibleRoleKey =
          settings.escalation_target_role === 'hall_supervisor'
            ? 'hall_supervisor'
            : settings.escalation_target_role === 'assembly'
              ? 'assembly'
              : settings.escalation_target_role === 'production'
                ? 'production'
                : 'admin';
        const escTargetResp = responsibleMap[targetRespKey];

        db.prepare(`
          INSERT INTO ticket_events (ticket_id, actor_user_id, actor_name, actor_department, event_type, from_status, to_status, note, created_at)
          VALUES (?, ?, 'النظام الآلي', 'الإدارة والتشغيل', 'escalated', ?, ?, ?, ?)
        `).run(
          ticket.id,
          actorId,
          ticket.status,
          ticket.status,
          `تصعيد تلقائي (المستوى ${nextLevel}) — ${ticket.ticket_number} — وقت حدوث التعثر: ${ticket.created_at} — وقت التصعيد الفعلي: ${nowIso} — مدة التعثر ${elapsed} دقيقة — ${deptRespLabel} — المصعد إليه: ${escTargetResp.role_title_ar} (${escTargetResp.assigned_person_name})`,
          nowIso
        );

        const updatedTicket = { ...ticket, escalation_level: nextLevel, last_escalated_at: nowIso };
        const notifs = createNotificationsForTicket(
          db,
          updatedTicket,
          'escalated',
          `تصعيد مستوى ${nextLevel} (${ticket.ticket_number}) — فاتورة ${ticket.invoice_number}`,
          `${ticket.item_name} (${REASON_LABELS[ticket.reason_code]}) متأخر منذ ${elapsed} دقيقة · ${deptRespLabel} · موجّه إلى ${escTargetResp.role_title_ar}: ${escTargetResp.assigned_person_name}`,
          undefined,
          settings.escalation_target_role,
          {
            messageUid,
            spokenText: `تنبيه تصعيد مستوى ${nextLevel}، رقم المتابعة ${ticket.ticket_number}، فاتورة رقم ${ticket.invoice_number}، الصنف ${ticket.item_name}، متأخر منذ ${elapsed} دقيقة، المسؤول المعني ${deptRespLabel}، تصعيد إلى ${escTargetResp.assigned_person_name}.`,
            urgencyLevel: 'critical',
            isTest: ticket.is_test,
          }
        );
        if (onNotifications) onNotifications(notifs, updatedTicket, 'ticket_escalated');
        escalatedCount++;
      }
    }
  }

  return escalatedCount;
}

export function getStatusLabelAr(status: TicketStatus): string {
  return STATUS_LABELS[status] || status;
}
