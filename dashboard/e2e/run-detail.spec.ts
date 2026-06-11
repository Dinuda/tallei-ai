import { expect, test, type Page } from "@playwright/test";

import { authCookieValue, closeLoopFixtureDb, seedLoopRunFixture, type SeededLoopFixture } from "./support/loop-fixtures";

type Scenario = SeededLoopFixture["scenario"];

const appOrigin = "http://localhost:3001";

async function openFixture(page: Page, scenario: Scenario) {
  const fixture = await seedLoopRunFixture(scenario);
  const { domain, path, ...cookie } = authCookieValue(fixture.auth);
  await page.context().addCookies([
    {
      ...cookie,
      url: appOrigin,
    },
  ]);
  await page.goto(`${appOrigin}${fixture.url}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixture.title, { timeout: 15_000 });
  return fixture;
}

async function expectRequestJson(page: Page, predicate: (url: string) => boolean) {
  const requestPromise = page.waitForRequest((request) => request.method() === "POST" && predicate(request.url()));
  return requestPromise.then((request) => request.postDataJSON() as Record<string, unknown>);
}

test.afterAll(async () => {
  await closeLoopFixtureDb();
});

test("run-start input requires text, then submits the exact surface payload", async ({ page }) => {
  const fixture = await openFixture(page, "input-start");

  const prompt = page.getByText("Paste sprint notes before drafting begins.");
  const textbox = page.locator("textarea").first();
  await expect(prompt).toBeVisible();
  await expect(textbox).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit input" })).toBeDisabled();

  await textbox.fill("Sprint notes: release is Friday and QA signed off.");
  await expect(page.getByRole("button", { name: "Submit input" })).toBeEnabled();

  const posted = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/submit`));
  await page.getByRole("button", { name: "Submit input" }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(posted).resolves.toEqual({
    values: {
      sprint_notes: {
        surface: "input.markdown",
        text: "Sprint notes: release is Friday and QA signed off.",
      },
    },
  });
  await expect(prompt).toBeHidden();
  await expect(textbox).toBeHidden();
});

test("run-start input already in memory stops requesting it and continues with an empty submit payload", async ({ page }) => {
  const fixture = await openFixture(page, "input-start-satisfied");

  await expect(page.locator("main").getByText("Input already saved", { exact: true }).first()).toBeVisible();
  await expect(page.locator("main").getByText("The required input is already in memory. Use the action button above to continue.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeEnabled();
  await expect(page.getByPlaceholder("Paste or type sprint notes…")).toHaveCount(0);

  const posted = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/submit`));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(posted).resolves.toEqual({ values: {} });
});

test("memory confirmation keeps selection state and sends the selected items on approve", async ({ page }) => {
  const fixture = await openFixture(page, "memory-confirmation");

  await expect(page.getByText("Select which memories the next agent may use.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Include memory/i })).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Approve (2)" })).toBeVisible();

  await page.getByRole("checkbox", { name: /Include memory Sprint notes say the release moved to Friday/i }).uncheck();
  await expect(page.getByRole("button", { name: "Approve (1)" })).toBeVisible();

  const posted = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/approve`));
  await page.getByRole("button", { name: "Approve (1)" }).click();
  await expect(posted).resolves.toMatchObject({
    channel: "dashboard",
    items: [
      { id: "mem_1", include: false },
      { id: "mem_2", include: true },
      { id: "mem_3", include: false },
    ],
  });
});

test("source confirmation supports disabled guards, custom sources, and revise payloads", async ({ page }) => {
  const fixture = await openFixture(page, "source-confirmation");

  const approve = page.getByRole("button", { name: "Approve (2)" });
  await expect(approve).toBeVisible();

  await page.getByRole("checkbox", { name: /Include source Source one/i }).uncheck();
  await page.getByRole("checkbox", { name: /Include source Source two/i }).uncheck();
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();

  await page.getByRole("checkbox", { name: /Include source Source one/i }).check();
  await page.getByPlaceholder("https://…").fill("https://example.com/custom-source");
  await page.getByPlaceholder("Title").fill("Custom source");
  await page.getByPlaceholder("Snippet or notes about this source").fill("Custom source snippet.");
  await page.getByRole("button", { name: "Add source" }).click();
  await expect(page.getByRole("checkbox", { name: /Include source Custom source/i })).toBeVisible();

  await page.getByPlaceholder("Optional feedback when revising (re-runs research with your notes)").fill("Rework with fresher sources.");
  const posted = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/revise`));
  await page.getByRole("button", { name: "Revise" }).click();
  await expect(posted).resolves.toEqual({
    feedback: "Rework with fresher sources.",
  });
});

test("canvas.email draft review shows the editable renderer and saves from the gate toolbar", async ({ page }) => {
  const fixture = await openFixture(page, "draft-review-email");

  await expect(page.getByRole("button", { name: "Edit draft" })).toBeVisible();
  await expect(page.getByText("Review the email draft, then save & approve or request changes.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save & Approve" })).toBeVisible();

  const posted = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/approve`));
  await page.getByRole("button", { name: "Save & Approve" }).click();
  await expect(posted).resolves.toMatchObject({ channel: "dashboard" });
});

test("canvas.preview renders the preview-only variant and allows revise with feedback", async ({ page }) => {
  const fixture = await openFixture(page, "draft-review-preview");

  await expect(page.getByText("Final preview — approved and ready to send.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save & Approve" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Revise" })).toBeVisible();

  const posted = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/revise`));
  await page.getByRole("button", { name: "Revise" }).click();
  await expect(posted).resolves.toEqual({});
});

test("recipient upload saves contacts and then continues instead of reopening the upload UI", async ({ page }) => {
  const fixture = await openFixture(page, "recipient-upload");

  await expect(page.getByRole("tab", { name: "Paste emails" })).toBeVisible();
  await page.getByRole("tab", { name: "Paste emails" }).click();
  await page.locator("textarea").first().fill("alex@example.com\ncasey@example.com");

  const savePayload = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/contacts`));
  await page.getByRole("button", { name: "Save contacts", exact: true }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(savePayload).resolves.toMatchObject({
    contacts: [
      { email: "alex@example.com" },
      { email: "casey@example.com" },
    ],
  });

  await expect(page.locator("main").getByText("Recipients saved", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue (2 recipients)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue (2 recipients)" })).toBeEnabled();
  await expect(page.getByRole("tab", { name: "Paste emails" })).toHaveCount(0);

  const continuePayload = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/submit`));
  await page.getByRole("button", { name: "Continue (2 recipients)" }).click();
  await expect(continuePayload).resolves.toEqual({ values: {} });
});

test("pre-send approval includes the saved contacts and render target payload", async ({ page }) => {
  const fixture = await openFixture(page, "pre-send");

  await expect(page.getByRole("button", { name: "Edit draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & send (2)" })).toBeVisible();

  const posted = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/approve`));
  await page.getByRole("button", { name: "Approve & send (2)" }).click();
  await expect(posted).resolves.toMatchObject({
    channel: "dashboard",
    contacts: [
      { email: "alex@example.com", name: "Alex" },
      { email: "casey@example.com", name: "Casey" },
    ],
  });
});

test("failed recipient recovery stays on the recovery path and retries after contacts are restored", async ({ page }) => {
  const fixture = await openFixture(page, "failed-recipient-recovery");

  await expect(page.getByRole("heading", { name: "Recipients required" })).toBeVisible();
  await expect(page.getByText("Upload contacts to fix the failed send, then retry the delivery agent.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save contacts", exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Paste emails" }).click();
  await page.locator("textarea").first().fill("alex@example.com\ncasey@example.com");
  const savePayload = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/gates/${fixture.gateId}/contacts`));
  await page.getByRole("button", { name: "Save contacts", exact: true }).evaluate((element) => {
    (element as HTMLButtonElement).click();
  });
  await expect(savePayload).resolves.toMatchObject({
    contacts: [
      { email: "alex@example.com" },
      { email: "casey@example.com" },
    ],
  });

  await expect(page.getByRole("button", { name: "Save contacts", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry agent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recipients required" })).toBeHidden();

  const retryPayload = expectRequestJson(page, (url) => url.endsWith(`/api/workflows/runs/${fixture.runId}/steps/${fixture.stepAttemptId}/retry`));
  await page.getByRole("button", { name: "Retry agent" }).click();
  await expect(retryPayload).resolves.toEqual({});
});
