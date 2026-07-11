/**
 * Voice pipeline config (STT/TTS). No-ops cleanly when keys are absent.
 */
export const VOICE = {
  sttProvider: 'elevenlabs',
  ttsProvider: 'elevenlabs',
  voiceId: process.env.ELEVENLABS_VOICE_ID || 'front-desk-warm',
  sampleRate: 16000,
};

export function ttsEnabled(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

export function sttEnabled(): boolean {
  return !!process.env.ELEVENLABS_API_KEY;
}

export function telephonyEnabled(): boolean {
  return !!(
    process.env.VAPI_API_KEY ||
    (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  );
}
