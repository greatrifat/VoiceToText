const http = require('node:http');
const { postToTaskNote } = require('../electron/integrations.cjs');

let receivedPath = '';
let receivedBody = '';

const server = http.createServer((request, response) => {
  receivedPath = request.url || '';
  request.on('data', (chunk) => { receivedBody += chunk; });
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'test-id' }));
  });
});

server.listen(0, '127.0.0.1', async () => {
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Mock server did not start.');
    const id = await postToTaskNote({
      settings: { taskNoteUrl: `http://127.0.0.1:${address.port}` },
      meeting: {
        id: 'desktop-id',
        title: 'Test meeting',
        createdAt: 0,
        durationSec: 60,
        transcript: 'Transcript',
        summary: 'Summary',
        folderUrl: '',
        audioUrl: '',
        transcriptUrl: '',
      },
    });
    const payload = JSON.parse(receivedBody);
    if (receivedPath !== '/api/meetings') throw new Error(`Wrong endpoint: ${receivedPath}`);
    if (payload.source !== 'voicetotext') throw new Error(`Wrong source: ${payload.source}`);
    if (!payload.externalId || id !== 'test-id') throw new Error('Invalid request or response mapping.');
    console.log('TaskNote request contract passed.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
