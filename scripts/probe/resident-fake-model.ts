import http from 'node:http';

/** The fake model: one assistant message per request, then the turn ends. */
export function startFakeModel(answer = 'probe-ok') {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      const item = {
        id: `msg_probe_${requests.length}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: answer }],
      };
      const response = {
        id: `resp_probe_${requests.length}`,
        object: 'response',
        created_at: 0,
        status: 'completed',
        model: 'probe-model',
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      const events = [
        ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }],
        ['response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer }],
        ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
        ['response.completed', { type: 'response.completed', response }],
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  const listening = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    requests, listening, port: () => (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

