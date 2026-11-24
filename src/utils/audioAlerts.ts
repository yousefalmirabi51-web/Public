import type {
  DepartmentCode,
  HumanVoiceRecord,
  NotificationItem,
  StationAudioSetting,
  StationCode,
  VoiceKind,
  VoiceReaderChannelCode,
  VoiceReaderSetting,
} from '../types/domain';

export interface AudioAlertSettings {
  voiceEnabled: boolean;
  chimeEnabled: boolean;
  volume: number; // 0.0 to 1.0
  unlocked: boolean;
}

export interface HumanVoicePlaybackOptions {
  humanVoiceId?: number | null;
  voiceName?: string | null;
  stylePrompt?: string | null;
  voiceKind?: VoiceKind | null;
  recordedFileUrl?: string | null;
  channelCode?: VoiceReaderChannelCode | null;
  departmentCode?: DepartmentCode | string | null;
  playbackMode?: 'alert' | 'test';
  cacheBust?: string;
}

export interface AudioAlertPlaybackResult {
  status: 'played' | 'blocked' | 'failed';
  tonePlayed: boolean;
  speechPlayed: boolean;
  speechRequired: boolean;
  ttsEngine?: string | null;
  selectedVoiceName?: string | null;
  failureReason?: string | null;
}

const STORAGE_KEY = 'almazaq_station_audio_settings';
const PLAYED_PREFIX = 'almazaq_played_alerts_u_';
const MAX_STORED_ALERTS = 300;

export function getStationCodeForDepartment(dept?: DepartmentCode | string | null): StationCode {
  if (dept === 'production') return 'production';
  if (dept === 'assembly') return 'assembly';
  if (dept === 'hall') return 'hall';
  return 'general';
}

export function getVoiceReaderChannelForNotification(
  userDept?: DepartmentCode | string | null,
  notif?: Pick<NotificationItem, 'event_type' | 'urgency_level' | 'target_department'> | null
): VoiceReaderChannelCode {
  if (
    notif?.event_type === 'escalated' ||
    notif?.urgency_level === 'critical' ||
    notif?.event_type === 'delayed'
  ) {
    return 'escalation';
  }
  const dept = notif?.target_department || userDept;
  if (dept === 'production') return 'production';
  if (dept === 'assembly') return 'assembly';
  if (dept === 'hall') return 'hall';
  return 'general';
}

export function isImportantNotification(
  notif?: Pick<NotificationItem, 'urgency_level' | 'event_type'> | null
): boolean {
  if (!notif) return true;
  return (
    notif.urgency_level === 'urgent' ||
    notif.urgency_level === 'critical' ||
    notif.event_type === 'escalated' ||
    notif.event_type === 'delayed'
  );
}

export function resolveAudioSettingForNotification(
  settings: StationAudioSetting[],
  userDept?: DepartmentCode | string | null,
  notif?: Pick<NotificationItem, 'event_type' | 'urgency_level' | 'target_department'> | null
): StationAudioSetting | null {
  if (!settings || settings.length === 0) return null;
  const byCode = new Map<StationCode, StationAudioSetting>(settings.map((s) => [s.station_code, s]));

  if (notif?.event_type === 'escalated') {
    const esc = byCode.get('escalation');
    if (esc) return esc;
  }

  if (notif?.urgency_level === 'critical' || notif?.event_type === 'delayed') {
    const critical = byCode.get('delayed_critical');
    if (critical) return critical;
  }

  const deptCode = getStationCodeForDepartment(notif?.target_department || userDept);
  return byCode.get(deptCode) || byCode.get('general') || null;
}

export function resolveVoiceReaderSettingForNotification(
  settings: VoiceReaderSetting[],
  userDept?: DepartmentCode | string | null,
  notif?: Pick<NotificationItem, 'event_type' | 'urgency_level' | 'target_department'> | null
): VoiceReaderSetting | null {
  if (!settings || settings.length === 0) return null;
  const byCode = new Map<VoiceReaderChannelCode, VoiceReaderSetting>(
    settings.map((s) => [s.channel_code, s])
  );
  const targetChannel = getVoiceReaderChannelForNotification(userDept, notif);
  return byCode.get(targetChannel) || byCode.get('general') || null;
}

export function loadAudioSettings(): AudioAlertSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AudioAlertSettings>;
      return {
        voiceEnabled: parsed.voiceEnabled ?? true,
        chimeEnabled: parsed.chimeEnabled ?? true,
        volume: typeof parsed.volume === 'number' ? Math.min(1, Math.max(0, parsed.volume)) : 0.85,
        unlocked: Boolean(parsed.unlocked),
      };
    }
  } catch {
    // ignore storage errors
  }
  return { voiceEnabled: true, chimeEnabled: true, volume: 0.85, unlocked: false };
}

export function saveAudioSettings(settings: AudioAlertSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

let sharedAudioCtx: AudioContext | null = null;
let activeHtmlAudio: HTMLAudioElement | null = null;
let activeBufferSource: AudioBufferSourceNode | null = null;
let activePlaybackStopper: (() => void) | null = null;
let isQueueProcessing = false;
let audioUnlockedState = false;
let audioPlayingState = false;
let playbackAbortGeneration = 0;
const unlockSubscribers = new Set<(unlocked: boolean) => void>();
const playbackSubscribers = new Set<(playing: boolean) => void>();
const audioBufferCache = new Map<string, AudioBuffer>();

function notifyUnlockSubscribers(unlocked: boolean) {
  for (const cb of unlockSubscribers) {
    try {
      cb(unlocked);
    } catch {
      // ignore subscriber errors
    }
  }
}

function setAudioPlayingState(playing: boolean) {
  if (audioPlayingState === playing) return;
  audioPlayingState = playing;
  for (const cb of playbackSubscribers) {
    try {
      cb(playing);
    } catch {
      // ignore subscriber errors
    }
  }
}

export function isStationAudioPlaying(): boolean {
  return audioPlayingState;
}

export function onAudioPlaybackStateChange(cb: (playing: boolean) => void): () => void {
  playbackSubscribers.add(cb);
  return () => {
    playbackSubscribers.delete(cb);
  };
}

export function onAudioUnlockChange(cb: (unlocked: boolean) => void): () => void {
  unlockSubscribers.add(cb);
  return () => {
    unlockSubscribers.delete(cb);
  };
}

export interface QueuedAlertJob {
  userId: number;
  alertKey: string;
  text: string;
  stationSetting?: StationAudioSetting | null;
  voiceReaderSetting?: VoiceReaderSetting | null;
  channelCode?: VoiceReaderChannelCode | null;
  departmentCode?: DepartmentCode | string | null;
  notificationMeta?: Pick<NotificationItem, 'urgency_level' | 'event_type'> | null;
  authToken?: string | null;
  onStarted?: () => void;
  onPlayed?: (alertKey: string, result: AudioAlertPlaybackResult) => void;
  onFailed?: (reason: string, result: AudioAlertPlaybackResult) => void;
  onBlocked?: () => void;
}

const activeQueue: QueuedAlertJob[] = [];
const blockedQueue: QueuedAlertJob[] = [];
const queuedKeySet = new Set<string>();
const failedAttemptExpiryMap = new Map<string, number>();

function getPlayedSet(userId: number): string[] {
  try {
    const raw = localStorage.getItem(`${PLAYED_PREFIX}${userId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function hasAlertBeenPlayed(userId: number, alertKey: string): boolean {
  return getPlayedSet(userId).includes(alertKey);
}

function markAlertAsPlayed(userId: number, alertKey: string) {
  try {
    const existing = getPlayedSet(userId);
    if (existing.includes(alertKey)) return;
    const next = [...existing, alertKey].slice(-MAX_STORED_ALERTS);
    localStorage.setItem(`${PLAYED_PREFIX}${userId}`, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

export async function unlockStationAudio(): Promise<boolean> {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      audioUnlockedState = false;
      notifyUnlockSubscribers(false);
      return false;
    }
  }
  const unlocked = !ctx || ctx.state === 'running';
  audioUnlockedState = unlocked;
  notifyUnlockSubscribers(unlocked);
  if (!unlocked) {
    return false;
  }

  const current = loadAudioSettings();
  saveAudioSettings({ ...current, unlocked: true });

  // Drain any notifications that were queued while browser blocked autoplay
  if (blockedQueue.length > 0) {
    const pending = blockedQueue.splice(0, blockedQueue.length);
    for (const job of pending) {
      activeQueue.push(job);
    }
    void processAlertQueue();
  }
  return true;
}

let unlockListenersAttached = false;
export function setupGlobalAudioUnlock(onUnlock?: () => void) {
  if (typeof window === 'undefined' || unlockListenersAttached) return;
  unlockListenersAttached = true;

  const handler = () => {
    void unlockStationAudio().then((ok) => {
      if (ok && onUnlock) onUnlock();
    });
  };

  window.addEventListener('pointerdown', handler, { passive: true });
  window.addEventListener('keydown', handler, { passive: true });
  window.addEventListener('touchstart', handler, { passive: true });
}

function stopCurrentPlaybackOnly() {
  if (activePlaybackStopper) {
    const stopper = activePlaybackStopper;
    activePlaybackStopper = null;
    try {
      stopper();
    } catch {
      // ignore
    }
  }
  if (activeBufferSource) {
    try {
      activeBufferSource.onended = null;
      activeBufferSource.stop();
      activeBufferSource.disconnect();
    } catch {
      // ignore
    }
    activeBufferSource = null;
  }
  if (activeHtmlAudio) {
    try {
      activeHtmlAudio.pause();
      activeHtmlAudio.currentTime = 0;
    } catch {
      // ignore
    }
    activeHtmlAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignore
    }
  }
}

export function stopAllAudio() {
  playbackAbortGeneration += 1;
  stopCurrentPlaybackOnly();
  setAudioPlayingState(false);
}

export function playSoftChime(volume: number) {
  const ctx = getAudioContext();
  if (!ctx || volume <= 0) return;
  try {
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    const now = ctx.currentTime;
    const notes = [523.25, 659.25];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.14);
      gain.gain.setValueAtTime(0.001, now + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.02, volume * 0.22), now + idx * 0.14 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.14 + 0.42);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.14);
      osc.stop(now + idx * 0.14 + 0.45);
    });
  } catch {
    // ignore audio errors in headless environments
  }
}

function buildAuthenticatedUrl(
  url: string,
  authToken?: string | null,
  cacheBust?: string,
  mode?: 'test' | 'alert'
): string {
  if (!url.startsWith('/api/')) return url;
  const sep = url.includes('?') ? '&' : '?';
  const parts: string[] = [];
  if (mode === 'test' && !url.includes('mode=')) parts.push('mode=test');
  if (authToken) parts.push(`token=${encodeURIComponent(authToken)}`);
  if (cacheBust) parts.push(`v=${encodeURIComponent(cacheBust)}`);
  return parts.length > 0 ? `${url}${sep}${parts.join('&')}` : url;
}

function playHtmlAudioElementUrl(
  playbackUrl: string,
  playbackRate: number,
  volume: number,
  revokeOnFinish?: () => void
): Promise<'played' | 'blocked' | 'stopped' | 'error'> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') {
      revokeOnFinish?.();
      resolve('error');
      return;
    }

    stopCurrentPlaybackOnly();
    setAudioPlayingState(true);
    const audio = new Audio(playbackUrl);
    activeHtmlAudio = audio;
    const clampedRate = Math.min(2.5, Math.max(0.5, playbackRate || 1));
    const clampedVol = Math.min(1, Math.max(0, volume));
    audio.playbackRate = clampedRate;
    audio.volume = clampedVol;

    let settled = false;
    const finish = (outcome: 'played' | 'blocked' | 'stopped' | 'error') => {
      if (settled) return;
      settled = true;
      clearTimeout(safetyTimer);
      if (activeHtmlAudio === audio) {
        activeHtmlAudio = null;
      }
      if (activePlaybackStopper === stopSelf) {
        activePlaybackStopper = null;
      }
      try {
        audio.pause();
      } catch {
        // ignore
      }
      revokeOnFinish?.();
      setAudioPlayingState(false);
      resolve(outcome);
    };

    const stopSelf = () => finish('stopped');
    activePlaybackStopper = stopSelf;

    const safetyTimer = window.setTimeout(() => finish('played'), 45000);

    audio.addEventListener('loadedmetadata', () => {
      audio.playbackRate = clampedRate;
      audio.volume = clampedVol;
    });
    audio.addEventListener('ended', () => finish('played'));
    audio.addEventListener('error', () => finish('error'));

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise
        .then(() => {
          audio.playbackRate = clampedRate;
          audio.volume = clampedVol;
        })
        .catch((err: unknown) => {
          const name = err instanceof Error ? err.name : '';
          if (name === 'NotAllowedError') {
            finish('blocked');
          } else if (name === 'AbortError' && settled) {
            finish('stopped');
          } else {
            finish('error');
          }
        });
    }
  });
}

function playDecodedAudioBuffer(
  ctx: AudioContext,
  buffer: AudioBuffer,
  playbackRate: number,
  volume: number
): Promise<'played' | 'stopped' | 'error'> {
  return new Promise((resolve) => {
    stopCurrentPlaybackOnly();
    const clampedRate = Math.min(2.5, Math.max(0.5, playbackRate || 1));
    const clampedVol = Math.min(1, Math.max(0, volume));
    if (clampedVol <= 0) {
      resolve('played');
      return;
    }

    setAudioPlayingState(true);
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      source.playbackRate.value = clampedRate;
      gain.gain.value = clampedVol;
      source.connect(gain);
      gain.connect(ctx.destination);
      activeBufferSource = source;

      let settled = false;
      const finish = (outcome: 'played' | 'stopped' | 'error') => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        if (activeBufferSource === source) {
          activeBufferSource = null;
        }
        if (activePlaybackStopper === stopSelf) {
          activePlaybackStopper = null;
        }
        try {
          source.onended = null;
          source.disconnect();
          gain.disconnect();
        } catch {
          // ignore
        }
        setAudioPlayingState(false);
        resolve(outcome);
      };

      const stopSelf = () => {
        try {
          source.stop();
        } catch {
          // ignore
        }
        finish('stopped');
      };
      activePlaybackStopper = stopSelf;

      const durationMs = Math.min(
        45000,
        Math.max(1500, Math.ceil((buffer.duration / clampedRate) * 1000) + 1200)
      );
      const safetyTimer = window.setTimeout(() => finish('played'), durationMs);

      source.onended = () => finish('played');
      source.start(0);
    } catch {
      setAudioPlayingState(false);
      resolve('error');
    }
  });
}

async function playAudioBytes(
  arrayBuffer: ArrayBuffer,
  mimeType: string,
  playbackRate: number,
  volume: number,
  cacheKey?: string
): Promise<'played' | 'blocked' | 'stopped' | 'error'> {
  const ctx = getAudioContext();

  // Decode & play via Web Audio BufferSourceNode when running so WebSocket alerts stay instant
  if (ctx && ctx.state === 'running' && typeof ctx.decodeAudioData === 'function') {
    try {
      let decoded = cacheKey ? audioBufferCache.get(cacheKey) : undefined;
      if (!decoded) {
        decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
        if (cacheKey && audioBufferCache.size < 25) {
          audioBufferCache.set(cacheKey, decoded);
        }
      }
      const outcome = await playDecodedAudioBuffer(ctx, decoded, playbackRate, volume);
      if (outcome !== 'error') {
        return outcome;
      }
    } catch {
      // Fall through to HTMLAudioElement if native media decoder is required
    }
  }

  if (typeof URL === 'undefined') {
    return ctx && ctx.state === 'suspended' ? 'blocked' : 'error';
  }

  const blob = new Blob([arrayBuffer], { type: mimeType || 'audio/wav' });
  const objectUrl = URL.createObjectURL(blob);
  const outcome = await playHtmlAudioElementUrl(objectUrl, playbackRate, volume, () => {
    URL.revokeObjectURL(objectUrl);
  });
  return outcome;
}

function getCacheKeyForStreamUrl(url: string): string | undefined {
  if (!url.startsWith('/api/') || url.includes('mode=test')) return undefined;
  const [base, query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  const v = params.get('v') || '';
  return `${base}?v=${v}`;
}

async function playHtmlAudioFile(
  url: string,
  playbackRate: number,
  volume: number,
  authToken?: string | null
): Promise<{ outcome: 'played' | 'blocked' | 'stopped' | 'forbidden' | 'error'; error?: string }> {
  const cacheKey = getCacheKeyForStreamUrl(url);
  const ctx = getAudioContext();

  if (cacheKey && ctx && ctx.state === 'running') {
    const cachedBuffer = audioBufferCache.get(cacheKey);
    if (cachedBuffer) {
      const outcome = await playDecodedAudioBuffer(ctx, cachedBuffer, playbackRate, volume);
      if (outcome !== 'error') {
        return { outcome };
      }
    }
  }

  if (url.startsWith('/api/') && typeof fetch !== 'undefined') {
    try {
      const headers: Record<string, string> = {};
      if (authToken) headers.Authorization = `Bearer ${authToken}`;
      const res = await fetch(url, { headers });
      if (res.status === 403) {
        let message = 'ليس لديك صلاحية تجربة الأصوات';
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // keep default message
        }
        return { outcome: 'forbidden', error: message };
      }
      if (!res.ok) {
        return { outcome: 'error', error: 'تعذر تحميل الملف الصوتي من الخادم' };
      }
      const arrayBuffer = await res.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength <= 0) {
        return { outcome: 'error', error: 'الملف الصوتي فارغ أو غير صالح للتشغيل' };
      }
      const contentType = res.headers.get('content-type') || 'audio/wav';
      const outcome = await playAudioBytes(arrayBuffer, contentType, playbackRate, volume, cacheKey);
      return { outcome };
    } catch {
      return { outcome: 'error', error: 'تعذر الاتصال بالخادم لتشغيل الملف الصوتي' };
    }
  }

  const outcome = await playHtmlAudioElementUrl(url, playbackRate, volume);
  return { outcome };
}

export async function playHumanArabicSpeech(
  text: string,
  playbackRate: number,
  volume: number,
  authToken?: string | null,
  voiceOpts?: HumanVoicePlaybackOptions
): Promise<{
  status: 'played' | 'blocked' | 'stopped' | 'forbidden' | 'unavailable';
  engine: 'gemini' | 'recorded' | 'disabled';
  ttsEngine?: string | null;
  voiceName?: string | null;
  error?: string;
}> {
  const cleanText = text.trim();
  if ((!cleanText && !voiceOpts?.recordedFileUrl) || volume <= 0) {
    return { status: 'played', engine: 'gemini' };
  }

  // Browser SpeechSynthesis Arabic reader is explicitly stopped due to inaccurate name pronunciation
  if (voiceOpts?.voiceKind === 'browser_human') {
    return {
      status: 'unavailable',
      engine: 'disabled',
      error: 'تم إيقاف القارئ العربي الفوري (المتصفح) نهائياً؛ يرجى استخدام الصوت البشري الذكي أو تسجيل مرفوع',
    };
  }

  const startGen = playbackAbortGeneration;

  // Recorded Human Voice Profile: play recorded human file, and optionally verify voice readout
  if (voiceOpts?.voiceKind === 'recorded_human' && voiceOpts.recordedFileUrl) {
    const streamUrl = buildAuthenticatedUrl(
      voiceOpts.recordedFileUrl,
      authToken,
      voiceOpts.cacheBust,
      voiceOpts.playbackMode || 'alert'
    );
    const recRes = await playHtmlAudioFile(streamUrl, playbackRate, volume, authToken);
    if (recRes.outcome === 'forbidden') {
      return { status: 'forbidden', engine: 'recorded', error: recRes.error };
    }
    if (recRes.outcome === 'blocked') {
      return { status: 'blocked', engine: 'recorded' };
    }
    if (recRes.outcome === 'stopped' || startGen !== playbackAbortGeneration) {
      return { status: 'stopped', engine: 'recorded' };
    }
    if (recRes.outcome === 'error') {
      return { status: 'unavailable', engine: 'recorded', error: recRes.error || 'تعذر تشغيل التسجيل البشري المرفوع' };
    }
    if (voiceOpts.playbackMode === 'test' || !cleanText) {
      return { status: 'played', engine: 'recorded', ttsEngine: 'recorded_human' };
    }
    return { status: 'played', engine: 'recorded', ttsEngine: 'recorded_human' };
  }

  // AI Natural Human Arabic Speech via Server Gemini TTS (never falls back to browser speechSynthesis)
  if (!cleanText) {
    return { status: 'unavailable', engine: 'gemini', error: 'النص المطلوب نطقه فارغ' };
  }
  if (!authToken || typeof fetch === 'undefined') {
    return { status: 'unavailable', engine: 'gemini', error: 'تعذر الوصول إلى خدمة الصوت بدون جلسة صالحة' };
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const abortTimer = controller ? window.setTimeout(() => controller.abort(), 25000) : null;
  try {
    setAudioPlayingState(true);
    const res = await fetch('/api/audio/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        text: cleanText,
        voiceName: voiceOpts?.voiceName || undefined,
        stylePrompt: voiceOpts?.stylePrompt || undefined,
        humanVoiceId: voiceOpts?.humanVoiceId || undefined,
        channelCode: voiceOpts?.channelCode || undefined,
        departmentCode: voiceOpts?.departmentCode || undefined,
        mode: voiceOpts?.playbackMode === 'test' ? 'preview' : 'alert',
      }),
      signal: controller?.signal,
    });

    if (startGen !== playbackAbortGeneration) {
      setAudioPlayingState(false);
      return { status: 'stopped', engine: 'gemini' };
    }

    const contentType = res.headers.get('content-type') || '';
    const hdrEngine = res.headers.get('X-TTS-Engine') || res.headers.get('X-TTS-Source') || 'gemini';
    const hdrVoice = res.headers.get('X-TTS-Voice') || voiceOpts?.voiceName || null;

    if (res.ok && contentType.startsWith('audio/')) {
      const arrayBuffer = await res.arrayBuffer();
      if (startGen !== playbackAbortGeneration) {
        setAudioPlayingState(false);
        return { status: 'stopped', engine: 'gemini' };
      }
      if (arrayBuffer && arrayBuffer.byteLength > 44) {
        const outcome = await playAudioBytes(arrayBuffer, contentType, playbackRate, volume);
        if (outcome === 'stopped') {
          return { status: 'stopped', engine: 'gemini', ttsEngine: hdrEngine, voiceName: hdrVoice };
        }
        if (outcome === 'played') {
          return { status: 'played', engine: 'gemini', ttsEngine: hdrEngine, voiceName: hdrVoice };
        }
        if (outcome === 'blocked') {
          setAudioPlayingState(false);
          return {
            status: 'blocked',
            engine: 'gemini',
            ttsEngine: hdrEngine,
            voiceName: hdrVoice,
            error: 'المتصفح منع التشغيل التلقائي للصوت',
          };
        }
        return {
          status: 'unavailable',
          engine: 'gemini',
          ttsEngine: hdrEngine,
          voiceName: hdrVoice,
          error: 'تعذر فك ترميز وتشغيل الملف الصوتي في المتصفح',
        };
      }
      setAudioPlayingState(false);
      return {
        status: 'unavailable',
        engine: 'gemini',
        error: 'استجابة الصوت المستلمة من الخادم فارغة أو غير صالحة',
      };
    }

    let serverMessage = 'خدمة الصوت البشري الذكي غير متاحة حالياً (القارئ الآلي للمتصفح متوقف)';
    try {
      const jsonBody = (await res.json()) as { message?: string; error?: string };
      if (jsonBody?.message) serverMessage = jsonBody.message;
      else if (jsonBody?.error) serverMessage = jsonBody.error;
    } catch {
      // ignore non-json
    }
    setAudioPlayingState(false);
    return {
      status: 'unavailable',
      engine: 'gemini',
      voiceName: hdrVoice,
      error: serverMessage,
    };
  } catch (err) {
    setAudioPlayingState(false);
    if (startGen !== playbackAbortGeneration) {
      return { status: 'stopped', engine: 'gemini' };
    }
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      status: 'unavailable',
      engine: 'gemini',
      error: isAbort
        ? 'انتهت مهلة انتظار استجابة خدمة الصوت الذكي (25 ثانية)'
        : err instanceof Error
          ? err.message
          : 'فشل الاتصال بخدمة الصوت البشري الذكي',
    };
  } finally {
    if (abortTimer !== null) clearTimeout(abortTimer);
  }
}

async function executeAlertPlayback(opts: {
  text: string;
  stationSetting?: StationAudioSetting | null;
  voiceReaderSetting?: VoiceReaderSetting | null;
  channelCode?: VoiceReaderChannelCode | null;
  departmentCode?: DepartmentCode | string | null;
  notificationMeta?: Pick<NotificationItem, 'urgency_level' | 'event_type'> | null;
  authToken?: string | null;
  onPlaybackStart?: () => void;
}): Promise<AudioAlertPlaybackResult> {
  const startGen = playbackAbortGeneration;
  const station = opts.stationSetting;
  const reader = opts.voiceReaderSetting;
  let tonePlayed = false;
  let speechPlayed = false;
  let ttsEngine: string | null = null;
  let selectedVoiceName: string | null =
    reader?.resolved_prebuilt_voice_name || reader?.resolved_human_voice_name || null;

  const speakStationFlag = station ? station.speak_text_enabled !== false : true;
  const readerEnabled = reader ? reader.is_enabled && speakStationFlag : speakStationFlag;
  const scopeAllowed =
    !reader || reader.read_scope !== 'important_only' || isImportantNotification(opts.notificationMeta);
  const voiceVol = reader
    ? Math.min(1, Math.max(0, reader.volume_percent / 100))
    : station
      ? Math.min(1, Math.max(0, station.volume_percent / 100))
      : 0.85;
  const speechRequired = Boolean(readerEnabled && scopeAllowed && opts.text.trim() && voiceVol > 0);

  // If AudioContext exists and is suspended BEFORE playback, fail fast into 'blocked' so autoplay recovery handles full alert!
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    return {
      status: 'blocked',
      tonePlayed: false,
      speechPlayed: false,
      speechRequired,
      selectedVoiceName,
      failureReason: 'المتصفح يوقف التشغيل التلقائي — بانتظار التفعيل من المستخدم',
    };
  }

  opts.onPlaybackStart?.();

  // Step 1: Independent Station Alert Chime / Tone
  const chimeEnabled = station ? station.is_enabled : true;
  const chimeVolume = station ? Math.min(1, Math.max(0, station.volume_percent / 100)) : 0.85;
  const chimeRate = station ? station.playback_rate : 1;

  if (chimeEnabled && chimeVolume > 0) {
    const effectiveFileUrl = station?.audio_file_url || station?.resolved_audio_file_url || null;
    if (effectiveFileUrl && opts.authToken) {
      const streamUrl = buildAuthenticatedUrl(effectiveFileUrl, opts.authToken, station?.updated_at, 'alert');
      const playRes = await playHtmlAudioFile(streamUrl, chimeRate, chimeVolume, opts.authToken);
      if (playRes.outcome === 'blocked') {
        return {
          status: 'blocked',
          tonePlayed: false,
          speechPlayed: false,
          speechRequired,
          selectedVoiceName,
          failureReason: 'تم منع تشغيل نغمة التنبيه بواسطة قيود التشغيل التلقائي في المتصفح',
        };
      }
      if (playRes.outcome === 'stopped' || startGen !== playbackAbortGeneration) {
        return {
          status: 'played',
          tonePlayed: true,
          speechPlayed: false,
          speechRequired,
          selectedVoiceName,
        };
      }
      if (playRes.outcome === 'error' || playRes.outcome === 'forbidden') {
        playSoftChime(chimeVolume);
        await new Promise((r) => setTimeout(r, 420));
        tonePlayed = true;
      } else {
        tonePlayed = true;
      }
    } else {
      playSoftChime(chimeVolume);
      await new Promise((r) => setTimeout(r, 420));
      tonePlayed = true;
    }
  }

  if (startGen !== playbackAbortGeneration) {
    return { status: 'played', tonePlayed, speechPlayed: false, speechRequired, selectedVoiceName };
  }

  // Step 2: Independent Human Voice Reader Channel (explicit error reporting when speech fails!)
  if (speechRequired) {
    const voiceRate = reader ? reader.playback_rate : chimeRate;
    try {
      const ttsRes = await playHumanArabicSpeech(opts.text, voiceRate, voiceVol, opts.authToken, {
        humanVoiceId: reader?.resolved_human_voice_id ?? reader?.human_voice_id ?? null,
        voiceName: reader?.resolved_prebuilt_voice_name ?? null,
        stylePrompt: reader?.resolved_style_prompt ?? null,
        voiceKind: reader?.resolved_human_voice_kind ?? null,
        recordedFileUrl: reader?.resolved_audio_file_url ?? null,
        channelCode: opts.channelCode ?? reader?.channel_code ?? null,
        departmentCode: opts.departmentCode ?? null,
        playbackMode: 'alert',
        cacheBust: reader?.updated_at,
      });
      ttsEngine = ttsRes.ttsEngine || ttsRes.engine;
      if (ttsRes.voiceName) selectedVoiceName = ttsRes.voiceName;

      if (ttsRes.status === 'blocked') {
        return {
          status: 'blocked',
          tonePlayed,
          speechPlayed: false,
          speechRequired,
          ttsEngine,
          selectedVoiceName,
          failureReason: ttsRes.error || 'المتصفح منع التشغيل التلقائي لقراءة البلاغ',
        };
      }
      if (ttsRes.status === 'unavailable' || ttsRes.status === 'forbidden') {
        return {
          status: 'failed',
          tonePlayed,
          speechPlayed: false,
          speechRequired,
          ttsEngine,
          selectedVoiceName,
          failureReason: ttsRes.error || 'فشل توليد أو تشغيل القراءة الصوتية للبلاغ',
        };
      }
      speechPlayed = ttsRes.status === 'played';
    } catch (err) {
      return {
        status: 'failed',
        tonePlayed,
        speechPlayed: false,
        speechRequired,
        ttsEngine,
        selectedVoiceName,
        failureReason: err instanceof Error ? err.message : 'خطأ غير متوقع أثناء تشغيل القراءة الصوتية',
      };
    }
  }

  return {
    status: 'played',
    tonePlayed,
    speechPlayed,
    speechRequired,
    ttsEngine,
    selectedVoiceName,
  };
}

async function processAlertQueue() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  try {
    while (activeQueue.length > 0) {
      const job = activeQueue.shift()!;
      const station = job.stationSetting;
      const reader = job.voiceReaderSetting;

      const chimePossible = !station || (station.is_enabled && station.volume_percent > 0);
      const voicePossible = !reader || (reader.is_enabled && reader.volume_percent > 0);
      if (!chimePossible && !voicePossible) {
        markAlertAsPlayed(job.userId, job.alertKey);
        queuedKeySet.delete(job.alertKey);
        continue;
      }

      const result = await executeAlertPlayback({
        text: job.text,
        stationSetting: station,
        voiceReaderSetting: reader,
        channelCode: job.channelCode ?? reader?.channel_code ?? null,
        departmentCode: job.departmentCode ?? null,
        notificationMeta: job.notificationMeta,
        authToken: job.authToken,
        onPlaybackStart: job.onStarted,
      });

      if (result.status === 'blocked') {
        audioUnlockedState = false;
        notifyUnlockSubscribers(false);
        blockedQueue.push(job);
        queuedKeySet.delete(job.alertKey);
        job.onBlocked?.();
        continue;
      }

      queuedKeySet.delete(job.alertKey);

      if (result.status === 'failed') {
        // Cooldown for 2 minutes on auto-poll re-enqueue, but NEVER falsely mark as successfully played!
        failedAttemptExpiryMap.set(`${job.userId}:${job.alertKey}`, Date.now() + 120000);
        job.onFailed?.(result.failureReason || 'تعذر قراءة البلاغ صوتياً', result);
        continue;
      }

      markAlertAsPlayed(job.userId, job.alertKey);
      job.onPlayed?.(job.alertKey, result);
    }
  } finally {
    isQueueProcessing = false;
  }
}

export function enqueueStationAlert(job: QueuedAlertJob) {
  if (!job.alertKey) return;
  if (hasAlertBeenPlayed(job.userId, job.alertKey)) return;
  if (queuedKeySet.has(job.alertKey)) return;
  if (blockedQueue.some((b) => b.alertKey === job.alertKey && b.userId === job.userId)) return;

  const cooldownUntil = failedAttemptExpiryMap.get(`${job.userId}:${job.alertKey}`) || 0;
  if (Date.now() < cooldownUntil) return;

  queuedKeySet.add(job.alertKey);
  activeQueue.push(job);
  void processAlertQueue();
}

export async function replayAlertAudio(opts: {
  text: string;
  stationSetting?: StationAudioSetting | null;
  voiceReaderSetting?: VoiceReaderSetting | null;
  channelCode?: VoiceReaderChannelCode | null;
  departmentCode?: DepartmentCode | string | null;
  notificationMeta?: Pick<NotificationItem, 'urgency_level' | 'event_type'> | null;
  authToken?: string | null;
  onPlaybackStart?: () => void;
}): Promise<{ ok: boolean; blocked?: boolean; error?: string; result: AudioAlertPlaybackResult }> {
  await unlockStationAudio();
  const result = await executeAlertPlayback(opts);
  return {
    ok: result.status === 'played',
    blocked: result.status === 'blocked',
    error: result.failureReason || undefined,
    result,
  };
}

export async function previewHumanVoice(opts: {
  voice: Pick<
    HumanVoiceRecord,
    'id' | 'voice_kind' | 'prebuilt_voice_name' | 'style_prompt' | 'audio_file_url' | 'updated_at'
  >;
  sampleText: string;
  playbackRate?: number;
  volumePercent?: number;
  authToken?: string | null;
  mode?: 'test' | 'alert';
}): Promise<{
  ok: boolean;
  stopped?: boolean;
  forbidden?: boolean;
  engine?: 'gemini' | 'recorded' | 'disabled';
  error?: string;
}> {
  await unlockStationAudio();
  const volume = Math.min(1, Math.max(0, (opts.volumePercent ?? 90) / 100));
  const rate = Math.min(2.5, Math.max(0.5, opts.playbackRate || 1));

  const res = await playHumanArabicSpeech(opts.sampleText, rate, volume, opts.authToken, {
    humanVoiceId: opts.voice.id,
    voiceName: opts.voice.prebuilt_voice_name,
    stylePrompt: opts.voice.style_prompt,
    voiceKind: opts.voice.voice_kind,
    recordedFileUrl: opts.voice.audio_file_url,
    playbackMode: opts.mode || 'test',
    cacheBust: opts.voice.updated_at || String(opts.voice.id),
  });

  if (res.status === 'forbidden') {
    return { ok: false, forbidden: true, error: res.error || 'ليس لديك صلاحية تجربة الأصوات' };
  }
  if (res.status === 'blocked') {
    return { ok: false, error: 'يرجى التفاعل مع الصفحة لتفعيل الصوت في المتصفح' };
  }
  if (res.status === 'unavailable') {
    return { ok: false, engine: res.engine, error: res.error };
  }
  if (res.status === 'stopped') {
    return { ok: true, stopped: true, engine: res.engine };
  }
  return { ok: true, engine: res.engine };
}

export async function previewStationAudio(opts: {
  fileUrl?: string | null;
  playbackRate: number;
  volumePercent: number;
  sampleText?: string;
  speakTextEnabled?: boolean;
  voiceOpts?: HumanVoicePlaybackOptions;
  authToken?: string | null;
  cacheBust?: string;
  mode?: 'test' | 'alert';
}): Promise<{
  ok: boolean;
  stopped?: boolean;
  forbidden?: boolean;
  engine?: 'gemini' | 'static' | 'recorded' | 'disabled';
  error?: string;
}> {
  await unlockStationAudio();
  const volume = Math.min(1, Math.max(0, opts.volumePercent / 100));
  const rate = Math.min(2.5, Math.max(0.5, opts.playbackRate || 1));
  const startGen = playbackAbortGeneration;

  if (opts.fileUrl) {
    const finalUrl = buildAuthenticatedUrl(opts.fileUrl, opts.authToken, opts.cacheBust, opts.mode ?? 'alert');
    const playRes = await playHtmlAudioFile(finalUrl, rate, volume, opts.authToken);
    if (playRes.outcome === 'forbidden') {
      return { ok: false, forbidden: true, error: playRes.error || 'ليس لديك صلاحية تجربة الأصوات' };
    }
    if (playRes.outcome === 'blocked') {
      return { ok: false, error: 'يرجى التفاعل مع الصفحة لتفعيل الصوت في المتصفح' };
    }
    if (playRes.outcome === 'stopped' || startGen !== playbackAbortGeneration) {
      return { ok: true, stopped: true, engine: 'static' };
    }
    if (playRes.outcome === 'error') {
      return { ok: false, error: playRes.error || 'تعذر تشغيل الملف الصوتي المختار' };
    }
    if (opts.speakTextEnabled && opts.sampleText?.trim()) {
      const ttsRes = await playHumanArabicSpeech(
        opts.sampleText,
        rate,
        volume,
        opts.authToken,
        opts.voiceOpts
      );
      if (ttsRes.status === 'stopped') {
        return { ok: true, stopped: true, engine: ttsRes.engine };
      }
      if (ttsRes.status === 'blocked') {
        return { ok: false, engine: ttsRes.engine, error: ttsRes.error || 'يرجى التفاعل مع الصفحة لتفعيل الصوت' };
      }
      if (ttsRes.status === 'unavailable' || ttsRes.status === 'forbidden') {
        return {
          ok: false,
          engine: ttsRes.engine,
          error: ttsRes.error || 'تم تشغيل النغمة فقط — تعذر تشغيل القراءة البشرية للبلاغ',
        };
      }
      return { ok: ttsRes.status === 'played', engine: ttsRes.engine };
    }
    return { ok: true, engine: 'static' };
  }

  playSoftChime(volume);
  await new Promise((r) => setTimeout(r, 380));
  if (startGen !== playbackAbortGeneration) {
    return { ok: true, stopped: true, engine: 'static' };
  }
  if (opts.speakTextEnabled !== false) {
    const text =
      opts.sampleText || 'تنبيه تشغيلي من نظام المذاق اليمني، يرجى متابعة البلاغ الوارد فوراً.';
    const ttsRes = await playHumanArabicSpeech(text, rate, volume, opts.authToken, opts.voiceOpts);
    if (ttsRes.status === 'blocked') {
      return { ok: false, error: 'يرجى التفاعل مع الصفحة لتفعيل الصوت في المتصفح' };
    }
    if (ttsRes.status === 'unavailable' || ttsRes.status === 'forbidden') {
      return {
        ok: false,
        engine: ttsRes.engine,
        error: ttsRes.error || 'تم تشغيل النغمة فقط — تعذر تشغيل القراءة البشرية للبلاغ',
      };
    }
    if (ttsRes.status === 'stopped') {
      return { ok: true, stopped: true, engine: ttsRes.engine };
    }
    return { ok: true, engine: ttsRes.engine };
  }

  return { ok: true, engine: 'static' };
}

export function speakArabicAlert(
  _text: string,
  settings?: AudioAlertSettings
): { spoken: boolean; blocked: boolean } {
  const cfg = settings ?? loadAudioSettings();
  if (cfg.chimeEnabled) {
    playSoftChime(cfg.volume);
  }
  return { spoken: false, blocked: false };
}

export function isStationAudioUnlocked(): boolean {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'running') {
    return true;
  }
  return audioUnlockedState;
}

export function getBrowserAudioDiagnostics(): {
  ctxState: string;
  audioUnlocked: boolean;
  isPlaying: boolean;
  blockedQueueLength: number;
  activeQueueLength: number;
} {
  const ctx = getAudioContext();
  return {
    ctxState: ctx ? ctx.state : 'unavailable',
    audioUnlocked: isStationAudioUnlocked(),
    isPlaying: audioPlayingState,
    blockedQueueLength: blockedQueue.length,
    activeQueueLength: activeQueue.length,
  };
}



