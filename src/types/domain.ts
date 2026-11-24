export type DepartmentCode = 'assembly' | 'production' | 'hall' | 'waiters' | 'management';

export type RoleCode = 'assembly' | 'production' | 'hall_supervisor' | 'waiter' | 'admin';

export type UrgencyLevel = 'normal' | 'urgent' | 'critical';

export type TicketKind = 'stall' | 'backlog' | 'inquiry';

export type InquiryStatusCode = 1 | 2 | 3 | 4 | 5 | 6;

export type MessageType = 'inquiry' | 'inquiry_reply' | 'backlog_update' | 'general';

export type TicketStatus =
  | 'new'
  | 'received'
  | 'in_progress'
  | 'awaiting_other_dept'
  | 'action_taken_awaiting_confirm'
  | 'arrived_assembly'
  | 'ready_for_hall'
  | 'closed'
  | 'reopened';

export type ReasonCode =
  | 'production_delay'
  | 'dispatched_not_arrived'
  | 'item_shortage'
  | 'item_mismatch'
  | 'assembly_backlog'
  | 'no_waiter_available'
  | 'handover_delay'
  | 'other';

export interface UserProfile {
  id: number;
  full_name: string;
  username: string;
  email: string | null;
  role_code: RoleCode;
  role_name_ar: string;
  department_code: DepartmentCode;
  department_name_ar: string;
  is_active: boolean;
  is_test_account?: boolean;
  permissions: string[];
  role_permissions?: string[];
  explicit_permissions?: Record<string, boolean>;
  has_assembly_support: boolean;
}

export interface TicketReadRecord {
  id: number;
  ticket_id: number;
  user_id: number;
  user_name: string;
  department_code: DepartmentCode;
  department_name_ar: string;
  read_at: string;
}

export interface TicketItem {
  id: number;
  ticket_id: number;
  item_name: string;
  quantity: number;
  expected_qty: number | null;
  delivered_qty: number | null;
  issue_note: string | null;
  arrival_confirmed: boolean;
  arrival_confirmed_by_name?: string | null;
  arrival_confirmed_at: string | null;
  order_completed: boolean;
  order_completed_by_name?: string | null;
  order_completed_at: string | null;
}

export interface TicketEvent {
  id: number;
  ticket_id: number;
  actor_user_id: number;
  actor_name: string;
  actor_department: string;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  created_at: string;
}

export interface TicketReply {
  id: number;
  ticket_id: number;
  user_id: number;
  author_name: string;
  author_department: string;
  sender_department?: DepartmentCode | null;
  recipient_department?: DepartmentCode | null;
  message: string;
  created_at: string;
}

export interface DepartmentMessageRecord {
  id: number;
  ticket_id: number | null;
  tracking_number: string;
  invoice_number: string;
  message_type: MessageType;
  canned_status_code: InquiryStatusCode | null;
  canned_status_label: string | null;
  sender_department: DepartmentCode;
  recipient_department: DepartmentCode;
  sender_user_id: number;
  sender_name: string;
  message_body: string;
  notes: string | null;
  parent_message_id: number | null;
  sent_at: string;
  sent_status: 'sent';
  received_at: string | null;
  received_by_name: string | null;
  read_at: string | null;
  read_by_name: string | null;
}

export interface TicketActionRecord {
  id: number;
  ticket_id: number;
  user_id: number;
  actor_name: string;
  action_type: string;
  action_note: string;
  created_at: string;
}

export interface TicketTransferRecord {
  id: number;
  ticket_id: number;
  from_department: DepartmentCode;
  to_department: DepartmentCode;
  transferred_by_name: string;
  reason: string;
  created_at: string;
}

export interface DepartmentWaitMinutes {
  production: number;
  assembly: number;
  hall: number;
}

export interface TicketSummary {
  id: number;
  ticket_number: string;
  invoice_number: string;
  item_name: string;
  quantity: number;
  reason_code: ReasonCode;
  urgency_level: UrgencyLevel;
  ticket_kind: TicketKind;
  problem_description: string;
  target_department: DepartmentCode;
  sender_department: DepartmentCode;
  created_by_user_id: number;
  created_by_name: string;
  assigned_waiter_id: number | null;
  assigned_waiter_name: string | null;
  status: TicketStatus;
  created_via_support: boolean;
  parent_ticket_id: number | null;
  escalation_level: number;
  last_escalated_at: string | null;
  delivered_to_dept_at?: string | null;
  delivered_to_dept_via?: string | null;
  first_read_at?: string | null;
  first_read_by_name?: string | null;
  first_read_department?: string | null;
  received_at: string | null;
  received_by_name: string | null;
  unreceived_reminder_count?: number;
  last_reminder_at?: string | null;
  is_overdue_unreceived?: boolean;
  is_test?: boolean;
  processing_started_at: string | null;
  prepared_at: string | null;
  action_taken_at: string | null;
  arrival_confirmed: boolean;
  arrival_confirmed_at: string | null;
  arrival_confirmed_by_name?: string | null;
  order_completed: boolean;
  order_completed_at: string | null;
  dispatched_to_hall_at: string | null;
  hall_received_at: string | null;
  hall_received_by_name: string | null;
  backlog_orders_count: number;
  backlog_invoices: string[];
  waiter_received_at: string | null;
  waiter_delivered_at: string | null;
  closed_at: string | null;
  closed_by_name: string | null;
  reopened_count: number;
  created_at: string;
  updated_at: string;
  stall_minutes: number;
  department_wait_minutes: DepartmentWaitMinutes;
  transfer_departments?: DepartmentCode[];
}

export interface TicketDetail extends TicketSummary {
  items: TicketItem[];
  replies: TicketReply[];
  messages: DepartmentMessageRecord[];
  actions: TicketActionRecord[];
  transfers: TicketTransferRecord[];
  events: TicketEvent[];
  reads?: TicketReadRecord[];
  can_close: boolean;
  close_block_reason: string | null;
}

export interface NotificationItem {
  id: number;
  user_id: number;
  ticket_id: number | null;
  ticket_number?: string | null;
  invoice_number?: string | null;
  item_name?: string | null;
  sender_department?: string | null;
  sender_department_code?: DepartmentCode | null;
  target_department?: DepartmentCode | null;
  message_uid?: string | null;
  should_play_audio?: boolean;
  spoken_text?: string | null;
  urgency_level?: UrgencyLevel | null;
  delivered_at?: string | null;
  read_at?: string | null;
  reason_code?: string | null;
  title: string;
  body: string;
  event_type: string;
  is_read: boolean;
  is_test?: boolean;
  created_at: string;
}

export type StationCode =
  | 'production'
  | 'assembly'
  | 'hall'
  | 'delayed_critical'
  | 'escalation'
  | 'general';

export const ALL_STATION_CODES: StationCode[] = [
  'production',
  'assembly',
  'hall',
  'delayed_critical',
  'escalation',
  'general',
];

export const STATION_CHANNEL_LABELS: Record<StationCode, string> = {
  production: 'صوت تنبيهات قسم الإنتاج',
  assembly: 'صوت تنبيهات قسم التجميع والتسليم',
  hall: 'صوت تنبيهات مسؤول الصالة',
  delayed_critical: 'صوت التنبيهات الحرجة والطلبات المتعثرة',
  escalation: 'صوت التصعيد التلقائي',
  general: 'صوت الإشعارات العامة',
};

export const PLAYBACK_RATE_OPTIONS = [0.75, 1, 1.25, 1.5, 2] as const;
export type PlaybackRateOption = (typeof PLAYBACK_RATE_OPTIONS)[number];

export interface AudioFileRecord {
  id: number;
  display_name: string;
  original_name: string;
  stored_filename: string;
  mime_type: string;
  size_bytes: number;
  source_type: 'upload' | 'ai_tts';
  file_category?: 'alert_tone' | 'human_voice';
  is_default: boolean;
  uploaded_by_user_id: number;
  uploaded_by_name?: string;
  used_by_stations?: StationCode[];
  stream_url: string;
  created_at: string;
  updated_at?: string;
}

export interface StationAudioSetting {
  station_code: StationCode;
  station_name_ar: string;
  audio_file_id: number | null;
  audio_file_name?: string | null;
  audio_file_url?: string | null;
  resolved_audio_file_id?: number | null;
  resolved_audio_file_name?: string | null;
  resolved_audio_file_url?: string | null;
  uses_default_fallback?: boolean;
  playback_rate: number;
  volume_percent: number;
  is_enabled: boolean;
  speak_text_enabled: boolean;
  updated_at: string;
}

export type VoiceKind = 'ai_human' | 'recorded_human' | 'browser_human';

export type VoiceReaderChannelCode = 'production' | 'assembly' | 'hall' | 'escalation' | 'general';

export const ALL_VOICE_READER_CHANNELS: VoiceReaderChannelCode[] = [
  'production',
  'assembly',
  'hall',
  'escalation',
  'general',
];

export const VOICE_READER_CHANNEL_LABELS: Record<VoiceReaderChannelCode, string> = {
  production: 'صوت قراءة بلاغات الإنتاج',
  assembly: 'صوت قراءة بلاغات التجميع',
  hall: 'صوت قراءة بلاغات مسؤول الصالة',
  escalation: 'صوت قراءة التنبيهات والتصعيدات',
  general: 'صوت قراءة الإشعارات العامة',
};

export type VoiceReadScope = 'all' | 'important_only';

export const GEMINI_PREBUILT_VOICES = [
  { id: 'Kore', label_ar: 'نورة — صوت نسائي رسمي واضح', gender: 'female' as const },
  { id: 'Charon', label_ar: 'سلمان — صوت رجالي جهوري متزن', gender: 'male' as const },
  { id: 'Aoede', label_ar: 'سارة — صوت نسائي هادئ وسلس', gender: 'female' as const },
  { id: 'Fenrir', label_ar: 'طارق — صوت رجالي حازم للتنبيهات', gender: 'male' as const },
  { id: 'Puck', label_ar: 'راشد — صوت رجالي نشيط وسريع', gender: 'male' as const },
  { id: 'Orus', label_ar: 'فيصل — صوت رجالي عميق رسمي', gender: 'male' as const },
  { id: 'Leda', label_ar: 'ليلى — صوت نسائي دافئ وواضح', gender: 'female' as const },
  { id: 'Zephyr', label_ar: 'ريم — صوت نسائي مشرق وسريع الفهم', gender: 'female' as const },
] as const;

export interface HumanVoiceRecord {
  id: number;
  voice_key: string | null;
  display_name: string;
  description: string | null;
  gender: 'female' | 'male';
  voice_kind: VoiceKind;
  prebuilt_voice_name: string | null;
  style_prompt: string | null;
  audio_file_id: number | null;
  audio_file_url: string | null;
  is_favorite: boolean;
  is_default: boolean;
  is_system: boolean;
  used_by_channels?: VoiceReaderChannelCode[];
  created_by_user_id: number | null;
  created_by_name?: string | null;
  created_at: string;
  updated_at?: string;
}

export interface VoiceReaderSetting {
  channel_code: VoiceReaderChannelCode;
  channel_name_ar: string;
  human_voice_id: number | null;
  human_voice_name?: string | null;
  human_voice_kind?: VoiceKind | null;
  resolved_human_voice_id?: number | null;
  resolved_human_voice_name?: string | null;
  resolved_human_voice_kind?: VoiceKind | null;
  resolved_prebuilt_voice_name?: string | null;
  resolved_style_prompt?: string | null;
  resolved_audio_file_url?: string | null;
  uses_default_fallback?: boolean;
  is_enabled: boolean;
  playback_rate: number;
  volume_percent: number;
  read_scope: VoiceReadScope;
  include_sender_dept: boolean;
  updated_at: string;
}

export type PlaybackDiagnosticStatus = 'requested' | 'started' | 'completed' | 'blocked' | 'failed';

export interface AudioDiagnosticRecord {
  id: number;
  client_diag_uid: string;
  notification_id: number | null;
  ticket_id: number | null;
  ticket_number: string | null;
  invoice_number: string | null;
  target_department: string | null;
  channel_code: string | null;
  selected_voice_id: number | null;
  selected_voice_name: string | null;
  selected_prebuilt_voice: string | null;
  selected_tone_name: string | null;
  event_type: string | null;
  spoken_text: string | null;
  alert_arrived_at: string;
  playback_requested: boolean;
  playback_started: boolean;
  playback_completed: boolean;
  playback_status: PlaybackDiagnosticStatus;
  tts_engine: string | null;
  failure_reason: string | null;
  user_id: number | null;
  user_name: string | null;
  is_test: boolean;
  created_at: string;
  updated_at: string;
}

export type ResponsibleRoleKey = 'production' | 'assembly' | 'hall_supervisor' | 'admin';

export interface ResponsibleAssignment {
  role_key: ResponsibleRoleKey;
  role_title_ar: string;
  assigned_person_name: string;
  updated_by_user_id: number | null;
  updated_by_name: string | null;
  updated_at: string;
}

export interface AuditLogEntry {
  id: number;
  user_id: number | null;
  username: string | null;
  actor_name: string | null;
  department_code?: string | null;
  department_name_ar?: string | null;
  status?: 'success' | 'failed';
  action: string;
  entity_type: string;
  entity_id: number | null;
  old_value: string | null;
  new_value: string | null;
  details: string | null;
  created_at: string;
}

export interface GranularPermissionMeta {
  code: string;
  label_ar: string;
  category: 'admin' | 'audio';
}

export const GRANULAR_PERMISSIONS: GranularPermissionMeta[] = [
  { code: 'manage_responsibles', label_ar: 'تعديل أسماء المسؤولين وتغيير المكلفين بالمسؤوليات', category: 'admin' },
  { code: 'manage_roles', label_ar: 'إدارة الأدوار والمسميات الوظيفية', category: 'admin' },
  { code: 'manage_stall_threshold', label_ar: 'إدارة مدة تعثر الطلبات', category: 'admin' },
  { code: 'manage_escalation_timing', label_ar: 'إدارة زمن التصعيد التلقائي', category: 'admin' },
  { code: 'audio_add', label_ar: 'إضافة أصوات جديدة (بما فيها الصوت الذكي)', category: 'audio' },
  { code: 'audio_upload', label_ar: 'رفع ملفات صوتية من الجهاز', category: 'audio' },
  { code: 'audio_test', label_ar: 'تجربة الأصوات ومقارنتها', category: 'audio' },
  { code: 'audio_set_default', label_ar: 'اختيار الصوت الافتراضي للنظام', category: 'audio' },
  { code: 'audio_assign', label_ar: 'تخصيص الأصوات للأقسام والتنبيهات', category: 'audio' },
  { code: 'audio_delete', label_ar: 'حذف الأصوات وتعديلها واستبدالها', category: 'audio' },
  { code: 'audio_volume', label_ar: 'التحكم في مستوى الصوت وإعداداته', category: 'audio' },
];

export const AUDIO_PERMISSION_CODES = [
  'audio_add',
  'audio_upload',
  'audio_test',
  'audio_set_default',
  'audio_assign',
  'audio_delete',
  'audio_volume',
] as const;

export interface EscalationSettings {
  id: number;
  first_warning_minutes: number;
  escalation_start_minutes: number;
  escalation_target_role: RoleCode;
  repeat_interval_minutes: number;
  max_escalations: number;
  updated_at: string;
}

export const ACTIVE_OPERATIONAL_DEPARTMENTS: DepartmentCode[] = ['production', 'assembly', 'hall'];
export const ACTIVE_USER_ROLES: RoleCode[] = ['assembly', 'production', 'hall_supervisor', 'admin'];
export const ACTIVE_USER_DEPARTMENTS: DepartmentCode[] = ['assembly', 'production', 'hall', 'management'];

export const DEPARTMENT_LABELS: Record<DepartmentCode, string> = {
  assembly: 'قسم التجميع',
  production: 'قسم الإنتاج',
  hall: 'إدارة الصالة',
  waiters: 'قسم المباشرين (ملغى)',
  management: 'الإدارة والتشغيل',
};

export const ROLE_LABELS: Record<RoleCode, string> = {
  assembly: 'مسؤول التجميع والتسليم',
  production: 'مسؤول الإنتاج',
  hall_supervisor: 'مسؤول الصالة',
  waiter: 'مباشر صالة',
  admin: 'مدير النظام',
};

export const URGENCY_LABELS: Record<UrgencyLevel, string> = {
  normal: 'عادي',
  urgent: 'عاجل',
  critical: 'حرج جداً',
};

export const TICKET_KIND_LABELS: Record<TicketKind, string> = {
  stall: 'بلاغ تعثر',
  backlog: 'بلاغ تراكم الطلبات',
  inquiry: 'استفسار مباشر',
};

export const INQUIRY_CANNED_STATUSES: Record<InquiryStatusCode, string> = {
  1: 'الصنف موجود وجارٍ تجهيزه',
  2: 'الطلب جاهز وفي الطريق إلى الصالة',
  3: 'الطلب متعثر في الإنتاج',
  4: 'الصنف غير متوفر',
  5: 'نحتاج إلى توضيح إضافي',
  6: 'رد كتابي',
};

export const STATUS_LABELS: Record<TicketStatus, string> = {
  new: 'بانتظار تأكيد الاستلام',
  received: 'تم تأكيد الاستلام – جارٍ المعالجة',
  in_progress: 'تم تأكيد الاستلام – جارٍ المعالجة',
  awaiting_other_dept: 'محول / بانتظار قسم آخر',
  action_taken_awaiting_confirm: 'تم التجهيز – الطلب في الطريق إلى التجميع',
  arrived_assembly: 'تم استلام الطلب في التجميع',
  ready_for_hall: 'الطلب جاهز – في الطريق إلى الصالة',
  closed: 'مغلق بعد التحقق النهائي',
  reopened: 'أعيد فتحه',
};

export const REASON_LABELS: Record<ReasonCode, string> = {
  production_delay: 'تأخر الإنتاج أو عدم خروج الصنف',
  dispatched_not_arrived: 'الصنف خرج ولم يصل إلى التجميع',
  item_shortage: 'الصنف وصل ناقصاً',
  item_mismatch: 'الصنف وصل غير مطابق',
  assembly_backlog: 'تراكم الطلبات داخل التجميع',
  no_waiter_available: 'الطلب جاهز ويحتاج تسليماً في الصالة',
  handover_delay: 'تأخر تسليم الطلب من التجميع إلى الصالة',
  other: 'سبب آخر',
};

export const DEFAULT_TARGET_DEPT_BY_REASON: Record<ReasonCode, DepartmentCode> = {
  production_delay: 'production',
  dispatched_not_arrived: 'production',
  item_shortage: 'production',
  item_mismatch: 'production',
  assembly_backlog: 'hall',
  no_waiter_available: 'hall',
  handover_delay: 'hall',
  other: 'production',
};

export type BackupTriggerType = 'manual' | 'pre_migration' | 'pre_restore' | 'scheduled' | 'startup';

export interface BackupRecord {
  id: string;
  filename: string;
  file_path: string;
  mirror_path: string | null;
  trigger_type: BackupTriggerType;
  reason: string;
  size_bytes: number;
  sha256: string;
  integrity_status: 'verified' | 'failed';
  integrity_detail: string;
  table_counts: Record<string, number>;
  created_by_user_id: number | null;
  created_by_name: string;
  created_at: string;
  restored_count?: number;
  last_restored_at?: string | null;
  file_exists?: boolean;
}

export interface SystemReadinessReport {
  generated_at: string;
  server: {
    status: 'ok' | 'degraded';
    version: string;
    node_env: string;
    started_at: string;
    uptime_seconds: number;
    timezone: string;
    persistence_mode: 'ephemeral_container_fs' | 'local_disk';
    persistence_notice: string;
  };
  database: {
    engine: string;
    path: string;
    size_bytes: number;
    integrity_check: string;
    counts: {
      users_active: number;
      test_accounts: number;
      production_tickets: number;
      isolated_test_tickets: number;
      audio_files: number;
      human_voices: number;
      audit_logs: number;
    };
  };
  websocket: {
    connected_clients: number;
    connected_departments: string[];
    connected_users: Array<{
      user_id: number;
      username: string;
      full_name: string;
      department_code: string;
    }>;
  };
  tickets_health: {
    new_unopened: number;
    read_awaiting_receipt: number;
    unreceived: number;
    in_progress: number;
    overdue_unreceived: number;
    escalated_open: number;
    closed_total: number;
    avg_response_minutes: number;
  };
  audio_status: {
    gemini_tts_configured: boolean;
    browser_fallback_enabled: boolean;
    station_settings: StationAudioSetting[];
    voice_reader_settings: VoiceReaderSetting[];
  };
  backups: {
    backup_dir: string;
    mirror_dir: string | null;
    total_count: number;
    verified_count: number;
    last_backup: BackupRecord | null;
  };
}
