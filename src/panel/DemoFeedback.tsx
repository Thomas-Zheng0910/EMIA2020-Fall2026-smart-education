import './demo-feedback.css';

const topics = ['Addition', 'Subtraction', 'Multiplication', 'Division'] as const;

const division = {
  slide: 4,
  label: 'Common Confusion',
  body: 'If 12 cookies are shared among 4 people, why does each person get fewer cookies? The total stays the same and more people share it. Give each person one cookie at a time. After three rounds, all 12 cookies are gone, so 12 ÷ 4 = 3. Check by multiplying: 4 × 3 = 12.',
};

const feedback = [
  {
    slide: 1,
    label: 'Fill the gap',
    body: 'Write the two sums side by side: 7 + 5 = 12 and 5 + 7 = 12. The order of the boxes changes, but you still count the same 12 pencils. This is the commutative property of addition.',
  },
  {
    slide: 2,
    label: 'Fill the gap',
    body: 'Label each number in 12 − 5 = 7. The 12 is the number of stickers you start with, the 5 is how many you give away, and the 7 is how many you keep. Put the parts back together to check: 5 + 7 = 12.',
  },
  {
    slide: 3,
    label: 'Answer your question',
    body: 'Write one 3 for each bag. There are four bags, so 3 + 3 + 3 + 3 = 12. The 4 tells you how many terms to write, and the 3 tells you how many apples each term counts.',
  },
  division,
];

export function DemoFeedback({
  slide,
  commonConfusionOnly,
  onGoToSlide,
  onClose,
}: {
  slide: number | null;
  commonConfusionOnly: boolean;
  onGoToSlide: (slide: number) => void;
  onClose: () => void;
}) {
  const replies = commonConfusionOnly ? [division] : feedback;
  const reply = commonConfusionOnly ? division : replies.find((entry) => entry.slide === slide);

  return (
    <aside className="panel demo-feedback" aria-label="Save me! feedback">
      <div className="panel-head">
        <h3>Save me!</h3>
        <div className="spacer" />
        <button type="button" className="icon-btn small" onClick={onClose} aria-label="Close feedback">
          ×
        </button>
      </div>
      <div className="panel-body">
        <p className="demo-feedback-label">Mock feedback · Select a reply to jump to its slide</p>
        <nav className="demo-feedback-slides" aria-label="Feedback by slide">
          {replies.map(({ slide: number }) => (
            <button
              key={number}
              type="button"
              aria-label={`Slide ${number} · ${topics[number - 1]}`}
              aria-pressed={slide === number}
              onClick={() => onGoToSlide(number)}
            >
              <span>Slide {number}</span>
              <strong>{topics[number - 1]}</strong>
            </button>
          ))}
        </nav>
        {reply ? (
          <>
            <h4>Slide {reply.slide} · {topics[reply.slide - 1]}</h4>
            <button
              type="button"
              className="demo-feedback-card"
              aria-label={`${reply.label} · Go to slide ${reply.slide}`}
              aria-describedby="demo-feedback-text"
              onClick={() => onGoToSlide(reply.slide)}
            >
              <span className="demo-feedback-card-title">
                <strong>{reply.label}</strong>
                <span aria-hidden="true">Slide {reply.slide} ↗</span>
              </span>
              <span id="demo-feedback-text" className="demo-feedback-card-text">
                {reply.body}
              </span>
            </button>
          </>
        ) : (
          <p>Open one of the four lecture slides to see its feedback.</p>
        )}
      </div>
    </aside>
  );
}
