import { VOICE, ttsEnabled } from '../config/voice';

/**
 * Text-to-speech. Returns audio bytes (mp3) or null when no key — the client then falls
 * back to browser SpeechSynthesis or silent text. Never throws on a missing key.
 */
export async function synthesize(text: string): Promise<Buffer | null> {
  if (!ttsEnabled()) return null;
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE.voiceId)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'xi-api-key': process.env.ELEVENLABS_API_KEY as string,
          accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: 'eleven_turbo_v2' }),
      }
    );
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn('[tts] failed, degrading to client speech:', (err as Error).message);
    return null;
  }
}
