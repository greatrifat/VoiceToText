export type DriveUploadResult = {
  audioUrl: string;
  transcriptUrl: string;
  folderUrl: string;
};

/**
 * Posts the recording and its transcript to the Apps Script Web App, which
 * writes both into Drive under the account that deployed the script.
 *
 * Form-encoded rather than JSON: a JSON content-type triggers a CORS preflight
 * that Apps Script does not answer.
 */
export async function uploadToDrive(params: {
  driveUrl: string;
  driveSecret?: string;
  base64Audio: string;
  mimeType: string;
  fileName: string;
  transcript: string;
  summary?: string;
}): Promise<DriveUploadResult> {
  const form: Record<string, string> = {
    fileName: params.fileName,
    mimeType: params.mimeType,
    audioBase64: params.base64Audio,
    transcript: params.transcript,
  };
  if (params.summary) {
    form.summary = params.summary;
  }
  if (params.driveSecret) {
    form.secret = params.driveSecret;
  }

  const response = await fetch(params.driveUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

  const raw = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Apps Script serves an HTML login page when the deployment is not set to
    // "Anyone" access — worth calling out, since the status code is still 200.
    throw new Error(
      'Drive returned a non-JSON response. Check the Web App is deployed with access set to "Anyone".'
    );
  }

  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }

  return {
    audioUrl: payload.audioUrl,
    transcriptUrl: payload.transcriptUrl,
    folderUrl: payload.folderUrl,
  };
}

/** Cheap GET used by the Settings screen to check a pasted Apps Script URL. */
export async function verifyDriveUrl(driveUrl: string): Promise<void> {
  const response = await fetch(driveUrl);
  const raw = await response.text();
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Not a JSON response — check the deployment is set to "Anyone".');
  }
  if (!payload?.ok) {
    throw new Error(payload?.error ?? 'Unexpected response from the script.');
  }
}
