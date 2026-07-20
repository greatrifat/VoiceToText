export const GEMINI_MODEL = 'gemini-2.5-flash';

/**
 * Gemini accepts inline audio up to ~20MB per request, and base64 inflates
 * bytes by ~33%. We refuse anything above this so the user gets a clear error
 * instead of an opaque 400 from the API.
 */
export const MAX_INLINE_AUDIO_BYTES = 14 * 1024 * 1024;
