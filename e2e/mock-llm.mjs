// Deterministic OpenAI-compatible stand-in for browser tests (transport/control flow only, not model quality).
import { createServer } from 'node:http';

const reply = (prompt) => {
  if (prompt.includes('study digest'))
    return { slides: [...prompt.matchAll(/--- Slide (\d+)/g)].map((m) => ({ page: Number(m[1]), title: `Topic ${m[1]}`, summary: `Slide ${m[1]} teaches gradient steps.`, formulas: [], topics: ['gd'] })) };
  if (prompt.includes('Extract the course knowledge'))
    return {
      link: { lectureNumber: 1, slide: 2, confidence: 0.9 },
      fragments: [{ kind: 'derivation', text: 'Missing step: $w \\leftarrow w - \\eta \\nabla L$', topic: 'Update rule', confidence: 0.9, bbox: [0.05, 0.05, 0.5, 0.3] }],
    };
  if (prompt.includes('TASK: The student is reviewing'))
    return { cards: [{ title: 'The update rule', body: 'Subtract $\\eta$ times the gradient.', basis: 'peer', citations: ['F1', 'S2'], conflict: null }] };
  if (prompt.includes('multiple-choice'))
    return { questions: [{ question: 'Which direction does gradient descent step?', options: ['Up the gradient', 'Against the gradient', 'Random', 'None'], correctIndex: 1, explanation: 'It moves against the gradient.', citations: ['S2'] }] };
  return {};
};

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const msg = JSON.parse(body || '{}').messages?.find((m) => m.role === 'user')?.content ?? '';
    const prompt = typeof msg === 'string' ? msg : msg.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(prompt)) } }] }));
  });
}).listen(Number(process.env.MOCK_LLM_PORT || 4399), '127.0.0.1');
