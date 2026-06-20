export class SpecRunInteractionRequiredError extends Error {
  readonly stepAttemptId: string;
  readonly interactionId: string;

  constructor(stepAttemptId: string, interactionId: string) {
    super("Run paused for operator interaction");
    this.name = "SpecRunInteractionRequiredError";
    this.stepAttemptId = stepAttemptId;
    this.interactionId = interactionId;
  }
}
