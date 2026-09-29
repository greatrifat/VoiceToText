export type ApiKeyEntry = { name: string; key: string };

export type Settings = {
  apiKeys: ApiKeyEntry[];
  driveUrl: string;
  driveSecret: string;
  taskNoteUrl: string;
};

export type MeetingStatus =
  | 'saved'
  | 'transcribing'
  | 'summarizing'
  | 'uploading'
  | 'posting'
  | 'done'
  | 'error';

export type Meeting = {
  id: string;
  title: string;
  createdAt: number;
  durationSec: number;
  mimeType: string;
  audioPath: string | null;
  transcript: string;
  summary: string;
  audioUrl: string | null;
  transcriptUrl: string | null;
  folderUrl: string | null;
  taskNoteId: string | null;
  lastError: string | null;
  status: MeetingStatus;
  timings: Record<string, number>;
};

export type ProcessingEvent = {
  meetingId: string;
  stage: string;
  message?: string;
  model?: string;
  keyNumber?: number;
  keyCount?: number;
  outcome?: string;
  sentBytes?: number;
  totalBytes?: number;
};

export type AppState = { settings: Settings; meetings: Meeting[]; version: string };

export type DesktopApi = {
  getState(): Promise<AppState>;
  saveSettings(settings: Settings): Promise<Settings>;
  testApiKey(key: string): Promise<{ models: string[] }>;
  testDrive(url: string): Promise<void>;
  testTaskNote(url: string): Promise<void>;
  saveAudio(audio: {
    bytes: ArrayBuffer;
    mimeType: string;
    durationSec: number;
    originalName?: string;
  }): Promise<Meeting>;
  listMeetings(): Promise<Meeting[]>;
  getMeeting(id: string): Promise<Meeting | null>;
  deleteMeeting(id: string): Promise<void>;
  processMeeting(id: string): Promise<Meeting>;
  askMeeting(id: string, question: string): Promise<string>;
  exportMeeting(id: string): Promise<string | null>;
  openMeetingAudio(id: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  onProcessing(callback: (event: ProcessingEvent) => void): () => void;
};
