import { GoogleGenAI, Modality } from '@google/genai';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TTS_CACHE_DIR = path.resolve(process.cwd(), 'data', 'tts_cache');
const memoryCache = new Map<string, { buffer: Buffer; engine: TtsEngineKind }>();
const modelQuotaBlockedUntil = new Map<string, number>();

export type TtsEngineKind = 'gemini_lite' | 'gemini_flash' | 'gemini_live';

export const ALLOWED_GEMINI_PREBUILT_VOICES = new Set([
  'Kore',
  'Charon',
  'Aoede',
  'Fenrir',
  'Puck',
  'Orus',
  'Leda',
  'Zephyr',
]);

export function isGeminiTtsConfigured(): boolean {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  return Boolean(key && key !== 'MY_GEMINI_API_KEY' && key !== 'undefined');
}

export function normalizeArabicForSpeech(rawText: string): string {
  let out = String(rawText || '').trim();
  if (!out) return '';

  // Read TRK-000123 as natural Arabic tracking number instead of spelling Latin letters
  out = out.replace(/رقم\s+المتابعة\s+TRK-0*(\d+)/gi, 'رقم المتابعة $1');
  out = out.replace(/\bTRK-0*(\d+)\b/gi, 'رقم المتابعة $1');

  // Replace harsh dashes/slashes with natural Arabic pauses without dropping numbers or words
  out = out.replace(/\s*[—–]\s*/g, '، ');
  out = out.replace(/\s*\|\s*/g, '، ');
  out = out.replace(/[،]{2,}/g, '،');
  out = out.replace(/\s{2,}/g, ' ');
  return out.trim();
}

export function wrapPcm24kMonoAsWav(pcmBuffer: Buffer): Buffer {
  // If buffer is already a valid RIFF WAVE file, return as-is
  if (pcmBuffer.length >= 44 && pcmBuffer.subarray(0, 4).toString('ascii') === 'RIFF') {
    return pcmBuffer;
  }
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function isQuotaOrRateError(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes('429') || m.includes('resource_exhausted') || m.includes('quota') || m.includes('rate limit');
}

function isModelBlocked(model: string): boolean {
  const until = modelQuotaBlockedUntil.get(model) || 0;
  return Date.now() < until;
}

function markModelQuotaBlocked(model: string, cooldownMs = 5 * 60 * 1000) {
  modelQuotaBlockedUntil.set(model, Date.now() + cooldownMs);
}

async function synthesizeViaUnaryTtsModel(
  ai: GoogleGenAI,
  model: 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts',
  text: string,
  voiceName: string
): Promise<Buffer> {
  const response = await ai.models.generateContent({
    model,
    contents: text,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName },
        },
      },
    },
  });

  const parts = response.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find((p) => Boolean(p.inlineData?.data));
  const base64Audio = audioPart?.inlineData?.data;
  if (!base64Audio) {
    throw new Error(`لم يُرجع نموذج ${model} بيانات صوتية صالحة`);
  }
  const raw = Buffer.from(base64Audio, 'base64');
  const mime = String(audioPart?.inlineData?.mimeType || '').toLowerCase();
  if (raw.subarray(0, 4).toString('ascii') === 'RIFF') {
    return raw;
  }
  if (mime.includes('pcm') || mime.includes('l16') || !mime.includes('wav')) {
    return wrapPcm24kMonoAsWav(raw);
  }
  return raw;
}

async function synthesizeViaLiveAudio(
  ai: GoogleGenAI,
  text: string,
  voiceName: string,
  stylePrompt?: string | null
): Promise<Buffer> {
  const styleLine = stylePrompt && stylePrompt.trim() ? ` الأسلوب المطلوب: ${stylePrompt.trim()}.` : '';
  const systemInstruction =
    `أنت نظام قراءة صوتية عربي محترف لمطعم المذاق اليمني. مهمتك الوحيدة هي قراءة نص التنبيه المُرسل لك حرفياً باللغة العربية بوضوح تام ونبرة احترافية، دون أي تحية أو إضافة أو شرح أو تعليق إضافي.${styleLine}`;

  return new Promise<Buffer>((resolve, reject) => {
    const pcmChunks: Buffer[] = [];
    let settled = false;
    let sessionRef: { close: () => void } | null = null;

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      try {
        sessionRef?.close();
      } catch {
        // ignore close errors
      }
      sessionRef = null;
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const pcm = Buffer.concat(pcmChunks);
      if (pcm.length < 256) {
        reject(new Error('لم يُرجع محرك الصوت الحي (gemini-3.8-live) بيانات صوتية كافية'));
        return;
      }
      resolve(wrapPcm24kMonoAsWav(pcm));
    };

    const timeoutTimer = setTimeout(() => {
      if (pcmChunks.length > 0) {
        succeed();
      } else {
        fail(new Error('انتهت مهلة استجابة محرك الصوت الحي'));
      }
    }, 18000);

    ai.live
      .connect({
        model: 'gemini-3.8-live',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
          systemInstruction,
        },
        callbacks: {
          onmessage: (message) => {
            try {
              const parts = message.serverContent?.modelTurn?.parts || [];
              for (const part of parts) {
                const b64 = part.inlineData?.data;
                if (b64) {
                  pcmChunks.push(Buffer.from(b64, 'base64'));
                }
              }
              if (message.serverContent?.turnComplete) {
                succeed();
              }
            } catch (e) {
              fail(e);
            }
          },
          onerror: (errEvent) => {
            const msg =
              errEvent && typeof errEvent === 'object' && 'message' in errEvent
                ? String((errEvent as { message?: unknown }).message)
                : 'تعذر الاتصال بمحرك الصوت الحي';
            fail(new Error(msg));
          },
          onclose: (closeEv) => {
            if (!settled) {
              if (pcmChunks.length > 0) {
                succeed();
              } else {
                const reason =
                  closeEv && typeof closeEv === 'object' && 'reason' in closeEv
                    ? String((closeEv as { reason?: unknown }).reason || '')
                    : '';
                fail(new Error(reason ? `أُغلق اتصال الصوت الحي: ${reason}` : 'أُغلق اتصال الصوت الحي قبل اكتمال القراءة'));
              }
            }
          },
        },
      })
      .then((session) => {
        if (settled) {
          try {
            session.close();
          } catch {
            // ignore
          }
          return;
        }
        sessionRef = session;
        session.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [{ text: `اقرأ التنبيه التالي حرفياً وبوضوح بالعربية فقط:\n${text}` }],
            },
          ],
          turnComplete: true,
        });
      })
      .catch(fail);
  });
}

export type TtsGenerationResult =
  | { ok: true; audioBuffer: Buffer; mimeType: string; cached: boolean; voiceName: string; engine: TtsEngineKind }
  | { ok: false; reason: 'missing_api_key' | 'empty_text' | 'missing_voice' | 'api_error'; message: string };

export async function generateArabicTtsAudio(
  rawText: string,
  options?: { voiceName?: string | null; stylePrompt?: string | null }
): Promise<TtsGenerationResult> {
  const normalized = normalizeArabicForSpeech(rawText);
  if (!normalized) {
    return { ok: false, reason: 'empty_text', message: 'النص المطلوب نطقه فارغ' };
  }

  const reqVoice = String(options?.voiceName || '').trim();
  if (!reqVoice || !ALLOWED_GEMINI_PREBUILT_VOICES.has(reqVoice)) {
    return {
      ok: false,
      reason: 'missing_voice',
      message: 'لم يتم تحديد صوت بشري معتمد صالح للقراءة (ممنوع التبديل التلقائي)',
    };
  }
  const voiceName = reqVoice;
  const styleClean = String(options?.stylePrompt || '').trim();
  const cacheSeed = `${voiceName}::${styleClean}::${normalized}`;
  const hash = crypto.createHash('sha256').update(cacheSeed).digest('hex');

  const memHit = memoryCache.get(hash);
  if (memHit) {
    return {
      ok: true,
      audioBuffer: memHit.buffer,
      mimeType: 'audio/wav',
      cached: true,
      voiceName,
      engine: memHit.engine,
    };
  }

  fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
  const cacheFile = path.join(TTS_CACHE_DIR, `${hash}.wav`);
  if (fs.existsSync(cacheFile)) {
    const diskBuf = fs.readFileSync(cacheFile);
    if (diskBuf.length > 44) {
      memoryCache.set(hash, { buffer: diskBuf, engine: 'gemini_lite' });
      return {
        ok: true,
        audioBuffer: diskBuf,
        mimeType: 'audio/wav',
        cached: true,
        voiceName,
        engine: 'gemini_lite',
      };
    }
  }

  if (!isGeminiTtsConfigured()) {
    return {
      ok: false,
      reason: 'missing_api_key',
      message: 'مفتاح GEMINI_API_KEY غير مهيأ في الخادم — القارئ الآلي للمتصفح متوقف نهائياً',
    };
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY!.trim(),
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });

  const errors: string[] = [];

  // Tier 1 & Tier 2: Dedicated TTS models with exact selected voiceName
  const unaryModels: Array<{ model: 'gemini-3.8-flash-lite-tts' | 'gemini-3.8-flash-tts'; engine: TtsEngineKind }> = [
    { model: 'gemini-3.8-flash-lite-tts', engine: 'gemini_lite' },
    { model: 'gemini-3.8-flash-tts', engine: 'gemini_flash' },
  ];

  for (const candidate of unaryModels) {
    if (isModelBlocked(candidate.model)) {
      errors.push(`${candidate.model}: في فترة تهدئة الحصة`);
      continue;
    }
    try {
      const wavBuffer = await synthesizeViaUnaryTtsModel(ai, candidate.model, normalized, voiceName);
      fs.writeFileSync(cacheFile, wavBuffer);
      if (memoryCache.size > 250) {
        const firstKey = memoryCache.keys().next().value;
        if (firstKey) memoryCache.delete(firstKey);
      }
      memoryCache.set(hash, { buffer: wavBuffer, engine: candidate.engine });
      return {
        ok: true,
        audioBuffer: wavBuffer,
        mimeType: 'audio/wav',
        cached: false,
        voiceName,
        engine: candidate.engine,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${candidate.model}: ${msg}`);
      if (isQuotaOrRateError(msg)) {
        markModelQuotaBlocked(candidate.model);
      }
    }
  }

  // Tier 3: Gemini 3.8 Live Native Audio with the exact same selected voiceName
  try {
    const wavBuffer = await synthesizeViaLiveAudio(ai, normalized, voiceName, styleClean);
    fs.writeFileSync(cacheFile, wavBuffer);
    if (memoryCache.size > 250) {
      const firstKey = memoryCache.keys().next().value;
      if (firstKey) memoryCache.delete(firstKey);
    }
    memoryCache.set(hash, { buffer: wavBuffer, engine: 'gemini_live' });
    return {
      ok: true,
      audioBuffer: wavBuffer,
      mimeType: 'audio/wav',
      cached: false,
      voiceName,
      engine: 'gemini_live',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`gemini-3.8-live: ${msg}`);
  }

  return {
    ok: false,
    reason: 'api_error',
    message: `تعذر توليد القراءة الصوتية بالصوت (${voiceName}): ${errors[errors.length - 1] || 'خطأ غير متوقع'}`,
  };
}
