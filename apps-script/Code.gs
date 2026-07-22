/**
 * VoiceToText — Drive receiver.
 *
 * Deploy: script.google.com > New project > paste this > Deploy > New deployment
 *   Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone
 * Then paste the /exec URL into the app's Settings screen.
 *
 * "Anyone" means anyone holding the URL can write into your Drive, so treat the
 * /exec URL as a secret. Setting SHARED_SECRET below adds a second check: put
 * the same value in the app's Settings screen and requests without it are
 * rejected.
 */

var ROOT_FOLDER_NAME = 'VoiceToText Meetings';
var SHARED_SECRET = ''; // leave empty to disable the check

function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    if (SHARED_SECRET && p.secret !== SHARED_SECRET) {
      return json({ ok: false, error: 'Unauthorized' });
    }
    if (!p.audioBase64) {
      return json({ ok: false, error: 'Missing audioBase64' });
    }

    // The app sends "<title>.<ext>". The extension is kept on the audio file so
    // an imported mp3 stays playable, but stripped from the folder name — a
    // folder called "Sprint planning.mp3" would read as a file.
    // Matched against known audio extensions rather than "text after the last
    // dot": a generated title like "Q3 review v1.2" would otherwise lose its
    // last two characters to a non-existent extension.
    var rawName = sanitize(p.fileName || 'meeting');
    var extMatch = rawName.match(/\.(m4a|mp4|mp3|wav|aac|ogg|oga|opus|flac|aiff|aif)$/i);
    var baseName = extMatch ? rawName.slice(0, rawName.length - extMatch[0].length) : rawName;
    var audioName = extMatch ? rawName : rawName + '.m4a';

    var root = getOrCreateFolder(ROOT_FOLDER_NAME);

    // One folder per meeting, so audio, transcript and summary travel together.
    // Always created fresh rather than reused: two meetings can share a title,
    // and silently merging them into one folder would be worse than a duplicate.
    var folder = root.createFolder(baseName);

    var audioFile = folder.createFile(
      Utilities.newBlob(
        Utilities.base64Decode(p.audioBase64),
        p.mimeType || 'audio/mp4',
        audioName
      )
    );

    // Plain text rather than a Google Doc: Drive full-text indexes .txt all the
    // same, and DocumentApp would drag in the Docs OAuth scope for no real gain.
    var transcriptFile = folder.createFile(
      Utilities.newBlob(p.transcript || '(no transcript)', 'text/plain', 'transcript.txt')
    );

    if (p.summary) {
      folder.createFile(Utilities.newBlob(p.summary, 'text/plain', 'summary.txt'));
    }

    return json({
      ok: true,
      audioUrl: audioFile.getUrl(),
      transcriptUrl: transcriptFile.getUrl(),
      folderUrl: folder.getUrl(),
    });
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  }
}

function doGet() {
  return json({ ok: true, status: 'VoiceToText Drive receiver is live' });
}

function getOrCreateFolder(name) {
  var existing = DriveApp.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : DriveApp.createFolder(name);
}

function sanitize(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '-').slice(0, 120);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
