import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResolvedPayload,
  describeBindingResolutionError,
  filterBindingResolutionAnswers,
  InvalidBindingScopeAnswerError,
  isBindingResolutionQuestionId,
  mapConfigAnswer,
  prepareBindingResolution,
  resolvePreparedBindings,
  type BindingResolutionInput,
} from "../../../src/loops/binding-resolver.js";

function gmailInput(): BindingResolutionInput {
  return {
    actions: [{
      outcomeId: "step-2",
      connector: "gmail",
      role: "source",
      description: "Retrieves ticket details",
      candidates: [{
        actionSlug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        name: "Fetch email content",
        description: "Fetch one message",
      }],
    }, {
      outcomeId: "step-5",
      connector: "gmail",
      role: "destination",
      description: "Sends the reply email to the customer",
      candidates: [{
        actionSlug: "GMAIL_REPLY_TO_THREAD",
        name: "Reply to email thread",
        description: "Reply in the original thread",
      }, {
        actionSlug: "GMAIL_SEND_EMAIL",
        name: "Send email",
        description: "Start a new email thread",
      }],
    }],
    trigger: {
      outcomeId: "step-1",
      connector: "gmail",
      description: "Monitors for new incoming support tickets",
      candidates: [{
        slug: "GMAIL_NEW_GMAIL_MESSAGE",
        name: "New Gmail message",
        configSchema: {
          type: "object",
          properties: {
            labelIds: { type: "array", items: { type: "string" } },
            userId: { type: "string" },
          },
        },
        configurableFields: [{
          key: "labelIds",
          label: "Gmail labels",
          description: "Only watch selected labels",
          type: "array",
          options: [{ label: "Inbox", value: "INBOX" }, { label: "Support", value: "Label_support" }],
        }],
      }],
    },
    answers: [],
  };
}

function gmailAnswers() {
  return [{
    questionId: "binding-action-step-5",
    question: "How should Gmail send the reply?",
    answerText: "Reply to email thread",
    selectedOptionIds: ["GMAIL_REPLY_TO_THREAD"],
    selectedValues: ["GMAIL_REPLY_TO_THREAD"],
  }, {
    questionId: "binding-config-step-1-labelIds",
    question: "Which Gmail labels should be watched?",
    answerText: "Inbox",
    selectedOptionIds: ["INBOX"],
    selectedValues: ["INBOX"],
  }];
}

test("binding resolution question ids are server-owned patterns only", () => {
  assert.equal(isBindingResolutionQuestionId("binding-action-step-5"), true);
  assert.equal(isBindingResolutionQuestionId("binding-config-step-1-labelIds"), true);
  assert.equal(isBindingResolutionQuestionId("trigger-scope"), false);
});

test("filterBindingResolutionAnswers drops model-authored binding questions", () => {
  const filtered = filterBindingResolutionAnswers([
    ...gmailAnswers(),
    {
      questionId: "trigger-scope",
      question: "Which incoming emails should trigger the automation?",
      answerText: "All inbox emails",
      selectedOptionIds: ["all_inbox"],
      selectedValues: ["all_inbox"],
    },
  ]);
  assert.deepEqual(filtered.map((answer) => answer.questionId), [
    "binding-action-step-5",
    "binding-config-step-1-labelIds",
  ]);
});

test("binding resolver waits for exact action and trigger-scope answers without invoking a model", () => {
  const prepared = prepareBindingResolution(gmailInput());
  assert.equal(prepared.ready, false);
  if (prepared.ready) return;
  assert.deepEqual(prepared.pendingQuestions.map((question) => question.questionId), [
    "binding-action-step-5",
    "binding-config-step-1-labelIds",
  ]);
  assert.deepEqual(prepared.pendingQuestions[0]?.options.map((option) => option.value), [
    "GMAIL_REPLY_TO_THREAD",
    "GMAIL_SEND_EMAIL",
  ]);
});

test("model-authored scope answers are ignored until server pendingQuestions are answered", () => {
  const input = gmailInput();
  input.answers = [{
    questionId: "binding-action-step-5",
    question: "How should Gmail send the reply?",
    answerText: "Reply to email thread",
    selectedOptionIds: ["GMAIL_REPLY_TO_THREAD"],
    selectedValues: ["GMAIL_REPLY_TO_THREAD"],
  }, {
    questionId: "trigger-scope",
    question: "Which incoming emails should trigger the automation?",
    answerText: "All inbox emails",
    selectedOptionIds: ["all_inbox"],
    selectedValues: ["all_inbox"],
  }];
  const prepared = prepareBindingResolution(input);
  assert.equal(prepared.ready, false);
  if (prepared.ready) return;
  assert.deepEqual(prepared.pendingQuestions.map((question) => question.questionId), [
    "binding-config-step-1-labelIds",
  ]);
});

test("mapConfigAnswer accepts exact provider option values only", () => {
  const config = mapConfigAnswer([{
    key: "labelIds",
    label: "Gmail labels",
    description: "Only watch selected labels",
    type: "array",
    options: [{ label: "Inbox", value: "INBOX" }],
  }], {
    questionId: "binding-config-step-1-labelIds",
    question: "Which Gmail labels should be watched?",
    answerText: "Inbox",
    selectedOptionIds: ["INBOX"],
    selectedValues: ["INBOX"],
  });
  assert.deepEqual(config, { labelIds: ["INBOX"] });
});

test("mapConfigAnswer rejects values outside the provider catalogue", () => {
  assert.throws(() => mapConfigAnswer([{
    key: "labelIds",
    label: "Gmail labels",
    description: "Only watch selected labels",
    type: "array",
    options: [{ label: "Inbox", value: "INBOX" }],
  }], {
    questionId: "binding-config-step-1-labelIds",
    question: "Which incoming emails should trigger the automation?",
    answerText: "All inbox emails",
    selectedOptionIds: ["all_inbox"],
    selectedValues: ["all_inbox"],
  }), InvalidBindingScopeAnswerError);
});

test("Gmail runtime schema accepts labelIds and rejects hallucinated userId", () => {
  const input = gmailInput();
  input.answers = gmailAnswers();
  const prepared = prepareBindingResolution(input);
  assert.equal(prepared.ready, true);
  if (!prepared.ready) return;

  assert.equal(prepared.schema.safeParse(buildResolvedPayload(prepared)).success, true);
  assert.equal(prepared.schema.safeParse({
    actions: {
      "step-2": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "step-5": "GMAIL_REPLY_TO_THREAD",
    },
    trigger: {
      outcomeId: "step-1",
      connector: "gmail",
      triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
      config: { userId: "me" },
    },
  }).success, false);
});

test("resolvePreparedBindings commits deterministically without calling a model", async () => {
  const input = gmailInput();
  input.answers = gmailAnswers();
  const prepared = prepareBindingResolution(input);
  assert.equal(prepared.ready, true);
  if (!prepared.ready) return;

  const resolved = await resolvePreparedBindings(prepared);

  assert.deepEqual(resolved.artifact.bindings.map((binding) => binding.actionSlug), [
    "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "GMAIL_REPLY_TO_THREAD",
  ]);
  assert.equal(resolved.artifact.trigger.kind, "event");
  if (resolved.artifact.trigger.kind === "event") {
    assert.deepEqual(resolved.artifact.trigger.config, { labelIds: ["INBOX"] });
  }
});

test("invalid injected model output still fails post-validation", async () => {
  const input = gmailInput();
  input.actions[1]!.candidates = [input.actions[1]!.candidates[0]!];
  input.answers = [{
    questionId: "binding-config-step-1-labelIds",
    question: "Which Gmail labels should be watched?",
    answerText: "Inbox",
    selectedOptionIds: ["INBOX"],
    selectedValues: ["INBOX"],
  }];
  const prepared = prepareBindingResolution(input);
  assert.equal(prepared.ready, true);
  if (!prepared.ready) return;

  await assert.rejects(() => resolvePreparedBindings(prepared, {
    generate: async () => ({
      actions: {
        "step-2": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
        "step-5": "GMAIL_SEND_EMAIL",
      },
      trigger: {
        outcomeId: "step-1",
        connector: "gmail",
        triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE",
        config: { labelIds: ["INBOX"] },
      },
    }),
  }));
});

test("describeBindingResolutionError classifies provider JSON format failures and invalid scope answers", () => {
  assert.deepEqual(
    describeBindingResolutionError(new Error(
      "Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'.",
    )),
    {
      code: "BINDING_RESOLVER_PROVIDER_ERROR",
      message: "Binding resolver model rejected structured JSON output.",
    },
  );
  assert.deepEqual(
    describeBindingResolutionError(new InvalidBindingScopeAnswerError("labelIds", ["all_inbox"])),
    {
      code: "INVALID_BINDING_SCOPE_ANSWER",
      message: "The saved trigger scope answer is not a valid provider option.",
    },
  );
  assert.deepEqual(
    describeBindingResolutionError(new Error("Binding resolver returned an unavailable action for step-5")),
    {
      code: "BINDING_RESOLUTION_FAILED",
      message: "The workflow bindings could not be validated.",
    },
  );
});
