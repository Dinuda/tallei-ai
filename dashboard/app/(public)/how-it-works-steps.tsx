export type HowItWorksStep = {
  num: string;
  title: string;
  body: string;
  detail?: string;
};

export function HowItWorksSteps({ steps }: { steps: readonly HowItWorksStep[] }) {
  return (
    <ol className="loops-how-steps">
      {steps.map((step, index) => (
        <li key={step.num} className="loops-how-step">
          <div className="loops-how-step-card">
            <span className="loops-mono loops-how-step-num">{step.num}</span>
            <h3 className="loops-how-step-title">{step.title}</h3>
            <p className="loops-how-step-body">{step.body}</p>
            {step.detail ? (
              <p className="loops-how-step-detail">{step.detail}</p>
            ) : null}
          </div>
          {index < steps.length - 1 ? (
            <span className="loops-how-step-connector" aria-hidden />
          ) : null}
        </li>
      ))}
    </ol>
  );
}
