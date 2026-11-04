// Deterministic OpenAI-compatible stand-in for browser tests (transport/control flow only, not model quality).
import { createServer } from 'node:http';

const reply = (prompt) => {
  if (prompt.includes('study digest'))
    return { slides: [...prompt.matchAll(/--- Slide (\d+)/g)].map((m) => ({ page: Number(m[1]), title: `Topic ${m[1]}`, summary: `Slide ${m[1]} teaches gradient steps.`, formulas: [], topics: ['gd'] })) };
  if (prompt.includes('Extract the course knowledge')) {
    // A gap the writer left, filled by the entry once a classmate has written on this slide.
    const known = /\[E([\w-]+)\]/.exec(prompt)?.[1];
    return {
      link: { lectureNumber: 1, slide: 2, confidence: 0.9 },
      fragments: [{ kind: 'derivation', text: 'Missing step: $w \\leftarrow w - \\eta \\nabla L$', topic: 'Update rule', confidence: 0.9, bbox: [0.05, 0.05, 0.5, 0.3] }],
      gaps: [{ bbox: [0.3, 0.4, 0.4, 0.2], missing: 'The step after the gradient.', entryIds: known ? [known] : [] }],
    };
  }
  if (prompt.includes('Group fragments that make the same point')) {
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
    return {
      entries: [
        { id: null, title: 'The update rule', summary: 'Subtract $\\eta$ times the gradient to step downhill.', fragmentIds: ids, contradicts: null, disputeExplanation: null },
      ],
    };
  }
  if (prompt.includes('Name 5-15 topics')) return { topics: [{ name: 'Gradient descent', slidePages: [1, 2, 3] }] };
  if (prompt.includes('fill this gap in 2-4 sentences'))
    return { title: 'Why subtract the gradient', body: 'The gradient points uphill, so subtracting steps downhill.', citations: ['S2'] };
  if (prompt.includes('does this entry reflect the slide')) return { disputed: true, explanation: 'The note contradicts the slide.' };
  if (prompt.includes('TASK: The student is reviewing')) {
    const entry = /\[E([\w-]+)\]/.exec(prompt)?.[1];
    // Cites the classmate entry and the slide it sits on, as a real answer would.
    return { cards: [{ title: 'The update rule', body: 'Subtract $\\eta$ times the gradient.', basis: 'peer', citations: entry ? [`E${entry}`, 'S2'] : ['S2'], conflict: null }] };
  }
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
